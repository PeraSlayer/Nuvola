export class WorkerPool {
  constructor(maxWorkers = 4) {
    this._maxWorkers = maxWorkers;
    this._available = new Map();
    this._active = new Map();
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

  returnWorker(worker) {
    const url = this._active.get(worker);
    if (!url) return;
    this._active.delete(worker);
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
