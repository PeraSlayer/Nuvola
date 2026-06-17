/*
===============================================================================
File: PointCloud.js

Questo modulo definisce la struttura dati principale per una nuvola di punti
tradizionale. PointCloud conserva posizioni, colori, intensita, numero di punti,
bounding box, centro e metadati utili alla visualizzazione.

Quando i dati non arrivano gia preparati da un worker, la classe calcola bounds,
range di altezza/intensita, livelli LOD, suddivisione in tile e griglia uniforme
per il picking. Queste strutture permettono al renderer di scegliere quanti
punti disegnare, all'interfaccia di mostrare statistiche e agli strumenti di
interazione di trovare il punto piu vicino a un click.

E il modello condiviso tra loader, camera, renderer, minimappa e strumenti di
misura.
===============================================================================
*/

// =============================================================================
// PointCloud
//
// Owns the parsed point buffer and precomputes:
//   - bounds & intensity range
//   - LOD pyramid (max-z grid decimation, 8 levels)
//   - 4×4 tile pyramid (for streaming/atlas use)
//   - 128×128 uniform grid for screen-space picking
// ============================================================================

/** Owns parsed point buffers, LOD pyramid, tile pyramid, and pick grid. */
export class PointCloud {
  /**
   * @param {{
   *   count: number,
   *   positions: Float32Array,
   *   colors: Uint8Array,
   *   intensity?: Float32Array|null,
   *   hasColor: boolean,
   *   hasIntensity: boolean,
   *   bounds?: { min: number[], max: number[] },
   *   center?: number[],
   *   zMin?: number,
   *   zMax?: number,
   *   intensityMin?: number,
   *   intensityMax?: number,
   *   lodLevels?: { indices: Uint32Array|null, count: number }[],
   *   tilePyramid?: object|null,
   *   pickGrid?: number[][],
   *   pickCells?: number,
   * }} data
   */
  constructor(data) {
    this.count       = data.count;
    this.positions   = data.positions;
    this.colors      = data.colors;
    this.intensity   = data.intensity;
    this.hasColor    = data.hasColor;
    this.hasIntensity = data.hasIntensity;

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

    if (data.lodLevels) {
      this.lodLevels = data.lodLevels;
    } else {
      this.lodLevels = [];
      this.lodLevels.push({ indices: null, count: this.count });
    }

    this.tilePyramid = data.tilePyramid || null;

    if (data.pickGrid) {
      this._pickGrid = data.pickGrid;
      this._pickCells = data.pickCells || 128;
    }

    this._buildToken = 0;

    if (!data.lodLevels) {
      this._buildHandle = setTimeout(() => {
        this._buildLODLevelsAsync().catch(e => console.error('LOD build failed:', e));
        if (this.count <= 10_000_000) {
          this._buildTilePyramid();
          this._buildPickGrid();
        } else {
          console.log(`[PointCloud] Skipping tile pyramid & pick grid for ${this.count.toLocaleString()} points`);
        }
      }, 100);
    }
  }

  /** Cancel any in-progress async LOD building. */
  cancelAsyncBuild() {
    this._buildToken++;
    if (this._buildHandle) {
      clearTimeout(this._buildHandle);
      this._buildHandle = null;
    }
  }

  /** Release all CPU-side memory immediately. */
  dispose() {
    this.cancelAsyncBuild();
    this.positions = null;
    this.colors = null;
    this.intensity = null;
    if (this.lodLevels) {
      for (const lod of this.lodLevels) lod.indices = null;
      this.lodLevels = null;
    }
    if (this.tilePyramid) {
      for (const tile of this.tilePyramid.tiles) tile.indices = null;
      this.tilePyramid = null;
    }
    this._pickGrid = null;
    this._pickCells = 0;
    this.bounds = null;
    this.center = null;
  }
  

  // ---------------------------------------------------------------------------
  // Bounds + intensity range
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // LOD pyramid — level 0 = full resolution, each subsequent level is a
  // max-Z grid decimation that keeps only the highest point per cell.
  // IMPROVED: More levels (16 instead of 8) with conservative step-up (1.4x
  // instead of 2x) for better detail preservation at intermediate zoom levels.
  // ---------------------------------------------------------------------------
  async _buildLODLevelsAsync() {
    const token = this._buildToken;
    if (!this.positions || !this.bounds) return;
    const maxLevels = 24;
    let prevCount = this.count;
    const spanX = this.bounds.max[0] - this.bounds.min[0] || 1;
    const spanY = this.bounds.max[1] - this.bounds.min[1] || 1;
    const baseSpan = Math.max(spanX, spanY);

    for (let lvl = 1; lvl < maxLevels; lvl++) {
      if (this._buildToken !== token || !this.positions) return;

      const cellSize = Math.pow(1.3, lvl) * baseSpan / 1024;

      if (cellSize <= 0 || prevCount < 1000) break;

      const grid = new Map();
      const p = this.positions;
      const inv = 1 / cellSize;

      const stride = prevCount > 10_000_000 ? 10 : 1;
      const loopLimit = this.count;

      for (let i = 0; i < loopLimit; i += stride) {
        if (!this.positions) return;
        const gx = ((p[i*3]   - this.bounds.min[0]) * inv) | 0;
        const gy = ((p[i*3+1] - this.bounds.min[1]) * inv) | 0;
        const key = (gx << 16) ^ gy;
        const existing = grid.get(key);
        if (existing === undefined || p[i*3+2] > p[existing*3+2]) {
          grid.set(key, i);
        }

        if (i > 0 && i % 500000 === 0) {
          if (this._buildToken !== token || !this.positions) return;
          await new Promise(r => setTimeout(r, 0));
        }
      }

      const indices = new Uint32Array(grid.size);
      let k = 0;
      for (const idx of grid.values()) indices[k++] = idx;

      if (indices.length >= prevCount * 0.9) break;

      this.lodLevels.push({ indices, count: indices.length });
      prevCount = indices.length;
    }
  }

  // ---------------------------------------------------------------------------
  // Tile pyramid — uniform 4×4 split for spatial streaming / atlas
  // ---------------------------------------------------------------------------
  _buildTilePyramid() {
    const tilesX = 4, tilesY = 4;
    const spanX = this.bounds.max[0] - this.bounds.min[0] || 1;
    const spanY = this.bounds.max[1] - this.bounds.min[1] || 1;
    const tiles = [];
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const tMinX = this.bounds.min[0] + (tx/tilesX)*spanX;
        const tMaxX = this.bounds.min[0] + ((tx+1)/tilesX)*spanX;
        const tMinY = this.bounds.min[1] + (ty/tilesY)*spanY;
        const tMaxY = this.bounds.min[1] + ((ty+1)/tilesY)*spanY;
        const indices = [];
        const p = this.positions;
        for (let i = 0; i < this.count; i++) {
          const x = p[i*3], y = p[i*3+1];
          if (x >= tMinX && x < tMaxX && y >= tMinY && y < tMaxY) indices.push(i);
        }
        tiles.push({
          tx, ty,
          bounds: { min: [tMinX, tMinY, this.bounds.min[2]], max: [tMaxX, tMaxY, this.bounds.max[2]] },
          indices: new Uint32Array(indices),
          count: indices.length,
        });
      }
    }
    this.tilePyramid = { tilesX, tilesY, tiles };
  }

  // ---------------------------------------------------------------------------
  // Pick grid — uniform 128×128 buckets for screen-space picking
  // ---------------------------------------------------------------------------
  _buildPickGrid() {
    const cells = 128;
    this._pickCells = cells;
    this._pickGrid = new Array(cells * cells);
    for (let i = 0; i < cells*cells; i++) this._pickGrid[i] = [];
    const p = this.positions;
    const spanX = this.bounds.max[0] - this.bounds.min[0] || 1;
    const spanY = this.bounds.max[1] - this.bounds.min[1] || 1;
    for (let i = 0; i < this.count; i++) {
      const gx = Math.min(cells-1, Math.floor(((p[i*3]   - this.bounds.min[0]) / spanX) * cells));
      const gy = Math.min(cells-1, Math.floor(((p[i*3+1] - this.bounds.min[1]) / spanY) * cells));
      this._pickGrid[gy*cells+gx].push(i);
    }
  }

  // ---------------------------------------------------------------------------
  // LOD selection — uses a normalised zoom ratio so that fit-view (ratio ≈ 1)
  // targets ~500k points. As the user zooms in the target rises linearly up to
  // the full model count; as they zoom out the target drops to a lower bound.
  // The range‑based XY filter below is retained as an optional extra pass but
  // is explicitly documented as a distance filter, not a viewport LOD.
  // ---------------------------------------------------------------------------
  /** Select the appropriate LOD level and optionally apply range-based decimation.
   * @param {number} zoomRatio  camera.zoom / camera._defaultZoom  (≈1 at fit view)
   */
  selectLOD(zoomRatio, options = {}) {
    const MAX_VISIBLE = 5_000_000;

    // Progressive LOD:
    //   - Distant (zoomRatio < 1): higher LOD levels → approximative, full spread
    //   - Close   (zoomRatio >= 1): level 0 → full detail
    let desiredCount;
    if (zoomRatio >= 1) {
      desiredCount = this.count;
    } else {
      desiredCount = Math.round(MAX_VISIBLE * Math.max(0.15, zoomRatio));
    }
    desiredCount = Math.min(this.count, desiredCount);

    let level = 0;
    let bestDiff = Math.abs(Math.min(this.count, MAX_VISIBLE) - desiredCount);
    for (let i = 0; i < this.lodLevels.length; i++) {
      const diff = Math.abs(this.lodLevels[i].count - desiredCount);
      if (diff < bestDiff) {
        bestDiff = diff;
        level = i;
      }
    }

    const lod = this.lodLevels[level];
    const count = Math.min(lod.count, MAX_VISIBLE, desiredCount);

    if (!lod.indices) {
      return { indices: null, count, level };
    }
    return { indices: lod.indices, count, level };
  }

  // ---------------------------------------------------------------------------
  // Pick nearest point in world XY from a screen click
  // ---------------------------------------------------------------------------
  /** Find the nearest point to a screen-space click. */
  pickNearest(camera, renderer, sx, sy, radiusPx = 12) {
    if (!this.count || !this._pickGrid) return -1;
    let bestIdx = -1, bestDist = radiusPx * radiusPx;
    const p = this.positions;
    const zoomRatio = camera.zoom / (camera._defaultZoom || 1);
    const lod = this.selectLOD(zoomRatio);
    const indices = lod.indices;
    const n = lod.count;
    const visit = (i) => {
      const [px, py] = camera.project(p[i*3], p[i*3+1], p[i*3+2]);
      const dx = px - sx, dy = py - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
    };
    if (indices) { for (let j = 0; j < n; j++) visit(indices[j]); }
    else         { for (let i = 0; i < n; i++) visit(i); }
    return bestIdx;
  }

  /** Approximate GPU memory usage in bytes (attributes + LOD index buffers). */
  getGPUByteSize() {
    let total = this.count * (12 + 3 + (this.intensity ? 4 : 0));
    for (const lod of this.lodLevels) {
      if (lod.indices) total += lod.indices.byteLength;
    }
    return total;
  }
}
