/*
===============================================================================
File: camera.js

Defines the isometric Camera class for Nuvola's 2.5D point cloud viewer.
Manages pan, zoom, rotation (cardinal snapping + Euler tilt), fit-to-bounds,
world-to-screen projection, and depth range computation.

All math matches the isometric path in the WebGL2 vertex shader (shader.js).

Exporta la classe Camera usata da renderer, main, minimap, misure e gizmo.
===============================================================================
*/

function _depthRange(cloud, angle) {
  if (!cloud || !cloud.bounds) return { min: 0, max: 1 };
  const b = cloud.bounds;
  const cx = cloud.center[0], cy = cloud.center[1], cz = cloud.center[2];
  const c = Math.cos(angle), s = Math.sin(angle);
  const cx0 = b.min[0], cx1 = b.max[0], cy0 = b.min[1], cy1 = b.max[1], cz0 = b.min[2], cz1 = b.max[2];
  let minD = Infinity, maxD = -Infinity;
  for (const corner of [
    [cx0, cy0, cz0], [cx1, cy0, cz0], [cx0, cy1, cz0], [cx1, cy1, cz0],
    [cx0, cy0, cz1], [cx1, cy0, cz1], [cx0, cy1, cz1], [cx1, cy1, cz1],
  ]) {
    const lx = corner[0] - cx, ly = corner[1] - cy, lz = corner[2] - cz;
    const rx = lx * c - ly * s;
    const ry = lx * s + ly * c;
    const d = rx + ry - lz;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  return { min: minD, max: minD === maxD ? maxD + 1 : maxD };
}

export class Camera {
  constructor() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this._defaultZoom = 1;
    this._rotAngle = Math.PI / 4;
    this.viewOffsetDeg = 0;
    this.rotationXDeg = 0;
    this.rotationYDeg = 0;
    this.rotationZDeg = 0;
    this.eightDir = false;
    this.viewIndex = 0;
    this._refCenter = [0, 0, 0];
    this._dirty = true;
    this._viewportW = 1;
    this._viewportH = 1;
    this._cloudCenter = [0, 0, 0];
    this._depthMin = 0;
    this._depthMax = 1;

    // Pre-allocated arrays for getUniforms (reused each frame, avoids allocation)
    this._uRes = new Float32Array(2);
    this._uPan = new Float32Array(2);
    this._uCenter = new Float32Array(3);
  }

  get viewOffsetRad() {
    return this.viewOffsetDeg * Math.PI / 180;
  }

  get rotAngle() { return this._rotAngle; }
  get defaultZoom() { return this._defaultZoom; }
  get refCenter() { return this._refCenter; }

  getUniforms(w, h, cloud) {
    const center = cloud ? cloud.center : this._cloudCenter;
    const zMin = cloud ? cloud.zMin - center[2] : 0;
    const zMax = cloud ? cloud.zMax - center[2] : 1;
    const hasIntensity = cloud && cloud.hasIntensity;
    const iMin = hasIntensity ? cloud.intensityMin : 0;
    const iMax = hasIntensity ? cloud.intensityMax : 1;
    const dr = _depthRange(cloud, this._rotAngle);
    this._uRes[0] = w; this._uRes[1] = h;
    this._uPan[0] = this.panX; this._uPan[1] = this.panY;
    this._uCenter[0] = center[0]; this._uCenter[1] = center[1]; this._uCenter[2] = center[2];
    return {
      u_resolution: this._uRes,
      u_pan: this._uPan,
      u_zoom: this.zoom,
      u_rot: this._rotAngle,
      u_rotX: this.rotationXDeg * Math.PI / 180,
      u_rotY: this.rotationYDeg * Math.PI / 180,
      u_rotZ: this.rotationZDeg * Math.PI / 180,
      u_center: this._uCenter,
      u_zMin: zMin,
      u_zMax: zMax,
      u_depthMin: dr.min,
      u_depthMax: dr.max,
      u_iMin: iMin,
      u_iMax: iMax,
    };
  }

  fitToBounds(cloud, w, h, angle) {
    if (angle === undefined) angle = this._rotAngle;
    if (!cloud || !cloud.bounds) return;
    const cx = cloud.center[0], cy = cloud.center[1], cz = cloud.center[2];
    const b = cloud.bounds;
    const rotX = this.rotationXDeg * Math.PI / 180;
    const rotY = this.rotationYDeg * Math.PI / 180;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const c = Math.cos(angle), s = Math.sin(angle);
    const corners = [
      [b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]],
      [b.min[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.min[2]],
      [b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]],
      [b.min[0], b.max[1], b.max[2]], [b.max[0], b.max[1], b.max[2]],
    ];
    let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
    for (const corner of corners) {
      let lx = corner[0] - cx, ly = corner[1] - cy, lz = corner[2] - cz;
      const y1 = ly * cosX - lz * sinX;
      const z1 = ly * sinX + lz * cosX;
      ly = y1; lz = z1;
      const x1 = lx * cosY + lz * sinY;
      const z2 = -lx * sinY + lz * cosY;
      lx = x1; lz = z2;
      const rx = lx * c - ly * s;
      const ry = lx * s + ly * c;
      const sx = rx - ry;
      const sy = (rx + ry) * 0.5 - lz;
      if (sx < minSx) minSx = sx;
      if (sx > maxSx) maxSx = sx;
      if (sy < minSy) minSy = sy;
      if (sy > maxSy) maxSy = sy;
    }
    const extentX = maxSx - minSx || 1;
    const extentY = maxSy - minSy || 1;
    const margin = 0.85;
    this.zoom = Math.min((w * margin) / extentX, (h * margin) / extentY);
    this._defaultZoom = this.zoom;
    this.panX = w * 0.5 - (minSx + maxSx) * 0.5 * this.zoom;
    this.panY = h * 0.5 - (minSy + maxSy) * 0.5 * this.zoom;
    const dr = _depthRange(cloud, angle);
    this._depthMin = dr.min;
    this._depthMax = dr.max;
  }

  project(x, y, z) {
    const cx = this._cloudCenter[0], cy = this._cloudCenter[1], cz = this._cloudCenter[2];
    let lx = x - cx, ly = y - cy, lz = z - cz;
    const rotX = this.rotationXDeg * Math.PI / 180;
    const rotY = this.rotationYDeg * Math.PI / 180;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const y1 = ly * cosX - lz * sinX;
    const z1 = ly * sinX + lz * cosX;
    ly = y1; lz = z1;
    const x1 = lx * cosY + lz * sinY;
    const z2 = -lx * sinY + lz * cosY;
    lx = x1; lz = z2;
    const c = Math.cos(this._rotAngle), s = Math.sin(this._rotAngle);
    const rx = lx * c - ly * s;
    const ry = lx * s + ly * c;
    return [
      (rx - ry) * this.zoom + this.panX,
      ((rx + ry) * 0.5 - lz) * this.zoom + this.panY,
    ];
  }

  static depthRange(cloud, angle) {
    return _depthRange(cloud, angle);
  }

  zoomAt(factor, sx, sy, w, h) {
    const prev = this.zoom;
    const next = this.zoom * factor;
    this.panX = sx - (sx - this.panX) * (next / prev);
    this.panY = sy - (sy - this.panY) * (next / prev);
    this.zoom = next;
    this.markDirty();
  }

  _updateViewIndex() {
    const n = this.eightDir ? 8 : 4;
    const step = (Math.PI * 2) / n;
    const idx = Math.round(((Math.PI / 4 - this._rotAngle) % (Math.PI * 2)) / step);
    this.viewIndex = ((idx % n) + n) % n;
  }

  rotateLeft() {
    const step = this.eightDir ? Math.PI / 4 : Math.PI / 2;
    this._rotAngle = ((this._rotAngle + step) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    this._updateViewIndex();
    this.markDirty();
  }

  rotateRight() {
    const step = this.eightDir ? Math.PI / 4 : Math.PI / 2;
    this._rotAngle = ((this._rotAngle - step) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    this._updateViewIndex();
    this.markDirty();
  }

  rotateHorizontal(delta) {
    this._rotAngle = ((this._rotAngle + delta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    this._updateViewIndex();
    this.markDirty();
  }

  rotateVertical(delta) {
    this.rotationXDeg += delta;
    this.markDirty();
  }

  setView(index) {
    const n = this.eightDir ? 8 : 4;
    const step = (Math.PI * 2) / n;
    this._rotAngle = ((Math.PI / 4 - index * step) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    this.viewIndex = index;
    this.markDirty();
  }

  setViewOffset(deg) {
    this.viewOffsetDeg = deg;
    this.markDirty();
  }

  setRefCenter(center) {
    this._refCenter = center;
    this._cloudCenter = center;
  }

  setViewport(w, h) {
    this._viewportW = w;
    this._viewportH = h;
  }

  markDirty() {
    this._dirty = true;
  }

  consumeDirty() {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  reset() {
    this.rotationXDeg = 0;
    this.rotationYDeg = 0;
    this.rotationZDeg = 0;
    this.viewOffsetDeg = 0;
    this._rotAngle = Math.PI / 4;
    this.zoom = this._defaultZoom || 1;
    this.panX = 0;
    this.panY = 0;
    this.viewIndex = 0;
    this.markDirty();
  }
}
