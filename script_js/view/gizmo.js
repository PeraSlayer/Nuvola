export class Gizmo {
  constructor() {
    this.mode = 'none';
    this._active = false;
    this._hovered = null;
    this._selected = null;
    this._dragStart = [0, 0];
    this._prevMX = 0;
    this._prevMY = 0;

    this._ringPts = { x: [], y: [], z: [] };
    this._ringTangents = { x: [], y: [], z: [] };
    this._ringRadii = { x: [], y: [], z: [] };
    this._ringSegments = 48;
    this._ringRadius = 0;
    this._centerScreen = [0, 0];
  }

  _getDiagonal(cloud) {
    if (!cloud || !cloud.bounds) return 1;
    const b = cloud.bounds;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _getCenter(cloud) {
    return cloud ? cloud.center : [0, 0, 0];
  }

  setMode(mode) {
    this.mode = mode;
    this._hovered = null;
    this._selected = null;
    this._active = false;
  }

  toggleMode() {
    if (this.mode === 'none') this.mode = 'rotate';
    else if (this.mode === 'rotate') this.mode = 'scale';
    else this.mode = 'none';
    this._hovered = null;
    this._selected = null;
    this._active = false;
  }

  isActive() {
    return this._active;
  }

  getModeLabel() {
    return this.mode === 'rotate' ? 'Rotate' : this.mode === 'scale' ? 'Scale' : '';
  }

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

  _getScreenCenter(center, camera) {
    return camera.project(center[0], center[1], center[2]);
  }

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

  _drawInternal(ctx, camera, cloud) {
    const center = this._getCenter(cloud);
    const diagonal = this._getDiagonal(cloud);
    const radius = diagonal * 0.45;

    const ringPts = this._buildRingPts(center, radius, camera);
    const [cx, cy] = this._getScreenCenter(center, camera);
    this._ringPts = ringPts;
    this._ringRadius = radius;
    this._centerScreen = [cx, cy];

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

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = ax.color;
        ctx.lineWidth = isHover || isActive ? 4 : 2.5;
        ctx.globalAlpha = isActive ? 1 : isHover ? 0.9 : 0.6;
        ctx.stroke();

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

  hitTest(sx, sy, camera, cloud) {
    if (this.mode === 'none' || !cloud) return null;
    const thresh = 12;

    if (this.mode === 'rotate') {
      const ringPts = this._ringPts;
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

  startDrag(part, sx, sy) {
    this._selected = part;
    this._active = true;
    this._dragStart = [sx, sy];
    this._prevMX = sx;
    this._prevMY = sy;
  }

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

  endDrag() {
    this._active = false;
    this._selected = null;
    this._prevMX = 0;
    this._prevMY = 0;
  }

  setHovered(part) {
    this._hovered = part;
  }
}
