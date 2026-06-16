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
   *   hasColor: boolean,
   *   hasIntensity: boolean,
   *   bounds?: { min: number[], max: number[] },
   *   center?: number[],
   *   zMin?: number,
   *   zMax?: number,
   *   intensityMin?: number,
   *   intensityMax?: number,
   *   tileManager?: TileManager,
   * }} data
   */
  constructor(data) {
    this.count       = data.count;
    this.hasColor    = data.hasColor;
    this.hasIntensity = data.hasIntensity;

    if (data.bounds) {
      this.bounds = data.bounds;
      this.zMin = data.zMin;
      this.zMax = data.zMax;
      this.center = data.center;
      this.intensityMin = data.intensityMin;
      this.intensityMax = data.intensityMax;
    } else {
      this.bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
      this.zMin = 0;
      this.zMax = 1;
      this.intensityMin = 0;
      this.intensityMax = 1;
      this.center = [0, 0, 0];
    }

    this.tileManager = data.tileManager || null;

    this.positions   = data.positions || null;
    this.colors      = data.colors || null;
    this.intensity   = data.intensity || null;
    this.lodLevels = [];
    const TOTAL = this.count;
    const MAX_CANDIDATES = 10000000;
    for (let level = 0; level < 8; level++) {
      const stride = Math.pow(2, level + 1);
      const spacing = Math.max(stride, Math.ceil(TOTAL / MAX_CANDIDATES));
      const lodCount = Math.ceil(TOTAL / spacing);
      const indices = new Uint32Array(lodCount);
      for (let i = 0; i < lodCount; i++) {
        indices[i] = Math.min(i * spacing, TOTAL - 1);
      }
      this.lodLevels.push({ level, count: lodCount, indices, minCount: lodCount });
    }

    this._buildToken = 0;
  }

  /** Cancel any in-progress async LOD building. */
  cancelAsyncBuild() {
    this._buildToken++;
    if (this._buildHandle) {
      clearTimeout(this._buildHandle);
      this._buildHandle = null;
    }
  }

  getGPUByteSize() {
    let bytes = 0;
    if (this.positions) bytes += this.positions.byteLength;
    if (this.colors) bytes += this.colors.byteLength;
    if (this.intensity) bytes += this.intensity.byteLength;
    return bytes;
  }

  /** Release all CPU-side memory immediately. */
  dispose() {
    this.cancelAsyncBuild();
    this.positions = null;
    this.colors = null;
    this.intensity = null;
    this.lodLevels = [];
    if (this.tileManager) {
      this.tileManager.dispose();
      this.tileManager = null;
    }
    this.bounds = null;
    this.center = null;
  }
}
