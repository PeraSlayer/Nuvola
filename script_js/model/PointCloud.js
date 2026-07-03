/**
 * @file PointCloud.js
 * @description Core PointCloud class for Nuvola's 2.5D point cloud viewer.
 *              Manages point data (positions, colors, intensity), bounding-box
 *              computation, octree-based level-of-detail selection, Potree-style
 *              deferred node loading with an LRU cache, and screen-space picking.
 *              Acts as the bridge between raw point data and the WebGL2 renderer.
 */

import { collectVisibleLeaves, extractCamParams } from './Octree.js';
import { VisibilitySystem } from '../potree/VisibilitySystem.js';
import { LRUCache } from '../potree/LRUCache.js';

/**
 * Initial capacity (in index entries) of the internal buffer used during
 * visibility collection. Grows dynamically up to COLLECT_BUF_MAX.
 */
const COLLECT_BUF_INITIAL = 2_000_000;

/**
 * Upper bound (in index entries) for the visibility-collection buffer.
 * Prevents unbounded memory growth on massive point clouds.
 */
const COLLECT_BUF_MAX = 100_000_000;

export class PointCloud {
  /**
   * @param {Object} data - Point-cloud descriptor.
   * @param {number} data.count - Number of points.
   * @param {Float32Array} data.positions - Interleaved xyz positions (length = count*3).
   * @param {Uint8Array} [data.colors] - RGB bytes (length = count*3).
   * @param {Float32Array} [data.intensity] - Intensity values (length = count).
   * @param {boolean} [data.hasColor]
   * @param {boolean} [data.hasIntensity]
   * @param {boolean} [data.hasClassification]
   * @param {Object} [data.bounds] - Pre-computed bounding box {min:[3],max:[3]}.
   * @param {Object} [data.octree] - Custom (non-Potree) octree root node.
   * @param {Object} [data.octreeGeometry] - Potree octree geometry descriptor.
   * @param {Uint32Array} [data.pickGrid] - Pre-indexed grid for GPU-free picking.
   * @param {Uint32Array} [data.pickOffsets]
   * @param {Uint32Array} [data.pickCounts]
   * @param {number} [data.pickCells=128]
   */
  constructor(data) {
    this.count       = data.count;
    this.positions   = data.positions;
    this.colors      = data.colors;
    this.intensity   = data.intensity;
    this.hasColor    = data.hasColor;
    this.hasIntensity = data.hasIntensity;
    this.hasClassification = data.hasClassification || false;

    if (data.bounds) {
      this.bounds = data.bounds;
      this.zMin = data.zMin;
      this.zMax = data.zMax;
      this.center = data.center;
      this.intensityMin = data.intensityMin;
      this.intensityMax = data.intensityMax;
      if (this.intensity && this.intensityMax === this.intensityMin) this.intensityMax += 1;
    } else {
      this.bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
      this._computeBounds();
      this.zMin = this.bounds.min[2];
      this.zMax = this.bounds.max[2];
      if (this.intensity) {
        if (this.intensityMax === this.intensityMin) this.intensityMax += 1;
      } else {
        this.intensityMin = 0;
        this.intensityMax = 1;
      }
      this.center = [
        (this.bounds.min[0] + this.bounds.max[0]) * 0.5,
        (this.bounds.min[1] + this.bounds.max[1]) * 0.5,
        (this.bounds.min[2] + this.bounds.max[2]) * 0.5,
      ];
    }

    this.octree = data.octree || null;
    this.octreeGeometry = data.octreeGeometry || null;
    this.visibilitySystem = new VisibilitySystem();
    this.lru = new LRUCache();

    if (data.pickGrid) {
      this._pickGrid = data.pickGrid;
      this._pickOffsets = data.pickOffsets || null;
      this._pickCounts = data.pickCounts || null;
      this._pickCells = data.pickCells || 128;
    }

    /**
     * Scratch buffer for assembling visible-index arrays during draw-call
     * generation. Null when using Potree (octreeGeometry) path.
     */
    this._collectBuf = this.octreeGeometry ? null : new Uint32Array(COLLECT_BUF_INITIAL);
    this._collectBufCapacity = COLLECT_BUF_INITIAL;
    this._leafRefs = [];
    this._loadedNodes = [];
    this.renderer = null;
    this._needsRender = false;
  }

  /**
   * Releases all GPU and CPU resources held by this point cloud.
   */
  dispose() {
    if (this.lru) this.lru.disposeAll();
    this.positions = null;
    this.colors = null;
    this.intensity = null;
    this.octree = null;
    this.octreeGeometry = null;
    this.visibilitySystem = null;
    this.lru = null;
    this._collectBuf = null;
    this._leafRefs = null;
    this._loadedNodes = null;
    this._pickGrid = null;
    this._pickOffsets = null;
    this._pickCounts = null;
    this._pickCells = 0;
    this.bounds = null;
    this.center = null;
    this.renderer = null;
  }

  /**
   * Sets the maximum number of points to render per frame.
   * Also updates the LRU cache capacity accordingly.
   * @param {number} val
   */
  set pointBudget(val) {
    this.visibilitySystem.pointBudget = val;
    this.visibilitySystem.invalidateCache();
    if (this.lru) this.lru.maxNumPoints = val * 2;
  }

  /**
   * Sets the maximum visible distance beyond which nodes are culled.
   * @param {number} val
   */
  set maxVisibleDistance(val) {
    this.visibilitySystem.maxVisibleDistance = val;
    this.visibilitySystem.invalidateCache();
  }

  /**
   * Returns whether the renderer should re-draw and resets the flag.
   * @returns {boolean}
   */
  consumeNeedsRender() {
    const v = this._needsRender;
    this._needsRender = false;
    return v;
  }

  /**
   * Produces a draw-call descriptor for the given camera and viewport.
   * Delegates to {@link _getDrawCallPotree} when an octreeGeometry is present,
   * otherwise traverses the custom octree directly.
   *
   * @param {Camera} camera
   * @param {number} viewportW - Viewport width in pixels.
   * @param {number} viewportH - Viewport height in pixels.
   * @returns {{indices: Uint32Array|null, count: number, nodes?: Array, profiling?: Object}}
   */
  getDrawCall(camera, viewportW, viewportH) {
    if (this.octreeGeometry && this.octreeGeometry.root) {
      return this._getDrawCallPotree(camera, viewportW, viewportH);
    }
    if (!this.octree) return { indices: null, count: this.count };

    const total = this.count;
    const budget = this.visibilitySystem ? this.visibilitySystem.pointBudget : total;

    // If all points fit within the budget, render everything.
    if (total <= budget) {
      return { indices: null, count: this.count };
    }

    const cp = extractCamParams(camera);
    this._leafRefs.length = 0;
    collectVisibleLeaves(this.octree, cp, viewportW, viewportH, this._leafRefs);

    let visCount = 0;
    const leaves = this._leafRefs;
    for (let li = 0; li < leaves.length; li++) visCount += leaves[li].length;

    const target = Math.min(budget, visCount);

    // Grow the collection buffer if the target count exceeds capacity.
    if (target >= this._collectBufCapacity) {
      const newCap = Math.min(COLLECT_BUF_MAX, Math.max(this._collectBufCapacity * 2, target + 100000));
      this._collectBuf = new Uint32Array(newCap);
      this._collectBufCapacity = newCap;
    }
    const buf = this._collectBuf;

    // All visible leaves fit within the budget — copy them straight.
    if (visCount <= budget) {
      let off = 0;
      for (let li = 0; li < leaves.length; li++) {
        buf.set(leaves[li], off);
        off += leaves[li].length;
      }
      return { indices: buf.subarray(0, off), count: off };
    }

    // Sub-sample visible leaves via strided selection to hit the budget.
    const stride = Math.max(1, Math.round(visCount / target));
    let outIdx = 0, globalPos = 0;
    for (let li = 0; li < leaves.length && outIdx < target; li++) {
      const leaf = leaves[li];
      for (let j = 0; j < leaf.length && outIdx < target; j++) {
        if (globalPos++ % stride === 0) {
          buf[outIdx++] = leaf[j];
        }
      }
    }
    return { indices: buf.subarray(0, outIdx), count: outIdx };
  }

  /**
   * Potree-specific draw-call generation using the {@link VisibilitySystem}.
   * Schedules loading of newly visible nodes and touches all visible nodes
   * in the LRU cache to keep them resident.
   *
   * @param {Camera} camera
   * @param {number} viewportW
   * @param {number} viewportH
   * @returns {{nodes: Array, count: number, indices: null, profiling: {selectNodesMs: number}}}
   */
  _getDrawCallPotree(camera, viewportW, viewportH) {
    const budget = this.visibilitySystem.pointBudget;
    const t0 = performance.now();
    const result = this.visibilitySystem.selectNodes(
      camera, this.octreeGeometry, viewportW, viewportH, budget
    );
    const selectMs = performance.now() - t0;

    this._scheduleNodeLoads(result.unloadedNodes);

    if (this.lru) {
      for (let i = 0; i < result.visibleNodes.length; i++) {
        const node = result.visibleNodes[i];
        if (node.loaded && !node._disposed) this.lru.touch(node);
      }
    }

    const loadedNodes = this._loadedNodes;
    loadedNodes.length = 0;
    for (let i = 0; i < result.visibleNodes.length; i++) {
      const node = result.visibleNodes[i];
      if (node._batchOffset != null && node.loaded) {
        loadedNodes.push(node);
      }
    }

    let total = 0;
    for (let i = 0; i < loadedNodes.length; i++) total += loadedNodes[i].numPoints;

    return { nodes: loadedNodes, count: total, indices: null, profiling: { selectNodesMs: selectMs } };
  }

  /**
   * Initiates asynchronous loading for up to {@link VisibilitySystem.maxNodesLoadingPerFrame}
   * nodes. Each node, once loaded, triggers a renderer upload and invalidates
   * the visibility cache.
   *
   * @param {Array} unloadedNodes - Nodes queued for loading by the visibility system.
   */
  _scheduleNodeLoads(unloadedNodes) {
    if (!this.renderer || !unloadedNodes || unloadedNodes.length === 0) return;
    const remaining = this.visibilitySystem.maxNodesLoadingPerFrame - this.visibilitySystem.numNodesLoading;
    if (remaining <= 0) return;

    const toLoad = Math.min(remaining, unloadedNodes.length);
    for (let i = 0; i < toLoad; i++) {
      const node = unloadedNodes[i];
      if (node.loaded || node.loading) continue;

      node.onLoad((n) => {
        if (this.renderer) this.renderer.uploadNode(n);
        if (this.lru) {
          this.lru.touch(n);
          this.lru.updateGPUUsage(n);
        }
        if (this.visibilitySystem) this.visibilitySystem.invalidateCache();
        this._needsRender = true;
      });

      this.visibilitySystem.incrementNodeLoading();
      node.load().then(() => {
        this.visibilitySystem.decrementNodeLoading();
      }).catch((error) => {
        this.visibilitySystem.decrementNodeLoading();
        console.warn(`PointCloud: failed to load node ${node.name}:`, error.message);
      });
    }
  }

  /**
   * Scans all point positions to compute the bounding box and intensity range.
   * Only called when the point cloud is constructed without pre-computed bounds.
   */
  _computeBounds() {
    const p = this.positions;
    const inten = this.intensity;
    let iMin = Infinity, iMax = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = p[i*3], y = p[i*3+1], z = p[i*3+2];
      if (x < this.bounds.min[0]) this.bounds.min[0] = x;
      if (y < this.bounds.min[1]) this.bounds.min[1] = y;
      if (z < this.bounds.min[2]) this.bounds.min[2] = z;
      if (x > this.bounds.max[0]) this.bounds.max[0] = x;
      if (y > this.bounds.max[1]) this.bounds.max[1] = y;
      if (z > this.bounds.max[2]) this.bounds.max[2] = z;
      if (inten) {
        const v = inten[i];
        if (v < iMin) iMin = v;
        if (v > iMax) iMax = v;
      }
    }
    if (inten) {
      this.intensityMin = iMin;
      this.intensityMax = iMax;
    }
  }

  /**
   * Finds the index of the point nearest to a screen-space coordinate (sx, sy)
   * within an optional radius. Uses a pre-built spatial grid when available,
   * falling back to a brute-force linear scan.
   *
   * @param {Camera} camera
   * @param {Object} renderer
   * @param {number} sx - Screen-space X coordinate.
   * @param {number} sy - Screen-space Y coordinate.
   * @param {number} [radiusPx=12] - Search radius in pixels.
   * @returns {number} Index of the nearest point, or -1 if none found.
   */
  pickNearest(camera, renderer, sx, sy, radiusPx = 12) {
    if (!this.count || !this._pickGrid) return -1;
    let bestIdx = -1, bestDist = radiusPx * radiusPx;
    const p = this.positions;
    const cells = this._pickCells;
    // Brute-force fallback when no spatial index (_pickOffsets) is available.
    if (!this._pickOffsets) {
      for (let i = 0; i < this.count; i++) {
        const [px, py] = camera.project(p[i*3], p[i*3+1], p[i*3+2]);
        const dx = px - sx, dy = py - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
      }
      return bestIdx;
    }
    // Grid-based search: compute cell extents and only check cells near (sx, sy).
    const spanX = this.bounds.max[0] - this.bounds.min[0] || 1;
    const spanY = this.bounds.max[1] - this.bounds.min[1] || 1;
    const cz = this.center[2];
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const ci = cy * cells + cx;
        const start = this._pickOffsets[ci];
        const end = this._pickOffsets[ci + 1];
        if (start >= end) continue;
        const ccx = this.bounds.min[0] + ((cx + 0.5) / cells) * spanX;
        const ccy = this.bounds.min[1] + ((cy + 0.5) / cells) * spanY;
        const [scx, scy] = camera.project(ccx, ccy, cz);
        if (Math.abs(scx - sx) > radiusPx * 3 || Math.abs(scy - sy) > radiusPx * 3) continue;
        for (let j = start; j < end; j++) {
          const i = this._pickGrid[j];
          const [px, py] = camera.project(p[i*3], p[i*3+1], p[i*3+2]);
          const dx = px - sx, dy = py - sy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
        }
      }
    }
    return bestIdx;
  }

  /**
   * Estimates the GPU memory footprint (in bytes) for this point cloud,
   * including positions, colors, intensity, and all octree index buffers.
   *
   * @returns {number} Approximate byte size on the GPU.
   */
  getGPUByteSize() {
    if (!this.octree) return this.count * (12 + 3 + (this.intensity ? 4 : 0));
    let total = this.count * (12 + 3 + (this.intensity ? 4 : 0));
    function countBufs(node) {
      if (node.indices) total += node.indices.byteLength;
      if (node.children) for (let i = 0; i < node.children.length; i++) countBufs(node.children[i]);
    }
    countBufs(this.octree);
    return total;
  }
}
