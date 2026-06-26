export class LRUCache {
  constructor() {
    this.first = null;
    this.last = null;
    this.items = new Map();
    this.numPoints = 0;
    this.gpuBytes = 0;
    this.maxNumPoints = Infinity;
    this.maxGPUBytes = 512 * 1024 * 1024;
    this._evictionThreshold = 0.9;
  }

  setGPUBudget(vramMB) {
    const usable = Math.floor(vramMB * 0.6);
    this.maxGPUBytes = usable * 1024 * 1024;
  }

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

  getLRUItem() {
    return this.first;
  }

  updateGPUUsage(node) {
    const item = this.items.get(node.id);
    if (!item) return;
    const oldBytes = item.node._gpuBytes || 0;
    const newBytes = node._gpuBytes || 0;
    this.gpuBytes += newBytes - oldBytes;
  }

  freeMemory() {
    const threshold = this.maxGPUBytes * this._evictionThreshold;
    while (this.first && (this.numPoints > this.maxNumPoints || this.gpuBytes > threshold)) {
      const item = this.first;
      this.remove(item.node);
      item.node.dispose();
    }
  }

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

  getGPUUsageMB() {
    return (this.gpuBytes / (1024 * 1024)).toFixed(1);
  }

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

  _unlink(item) {
    if (item.prev) item.prev.next = item.next;
    else this.first = item.next;
    if (item.next) item.next.prev = item.prev;
    else this.last = item.prev;
  }

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
