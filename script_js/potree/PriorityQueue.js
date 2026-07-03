/**
 * @file PriorityQueue.js
 * @description A max-heap priority queue with O(log n) push/pop/remove
 *   and a secondary {@link Map} index for fast O(1) `contains` and
 *   arbitrary-element removal. Used by {@link VisibilitySystem} to order
 *   octree nodes by projected screen size.
 */

/**
 * Binary max-heap indexed by a `node` key for O(1) lookups.
 * Each entry is `{ node, weight }` where a higher weight means higher priority.
 *
 * @class PriorityQueue
 */
export class PriorityQueue {
  constructor() {
    /** @type {{node: *, weight: number}[]} Internal heap array. */
    this._heap = [];
    /** @type {Map<*, number>} Maps a node to its current index in `_heap`. */
    this._index = new Map();
  }

  /**
   * Inserts a node with the given priority weight.
   * @param {*} node The element to insert (by reference).
   * @param {number} weight Priority value (higher = higher priority).
   */
  push(node, weight) {
    const entry = { node, weight };
    this._heap.push(entry);
    const idx = this._heap.length - 1;
    this._index.set(node, idx);
    this._siftUp(idx);
  }

  /**
   * Removes and returns the entry with the highest weight.
   * @returns {{node: *, weight: number}|null} The top entry, or null if empty.
   */
  pop() {
    if (this._heap.length === 0) return null;
    const top = this._heap[0];
    const bottom = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = bottom;
      this._index.set(bottom.node, 0);
      const idx = this._index.get(top.node);
      if (idx !== undefined) this._index.delete(top.node);
      this._siftDown(0);
    } else {
      this._index.delete(top.node);
    }
    return top;
  }

  /**
   * Returns the entry with the highest weight without removing it.
   * @returns {{node: *, weight: number}|null}
   */
  peek() {
    return this._heap.length > 0 ? this._heap[0] : null;
  }

  /**
   * Number of entries in the queue.
   * @returns {number}
   */
  size() {
    return this._heap.length;
  }

  /**
   * Whether the queue is empty.
   * @returns {boolean}
   */
  isEmpty() {
    return this._heap.length === 0;
  }

  /**
   * Checks if a given node reference exists in the queue.
   * @param {*} node
   * @returns {boolean}
   */
  contains(node) {
    return this._index.has(node);
  }

  /**
   * Removes a specific node from the queue, regardless of its weight.
   * Splices by swapping in the last element and re-heapifying.
   *
   * @param {*} node
   * @returns {boolean} True if the node was found and removed.
   */
  remove(node) {
    const idx = this._index.get(node);
    if (idx === undefined) return false;
    this._index.delete(node);
    if (idx === this._heap.length - 1) {
      this._heap.pop();
      return true;
    }
    const last = this._heap.pop();
    this._heap[idx] = last;
    this._index.set(last.node, idx);
    this._siftDown(idx);
    this._siftUp(idx);
    return true;
  }

  /**
   * Empties the queue entirely.
   */
  clear() {
    this._heap = [];
    this._index.clear();
  }

  /**
   * Sifts an element upward to restore max-heap order.
   * @private
   * @param {number} idx Index of the element to sift.
   */
  _siftUp(idx) {
    const heap = this._heap;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[parent].weight >= heap[idx].weight) break;
      this._swap(parent, idx);
      idx = parent;
    }
  }

  /**
   * Sifts an element downward to restore max-heap order.
   * @private
   * @param {number} idx Index of the element to sift.
   */
  _siftDown(idx) {
    const heap = this._heap;
    const size = heap.length;
    while (true) {
      let largest = idx;
      const left = (idx << 1) + 1;
      const right = left + 1;
      if (left < size && heap[left].weight > heap[largest].weight) largest = left;
      if (right < size && heap[right].weight > heap[largest].weight) largest = right;
      if (largest === idx) break;
      this._swap(idx, largest);
      idx = largest;
    }
  }

  /**
   * Swaps two entries in the heap and updates their index map.
   * @private
   * @param {number} i First index.
   * @param {number} j Second index.
   */
  _swap(i, j) {
    const heap = this._heap;
    const tmp = heap[i];
    heap[i] = heap[j];
    heap[j] = tmp;
    this._index.set(heap[i].node, i);
    this._index.set(heap[j].node, j);
  }
}
