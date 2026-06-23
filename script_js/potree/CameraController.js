import { Camera } from '../model/camera.js?v=2';
import { FPSCamera } from '../view/fps-camera.js?v=2';

export class CameraController {
  constructor() {
    this.isometricCamera = new Camera();
    this.fpsCamera = new FPSCamera();
    this.activeMode = 'isometric';

    this._dirty = true;
  }

  getActiveCamera() {
    return this.activeMode === 'fps' ? this.fpsCamera : this.isometricCamera;
  }

  switchMode() {
    this.activeMode = this.activeMode === 'isometric' ? 'fps' : 'isometric';
    this._dirty = true;
  }

  setMode(mode) {
    this.activeMode = mode;
    this._dirty = true;
  }

  getUniforms(w, h, cloud) {
    return this.getActiveCamera().getUniforms(w, h, cloud);
  }

  update(dt) {
    if (this.activeMode === 'fps') {
      this.fpsCamera.update();
    }
  }

  markDirty() {
    this.getActiveCamera().markDirty();
    this._dirty = true;
  }

  consumeDirty() {
    const camDirty = this.getActiveCamera().consumeDirty();
    const d = this._dirty || camDirty;
    this._dirty = false;
    return d;
  }

  reset() {
    this.getActiveCamera().reset();
    this._dirty = true;
  }

  fitToBounds(cloud, w, h) {
    if (this.activeMode === 'fps') {
      if (cloud && cloud.bounds) {
        this.fpsCamera.fitToBounds(cloud.bounds);
      }
    } else {
      this.isometricCamera.fitToBounds(cloud, w, h);
    }
    this._dirty = true;
  }

  setViewport(w, h) {
    this.isometricCamera.setViewport(w, h);
    this.fpsCamera.setViewport(w, h);
  }

  setRefCenter(center) {
    this.isometricCamera.setRefCenter(center);
    this.fpsCamera.setTarget(center);
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

  rotateLeft() { this.isometricCamera.rotateLeft(); }
  rotateRight() { this.isometricCamera.rotateRight(); }
  rotateHorizontal(d) { this.isometricCamera.rotateHorizontal(d); }
  rotateVertical(d) { this.isometricCamera.rotateVertical(d); }
  setView(i) { this.isometricCamera.setView(i); }
  setViewOffset(d) { this.isometricCamera.setViewOffset(d); }
  project(x, y, z) { return this.isometricCamera.project(x, y, z); }
}
