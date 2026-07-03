/**
 * @file gizmo.js
 * @description Canvas2D-based transform gizmo (rotate and scale) drawn on top
 *   of the point cloud view. Provides hit-testing against rotation rings and
 *   scale axis handles, drag gestures that update a transformation object, and
 *   visual feedback via colour/alpha changes on hover and active states.
 *
 *   The rotate mode draws three orthogonal coloured rings (X=red, Y=green,
 *   Z=blue) around the cloud centre. The scale mode draws three axis-aligned
 *   lines with spherical handles and a central uniform-scale handle.
 */

/** Interactive 2D transform gizmo drawn with Canvas2D. */
export class Gizmo {
  constructor() {
    /** @type {string} Current mode: 'none' | 'rotate' | 'scale'. */
    this.mode = 'none';
    this._active = false;
    /** @type {string|null} Hovered ring/axis key ('x', 'y', 'z', 'center'). */
    this._hovered = null;
    /** @type {string|null} Selected (actively dragged) ring/axis key. */
    this._selected = null;
    /** @type {number[]} Screen position where drag started [sx, sy]. */
    this._dragStart = [0, 0];
    this._prevMX = 0;
    this._prevMY = 0;

    /** @type {Object<string, number[][]>} Screen-space ring points per axis. */
    this._ringPts = { x: [], y: [], z: [] };
    /** @type {Object<string, number[][]>} Per-vertex tangent vectors for rings. */
    this._ringTangents = { x: [], y: [], z: [] };
    /** @type {Object<string, number[]>} Per-vertex screen-space radius for rings. */
    this._ringRadii = { x: [], y: [], z: [] };
    /** @type {number} Number of segments per ring (smoothness). */
    this._ringSegments = 48;
    /** @type {number} Cached world-space ring radius. */
    this._ringRadius = 0;
    /** @type {number[]} Screen-space centre of the gizmo [cx, cy]. */
    this._centerScreen = [0, 0];
  }

  /**
   * Compute the bounding-box diagonal length of the point cloud.
   * @param {object} cloud - Point cloud with `.bounds` property.
   * @returns {number} Diagonal length (>= 1).
   */
  _getDiagonal(cloud) {
    if (!cloud || !cloud.bounds) return 1;
    const b = cloud.bounds;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Return the cloud centre as a 3-element array.
   * @param {object} cloud
   * @returns {number[]} [cx, cy, cz]
   */
  _getCenter(cloud) {
    return cloud ? cloud.center : [0, 0, 0];
  }

  /**
   * Set the gizmo mode directly.
   * @param {string} mode - 'none', 'rotate', or 'scale'.
   */
  setMode(mode) {
    this.mode = mode;
    this._hovered = null;
    this._selected = null;
    this._active = false;
  }

  /**
   * Cycle through gizmo modes: none -> rotate -> scale -> none.
   */
  toggleMode() {
    if (this.mode === 'none') this.mode = 'rotate';
    else if (this.mode === 'rotate') this.mode = 'scale';
    else this.mode = 'none';
    this._hovered = null;
    this._selected = null;
    this._active = false;
  }

  /**
   * Whether the gizmo is currently being dragged.
   * @returns {boolean}
   */
  isActive() {
    return this._active;
  }

  /**
   * Human-readable label for the current mode.
   * @returns {string}
   */
  getModeLabel() {
    return this.mode === 'rotate' ? 'Rotate' : this.mode === 'scale' ? 'Scale' : '';
  }

  /**
   * Build screen-space ring point arrays for each axis.
   * @param {number[]} center - World-space centre [cx, cy, cz].
   * @param {number} radius - World-space ring radius.
   * @param {object} camera - Camera with `.project(x, y, z)` method.
   * @returns {Object<string, number[][]>} Ring points keyed by axis.
   */
  _buildRingPts(center, radius, camera) {
    const r = {};
    for (const axis of ['x', 'y', 'z']) {
      const pts = [];
      for (let i = 0; i < this._ringSegments; i++) {
        const t = (i / this._ringSegments) * Math.PI * 2;
        let x, y, z;
        if (axis === 'z') {
          x = center[0] + radius * Math.cos(t);
          y = center[1] + radius * Math.sin(t);
          z = center[2];
        } else if (axis === 'y') {
          x = center[0] + radius * Math.cos(t);
          y = center[1];
          z = center[2] + radius * Math.sin(t);
        } else {
          x = center[0];
          y = center[1] + radius * Math.cos(t);
          z = center[2] + radius * Math.sin(t);
        }
        pts.push(camera.project(x, y, z));
      }
      r[axis] = pts;
    }
    return r;
  }

  /**
   * Project the world-space centre to screen space.
   * @param {number[]} center - [cx, cy, cz]
   * @param {object} camera
   * @returns {number[]} [screenX, screenY]
   */
  _getScreenCenter(center, camera) {
    return camera.project(center[0], center[1], center[2]);
  }

  /**
   * Calculate the shortest distance from a screen point to a ring polygon.
   * @param {number} px - Screen X.
   * @param {number} py - Screen Y.
   * @param {number[][]} ringPts - Array of [x, y] screen points forming the ring.
   * @returns {number} Minimum distance in pixels.
   */
  _distanceToRing(px, py, ringPts) {
    let minDist = Infinity;
    for (let i = 0; i < ringPts.length; i++) {
      const [x1, y1] = ringPts[i];
      const [x2, y2] = ringPts[(i + 1) % ringPts.length];
      const dx = x2 - x1, dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }
      const cx = x1 + t * dx;
      const cy = y1 + t * dy;
      const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  /**
   * Draw the gizmo onto a 2D canvas context.
   * Safe-wrapper that catches errors during internal drawing.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera
   * @param {object} cloud
   */
  draw(ctx, camera, cloud) {
    if (this.mode === 'none' || !cloud || !cloud.bounds) return;

    try {
      this._drawInternal(ctx, camera, cloud);
    } catch(e) {
      console.error('Gizmo draw error:', e);
      ctx.fillStyle = 'red';
      ctx.fillText('Gizmo error: ' + e.message, 20, 60);
    }
  }

  /**
   * Internal draw logic: builds ring/axis geometry, computes tangents and
   * radii, then renders rotate rings or scale handles based on the current mode.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera
   * @param {object} cloud
   */
  _drawInternal(ctx, camera, cloud) {
    const center = this._getCenter(cloud);
    const diagonal = this._getDiagonal(cloud);
    const radius = diagonal * 0.45;

    const ringPts = this._buildRingPts(center, radius, camera);
    const [cx, cy] = this._getScreenCenter(center, camera);
    this._ringPts = ringPts;
    this._ringRadius = radius;
    this._centerScreen = [cx, cy];

    // Pre-compute per-vertex tangents and screen-space radii for drag maths.
    const tangents = {};
    const radii = {};
    for (const axis of ['x', 'y', 'z']) {
      const pts = ringPts[axis];
      const t = [];
      const r = [];
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const len = Math.sqrt(tx * tx + ty * ty);
        t.push(len > 0.001 ? [tx / len, ty / len] : [0, 0]);
        const rdx = pts[i][0] - cx;
        const rdy = pts[i][1] - cy;
        r.push(Math.sqrt(rdx * rdx + rdy * rdy));
      }
      tangents[axis] = t;
      radii[axis] = r;
    }
    this._ringTangents = tangents;
    this._ringRadii = radii;

    const axes = [
      { key: 'x', color: '#ff4444', label: 'X' },
      { key: 'y', color: '#44ff44', label: 'Y' },
      { key: 'z', color: '#4488ff', label: 'Z' },
    ];

    const pts3d = {
      x: [center[0] + radius, center[1], center[2]],
      y: [center[0], center[1] + radius, center[2]],
      z: [center[0], center[1], center[2] + radius],
    };

    ctx.save();

    if (this.mode === 'rotate') {
      for (const ax of axes) {
        const pts = ringPts[ax.key];
        const isHover = this._hovered === ax.key;
        const isActive = this._selected === ax.key;

        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = pts[i];
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();

        ctx.strokeStyle = isActive ? '#ffffff' : ax.color;
        ctx.lineWidth = isHover || isActive ? 5 : 3;
        ctx.globalAlpha = isActive ? 1 : isHover ? 0.9 : 0.6;
        ctx.stroke();

        const ep = pts[Math.floor(pts.length * 0.125)];
        if (ep) {
          ctx.fillStyle = ax.color;
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.globalAlpha = isActive || isHover ? 1 : 0.7;
          ctx.fillText(ax.label, ep[0], ep[1]);
        }
      }
    } else if (this.mode === 'scale') {
      const handleRadius = 10;
      for (const ax of axes) {
        const p = camera.project(pts3d[ax.key][0], pts3d[ax.key][1], pts3d[ax.key][2]);
        const isHover = this._hovered === ax.key;
        const isActive = this._selected === ax.key;

        // Draw axis line from centre to handle.
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = ax.color;
        ctx.lineWidth = isHover || isActive ? 4 : 2.5;
        ctx.globalAlpha = isActive ? 1 : isHover ? 0.9 : 0.6;
        ctx.stroke();

        // Draw handle sphere.
        ctx.beginPath();
        ctx.arc(p[0], p[1], handleRadius, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? '#ffffff' : ax.color;
        ctx.globalAlpha = isActive ? 1 : isHover ? 0.9 : 0.7;
        ctx.fill();
        if (isHover || isActive) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.8;
        ctx.fillText(ax.label, p[0], p[1] + handleRadius + 14);
      }

      // Uniform-scale centre handle.
      const isCenterHover = this._hovered === 'center';
      const isCenterActive = this._selected === 'center';
      ctx.beginPath();
      ctx.arc(cx, cy, handleRadius * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = isCenterActive ? '#ffffff' : isCenterHover ? '#cccccc' : '#888888';
      ctx.globalAlpha = 0.8;
      ctx.fill();
      if (isCenterHover || isCenterActive) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Hit-test a screen position against the gizmo elements.
   * @param {number} sx - Screen X.
   * @param {number} sy - Screen Y.
   * @param {object} camera
   * @param {object} cloud
   * @returns {string|null} Axis key ('x','y','z','center') or null if no hit.
   */
  hitTest(sx, sy, camera, cloud) {
    if (this.mode === 'none' || !cloud) return null;
    const thresh = 12;

    if (this.mode === 'rotate') {
      const ringPts = this._ringPts;
      // Test in reverse order for painter-like priority.
      for (const axis of ['z', 'y', 'x']) {
        if (ringPts[axis] && ringPts[axis].length > 0) {
          const d = this._distanceToRing(sx, sy, ringPts[axis]);
          if (d < thresh) return axis;
        }
      }
    } else if (this.mode === 'scale' && cloud.bounds) {
      const center = this._getCenter(cloud);
      const diagonal = this._getDiagonal(cloud);
      const radius = diagonal * 0.45;
      const pts3d = {
        x: [center[0] + radius, center[1], center[2]],
        y: [center[0], center[1] + radius, center[2]],
        z: [center[0], center[1], center[2] + radius],
      };
      const [cx, cy] = this._centerScreen;

      const distCenter = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
      if (distCenter < 14) return 'center';

      for (const axis of ['x', 'y', 'z']) {
        const p = camera.project(pts3d[axis][0], pts3d[axis][1], pts3d[axis][2]);
        const d = Math.sqrt((sx - p[0]) ** 2 + (sy - p[1]) ** 2);
        if (d < 14) return axis;
      }
    }

    return null;
  }

  /**
   * Begin a drag gesture on a gizmo part.
   * @param {string} part - Axis key ('x','y','z','center').
   * @param {number} sx - Screen X at drag start.
   * @param {number} sy - Screen Y at drag start.
   */
  startDrag(part, sx, sy) {
    this._selected = part;
    this._active = true;
    this._dragStart = [sx, sy];
    this._prevMX = sx;
    this._prevMY = sy;
  }

  /**
   * Process a mouse/touch move during an active drag, updating the provided
   * transformation object (rotation or scale).
   * @param {number} sx - Current screen X.
   * @param {number} sy - Current screen Y.
   * @param {object} camera
   * @param {object} cloud
   * @param {object} xform - Transformation object with `.rotation[]` and
   *   `.scale[]` arrays and a `.markDirty()` method.
   */
  onDrag(sx, sy, camera, cloud, xform) {
    if (!this._active || !xform) return;
    const dx = sx - this._prevMX;
    const dy = sy - this._prevMY;
    this._prevMX = sx;
    this._prevMY = sy;

    if (this.mode === 'rotate') {
      const axisIdx = { x: 0, y: 1, z: 2 }[this._selected];
      if (axisIdx === undefined) return;

      const tangents = this._ringTangents[this._selected];
      const radii = this._ringRadii[this._selected];
      const pts = this._ringPts[this._selected];
      if (!pts || pts.length === 0) return;

      // Find closest point on the ring to project the mouse delta onto the tangent.
      let closestIdx = 0;
      let minDistSq = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (sx - pts[i][0]) ** 2 + (sy - pts[i][1]) ** 2;
        if (d < minDistSq) { minDistSq = d; closestIdx = i; }
      }

      const tangent = tangents[closestIdx];
      const radius = radii[closestIdx] || 1;
      const proj = dx * tangent[0] + dy * tangent[1];
      const deltaRadians = proj / Math.max(radius, 1);

      xform.rotation[axisIdx] = (xform.rotation[axisIdx] + deltaRadians * 180 / Math.PI) % 360;
      xform.markDirty();
    } else if (this.mode === 'scale') {
      const factor = 1 + dx * 0.008;
      if (this._selected === 'center') {
        // Uniform scale on all three axes.
        xform.scale[0] = Math.max(0.01, Math.min(100, xform.scale[0] * factor));
        xform.scale[1] = Math.max(0.01, Math.min(100, xform.scale[1] * factor));
        xform.scale[2] = Math.max(0.01, Math.min(100, xform.scale[2] * factor));
      } else {
        const idx = { x: 0, y: 1, z: 2 }[this._selected];
        if (idx !== undefined) {
          xform.scale[idx] = Math.max(0.01, Math.min(100, xform.scale[idx] * factor));
        }
      }
      xform.markDirty();
    }
  }

  /**
   * End the current drag gesture, resetting selection and internal state.
   */
  endDrag() {
    this._active = false;
    this._selected = null;
    this._prevMX = 0;
    this._prevMY = 0;
  }

  /**
   * Set the hovered gizmo part (used for visual highlighting).
   * @param {string|null} part - Axis key or null.
   */
  setHovered(part) {
    this._hovered = part;
  }
}
