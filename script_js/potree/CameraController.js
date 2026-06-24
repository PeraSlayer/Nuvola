import * as THREE from 'three';
import { Camera } from '../model/camera.js?v=2';

const DEFAULT_FOV = 60;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 100000;
const MIN_POLAR = 0.01;
const MAX_POLAR = Math.PI - 0.01;
const MIN_RADIUS = 0.1;
const MAX_RADIUS = 100000;

const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

export class CameraController {
  constructor() {
    this.isometricCamera = new Camera();
    this.perspectiveCamera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, DEFAULT_NEAR, DEFAULT_FAR);
    this.activeMode = 'isometric';

    this._target = new THREE.Vector3();
    this._spherical = new THREE.Spherical(100, Math.PI / 3, Math.PI / 4);
    this._dirty = true;

    this._frustumOut = new THREE.Frustum();
    this._uRes = new Float32Array(2);
    this._uPan = new Float32Array(2);
    this._uCenter = new Float32Array(3);
  }

  get fpsSpeed() {
    return this._spherical.radius * 0.2;
  }

  set fpsSpeed(v) {
    this._spherical.radius = v / 0.2;
    this._dirty = true;
  }

  orbit(dyaw, dpitch) {
    this._spherical.theta -= dyaw;
    this._spherical.phi -= dpitch;
    if (this._spherical.phi < MIN_POLAR) this._spherical.phi = MIN_POLAR;
    if (this._spherical.phi > MAX_POLAR) this._spherical.phi = MAX_POLAR;
    this._dirty = true;
  }

  dolly(factor) {
    this._spherical.radius *= factor;
    if (this._spherical.radius < MIN_RADIUS) this._spherical.radius = MIN_RADIUS;
    if (this._spherical.radius > MAX_RADIUS) this._spherical.radius = MAX_RADIUS;
    this._dirty = true;
  }

  pan(dx, dy) {
    this._ensureUpdated();
    this.perspectiveCamera.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.length() < 0.001) _v3.set(0, 0, -1);
    _v3.normalize();
    _v3b.crossVectors(_v3, _up).normalize();
    _v3c.crossVectors(_v3b, _v3).normalize();
    const scale = this._spherical.radius * 0.002;
    this._target.addScaledVector(_v3b, dx * scale);
    this._target.addScaledVector(_v3c, dy * scale);
    this._dirty = true;
  }

  moveForward(dist) {
    this._ensureUpdated();
    this.perspectiveCamera.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.length() < 0.001) _v3.set(0, 0, -1);
    _v3.normalize();
    this._target.addScaledVector(_v3, dist);
    this._dirty = true;
  }

  moveRight(dist) {
    this._ensureUpdated();
    this._getCameraRight(_v3);
    this._target.addScaledVector(_v3, dist);
    this._dirty = true;
  }

  moveUp(dist) {
    this._target.y += dist;
    this._dirty = true;
  }

  _ensureUpdated() {
    if (this._dirty) this._applyOrbit();
  }

  _getCameraRight(target) {
    this.perspectiveCamera.getWorldDirection(_v3b);
    _v3b.y = 0;
    if (_v3b.length() < 0.001) _v3b.set(0, 0, -1);
    _v3b.normalize();
    target.crossVectors(_v3b, _up).normalize();
  }

  _applyOrbit() {
    _v3.setFromSpherical(this._spherical).add(this._target);
    this.perspectiveCamera.position.copy(_v3);
    this.perspectiveCamera.lookAt(this._target);
    this.perspectiveCamera.updateMatrixWorld();
  }

  update(dt) {
    if (this.activeMode === 'fps') {
      if (!this._dirty) return;
      this._applyOrbit();
    }
  }

  markDirty() {
    this._dirty = true;
  }

  consumeDirty() {
    if (this.activeMode === 'fps') {
      const d = this._dirty;
      this._dirty = false;
      return d;
    }
    const camDirty = this.isometricCamera.consumeDirty();
    const d = this._dirty || camDirty;
    this._dirty = false;
    return d;
  }

  switchMode() {
    if (this.activeMode === 'isometric') {
      this.activeMode = 'fps';
      this._applyOrbit();
    } else {
      this.activeMode = 'isometric';
    }
    this._dirty = true;
  }

  setMode(mode) {
    this.activeMode = mode;
    this._dirty = true;
  }

  getViewMatrix() {
    return this.perspectiveCamera.matrixWorldInverse;
  }

  getProjectionMatrix() {
    return this.perspectiveCamera.projectionMatrix;
  }

  getWorldPosition() {
    return this.perspectiveCamera.position;
  }

  getFrustum() {
    this.update();
    _m4.multiplyMatrices(
      this.perspectiveCamera.projectionMatrix,
      this.perspectiveCamera.matrixWorldInverse,
    );
    this._frustumOut.setFromProjectionMatrix(_m4);
    return this._frustumOut;
  }

  getWorldDirection(target) {
    this.perspectiveCamera.getWorldDirection(target);
    return target;
  }

  setTarget(center) {
    this._target.set(center[0], center[1], center[2]);
    this._dirty = true;
  }

  fitToBounds(cloud, w, h) {
    if (this.activeMode === 'fps') {
      this._fitToBoundsFPS(cloud);
    } else {
      this.isometricCamera.fitToBounds(cloud, w, h);
    }
    this._dirty = true;
  }

  _fitToBoundsFPS(cloud) {
    if (!cloud || !cloud.bounds) return;
    const min = cloud.bounds.min;
    const max = cloud.bounds.max;
    this._target.set(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    );
    const dx = max[0] - min[0];
    const dy = max[1] - min[1];
    const dz = max[2] - min[2];
    const maxDim = Math.max(dx, dy, dz);

    this._spherical.theta = Math.PI / 4;
    this._spherical.phi = Math.PI / 3;
    this._spherical.radius = maxDim * 1.5;
  }

  setViewport(w, h) {
    this.isometricCamera.setViewport(w, h);
    this.perspectiveCamera.aspect = w / h;
    this.perspectiveCamera.updateProjectionMatrix();
    this._dirty = true;
  }

  setRefCenter(center) {
    this.isometricCamera.setRefCenter(center);
    this.setTarget(center);
  }

  reset() {
    this.isometricCamera.reset();
    this._spherical.set(100, Math.PI / 3, Math.PI / 4);
    this._target.set(0, 0, 0);
    this._dirty = true;
  }

  getUniforms(w, h, cloud) {
    if (this.activeMode === 'fps') {
      return this._getUniformsFPS(w, h, cloud);
    }
    return this.isometricCamera.getUniforms(w, h, cloud);
  }

  _getUniformsFPS(w, h, cloud) {
    this.update();
    const center = cloud ? cloud.center : [0, 0, 0];
    const zMin = cloud ? cloud.zMin - center[2] : 0;
    const zMax = cloud ? cloud.zMax - center[2] : 1;
    const spacing = cloud && cloud.octreeGeometry && cloud.octreeGeometry.spacing
      ? cloud.octreeGeometry.spacing : 1.0;
    this._uRes[0] = w; this._uRes[1] = h;
    this._uCenter[0] = center[0]; this._uCenter[1] = center[1]; this._uCenter[2] = center[2];

    return {
      u_resolution: this._uRes,
      u_pan: this._uPan,
      u_zoom: 1,
      u_rot: 0,
      u_rotX: 0,
      u_rotY: 0,
      u_rotZ: 0,
      u_center: this._uCenter,
      u_zMin: zMin,
      u_zMax: zMax,
      u_depthMin: 0,
      u_depthMax: 1,
      u_iMin: cloud && cloud.hasIntensity ? cloud.intensityMin : 0,
      u_iMax: cloud && cloud.hasIntensity ? cloud.intensityMax : 1,
      u_cameraMode: 1,
      u_viewMatrix: this.perspectiveCamera.matrixWorldInverse.elements,
      u_projMatrix: this.perspectiveCamera.projectionMatrix.elements,
      u_spacing: spacing,
    };
  }

  get panX() { return this.isometricCamera.panX; }
  set panX(v) { this.isometricCamera.panX = v; }
  get panY() { return this.isometricCamera.panY; }
  set panY(v) { this.isometricCamera.panY = v; }
  get zoom() { return this.isometricCamera.zoom; }
  set zoom(v) { this.isometricCamera.zoom = v; }
  get rotAngle() { return this.isometricCamera.rotAngle; }
  get rotationXDeg() { return this.isometricCamera.rotationXDeg; }
  set rotationXDeg(v) { this.isometricCamera.rotationXDeg = v; }
  get rotationYDeg() { return this.isometricCamera.rotationYDeg; }
  set rotationYDeg(v) { this.isometricCamera.rotationYDeg = v; }
  get viewOffsetDeg() { return this.isometricCamera.viewOffsetDeg; }
  get eightDir() { return this.isometricCamera.eightDir; }
  get viewIndex() { return this.isometricCamera.viewIndex; }
  get refCenter() { return this.isometricCamera.refCenter; }
  get _cloudCenter() { return this.isometricCamera._cloudCenter; }

  zoomAt(factor, sx, sy, w, h) { this.isometricCamera.zoomAt(factor, sx, sy, w, h); }
  rotateLeft() { this.isometricCamera.rotateLeft(); }
  rotateRight() { this.isometricCamera.rotateRight(); }
  rotateHorizontal(d) { this.isometricCamera.rotateHorizontal(d); }
  rotateVertical(d) { this.isometricCamera.rotateVertical(d); }
  setView(i) { this.isometricCamera.setView(i); }
  setViewOffset(d) { this.isometricCamera.setViewOffset(d); }
  project(x, y, z) { return this.isometricCamera.project(x, y, z); }
}
