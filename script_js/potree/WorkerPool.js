/**
 * @file WorkerPool.js
 * @description A simple LRU-like pool of Web Workers partitioned by URL.
 *   Workers are lazily created up to a configurable maximum. When all
 *   workers are busy, callers may queue requests via `requestWorker` and
 *   receive the next available worker asynchronously.
 */

/**
 * Manages a capped pool of Web Workers. Workers are grouped by their
 * script URL, allowing different worker scripts to share the same pool.
 * Provides a method to request a worker with a callback-based fallback
 * queue when the pool is saturated.
 *
 * @class WorkerPool
 */
export class WorkerPool {
  /**
   * @param {number} maxWorkers Maximum total workers across all URLs.
   *   Defaults to 2–8 depending on `navigator.hardwareConcurrency`.
   */
  constructor(maxWorkers) {
    /** @type {number} Hard cap on active workers. */
    this._maxWorkers = maxWorkers || (typeof navigator !== 'undefined'
      ? Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
      : 4);
    /** @type {Map<string, Worker[]>} Idle workers grouped by URL. */
    this._available = new Map();
    /** @type {Map<Worker, string>} Currently active workers mapped to their URL. */
    this._active = new Map();
    /** @type {Map<string, function[]>} Pending callbacks waiting for a worker. */
    this._pendingQueue = new Map();
  }

  /**
   * Synchronously returns an available (idle) worker for the given URL,
   * or creates a new one if under the max limit. Returns `null` when the
   * pool is full.
   *
   * @param {string} url Worker script URL.
   * @returns {Worker|null} A worker instance or null if none available.
   */
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

  /**
   * Requests a worker asynchronously. Invokes the callback immediately if
   * one is available; otherwise enqueues the callback to be delivered when
   * a worker is returned to the pool.
   *
   * @param {string} url Worker script URL.
   * @param {function(Worker): void} callback Called with the worker instance.
   */
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

  /**
   * Returns a worker to the idle pool so it can be reused, or passes it
   * directly to a pending requester.
   *
   * @param {Worker} worker The worker being returned.
   */
  returnWorker(worker) {
    const url = this._active.get(worker);
    if (!url) return;
    this._active.delete(worker);

    // If a requester is waiting, hand the worker directly to it
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

  /**
   * Terminates all workers (both active and idle) and clears the pool.
   */
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

  /**
   * Number of currently active (busy) workers.
   * @returns {number}
   */
  get activeCount() {
    return this._active.size;
  }

  /**
   * Number of idle workers available for immediate reuse.
   * @returns {number}
   */
  get availableCount() {
    let count = 0;
    for (const [, workers] of this._available) {
      count += workers.length;
    }
    return count;
  }
}
