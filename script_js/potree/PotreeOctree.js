/**
 * @file PotreeOctree.js
 * @description Defines the core octree data structures for Potree point clouds.
 *   {@link OctreeGeometry} holds global octree metadata (bounds, spacing, attributes),
 *   while {@link OctreeGeometryNode} represents a single octree node with its
 *   bounding volume, point data references, child pointers, and loading state.
 */

import * as THREE from 'three';

/** Monotonically increasing counter for unique node IDs. */
let _nodeIdCounter = 0;

/**
 * Represents a single node in the Potree octree. Each node carries its
 * bounding box, point-count metadata, byte-range of its point data, and
 * references to child nodes.
 *
 * @class OctreeGeometryNode
 */
export class OctreeGeometryNode {
  /**
   * @param {string} name Node name (e.g. "r" for root, "r0", "r01", …).
   *   The name encodes the depth and octant path.
   * @param {OctreeGeometry} geometry Parent octree geometry.
   * @param {THREE.Box3} boundingBox Axis-aligned bounding box of this node.
   */
  constructor(name, geometry, boundingBox) {
    /** @type {number} Unique numeric identifier. */
    this.id = _nodeIdCounter++;
    /** @type {string} Node name encoding the octant path. */
    this.name = name;
    /** @type {OctreeGeometry} Owning octree geometry. */
    this.geometry = geometry;
    /** @type {THREE.Box3} Axis-aligned bounding box. */
    this.boundingBox = boundingBox.clone();
    /** @type {THREE.Sphere} Bounding sphere derived from the AABB. */
    this.boundingSphere = new THREE.Sphere();
    boundingBox.getBoundingSphere(this.boundingSphere);
    /** @type {THREE.Box3} Tight (more accurate) bounding box; initially equal to AABB. */
    this.tightBoundingBox = boundingBox.clone();

    /** @type {number} Octant index (0–7) of this node within its parent. Root has index -1. */
    this.index = name === 'r' ? -1 : parseInt(name.slice(-1), 10);
    /** @type {number} Depth in the octree (0 = root). */
    this.depth = name === 'r' ? 0 : name.length - 1;

    /** @type {number} Point spacing at this level (halved per depth). */
    this.spacing = geometry.spacing / Math.pow(2, this.depth);

    /** @type {number} Total point count in this node (from metadata). */
    this.numPoints = 0;
    /** @type {bigint} Byte offset of this node's point data in octree.bin. */
    this.byteOffset = 0n;
    /** @type {bigint} Byte size of this node's point data in octree.bin. */
    this.byteSize = 0n;

    /** @type {OctreeGeometryNode[]|null} Child nodes, or null if not created yet. */
    this.children = null;
    /** @type {number} Bitmask indicating which octants (0–7) contain children. */
    this.hasChildren = 0;

    /** @type {boolean} Whether point geometry data has been loaded and decoded. */
    this.loaded = false;
    /** @type {boolean} Whether a load request for this node is in flight. */
    this.loading = false;
    /** @type {Object|null} Decoded geometry attributes (position, color, etc.). */
    this.geometryData = null;
    /** @type {Object|null} GPU-side resource handle for this node. */
    this.gpuNode = null;

    /** @type {function[]} Callbacks invoked once after this node is disposed. */
    this._oneTimeDisposeHandlers = [];
    /** @type {function[]} Callbacks invoked when point data finishes loading. */
    this._loadCallbacks = [];
    /** @type {boolean} Whether this node has been disposed. */
    this._disposed = false;
  }

  /**
   * Returns the number of points in this node.
   * @returns {number}
   */
  getNumPoints() {
    return this.numPoints;
  }

  /**
   * Returns the depth (level) of this node in the octree.
   * @returns {number}
   */
  getLevel() {
    return this.depth;
  }

  /**
   * Whether this node's point data is fully loaded.
   * @returns {boolean}
   */
  isLoaded() {
    return this.loaded;
  }

  /**
   * Always returns true — used for type discrimination against virtual nodes.
   * @returns {boolean}
   */
  isGeometryNode() {
    return true;
  }

  /**
   * Returns the axis-aligned bounding box.
   * @returns {THREE.Box3}
   */
  getBoundingBox() {
    return this.boundingBox;
  }

  /**
   * Returns the bounding sphere.
   * @returns {THREE.Sphere}
   */
  getBoundingSphere() {
    return this.boundingSphere;
  }

  /**
   * Registers a callback to be invoked when this node finishes loading.
   * @param {function(OctreeGeometryNode): void} callback
   */
  onLoad(callback) {
    this._loadCallbacks.push(callback);
  }

  /**
   * Registers a one-time dispose handler. The callback is invoked with the
   * node reference when {@link dispose} is called, then discarded.
   * @param {function(OctreeGeometryNode): void} callback
   */
  onDispose(callback) {
    this._oneTimeDisposeHandlers.push(callback);
  }

  /**
   * Triggers loading of this node's point data from octree.bin.
   * Delegates to the geometry's loader.
   *
   * @returns {Promise<OctreeGeometryNode>}
   */
  load() {
    return this.geometry.loader.loadNode(this);
  }

  /**
   * Triggers loading of this node's children from the hierarchy, if not
   * already loaded. Returns `null` if children already exist and are loaded
   * in memory.
   *
   * @returns {OctreeGeometryNode[]|null} The newly (or previously) loaded children.
   */
  loadChildren() {
    if (!this.children || this.children.length === 0) {
      return this.geometry.loader.loadChildren(this);
    }
    return null;
  }

  /**
   * Adds a child node to this node's children array and sets the
   * corresponding bit in `hasChildren`.
   *
   * @param {OctreeGeometryNode} child
   */
  addChild(child) {
    if (!this.children) this.children = [];
    this.children.push(child);
    this.hasChildren |= (1 << child.index);
  }

  /**
   * Finds and returns a child by its name (e.g. "r01").
   *
   * @param {string} name
   * @returns {OctreeGeometryNode|null}
   */
  getChild(name) {
    if (!this.children) return null;
    for (let i = 0; i < this.children.length; i++) {
      if (this.children[i].name === name) return this.children[i];
    }
    return null;
  }

  /**
   * Disposes of this node: fires one-time dispose handlers, clears
   * geometry data, and resets the loaded state. The node is not removed
   * from the tree — use {@link disposeDescendants} for that.
   */
  dispose() {
    for (const handler of this._oneTimeDisposeHandlers) {
      handler(this);
    }
    this._oneTimeDisposeHandlers.length = 0;
    this.geometryData = null;
    this.loaded = false;
    this._loadCallbacks.length = 0;
    this._disposed = true;
  }

  /**
   * Recursively disposes all descendant nodes and clears this node's
   * children collection.
   */
  disposeDescendants() {
    if (!this.children) return;
    for (const child of this.children) {
      child.disposeDescendants();
      child.dispose();
    }
    this.children = null;
    this.hasChildren = 0;
  }
}

/**
 * Global octree geometry container that holds metadata, the root node,
 * and a reference to the {@link NodeLoader} used to fetch and decode data.
 *
 * @class OctreeGeometry
 */
export class OctreeGeometry {
  constructor() {
    /** @type {OctreeGeometryNode|null} Root node ('r'). */
    this.root = null;
    /** @type {THREE.Box3} Global axis-aligned bounding box. */
    this.boundingBox = new THREE.Box3();
    /** @type {THREE.Box3} Global tight bounding box. */
    this.tightBoundingBox = new THREE.Box3();
    /** @type {number} Point spacing at root level. */
    this.spacing = 0;
    /** @type {number} Uniform scale factor applied to point positions. */
    this.scale = 1;
    /** @type {THREE.Vector3} Global offset added to point positions. */
    this.offset = new THREE.Vector3();
    /** @type {Object|null} EPSG / coordinate projection metadata. */
    this.projection = null;
    /** @type {number} Total number of nodes in the octree. */
    this.numNodes = 0;
    /** @type {number} Total point count across all nodes. */
    this.totalPoints = 0;
    /** @type {NodeLoader|null} Loader instance for fetching and decoding. */
    this.loader = null;
    /** @type {Object[]} Attribute descriptors from metadata. */
    this.attributes = [];
    /** @type {string} Base URL of the dataset. */
    this.url = '';
  }
}
