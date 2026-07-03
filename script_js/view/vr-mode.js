/**
 * @file vr-mode.js
 * @description WebXR-based virtual-reality mode for the point-cloud viewer.
 *   Creates a separate Three.js scene with stereo rendering, head-tracking
 *   camera, and VR controller support. Integrates with the main App to
 *   display the point cloud inside an immersive VR session on compatible
 *   headsets (Oculus, Vive, etc.).
 *
 *   Features:
 *     - WebXR session initialisation and teardown
 *     - Automatic stereo rendering via Three.js WebXRManager
 *     - Head-tracked camera following the viewer pose
 *     - Optional VR controller visualisation and event handlers
 *     - Point-cloud mesh generation from the app's loaded data
 */

import * as THREE from 'three';

/**
 * Manages the VR viewing mode. Builds its own Three.js renderer and scene,
 * copies the point cloud into a Points mesh, and handles the WebXR session
 * lifecycle (start, render loop, end).
 */
export class VRMode {
  /**
   * @param {object} app - The main App instance providing .cloud and .canvas.
   */
  constructor(app) {
    /** @type {object} */
    this.app = app;
    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {THREE.Scene|null} */
    this.scene = null;
    /** @type {THREE.PerspectiveCamera|null} */
    this.camera = null;
    /** @type {XRSession|null} */
    this.session = null;
    /** @type {XRReferenceSpace|null} */
    this.referenceSpace = null;
    /** @type {boolean} Whether a VR session is currently active. */
    this.isActive = false;
    /** @type {THREE.Points|null} Mesh representing the point cloud. */
    this.pointCloudMesh = null;
    /** @type {THREE.Group[]} VR controller objects. */
    this.controllers = [];
  }

  /**
   * Check if the browser supports immersive-vr sessions.
   * @returns {Promise<boolean>}
   */
  async isSupported() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch (err) {
      return false;
    }
  }

  /**
   * Initialise the Three.js renderer, scene, camera, lights, and controllers.
   * Called automatically by startSession() if not already initialised.
   * @throws {Error} If WebXR is not supported.
   */
  async init() {
    if (!await this.isSupported()) {
      throw new Error('WebXR non supportato su questo dispositivo/browser');
    }

    // Create a dedicated Three.js WebGLRenderer with XR enabled.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      10000
    );
    this.scene.add(this.camera);

    // Static ambient + directional lighting for the point mesh.
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    this.scene.add(directionalLight);

    this._initControllers();
  }

  /**
   * Create two VR controllers with visual representations and event listeners.
   * @private
   */
  _initControllers() {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);

      controller.addEventListener('selectstart', () => {
        this._onControllerSelect(controller);
      });

      controller.addEventListener('squeezestart', () => {
        this._onControllerSqueeze(controller);
      });

      this.scene.add(controller);
      this.controllers.push(controller);

      // Add a simple cylinder visual for the controller.
      const geometry = new THREE.CylinderGeometry(0.01, 0.02, 0.1, 8);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        color: 0x00ff00,
        metalness: 0.5,
        roughness: 0.5
      });
      const mesh = new THREE.Mesh(geometry, material);
      controller.add(mesh);
    }
  }

  /**
   * Handle the trigger (select) event on a VR controller.
   * @param {THREE.Group} controller
   * @private
   */
  _onControllerSelect(controller) {
    console.log('Controller select:', controller);
    // Extension point: add point-cloud interactions here.
  }

  /**
   * Handle the grip (squeeze) event on a VR controller.
   * @param {THREE.Group} controller
   * @private
   */
  _onControllerSqueeze(controller) {
    console.log('Controller squeeze:', controller);
    // Extension point: add point-cloud interactions here.
  }

  /**
   * Rebuild the point-cloud mesh from the app's current cloud data.
   * Removes the previous mesh if one exists.
   */
  updatePointCloud() {
    if (!this.app.cloud || !this.scene) return;

    if (this.pointCloudMesh) {
      this.scene.remove(this.pointCloudMesh);
      this.pointCloudMesh.geometry.dispose();
      this.pointCloudMesh.material.dispose();
    }

    const cloud = this.app.cloud;
    const positions = cloud.positions;
    const colors = cloud.colors;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(
      Array.from(colors).map(c => c / 255), 3
    ));

    const material = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      sizeAttenuation: true
    });

    this.pointCloudMesh = new THREE.Points(geometry, material);

    // Centre and scale the cloud to fit nicely in the VR scene.
    const center = cloud.center;
    this.pointCloudMesh.position.set(-center[0], -center[1], -center[2]);

    const bounds = cloud.bounds;
    const size = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
    const scale = 10 / size; // Normalise to ~10 world units.
    this.pointCloudMesh.scale.set(scale, scale, scale);

    this.scene.add(this.pointCloudMesh);
  }

  /**
   * Request an immersive-vr session and start the XR render loop.
   * Swaps visibility: hides the main canvas, shows the VR canvas.
   * @throws {Error} If session request or setup fails.
   */
  async startSession() {
    if (this.isActive) return;

    try {
      if (!this.renderer) {
        await this.init();
      }

      this.session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      });

      await this.renderer.xr.setSession(this.session);

      this.referenceSpace = await this.session.requestReferenceSpace('local-floor');

      this.updatePointCloud();

      // Handle session end (e.g. user removes headset).
      this.session.addEventListener('end', () => {
        this.isActive = false;
        this.session = null;
        this.app.canvas.style.display = 'block';
        this.renderer.domElement.style.display = 'none';
      });

      // Swap canvas visibility.
      this.app.canvas.style.display = 'none';
      this.renderer.domElement.style.display = 'block';

      // Append VR canvas to the DOM if not already present.
      if (!this.renderer.domElement.parentNode) {
        document.getElementById('main').appendChild(this.renderer.domElement);
      }

      this.isActive = true;

      // Start the per-frame XR render loop.
      this.renderer.setAnimationLoop((time, frame) => {
        this._renderLoop(time, frame);
      });

    } catch (err) {
      console.error('Failed to start VR session:', err);
      throw err;
    }
  }

  /**
   * Called every XR frame. Updates the camera pose from head tracking and
   * renders the scene via the Three.js XR manager.
   * @param {number} time - Timestamp from the XR system.
   * @param {XRFrame} frame - The current XR frame.
   * @private
   */
  _renderLoop(time, frame) {
    if (!this.isActive || !this.session) return;

    // Update camera from the viewer pose.
    const pose = frame.getViewerPose(this.referenceSpace);
    if (pose) {
      const view = pose.views[0];
      if (view) {
        const position = view.transform.position;
        const orientation = view.transform.orientation;

        this.camera.position.set(position.x, position.y, position.z);
        this.camera.quaternion.set(
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w
        );
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * End the active VR session and stop the render loop.
   */
  async endSession() {
    if (!this.isActive || !this.session) return;

    try {
      await this.session.end();
      this.renderer.setAnimationLoop(null);
      this.isActive = false;
    } catch (err) {
      console.error('Failed to end VR session:', err);
    }
  }

  /**
   * Dispose of all GPU resources and end any active session.
   */
  dispose() {
    this.endSession();

    if (this.pointCloudMesh) {
      this.pointCloudMesh.geometry.dispose();
      this.pointCloudMesh.material.dispose();
    }

    if (this.renderer) {
      this.renderer.dispose();
    }

    this.controllers = [];
  }
}
