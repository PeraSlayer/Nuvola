/**
 * @file LRUCache.js
 * @description A doubly-linked-list implementation of an LRU (Least Recently
 *   Used) cache for octree nodes. Tracks point count and estimated GPU memory
 *   and auto-evicts least-recently-used entries when thresholds are exceeded.
 */

/**
 * Tracks octree nodes in LRU order. Nodes are "touched" when rendered and
 * "removed" when evicted. The cache monitors total point count and approximate
 * GPU bytes to stay within a user-configurable budget.
 *
 * @class LRUCache
 */
export class LRUCache {
  constructor() {
    /** @type {Object|null} Most recently used item (head of list). */
    this.first = null;
    /** @type {Object|null} Least recently used item (tail of list). */
    this.last = null;
    /** @type {Map<number, Object>} Maps node.id to linked-list item. */
    this.items = new Map();
    /** @type {number} Accumulated point count of all cached nodes. */
    this.numPoints = 0;
    /** @type {number} Estimated GPU memory usage in bytes. */
    this.gpuBytes = 0;
    /** @type {number} Soft cap on total cached points. */
    this.maxNumPoints = Infinity;
    /** @type {number} Soft cap on total GPU memory (default 512 MiB). */
    this.maxGPUBytes = 512 * 1024 * 1024;
    /** @type {number} Eviction threshold fraction (0-1). Eviction starts when
     *   gpuBytes exceeds this fraction of maxGPUBytes. */
    this._evictionThreshold = 0.9;
  }

  /**
   * Sets the GPU memory budget from a VRAM size in MiB.
   * Uses 60% of total VRAM as the usable budget.
   *
   * @param {number} vramMB Total VRAM in megabytes.
   */
  setGPUBudget(vramMB) {
    const usable = Math.floor(vramMB * 0.6);
    this.maxGPUBytes = usable * 1024 * 1024;
  }

  /**
   * Records that a node has been accessed. Updates its position to
   * most-recently-used. If the node is not yet cached, it is added.
   *
   * @param {OctreeGeometryNode} node
   */
  touch(node) {
    const existing = this.items.get(node.id);
    if (existing) {
      this._moveToEnd(existing);
    } else {
      const item = { node, prev: null, next: null };
      this.items.set(node.id, item);
      this._append(item);
    }
  }

  /**
   * Removes a node from the cache (but does NOT dispose of it).
   *
   * @param {OctreeGeometryNode} node
   * @returns {boolean} True if the node was in the cache.
   */
  remove(node) {
    const item = this.items.get(node.id);
    if (!item) return false;
    this._unlink(item);
    this.items.delete(node.id);
    this.numPoints -= node.numPoints || 0;
    this.gpuBytes -= node._gpuBytes || 0;
    if (this.gpuBytes < 0) this.gpuBytes = 0;
    return true;
  }

  /**
   * Returns the least-recently-used list item (without removing it).
   * @returns {Object|null} `{ node, prev, next }` or null.
   */
  getLRUItem() {
    return this.first;
  }

  /**
   * Updates the accumulated GPU byte counter when a node's GPU footprint
   * changes after initial caching.
   *
   * @param {OctreeGeometryNode} node
   */
  updateGPUUsage(node) {
    const item = this.items.get(node.id);
    if (!item) return;
    const oldBytes = item.node._gpuBytes || 0;
    const newBytes = node._gpuBytes || 0;
    this.gpuBytes += newBytes - oldBytes;
  }

  /**
   * Evicts nodes from the head (least-recently-used) until the point count
   * and GPU byte budget are within threshold. Each evicted node is disposed.
   */
  freeMemory() {
    const threshold = this.maxGPUBytes * this._evictionThreshold;
    while (this.first && (this.numPoints > this.maxNumPoints || this.gpuBytes > threshold)) {
      const item = this.first;
      this.remove(item.node);
      item.node.dispose();
    }
  }

  /**
   * Disposes all cached nodes and clears the cache.
   */
  disposeAll() {
    let current = this.first;
    while (current) {
      const next = current.next;
      current.node.dispose();
      current = next;
    }
    this.first = null;
    this.last = null;
    this.items.clear();
    this.numPoints = 0;
    this.gpuBytes = 0;
  }

  /**
   * Returns the current GPU usage as a formatted string in MiB.
   * @returns {string} e.g. "245.3"
   */
  getGPUUsageMB() {
    return (this.gpuBytes / (1024 * 1024)).toFixed(1);
  }

  /**
   * Appends a new item to the end (most-recently-used) of the list and
   * adds its point/byte contribution to the cache totals.
   *
   * @private
   * @param {Object} item Linked-list item `{ node, prev, next }`.
   */
  _append(item) {
    if (!this.first) {
      this.first = item;
      this.last = item;
      item.prev = null;
      item.next = null;
    } else {
      this.last.next = item;
      item.prev = this.last;
      item.next = null;
      this.last = item;
    }
    this.numPoints += item.node.numPoints || 0;
    this.gpuBytes += item.node._gpuBytes || 0;
  }

  /**
   * Removes an item from the doubly-linked list (keeping the Map in sync).
   *
   * @private
   * @param {Object} item `{ node, prev, next }`.
   */
  _unlink(item) {
    if (item.prev) item.prev.next = item.next;
    else this.first = item.next;
    if (item.next) item.next.prev = item.prev;
    else this.last = item.prev;
  }

  /**
   * Moves an existing item to the end of the list (most-recently-used).
   *
   * @private
   * @param {Object} item `{ node, prev, next }`.
   */
  _moveToEnd(item) {
    if (item === this.last) return;
    if (item.prev) item.prev.next = item.next;
    else this.first = item.next;
    if (item.next) item.next.prev = item.prev;
    else this.last = item.prev;
    item.prev = this.last;
    item.next = null;
    if (this.last) this.last.next = item;
    this.last = item;
    if (!this.first) this.first = item;
  }
}
