/**
 * @file CameraController.js
 * @description Manages camera behavior for point cloud rendering. Supports two modes:
 *   - `isometric`: A fixed-perspective, Bird's-eye / isometric view with pan, zoom, and rotation.
 *   - `fps`: A first-person, free-look camera with orbit, dolly, and pan controls.
 *   Provides view/projection matrices, frustum culling helpers, uniform generation for
 *   shaders, and coordinate conversion between the two modes.
 */

import * as THREE from 'three';
import { Camera } from '../model/camera.js?v=2';

/** Default vertical field of view in degrees for the perspective camera. */
const DEFAULT_FOV = 60;
/** Near clipping plane distance. */
const DEFAULT_NEAR = 0.1;
/** Far clipping plane distance. */
const DEFAULT_FAR = 100000;
/** Minimum polar angle (radians) to prevent gimbal lock at the poles. */
const MIN_POLAR = 0.01;
/** Maximum polar angle (radians) to prevent gimbal lock at the poles. */
const MAX_POLAR = Math.PI - 0.01;
/** Minimum orbital radius. */
const MIN_RADIUS = 0.1;
/** Maximum orbital radius. */
const MAX_RADIUS = 100000;

/** Reusable Vector3 for temporary calculations. */
const _v3 = new THREE.Vector3();
/** Reusable Vector3 for temporary calculations. */
const _v3b = new THREE.Vector3();
/** Reusable Vector3 for temporary calculations. */
const _v3c = new THREE.Vector3();
/** Reusable Matrix4 for frustum construction. */
const _m4 = new THREE.Matrix4();
/** World up vector (Y-up). */
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Camera controller supporting isometric and FPS navigation modes.
 * Delegates isometric-specific operations to an internal {@link Camera} instance
 * while managing a THREE.PerspectiveCamera for first-person orbital viewing.
 *
 * @class CameraController
 */
export class CameraController {
  /**
   * Initializes both the isometric and perspective cameras and sets up
   * spherical coordinate state for FPS mode.
   */
  constructor() {
    /** @type {Camera} Isometric camera for top-down / fixed-angle viewing. */
    this.isometricCamera = new Camera();
    /** @type {THREE.PerspectiveCamera} Perspective camera for FPS / orbital viewing. */
    this.perspectiveCamera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, DEFAULT_NEAR, DEFAULT_FAR);
    /** @type {'isometric'|'fps'} Currently active camera mode. */
    this.activeMode = 'isometric';

    /** @type {THREE.Vector3} Look-at target in world space (FPS mode). */
    this._target = new THREE.Vector3();
    /** @type {THREE.Spherical} Spherical coordinates (radius, phi, theta) for orbit position. */
    this._spherical = new THREE.Spherical(100, Math.PI / 3, Math.PI / 4);
    /** @type {boolean} Flag indicating camera parameters need to be re-applied. */
    this._dirty = true;

    /** @type {THREE.Frustum} Reusable frustum instance. */
    this._frustumOut = new THREE.Frustum();
    /** @type {Float32Array} Cached resolution uniform (2 elements). */
    this._uRes = new Float32Array(2);
    /** @type {Float32Array} Cached pan uniform (2 elements). */
    this._uPan = new Float32Array(2);
    /** @type {Float32Array} Cached center uniform (3 elements). */
    this._uCenter = new Float32Array(3);

    /** @type {Object|null} Cached FPS uniform object. */
    this._cachedFPSUniforms = null;
    /** @type {number} Cached viewport width for FPS uniform cache invalidation. */
    this._cachedFPSW = 0;
    /** @type {number} Cached viewport height for FPS uniform cache invalidation. */
    this._cachedFPSH = 0;
    /** @type {boolean} Whether FPS uniforms need recalculation. */
    this._fpsUniformsDirty = true;
    /** @type {Object|null} Reference to the currently loaded point cloud for face-center calculation. */
    this._cloud = null;
  }

  /**
   * Gets the current movement speed in FPS mode.
   * @returns {number} Speed proportional to orbit radius.
   */
  get fpsSpeed() {
    return this._spherical.radius * 0.05;
  }

  /**
   * Sets the FPS movement speed by adjusting the orbit radius.
   * @param {number} v Desired speed value.
   */
  set fpsSpeed(v) {
    this._spherical.radius = v / 0.05;
    this._dirty = true;
  }

  /**
   * Rotates the camera around the target point by the given yaw and pitch deltas.
   * Clamps pitch to avoid gimbal-lock and updates the target to face
   * the most visible bounding-box side when a cloud is loaded.
   *
   * @param {number} dyaw Delta yaw angle in radians.
   * @param {number} dpitch Delta pitch angle in radians.
   */
  orbit(dyaw, dpitch) {
    this._spherical.theta -= dyaw;
    this._spherical.phi -= dpitch;
    if (this._spherical.phi < MIN_POLAR) this._spherical.phi = MIN_POLAR;
    if (this._spherical.phi > MAX_POLAR) this._spherical.phi = MAX_POLAR;
    if (this._cloud) {
      const rotationXDeg = (this._spherical.phi - Math.PI / 2) * 180 / Math.PI;
      const angle = -this._spherical.theta + Math.PI / 4;
      const newTarget = this._getVisibleFaceCenter(this._cloud, angle, rotationXDeg);
      this._target.set(newTarget[0], newTarget[1], newTarget[2]);
    }
    this._dirty = true;
  }

  /**
   * Zooms in/out by multiplying the orbit radius by the given factor.
   * Clamps radius to allowable range.
   *
   * @param {number} factor Scale factor (> 1 to zoom out, < 1 to zoom in).
   */
  dolly(factor) {
    this._spherical.radius *= factor;
    if (this._spherical.radius < MIN_RADIUS) this._spherical.radius = MIN_RADIUS;
    if (this._spherical.radius > MAX_RADIUS) this._spherical.radius = MAX_RADIUS;
    this._dirty = true;
  }

  /**
   * Pans the camera target in screen-space X and Y directions.
   * Disregards vertical component of the forward direction to stay
   * on a horizontal plane.
   *
   * @param {number} dx Horizontal pan delta (screen units).
   * @param {number} dy Vertical pan delta (screen units).
   */
  pan(dx, dy) {
    this._ensureUpdated();
    this.perspectiveCamera.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.length() < 0.001) _v3.set(0, 0, -1);
    _v3.normalize();
    _v3b.crossVectors(_v3, _up).normalize();
    _v3c.crossVectors(_v3b, _v3).normalize();
    const scale = this._spherical.radius * 0.0005;
    this._target.addScaledVector(_v3b, dx * scale);
    this._target.addScaledVector(_v3c, dy * scale);
    this._dirty = true;
  }

  /**
   * Moves the target forward (along the camera's horizontal direction).
   *
   * @param {number} dist Distance to move.
   */
  moveForward(dist) {
    this._ensureUpdated();
    this.perspectiveCamera.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.length() < 0.001) _v3.set(0, 0, -1);
    _v3.normalize();
    this._target.addScaledVector(_v3, dist);
    this._dirty = true;
  }

  /**
   * Moves the target right (perpendicular to the camera forward and world up).
   *
   * @param {number} dist Distance to move.
   */
  moveRight(dist) {
    this._ensureUpdated();
    this._getCameraRight(_v3);
    this._target.addScaledVector(_v3, dist);
    this._dirty = true;
  }

  /**
   * Moves the target directly up along the world Y-axis.
   *
   * @param {number} dist Distance to move.
   */
  moveUp(dist) {
    this._target.y += dist;
    this._dirty = true;
  }

  /**
   * Applies pending orbit calculations if the dirty flag is set.
   * @private
   */
  _ensureUpdated() {
    if (this._dirty) this._applyOrbit();
  }

  /**
   * Computes the camera's right direction vector (horizontal plane only).
   * @private
   * @param {THREE.Vector3} target Output vector.
   */
  _getCameraRight(target) {
    this.perspectiveCamera.getWorldDirection(_v3b);
    _v3b.y = 0;
    if (_v3b.length() < 0.001) _v3b.set(0, 0, -1);
    _v3b.normalize();
    target.crossVectors(_v3b, _up).normalize();
  }

  /**
   * Determines the center of the point-cloud bounding-box face that is most
   * visible from the given viewing angle and vertical inclination.
   *
   * @private
   * @param {Object} cloud Point cloud object with a {min, max} bounds array.
   * @param {number} angle Horizontal viewing angle in radians.
   * @param {number} [rotationXDeg=0] Vertical rotation in degrees.
   *   Values > 45 select the top face, < -45 the bottom face.
   * @returns {number[]} [x, y, z] world-space center of the visible face.
   */
  _getVisibleFaceCenter(cloud, angle, rotationXDeg = 0) {
    if (!cloud || !cloud.bounds) return [0, 0, 0];
    
    const b = cloud.bounds;
    const centerX = (b.min[0] + b.max[0]) / 2;
    const centerY = (b.min[1] + b.max[1]) / 2;
    const centerZ = (b.min[2] + b.max[2]) / 2;
    
    let faceY;
    if (rotationXDeg > 45) {
      faceY = b.max[1];
    } else if (rotationXDeg < -45) {
      faceY = b.min[1];
    } else {
      faceY = centerY;
    }
    
    // Normalize angle to [0, 2*PI) to determine the quadrant
    const normalizedAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    
    // Each quadrant covers one of the four side faces
    const quadrant = Math.floor(normalizedAngle / (Math.PI / 2));
    const localAngle = normalizedAngle - quadrant * (Math.PI / 2);
    const t = localAngle / (Math.PI / 2);
    
    // Face centers for the four vertical sides (interpolated edges)
    const faceCenters = [
      { x: centerX, z: b.max[1] },
      { x: b.max[0], z: centerY },
      { x: centerX, z: b.min[1] },
      { x: b.min[0], z: centerY }
    ];
    
    const idx1 = quadrant % 4;
    const idx2 = (quadrant + 1) % 4;
    
    // Linear interpolation between two adjacent face centers
    const x = faceCenters[idx1].x + (faceCenters[idx2].x - faceCenters[idx1].x) * t;
    const z = faceCenters[idx1].z + (faceCenters[idx2].z - faceCenters[idx1].z) * t;
    
    return [x, faceY, z];
  }

  /**
   * Converts spherical coordinates to a cartesian position relative to target
   * and updates the perspective camera.
   * @private
   */
  _applyOrbit() {
    _v3.setFromSpherical(this._spherical).add(this._target);
    this.perspectiveCamera.position.copy(_v3);
    this.perspectiveCamera.lookAt(this._target);
    this.perspectiveCamera.updateMatrixWorld();
  }

  /**
   * Called each frame to reconcile camera state with the current mode.
   * In FPS mode the orbit is applied when dirty; isometric mode is handled
   * by the internal Camera.
   *
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    if (this.activeMode === 'fps') {
      if (!this._dirty) return;
      this._applyOrbit();
    }
  }

  /**
   * Marks the camera state as needing an update on the next frame.
   * Also invalidates the FPS uniform cache.
   */
  markDirty() {
    this._dirty = true;
    this._fpsUniformsDirty = true;
  }

  /**
   * Consumes and returns the dirty flag. In FPS mode, only the internal flag
   * is read; in isometric mode the delegate camera's dirty flag is OR-ed.
   *
   * @returns {boolean} Whether the camera state was dirty.
   */
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

  /**
   * Toggles between 'isometric' and 'fps' modes. When switching to FPS,
   * the target is re-centered on the most visible cloud face.
   */
  switchMode() {
    if (this.activeMode === 'isometric') {
      this.activeMode = 'fps';
      if (this._cloud) {
        const rotationXDeg = (this._spherical.phi - Math.PI / 2) * 180 / Math.PI;
        const angle = -this._spherical.theta + Math.PI / 4;
        const newTarget = this._getVisibleFaceCenter(this._cloud, angle, rotationXDeg);
        this._target.set(newTarget[0], newTarget[1], newTarget[2]);
      }
      this._applyOrbit();
    } else {
      this.activeMode = 'isometric';
    }
    this._dirty = true;
    this._fpsUniformsDirty = true;
  }

  /**
   * Explicitly sets the camera mode.
   *
   * @param {'isometric'|'fps'} mode Desired camera mode.
   */
  setMode(mode) {
    this.activeMode = mode;
    this._dirty = true;
    this._fpsUniformsDirty = true;
  }

  /**
   * Returns the view matrix (world-to-camera) of the perspective camera.
   * @returns {THREE.Matrix4} View matrix.
   */
  getViewMatrix() {
    return this.perspectiveCamera.matrixWorldInverse;
  }

  /**
   * Returns the projection matrix of the perspective camera.
   * @returns {THREE.Matrix4} Projection matrix.
   */
  getProjectionMatrix() {
    return this.perspectiveCamera.projectionMatrix;
  }

  /**
   * Returns the world-space position of the perspective camera.
   * @returns {THREE.Vector3} Camera world position.
   */
  getWorldPosition() {
    return this.perspectiveCamera.position;
  }

  /**
   * Builds and returns a {@link THREE.Frustum} from the current view and
   * projection matrices for frustum culling.
   *
   * @returns {THREE.Frustum} Current view frustum.
   */
  getFrustum() {
    this.update();
    _m4.multiplyMatrices(
      this.perspectiveCamera.projectionMatrix,
      this.perspectiveCamera.matrixWorldInverse,
    );
    this._frustumOut.setFromProjectionMatrix(_m4);
    return this._frustumOut;
  }

  /**
   * Fills the provided vector with the camera's world-space forward direction.
   *
   * @param {THREE.Vector3} target Vector to store the direction in.
   * @returns {THREE.Vector3} The target vector (for chaining).
   */
  getWorldDirection(target) {
    this.perspectiveCamera.getWorldDirection(target);
    return target;
  }

  /**
   * Sets the look-at target position.
   *
   * @param {number[]} center [x, y, z] world-space target.
   */
  setTarget(center) {
    this._target.set(center[0], center[1], center[2]);
    this._dirty = true;
  }

  /**
   * Adjusts the camera so that the entire point cloud is visible.
   *
   * @param {Object} cloud Point cloud object with bounds.
   * @param {number} w Viewport width in pixels.
   * @param {number} h Viewport height in pixels.
   */
  fitToBounds(cloud, w, h) {
    if (this.activeMode === 'fps') {
      this._fitToBoundsFPS(cloud);
    } else {
      this.isometricCamera.fitToBounds(cloud, w, h);
    }
    this._dirty = true;
  }

  /**
   * Internal method to fit the FPS camera to the cloud bounds.
   * Centers the target on the visible face and adjusts radius.
   *
   * @private
   * @param {Object} cloud Point cloud object with bounds.
   */
  _fitToBoundsFPS(cloud) {
    if (!cloud || !cloud.bounds) return;
    const min = cloud.bounds.min;
    const max = cloud.bounds.max;
    const rotationXDeg = (this._spherical.phi - Math.PI / 2) * 180 / Math.PI;
    const angle = -this._spherical.theta + Math.PI / 4;
    const newTarget = this._getVisibleFaceCenter(cloud, angle, rotationXDeg);
    this._target.set(newTarget[0], newTarget[1], newTarget[2]);
    const dx = max[0] - min[0];
    const dy = max[1] - min[1];
    const dz = max[2] - min[2];
    const maxDim = Math.max(dx, dy, dz);

    this._spherical.theta = Math.PI / 4;
    this._spherical.phi = Math.PI / 3;
    this._spherical.radius = maxDim * 1.5;
  }

  /**
   * Updates the viewport dimensions, adjusting aspect ratio and projection.
   *
   * @param {number} w Viewport width in pixels.
   * @param {number} h Viewport height in pixels.
   */
  setViewport(w, h) {
    this.isometricCamera.setViewport(w, h);
    this.perspectiveCamera.aspect = w / h;
    this.perspectiveCamera.updateProjectionMatrix();
    this._dirty = true;
  }

  /**
   * Sets the reference center for both cameras.
   *
   * @param {number[]} center [x, y, z] reference center.
   */
  setRefCenter(center) {
    this.isometricCamera.setRefCenter(center);
    this.setTarget(center);
  }

  /**
   * Associates a point cloud with the controller, recalculating the target
   * to face the most visible bounding-box face.
   *
   * @param {Object} cloud Point cloud object.
   */
  setCloud(cloud) {
    this._cloud = cloud;
    this.isometricCamera.setCloud(cloud);
    if (cloud) {
      const rotationXDeg = (this._spherical.phi - Math.PI / 2) * 180 / Math.PI;
      const angle = -this._spherical.theta + Math.PI / 4;
      const newTarget = this._getVisibleFaceCenter(cloud, angle, rotationXDeg);
      this._target.set(newTarget[0], newTarget[1], newTarget[2]);
      this._dirty = true;
    }
  }

  /**
   * Resets camera state to default position, target, and spherical coordinates.
   */
  reset() {
    this.isometricCamera.reset();
    this._spherical.set(100, Math.PI / 3, Math.PI / 4);
    this._target.set(0, 0, 0);
    this._dirty = true;
  }

  /**
   * Returns a uniform object suitable for the point-cloud render shader.
   * Caches FPS uniforms per viewport size to avoid redundant computations.
   *
   * @param {number} w Viewport width in pixels.
   * @param {number} h Viewport height in pixels.
   * @param {Object} cloud Point cloud object for intensity / Z-range metadata.
   * @returns {Object} Uniform key-value pairs.
   */
  getUniforms(w, h, cloud) {
    if (this.activeMode === 'fps') {
      return this._getUniformsFPS(w, h, cloud);
    }
    return this.isometricCamera.getUniforms(w, h, cloud);
  }

  /**
   * Builds and caches the uniform object for FPS mode.
   *
   * @private
   * @param {number} w Viewport width in pixels.
   * @param {number} h Viewport height in pixels.
   * @param {Object} cloud Point cloud object.
   * @returns {Object} FPS uniform key-value pairs.
   */
  _getUniformsFPS(w, h, cloud) {
    if (!this._fpsUniformsDirty && this._cachedFPSUniforms && this._cachedFPSW === w && this._cachedFPSH === h) {
      return this._cachedFPSUniforms;
    }
    this.update();
    const center = cloud ? cloud.center : [0, 0, 0];
    const zMin = cloud ? cloud.zMin - center[2] : 0;
    const zMax = cloud ? cloud.zMax - center[2] : 1;
    const spacing = cloud && cloud.octreeGeometry && cloud.octreeGeometry.spacing
      ? cloud.octreeGeometry.spacing : 1.0;
    this._uRes[0] = w; this._uRes[1] = h;
    this._uCenter[0] = center[0]; this._uCenter[1] = center[1]; this._uCenter[2] = center[2];

    this._cachedFPSUniforms = {
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
    this._cachedFPSW = w;
    this._cachedFPSH = h;
    this._fpsUniformsDirty = false;
    return this._cachedFPSUniforms;
  }

  // ─── Delegate getters / setters for isometric camera ───

  /** @returns {number} Pan X offset. */
  get panX() { return this.isometricCamera.panX; }
  /** @param {number} v Pan X offset. */
  set panX(v) { this.isometricCamera.panX = v; }
  /** @returns {number} Pan Y offset. */
  get panY() { return this.isometricCamera.panY; }
  /** @param {number} v Pan Y offset. */
  set panY(v) { this.isometricCamera.panY = v; }
  /** @returns {number} Zoom level. */
  get zoom() { return this.isometricCamera.zoom; }
  /** @param {number} v Zoom level. */
  set zoom(v) { this.isometricCamera.zoom = v; }
  /** @returns {number} Rotation angle in radians. */
  get rotAngle() { return this.isometricCamera.rotAngle; }
  /** @returns {number} Rotation around X axis in degrees. */
  get rotationXDeg() { return this.isometricCamera.rotationXDeg; }
  /** @param {number} v Rotation around X axis in degrees. */
  set rotationXDeg(v) { this.isometricCamera.rotationXDeg = v; }
  /** @returns {number} Rotation around Y axis in degrees. */
  get rotationYDeg() { return this.isometricCamera.rotationYDeg; }
  /** @param {number} v Rotation around Y axis in degrees. */
  set rotationYDeg(v) { this.isometricCamera.rotationYDeg = v; }
  /** @returns {number} View offset in degrees. */
  get viewOffsetDeg() { return this.isometricCamera.viewOffsetDeg; }
  /** @returns {number} Eight-directional index. */
  get eightDir() { return this.isometricCamera.eightDir; }
  /** @returns {number} Current discrete view index. */
  get viewIndex() { return this.isometricCamera.viewIndex; }
  /** @returns {number[]} Reference center [x, y, z]. */
  get refCenter() { return this.isometricCamera.refCenter; }
  /** @returns {number[]} Cloud center [x, y, z]. */
  get _cloudCenter() { return this.isometricCamera._cloudCenter; }

  // ─── Delegate methods for isometric camera ───

  /**
   * Zooms toward a screen-space point.
   * @param {number} factor Zoom factor.
   * @param {number} sx Normalized screen X (0–1).
   * @param {number} sy Normalized screen Y (0–1).
   * @param {number} w Viewport width in pixels.
   * @param {number} h Viewport height in pixels.
   */
  zoomAt(factor, sx, sy, w, h) { this.isometricCamera.zoomAt(factor, sx, sy, w, h); }
  /** Rotates the isometric view one step left. */
  rotateLeft() { this.isometricCamera.rotateLeft(); }
  /** Rotates the isometric view one step right. */
  rotateRight() { this.isometricCamera.rotateRight(); }
  /**
   * Rotates the isometric view horizontally.
   * @param {number} d Rotation delta in degrees.
   */
  rotateHorizontal(d) { this.isometricCamera.rotateHorizontal(d); }
  /**
   * Rotates the isometric view vertically.
   * @param {number} d Rotation delta in degrees.
   */
  rotateVertical(d) { this.isometricCamera.rotateVertical(d); }
  /**
   * Sets the discrete isometric view index.
   * @param {number} i View index.
   */
  setView(i) { this.isometricCamera.setView(i); }
  /**
   * Sets the view offset.
   * @param {number} d Offset in degrees.
   */
  setViewOffset(d) { this.isometricCamera.setViewOffset(d); }
  /**
   * Projects a world-space point to a custom screen-space representation.
   * @param {number} x X coordinate.
   * @param {number} y Y coordinate.
   * @param {number} z Z coordinate.
   * @returns {Object} Projected point.
   */
  project(x, y, z) { return this.isometricCamera.project(x, y, z); }
  /**
   * Delegates cloud assignment to the internal isometric camera and stores
   * a local reference.
   * @param {Object} c Point cloud object.
   */
  setCloud(c) { this.isometricCamera.setCloud(c); this._cloud = c; }
}
