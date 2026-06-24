import { collectVisibleLeaves, flattenTree, extractCamParams } from './Octree.js';
import { VisibilitySystem } from '../potree/VisibilitySystem.js';
import { LRUCache } from '../potree/LRUCache.js';

const MAX_BUDGET = 500000;
const MIN_BUDGET = 50000;

export class PointCloud {
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

    this._collectBuf = this.octreeGeometry ? null : new Uint32Array(MAX_BUDGET);
    this._leafRefs = [];
    this.renderer = null;
    this._needsRender = false;
  }

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
    this._pickGrid = null;
    this._pickOffsets = null;
    this._pickCounts = null;
    this._pickCells = 0;
    this.bounds = null;
    this.center = null;
    this.renderer = null;
  }

  set pointBudget(val) {
    this.visibilitySystem.pointBudget = val;
    this.visibilitySystem.invalidateCache();
    if (this.lru) this.lru.maxNumPoints = val * 2;
  }

  set maxVisibleDistance(val) {
    this.visibilitySystem.maxVisibleDistance = val;
    this.visibilitySystem.invalidateCache();
  }

  consumeNeedsRender() {
    const v = this._needsRender;
    this._needsRender = false;
    return v;
  }

  getDrawCall(camera, viewportW, viewportH) {
    if (this.octreeGeometry && this.octreeGeometry.root) {
      return this._getDrawCallPotree(camera, viewportW, viewportH);
    }
    if (!this.octree) return { indices: null, count: this.count };

    const total = this.count;
    const buf = this._collectBuf;

    if (total <= MAX_BUDGET) {
      const off = { current: 0 };
      flattenTree(this.octree, buf, off);
      return { indices: null, count: off.current };
    }

    const cp = extractCamParams(camera);
    this._leafRefs.length = 0;
    collectVisibleLeaves(this.octree, cp, viewportW, viewportH, this._leafRefs);

    let visCount = 0;
    const leaves = this._leafRefs;
    for (let li = 0; li < leaves.length; li++) visCount += leaves[li].length;

    if (visCount <= MAX_BUDGET) {
      let off = 0;
      for (let li = 0; li < leaves.length; li++) {
        buf.set(leaves[li], off);
        off += leaves[li].length;
      }
      return { indices: buf.subarray(0, off), count: off };
    }

    const target = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(visCount * 0.5)));
    const stride = Math.round(visCount / target);
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

  _getDrawCallPotree(camera, viewportW, viewportH) {
    const budget = Math.min(this.visibilitySystem.pointBudget, MAX_BUDGET);
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

    const loadedNodes = [];
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
        if (this.lru) this.lru.touch(n);
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

  pickNearest(camera, renderer, sx, sy, radiusPx = 12) {
    if (!this.count || !this._pickGrid) return -1;
    let bestIdx = -1, bestDist = radiusPx * radiusPx;
    const p = this.positions;
    const cells = this._pickCells;
    if (!this._pickOffsets) {
      for (let i = 0; i < this.count; i++) {
        const [px, py] = camera.project(p[i*3], p[i*3+1], p[i*3+2]);
        const dx = px - sx, dy = py - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
      }
      return bestIdx;
    }
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
