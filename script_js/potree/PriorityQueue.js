export class PriorityQueue {
  constructor() {
    this._heap = [];
    this._index = new Map();
  }

  push(node, weight) {
    const entry = { node, weight };
    this._heap.push(entry);
    const idx = this._heap.length - 1;
    this._index.set(node, idx);
    this._siftUp(idx);
  }

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

  peek() {
    return this._heap.length > 0 ? this._heap[0] : null;
  }

  size() {
    return this._heap.length;
  }

  isEmpty() {
    return this._heap.length === 0;
  }

  contains(node) {
    return this._index.has(node);
  }

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

  clear() {
    this._heap = [];
    this._index.clear();
  }

  _siftUp(idx) {
    const heap = this._heap;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[parent].weight >= heap[idx].weight) break;
      this._swap(parent, idx);
      idx = parent;
    }
  }

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

  _swap(i, j) {
    const heap = this._heap;
    const tmp = heap[i];
    heap[i] = heap[j];
    heap[j] = tmp;
    this._index.set(heap[i].node, i);
    this._index.set(heap[j].node, j);
  }
}
