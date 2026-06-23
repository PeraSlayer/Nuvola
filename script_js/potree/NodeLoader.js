import * as THREE from 'three';
import { OctreeGeometryNode } from './PotreeOctree.js';
import { WorkerPool } from './WorkerPool.js';
import { createDecoderWorker } from './DecoderWorker.js';

const HIERARCHY_ENTRY_FIXED_SIZE = 22;
const HIERARCHY_ENTRY_VARIABLE_SIZE = 20;
const DECODER_WORKER_COUNT = 2;

export class NodeLoader {
  constructor() {
    this._decoderUrl = createDecoderWorker();
    this._workerPool = new WorkerPool(DECODER_WORKER_COUNT);
    this._urlOctree = '';
    this._urlHierarchy = '';
    this._attributes = [];
    this._scale = 1;
    this._offset = 0;
    this._firstChunkSize = 0;
  }

  async loadMetadata(baseUrl) {
    const url = baseUrl.endsWith('/') ? baseUrl + 'metadata.json' : baseUrl;
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

  async loadHierarchyAll(geometry) {
    const resp = await fetch(this._urlHierarchy);
    if (!resp.ok) throw new Error(`Failed to fetch hierarchy.bin: ${resp.statusText}`);
    const buf = await resp.arrayBuffer();
    const entries = this._parseHierarchyEntries(buf);
    this._totalHierarchyEntries = entries.length;

    const hasNames = entries.some(e => e.name);
    const nodes = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const name = entry.name || (i === 0 ? 'r' : '');
      const node = this._createNodeFromEntry(name, geometry, entry);
      nodes.push(node);
    }

    if (hasNames) {
      const byName = new Map();
      for (const node of nodes) byName.set(node.name, node);
      for (const node of nodes) {
        if (node.name === 'r') continue;
        const parentName = node.name.slice(0, -1);
        const parent = byName.get(parentName);
        if (parent) {
          parent.addChild(node);
          this._setNodeAABB(node, geometry);
          node.depth = node.name.length - 1;
          node.spacing = geometry.spacing / Math.pow(2, node.depth);
        }
      }
    } else {
      let childPtr = 1;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const node = nodes[i];
        const mask = entry.childMask;
        for (let b = 0; b < 8; b++) {
          if (mask & (1 << b) && childPtr < nodes.length) {
            const child = nodes[childPtr];
            child.name = node.name + b;
            this._setNodeAABB(child, geometry);
            child.depth = child.name.length - 1;
            child.spacing = geometry.spacing / Math.pow(2, child.depth);
            node.addChild(child);
            childPtr++;
          }
        }
      }
    }

    geometry.root = nodes[0];
    geometry.numNodes = nodes.length;
    return geometry.root;
  }

  async loadNode(node) {
    if (node.loaded || node.loading) return node;
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

  _parseHierarchyEntries(buffer) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder('utf-8');
    const entries = [];
    let offset = 0;
    while (offset + HIERARCHY_ENTRY_FIXED_SIZE <= buffer.byteLength) {
      const typeByte = view.getUint8(offset);
      if (typeByte & 0x80) {
        const nameLen = typeByte & 0x3F;
        const nameBytes = new Uint8Array(buffer, offset + 1, nameLen);
        const name = decoder.decode(nameBytes);
        offset += 1 + nameLen;
        if (offset + HIERARCHY_ENTRY_VARIABLE_SIZE > buffer.byteLength) break;
        entries.push({
          name,
          type: 0,
          childMask: view.getUint8(offset),
          numPoints: view.getUint32(offset + 2, true),
          byteOffset: view.getBigInt64(offset + 6, true),
          byteSize: view.getBigInt64(offset + 14, true),
        });
        offset += HIERARCHY_ENTRY_VARIABLE_SIZE;
      } else {
        entries.push({
          name: '',
          type: typeByte,
          childMask: view.getUint8(offset + 1),
          numPoints: view.getUint32(offset + 2, true),
          byteOffset: view.getBigInt64(offset + 6, true),
          byteSize: view.getBigInt64(offset + 14, true),
        });
        offset += HIERARCHY_ENTRY_FIXED_SIZE;
      }
    }
    return entries;
  }

  _createNodeFromEntry(name, geometry, entry) {
    const box = name === 'r' ? geometry.boundingBox.clone() : new THREE.Box3();
    const node = new OctreeGeometryNode(name, geometry, box);
    node.numPoints = entry.numPoints;
    node.byteOffset = entry.byteOffset;
    node.byteSize = entry.byteSize;
    node.hasChildren = entry.childMask;

    if (name === 'r') {
      node.depth = 0;
      node.spacing = geometry.spacing;
    }

    return node;
  }

  _setNodeAABB(node, geometry) {
    let box = geometry.boundingBox.clone();
    const center = new THREE.Vector3();
    const name = node.name;

    for (let i = 1; i < name.length; i++) {
      const childIndex = parseInt(name[i], 10);
      box.getCenter(center);
      const mx = center.x, my = center.y, mz = center.z;
      const min = box.min.clone(), max = box.max.clone();

      box = new THREE.Box3(
        new THREE.Vector3(
          (childIndex & 4) !== 0 ? mx : min.x,
          (childIndex & 2) !== 0 ? my : min.y,
          (childIndex & 1) !== 0 ? mz : min.z,
        ),
        new THREE.Vector3(
          (childIndex & 4) !== 0 ? max.x : mx,
          (childIndex & 2) !== 0 ? max.y : my,
          (childIndex & 1) !== 0 ? max.z : mz,
        ),
      );
    }

    node.boundingBox = box;
    node.boundingBox.getBoundingSphere(node.boundingSphere);
    node.tightBoundingBox = box.clone();
  }

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

      const transferables = [buffer];
      worker.postMessage({
        buffer,
        attributes: this._attributes,
        scale: this._scale,
        offset: this._offset,
      }, transferables);
    });
  }

  dispose() {
    this._workerPool.terminateAll();
    URL.revokeObjectURL(this._decoderUrl);
  }
}
