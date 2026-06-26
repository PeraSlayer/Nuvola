export class WorkerPool {
  constructor(maxWorkers) {
    this._maxWorkers = maxWorkers || (typeof navigator !== 'undefined'
      ? Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
      : 4);
    this._available = new Map();
    this._active = new Map();
    this._pendingQueue = new Map();
  }

  getWorker(url) {
    let available = this._available.get(url);
    if (!available) {
      available = [];
      this._available.set(url, available);
    }
    if (available.length > 0) {
      const worker = available.pop();
      this._active.set(worker, url);
      return worker;
    }
    if (this._active.size >= this._maxWorkers) {
      return null;
    }
    const worker = new Worker(url);
    this._active.set(worker, url);
    return worker;
  }

  requestWorker(url, callback) {
    const worker = this.getWorker(url);
    if (worker) {
      callback(worker);
      return;
    }
    let queue = this._pendingQueue.get(url);
    if (!queue) {
      queue = [];
      this._pendingQueue.set(url, queue);
    }
    queue.push(callback);
  }

  returnWorker(worker) {
    const url = this._active.get(worker);
    if (!url) return;
    this._active.delete(worker);

    let queue = this._pendingQueue.get(url);
    if (queue && queue.length > 0) {
      const nextCallback = queue.shift();
      this._active.set(worker, url);
      nextCallback(worker);
      return;
    }

    let available = this._available.get(url);
    if (!available) {
      available = [];
      this._available.set(url, available);
    }
    available.push(worker);
  }

  terminateAll() {
    for (const [worker] of this._active) {
      worker.terminate();
    }
    this._active.clear();
    for (const [, workers] of this._available) {
      for (const worker of workers) {
        worker.terminate();
      }
    }
    this._available.clear();
  }

  get activeCount() {
    return this._active.size;
  }

  get availableCount() {
    let count = 0;
    for (const [, workers] of this._available) {
      count += workers.length;
    }
    return count;
  }
}
