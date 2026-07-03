/**
 * @file minimap.js
 * @description Top-down minimap that shows a cached overview of the point
 *   cloud's spatial extent together with the current camera position and
 *   view direction. The static cloud rendering is drawn once onto an
 *   offscreen canvas and reused across frames; only the dynamic camera
 *   indicator is redrawn each update.
 *
 *   Serves as an orientation aid, letting the user quickly see where they
 *   are within the scene and which direction they are looking.
 */

/**
 * Top-down minimap showing a cached point cloud overview and camera view
 * direction.
 */
export class MiniMap {
  /**
   * @param {HTMLCanvasElement} canvas - The DOM canvas element for the minimap.
   */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = canvas.getContext('2d');

    /** @type {HTMLCanvasElement} Offscreen canvas for the static cloud cache. */
    this.bgCanvas = document.createElement('canvas');
    /** @type {CanvasRenderingContext2D} */
    this.bgCtx = this.bgCanvas.getContext('2d');
    /** @type {boolean} Whether the static background has been cached. */
    this.isCached = false;
  }

  /**
   * Draw the minimap. On first call (or after `clearCache()`), the point
   * cloud outline is rendered once to an offscreen canvas. Subsequent calls
   * only draw the background + cached cloud + dynamic camera indicator.
   * @param {object} cloud - Point cloud object with `.bounds`, `.center`,
   *   `.positions`, and `.count`.
   * @param {object} camera - Camera with `.rotAngle` and `.viewOffsetRad`.
   * @param {number} rendererW - Renderer width (unused, kept for API compatibility).
   * @param {number} rendererH - Renderer height (unused, kept for API compatibility).
   */
  draw(cloud, camera, rendererW, rendererH) {
    if (!cloud) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;

    // Initialise the static cache if this is the first draw.
    if (!this.isCached) {
      this.bgCanvas.width = w;
      this.bgCanvas.height = h;
      this._cachePointCloud(cloud, w, h);
      this.isCached = true;
    }

    // Draw background and cached point cloud (instant).
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.bgCanvas, 0, 0);

    // Draw the dynamic camera indicator.
    const b = cloud.bounds;
    const spanX = b.max[0] - b.min[0] || 1;
    const spanY = b.max[1] - b.min[1] || 1;
    const pad = 8;
    const scale = Math.min((w - pad*2) / spanX, (h - pad*2) / spanY);

    /**
     * Map world (x, y) coordinates to minimap pixel space.
     * @param {number} x - World X coordinate.
     * @param {number} y - World Y coordinate.
     * @returns {number[]} [pixelX, pixelY]
     */
    const toMap = (x, y) => [
      pad + (x - b.min[0]) * scale,
      h - pad - (y - b.min[1]) * scale,
    ];

    const [cx, cy] = toMap(cloud.center[0], cloud.center[1]);
    ctx.strokeStyle = '#3fb950';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI*2);
    ctx.stroke();

    const angle = camera.rotAngle - camera.viewOffsetRad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(angle) * 12, cy - Math.cos(angle) * 12);
    ctx.stroke();
  }

  /**
   * Invalidate the cached point cloud rendering so it is rebuilt on the
   * next `draw()` call.
   */
  clearCache() {
    this.isCached = false;
    const ctx = this.bgCtx;
    ctx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
  }

  /**
   * Render the point cloud onto the offscreen canvas (cached static layer).
   * Draws a bounding-box outline and a subsampled scatter of points.
   * @param {object} cloud - Point cloud object.
   * @param {number} w - Canvas width in pixels.
   * @param {number} h - Canvas height in pixels.
   */
  _cachePointCloud(cloud, w, h) {
    const ctx = this.bgCtx;
    ctx.clearRect(0, 0, w, h);
    const b = cloud.bounds;
    const spanX = b.max[0] - b.min[0] || 1;
    const spanY = b.max[1] - b.min[1] || 1;
    const pad = 8;
    const scale = Math.min((w - pad*2) / spanX, (h - pad*2) / spanY);

    /**
     * Map world (x, y) to minimap pixel space (local to this method).
     * @param {number} x
     * @param {number} y
     * @returns {number[]} [pixelX, pixelY]
     */
    const toMap = (x, y) => [
      pad + (x - b.min[0]) * scale,
      h - pad - (y - b.min[1]) * scale,
    ];

    // Bounding-box outline.
    const [x0, y0] = toMap(b.min[0], b.min[1]);
    const [x1, y1] = toMap(b.max[0], b.max[1]);
    ctx.strokeStyle = '#30363d';
    ctx.strokeRect(x0, y1, x1 - x0, y0 - y1);

    if (!cloud.positions) return;

    // Subsampled point scatter (capped at ~800 points for performance).
    ctx.fillStyle = 'rgba(88,166,255,0.35)';
    const step = Math.max(1, Math.floor(cloud.count / 800));
    const p = cloud.positions;
    for (let i = 0; i < cloud.count; i += step) {
      const [mx, my] = toMap(p[i*3], p[i*3+1]);
      ctx.fillRect(mx, my, 1, 1);
    }
  }
}
