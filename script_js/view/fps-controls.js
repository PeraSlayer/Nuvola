import * as THREE from 'three';

const ORBIT_SENSITIVITY = 0.003;
const PAN_SENSITIVITY = 0.002;
const MOVE_SPEED = 50;
const MOVE_SPEED_BOOST = 2;

export class FPSControls {
  constructor(canvas, fpsCamera) {
    this.canvas = canvas;
    this.fpsCamera = fpsCamera;
    this.enabled = false;

    this._dragging = false;
    this._dragButton = -1;
    this._lastMouse = [0, 0];
    this._lastTouchDist = 0;
    this._keys = new Set();
    this._abortController = null;

    this._bindEvents();
  }

  _bindEvents() {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this._dragging = true;
      this._lastMouse = [e.clientX, e.clientY];
      this._dragButton = e.button;
    }, { signal });

    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this._dragging) return;
      if (e.which === 0) { this._dragging = false; return; }

      const dx = e.clientX - this._lastMouse[0];
      const dy = e.clientY - this._lastMouse[1];
      this._lastMouse = [e.clientX, e.clientY];

      if (this._dragButton === 2) {
        this.fpsCamera.pan(dx, dy);
      } else {
        this.fpsCamera.orbit(-dx * ORBIT_SENSITIVITY, -dy * ORBIT_SENSITIVITY);
      }
    }, { signal });

    window.addEventListener('mouseup', (e) => {
      if (e.button === this._dragButton) this._dragging = false;
    }, { signal });

    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    c.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      this.fpsCamera.zoom(factor);
    }, { passive: false, signal });

    c.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      if (e.touches.length === 1) {
        this._dragging = true;
        this._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this._lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: true, signal });

    c.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
      if (e.touches.length === 1 && this._dragging) {
        const dx = e.touches[0].clientX - this._lastMouse[0];
        const dy = e.touches[0].clientY - this._lastMouse[1];
        this._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
        this.fpsCamera.orbit(-dx * ORBIT_SENSITIVITY, -dy * ORBIT_SENSITIVITY);
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (this._lastTouchDist > 0) {
          this.fpsCamera.zoom(this._lastTouchDist / dist);
        }
        this._lastTouchDist = dist;
      }
    }, { passive: true, signal });

    c.addEventListener('touchend', () => {
      this._dragging = false;
      this._lastTouchDist = 0;
    }, { signal });

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      this._keys.add(e.key.toLowerCase());
    }, { signal });

    window.addEventListener('keyup', (e) => {
      this._keys.delete(e.key.toLowerCase());
    }, { signal });
  }

  update(dt) {
    if (!this.enabled || this._keys.size === 0) return;

    const cam = this.fpsCamera;
    cam.update();

    const forward = new THREE.Vector3();
    forward.subVectors(cam.camera.position, cam.target);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
    right.normalize();

    const speed = MOVE_SPEED * (this._keys.has('shift') ? MOVE_SPEED_BOOST : 1) * dt;

    if (this._keys.has('w') || this._keys.has('arrowup')) {
      cam.target.addScaledVector(forward, -speed);
    }
    if (this._keys.has('s') || this._keys.has('arrowdown')) {
      cam.target.addScaledVector(forward, speed);
    }
    if (this._keys.has('a') || this._keys.has('arrowleft')) {
      cam.target.addScaledVector(right, -speed);
    }
    if (this._keys.has('d') || this._keys.has('arrowright')) {
      cam.target.addScaledVector(right, speed);
    }

    cam.markDirty();
  }

  dispose() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}
