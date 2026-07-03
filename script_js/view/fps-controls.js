/**
 * @file fps-controls.js
 * @description First-person-style camera controls for the point-cloud viewer.
 *   Provides mouse look (orbit), right-click pan, scroll-wheel dolly zoom,
 *   touch-gesture navigation, and WASD keyboard movement through the scene.
 *   Designed to work with a CameraController that exposes orbit, pan, dolly,
 *   moveForward, moveRight, and moveUp methods.
 */

import * as THREE from 'three';

/** Mouse look sensitivity (radians per pixel). */
const LOOK_SENSITIVITY = 0.003;

/** Factor applied to fpsSpeed for keyboard movement. */
const MOVE_SPEED_FACTOR = 50;

/** Speed multiplier when the Shift key is held. */
const BOOST_MULTIPLIER = 3;

/**
 * First-person-style camera controls supporting mouse, touch, and keyboard
 * input. Wraps a CameraController instance and uses an AbortController for
 * clean event listener teardown.
 */
export class FPSControls {
  /**
   * @param {HTMLCanvasElement} canvas - The canvas receiving input events.
   * @param {object} cameraController - Controller with orbit, pan, dolly,
   *   moveForward, moveRight, moveUp, and fpsSpeed properties.
   */
  constructor(canvas, cameraController) {
    this.canvas = canvas;
    /** @type {object} Reference to the camera controller. */
    this.cc = cameraController;
    /** @type {boolean} Whether FPS controls are active. */
    this.enabled = false;

    this._dragging = false;
    this._dragButton = -1;
    /** @type {number[]} Last recorded mouse position [x, y]. */
    this._lastMouse = [0, 0];
    this._lastTouchDist = 0;
    /** @type {Set<string>} Currently pressed keys (lowercase). */
    this._keys = new Set();
    /** @type {AbortController|null} For removing all listeners at once. */
    this._abortController = null;

    this._bindEvents();
  }

  /**
   * Register all DOM event listeners using an AbortController signal so they
   * can be removed in a single call to `dispose()`.
   * @private
   */
  _bindEvents() {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const c = this.canvas;

    // Mouse-down begins a drag; records the button for subsequent differentiation.
    c.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this._dragging = true;
      this._lastMouse = [e.clientX, e.clientY];
      this._dragButton = e.button;
    }, { signal });

    // Mouse-move: right button = pan, any other button = orbit look.
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this._dragging) return;
      if (e.which === 0) { this._dragging = false; return; }

      const dx = e.clientX - this._lastMouse[0];
      const dy = e.clientY - this._lastMouse[1];
      this._lastMouse = [e.clientX, e.clientY];

      if (this._dragButton === 2) {
        this.cc.pan(dx, dy);
      } else {
        this.cc.orbit(-dx * LOOK_SENSITIVITY, -dy * LOOK_SENSITIVITY);
      }
    }, { signal });

    window.addEventListener('mouseup', (e) => {
      if (e.button === this._dragButton) this._dragging = false;
    }, { signal });

    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    // Scroll wheel dolly.
    c.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.cc.dolly(e.deltaY > 0 ? 0.9 : 1.1);
    }, { passive: false, signal });

    // Touch: single-finger for orbit, two-finger pinch for dolly.
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
        this.cc.orbit(-dx * LOOK_SENSITIVITY, -dy * LOOK_SENSITIVITY);
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (this._lastTouchDist > 0) {
          this.cc.dolly(this._lastTouchDist / dist);
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

  /**
   * Apply keyboard movement based on currently held keys.
   * Call once per animation frame.
   * @param {number} dt - Delta time in seconds since the last frame.
   */
  update(dt) {
    if (!this.enabled || this._keys.size === 0) return;

    const cc = this.cc;
    const boost = this._keys.has('shift') ? BOOST_MULTIPLIER : 1;
    const speed = cc.fpsSpeed * MOVE_SPEED_FACTOR * boost * dt;

    if (this._keys.has('w') || this._keys.has('arrowup')) {
      cc.moveForward(speed);
    }
    if (this._keys.has('s') || this._keys.has('arrowdown')) {
      cc.moveForward(-speed);
    }
    if (this._keys.has('a') || this._keys.has('arrowleft')) {
      cc.moveRight(-speed);
    }
    if (this._keys.has('d') || this._keys.has('arrowright')) {
      cc.moveRight(speed);
    }
    if (this._keys.has('q')) {
      cc.moveUp(-speed);
    }
    if (this._keys.has('e')) {
      cc.moveUp(speed);
    }
  }

  /**
   * Remove all event listeners by aborting the AbortSignal.
   */
  dispose() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}
