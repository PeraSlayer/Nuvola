/**
 * @file NodeLoader.js
 * @description Loads Potree octree data from the network. Handles metadata
 *   retrieval, hierarchy parsing, node creation, and point-data decoding.
 *   Uses a pool of Web Workers ({@link WorkerPool}) for parallel binary decoding
 *   and issues HTTP Range requests to fetch per-node byte segments from octree.bin.
 */

import * as THREE from 'three';
import { OctreeGeometryNode } from './PotreeOctree.js';
import { WorkerPool } from './WorkerPool.js';
import { createDecoderWorker } from './DecoderWorker.js';

/**
 * Fixed byte size of a hierarchy entry without a variable-length name.
 * Layout: type(1) + childMask(1) + numPoints(4) + byteOffset(8) + byteSize(8) = 22.
 */
const HIERARCHY_ENTRY_FIXED_SIZE = 22;
/**
 * Byte size of a hierarchy entry that includes a variable-length name.
 * Layout: type(1) + nameLen(variable) + childMask(1) + padding(1) + numPoints(4) + byteOffset(8) + byteSize(8) = 22 + nameLen.
 */
const HIERARCHY_ENTRY_VARIABLE_SIZE = 22;
/**
 * Number of Web Workers to spawn for parallel decoding.
 * Respects `navigator.hardwareConcurrency` when available.
 */
const DECODER_WORKER_COUNT = typeof navigator !== 'undefined'
  ? Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
  : 4;
/** Byte stride per entry in the compact binary index buffer. */
const BIN_ENTRY_SIZE = 21;
// childMask(1) + numPoints(4) + byteOffset(8) + byteSize(8)
/** Maximum number of concurrent fetch requests. */
const MAX_CONCURRENT_FETCHES = 8;

/**
 * Loads and decodes Potree binary data. Manages a pool of decoder workers,
 * fetches hierarchy data, constructs the octree node graph, and streams
 * per-node point data via HTTP Range requests.
 *
 * @class NodeLoader
 */
export class NodeLoader {
  constructor() {
    /** @type {string} Blob URL for the inline decoder worker script. */
    this._decoderUrl = createDecoderWorker();
    /** @type {WorkerPool} Pool of reusable Web Workers for decoding. */
    this._workerPool = new WorkerPool(DECODER_WORKER_COUNT);
    /** @type {string} URL of the octree binary data file (octree.bin). */
    this._urlOctree = '';
    /** @type {string} URL of the hierarchy binary data file (hierarchy.bin). */
    this._urlHierarchy = '';
    /** @type {Object[]} Attribute descriptors parsed from metadata.json. */
    this._attributes = [];
    /** @type {number} Scale factor applied during decoding. */
    this._scale = 1;
    /** @type {number} Offset applied during decoding. */
    this._offset = 0;
    /** @type {number} First chunk size from hierarchy metadata. */
    this._firstChunkSize = 0;
  }

  /**
   * Fetches and parses metadata.json from the given base URL.
   * Constructs the URLs for octree.bin and hierarchy.bin and stores
   * attribute/scale/offset metadata.
   *
   * @async
   * @param {string} baseUrl Base dataset URL or full metadata.json path.
   * @returns {Promise<Object>} Parsed metadata JSON object.
   * @throws {Error} If the fetch fails.
   */
  async loadMetadata(baseUrl) {
    let url = baseUrl;
    if (url.endsWith('/')) {
      url += 'metadata.json';
    } else if (!url.endsWith('/metadata.json') && !url.endsWith('metadata.json')) {
      url += '/metadata.json';
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch metadata.json: ${resp.statusText}`);
    const json = await resp.json();

    const base = url.substring(0, url.lastIndexOf('/') + 1);
    this._urlOctree = base + 'octree.bin';
    this._urlHierarchy = base + 'hierarchy.bin';
    this._attributes = json.attributes || [];
    this._scale = json.scale || 1;
    this._offset = json.offset || 0;
    this._firstChunkSize = json.hierarchy ? json.hierarchy.firstChunkSize || 1 : 1;

    return json;
  }

  /**
   * Fetches the full hierarchy.bin, parses all entries, builds a compact
   * binary index in {@link OctreeGeometry}, and returns the root node.
   *
   * @async
   * @param {OctreeGeometry} geometry Container to populate.
   * @returns {Promise<OctreeGeometryNode>} The root node.
   * @throws {Error} If hierarchy.bin cannot be fetched or no root entry is found.
   */
  async loadHierarchyRoot(geometry) {
    const resp = await fetch(this._urlHierarchy);
    if (!resp.ok) throw new Error(`Failed to fetch hierarchy.bin: ${resp.statusText}`);
    const buf = await resp.arrayBuffer();
    this._buildHierarchyBuffer(buf, geometry);

    if (!geometry._entryMap.has('r')) throw new Error('No root node in hierarchy');
    return this._createNodeFromEntry('r', geometry, 0);
  }

  /**
   * Lazily loads child nodes for the given node from the hierarchy index.
   * If children have already been created and pushed, returns them directly.
   *
   * @param {OctreeGeometryNode} node
   * @returns {OctreeGeometryNode[]|null} The children array, or null if no children exist.
   */
  loadChildren(node) {
    const geometry = node.geometry;
    if (!geometry._entryMap) return null;
    if (!node.children) node.children = [];

    for (let i = 0; i < 8; i++) {
      if (!(node.hasChildren & (1 << i))) continue;
      const childName = node.name + String(i);
      if (node.getChild(childName)) continue;

      const idx = geometry._entryMap.get(childName);
      if (idx == null) continue;

      const child = this._createNodeFromEntry(childName, geometry, idx);
      this._setNodeAABB(child, geometry);
      node.addChild(child);
    }

    return node.children;
  }

  /**
   * Parses the raw hierarchy binary buffer and builds:
   *  - `geometry._entryMap`  : name → byte-offset lookup within entry buffer
   *  - `geometry._entryBuffer` : compact fixed-size binary index for random access
   *  - `geometry.totalPoints` : accumulative point count
   *
   * @private
   * @param {ArrayBuffer} buffer Raw hierarchy.bin data.
   * @param {OctreeGeometry} geometry Geometry to populate with index data.
   */
  _buildHierarchyBuffer(buffer, geometry) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder('utf-8');

    const entryMap = new Map();
    const entries = [];
    let totalPoints = 0;
    let offset = 0;

    while (offset + HIERARCHY_ENTRY_FIXED_SIZE <= buffer.byteLength) {
      let name, childMask, numPoints, byteOffset, byteSize;
      const typeByte = view.getUint8(offset);

      // High bit set indicates a variable-length name is present.
      if (typeByte & 0x80) {
        const nameLen = typeByte & 0x3F;
        const nameBytes = new Uint8Array(buffer, offset + 1, nameLen);
        name = decoder.decode(nameBytes);
        offset += 1 + nameLen;
        if (offset + HIERARCHY_ENTRY_VARIABLE_SIZE > buffer.byteLength) break;
        childMask = view.getUint8(offset);
        numPoints = view.getUint32(offset + 2, true);
        byteOffset = view.getBigInt64(offset + 6, true);
        byteSize = view.getBigInt64(offset + 14, true);
        offset += HIERARCHY_ENTRY_VARIABLE_SIZE;
      } else {
        name = '';
        childMask = view.getUint8(offset + 1);
        numPoints = view.getUint32(offset + 2, true);
        byteOffset = view.getBigInt64(offset + 6, true);
        byteSize = view.getBigInt64(offset + 14, true);
        offset += HIERARCHY_ENTRY_FIXED_SIZE;
      }

      totalPoints += numPoints || 0;
      entries.push({ name, childMask, numPoints, byteOffset, byteSize });
    }

    // Build compact binary index: each entry is BIN_ENTRY_SIZE bytes
    const binBuf = new ArrayBuffer(entries.length * BIN_ENTRY_SIZE);
    const binView = new DataView(binBuf);
    let binOff = 0;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const idx = binOff;
      binView.setUint8(binOff, e.childMask);
      binView.setUint32(binOff + 1, e.numPoints, true);
      // Split 64-bit values into two 32-bit halves for storage
      const lo = Number(e.byteOffset & 0xFFFFFFFFn);
      binView.setUint32(binOff + 5, lo, true);
      binView.setUint32(binOff + 9, Number(e.byteOffset >> 32n), true);
      const ls = Number(e.byteSize & 0xFFFFFFFFn);
      binView.setUint32(binOff + 13, ls, true);
      binView.setUint32(binOff + 17, Number(e.byteSize >> 32n), true);
      binOff += BIN_ENTRY_SIZE;

      const mapName = entries[i].name || (i === 0 ? 'r' : '');
      if (mapName) entryMap.set(mapName, idx);
    }

    geometry.totalPoints = totalPoints;
    geometry._entryMap = entryMap;
    geometry._entryBuffer = binBuf;
    geometry._entryView = binView;
    geometry._nodeMap = new Map();
  }

  /**
   * Instantiates an {@link OctreeGeometryNode} from the compact binary index.
   *
   * @private
   * @param {string} name Node name (e.g. "r", "r01").
   * @param {OctreeGeometry} geometry Owning geometry.
   * @param {number} entryIdx Byte-offset into `geometry._entryBuffer`.
   * @returns {OctreeGeometryNode}
   */
  _createNodeFromEntry(name, geometry, entryIdx) {
    const v = geometry._entryView;
    const idx = (name === 'r') ? 0 : entryIdx;

    const childMask = v.getUint8(idx);
    const numPoints = v.getUint32(idx + 1, true);
    const loOff = v.getUint32(idx + 5, true);
    const hiOff = v.getUint32(idx + 9, true);
    // Reconstruct BigInt from two 32-bit halves
    const byteOffset = BigInt(hiOff) << 32n | BigInt(loOff);
    const loSz = v.getUint32(idx + 13, true);
    const hiSz = v.getUint32(idx + 17, true);
    const byteSize = BigInt(hiSz) << 32n | BigInt(loSz);

    const box = name === 'r' ? geometry.boundingBox.clone() : new THREE.Box3();
    const node = new OctreeGeometryNode(name, geometry, box);
    node.numPoints = numPoints;
    node.byteOffset = byteOffset;
    node.byteSize = byteSize;
    node.hasChildren = childMask;

    if (name === 'r') {
      node.depth = 0;
      node.spacing = geometry.spacing;
    }

    return node;
  }

  /**
   * Fetches and decodes the point data for a single octree node via an HTTP
   * Range request. Delegates decoding to a Web Worker. Fires `_loadCallbacks`
   * on success.
   *
   * @async
   * @param {OctreeGeometryNode} node
   * @returns {Promise<OctreeGeometryNode>} The same node, now with geometry data attached.
   */
  async loadNode(node) {
    if (node.loaded || node.loading) return node;
    node._disposed = false;
    if (node.byteSize === 0n || node.numPoints === 0) {
      node.loaded = true;
      return node;
    }

    node.loading = true;
    try {
      const first = node.byteOffset;
      const last = node.byteOffset + node.byteSize - 1n;
      const resp = await fetch(this._urlOctree, {
        headers: { Range: `bytes=${first}-${last}` },
      });
      if (!resp.ok) throw new Error(`Range request failed: ${resp.statusText}`);
      const buf = await resp.arrayBuffer();

      const decoded = await this._decodeBuffer(buf);
      if (decoded && decoded.numPoints > 0) {
        node.geometryData = decoded;
        node.loaded = true;
        node.loading = false;
        for (const cb of node._loadCallbacks) {
          try { cb(node); } catch (e) { console.warn('Node load callback error:', e); }
        }
        node._loadCallbacks.length = 0;
      } else {
        node.loaded = true;
        node.loading = false;
      }
    } catch (err) {
      node.loaded = false;
      node.loading = false;
      console.warn(`Failed to load node ${node.name}:`, err);
    }
    return node;
  }

  /**
   * Computes the axis-aligned bounding box for a given node by subdividing
   * the root box according to its octant path encoded in the node name.
   *
   * @private
   * @param {OctreeGeometryNode} node Node to set the AABB on.
   * @param {OctreeGeometry} geometry The root geometry for initial bounds.
   */
  _setNodeAABB(node, geometry) {
    const box = geometry.boundingBox.clone();
    const name = node.name;

    // Walk the octant path character by character (after 'r')
    for (let i = 1; i < name.length; i++) {
      const childIndex = parseInt(name[i], 10);
      const mx = (box.min.x + box.max.x) * 0.5;
      const my = (box.min.y + box.max.y) * 0.5;
      const mz = (box.min.z + box.max.z) * 0.5;

      // Octant bit layout: bit 2 = X, bit 1 = Y, bit 0 = Z
      box.min.x = (childIndex & 4) !== 0 ? mx : box.min.x;
      box.min.y = (childIndex & 2) !== 0 ? my : box.min.y;
      box.min.z = (childIndex & 1) !== 0 ? mz : box.min.z;
      box.max.x = (childIndex & 4) !== 0 ? box.max.x : mx;
      box.max.y = (childIndex & 2) !== 0 ? box.max.y : my;
      box.max.z = (childIndex & 1) !== 0 ? box.max.z : mz;
    }

    node.boundingBox = box;
    box.getBoundingSphere(node.boundingSphere);
    node.tightBoundingBox = box.clone();

    node.depth = name.length - 1;
    node.spacing = geometry.spacing / Math.pow(2, node.depth);
  }

  /**
   * Sends a raw binary buffer to a decoder Web Worker and returns a promise
   * that resolves with the decoded attribute arrays.
   *
   * @private
   * @param {ArrayBuffer} buffer Raw point data.
   * @returns {Promise<Object>} Decoded geometry data (position, color, intensity, etc.).
   */
  _decodeBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const worker = this._workerPool.getWorker(this._decoderUrl);
      if (!worker) {
        reject(new Error('No worker available'));
        return;
      }

      worker.onmessage = (e) => {
        this._workerPool.returnWorker(worker);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(e.data);
        }
      };
      worker.onerror = (e) => {
        this._workerPool.returnWorker(worker);
        reject(new Error(e.message || 'Worker error'));
      };

      // Transfer the buffer to the worker (zero-copy) for performance
      const transferables = [buffer];
      worker.postMessage({
        buffer,
        attributes: this._attributes,
        scale: this._scale,
        offset: this._offset,
      }, transferables);
    });
  }

  /**
   * Terminates all decoder workers and releases the Blob URL.
   */
  dispose() {
    this._workerPool.terminateAll();
    URL.revokeObjectURL(this._decoderUrl);
  }
}
