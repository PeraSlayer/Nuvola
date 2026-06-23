import * as THREE from 'three';

const DEFAULT_FOV = 60;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 10000;
const MIN_RADIUS = 0.1;
const MAX_RADIUS = 10000;
const MAX_PITCH_RAD = Math.PI / 2 - 0.01;

export class FPSCamera {
  constructor() {
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -Math.PI / 6;
    this.radius = 100;
    this.fov = DEFAULT_FOV;
    this.near = DEFAULT_NEAR;
    this.far = DEFAULT_FAR;

    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV, 1, DEFAULT_NEAR, DEFAULT_FAR,
    );
    this.position = new THREE.Vector3();

    this._dirty = true;
    this._viewportW = 1;
    this._viewportH = 1;

    this._viewMatrix = new THREE.Matrix4();
    this._projMatrix = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
  }

  orbit(dyaw, dpitch) {
    this.yaw += dyaw;
    this.pitch += dpitch;
    if (this.pitch > MAX_PITCH_RAD) this.pitch = MAX_PITCH_RAD;
    if (this.pitch < -MAX_PITCH_RAD) this.pitch = -MAX_PITCH_RAD;
    this._dirty = true;
  }

  pan(dx, dy) {
    const forward = new THREE.Vector3();
    forward.subVectors(this.camera.position, this.target);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
    right.normalize();

    const up = new THREE.Vector3(0, 1, 0);

    const scale = this.radius * 0.002;
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
    this._dirty = true;
  }

  zoom(factor) {
    this.radius *= factor;
    if (this.radius < MIN_RADIUS) this.radius = MIN_RADIUS;
    if (this.radius > MAX_RADIUS) this.radius = MAX_RADIUS;
    this._dirty = true;
  }

  update() {
    if (!this._dirty) return;

    this.position.set(
      this.target.x + this.radius * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target.y + this.radius * Math.sin(this.pitch),
      this.target.z + this.radius * Math.cos(this.pitch) * Math.cos(this.yaw),
    );

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();

    this._viewMatrix.copy(this.camera.matrixWorldInverse);
    this._projMatrix.copy(this.camera.projectionMatrix);
    this._frustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this._projMatrix, this._viewMatrix),
    );

    this._dirty = false;
  }

  setViewport(w, h) {
    this._viewportW = w;
    this._viewportH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  getViewMatrix() {
    this.update();
    return this._viewMatrix;
  }

  getProjectionMatrix() {
    this.update();
    return this._projMatrix;
  }

  getWorldPosition() {
    this.update();
    return this.position;
  }

  getFrustum() {
    this.update();
    return this._frustum;
  }

  setPosition(pos) {
    this.position.set(pos[0], pos[1], pos[2]);
    this._dirty = true;
  }

  setTarget(targ) {
    this.target.set(targ[0], targ[1], targ[2]);
    this._dirty = true;
  }

  setRadius(r) {
    this.radius = r;
    this._dirty = true;
  }

  fitToBounds(box) {
    if (!box) return;
    const min = box.min instanceof THREE.Vector3 ? box.min : new THREE.Vector3(box.min[0], box.min[1], box.min[2]);
    const max = box.max instanceof THREE.Vector3 ? box.max : new THREE.Vector3(box.max[0], box.max[1], box.max[2]);

    const center = new THREE.Vector3();
    center.addVectors(min, max).multiplyScalar(0.5);
    this.target.copy(center);

    const size = new THREE.Vector3();
    size.subVectors(max, min);
    const maxDim = Math.max(size.x, size.y, size.z);
    this.radius = maxDim * 1.5;

    this._dirty = true;
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
    this.target.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = -Math.PI / 6;
    this.radius = 100;
    this._dirty = true;
  }

  getUniforms(w, h, cloud) {
    this.update();
    const center = cloud ? cloud.center : [0, 0, 0];
    const zMin = cloud ? cloud.zMin - center[2] : 0;
    const zMax = cloud ? cloud.zMax - center[2] : 1;
    const hasIntensity = cloud && cloud.hasIntensity;
    const iMin = hasIntensity ? cloud.intensityMin : 0;
    const iMax = hasIntensity ? cloud.intensityMax : 1;

    return {
      u_resolution: new Float32Array([w, h]),
      u_pan: new Float32Array([0, 0]),
      u_zoom: 1,
      u_rot: 0,
      u_rotX: 0,
      u_rotY: 0,
      u_rotZ: 0,
      u_center: new Float32Array(center),
      u_zMin: zMin,
      u_zMax: zMax,
      u_depthMin: 0,
      u_depthMax: 1,
      u_iMin: iMin,
      u_iMax: iMax,
      u_cameraMode: 1,
      u_viewMatrix: this._viewMatrix.elements,
      u_projMatrix: this._projMatrix.elements,
    };
  }
}
