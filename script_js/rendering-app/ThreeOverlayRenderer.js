/**
 * @file ThreeOverlayRenderer.js
 * @description Thin wrapper around a dedicated Three.js WebGLRenderer that draws
 *   overlay geometry (markers and lines from {@link OverlayScene}) on top of
 *   the primary WebGL2 point-cloud canvas. Both renderers share the same
 *   HTMLCanvasElement but maintain independent GL contexts.
 */

import * as THREE from 'three';
import { OverlayScene } from './OverlayScene.js';

/**
 * Three.js overlay renderer that shares its canvas with the main point-cloud
 * renderer. Provides methods to add/remove markers and lines via the
 * underlying {@link OverlayScene}.
 */
export class ThreeOverlayRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The canvas to render into (shared with
   *   the primary WebGL2 context).
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);

    /** @type {OverlayScene} */
    this.overlayScene = new OverlayScene();
    this._width = 1;
    this._height = 1;
  }

  /**
   * Resize the renderer and the overlay camera to the given logical dimensions.
   * @param {number} width - Logical CSS width.
   * @param {number} height - Logical CSS height.
   */
  setSize(width, height) {
    this._width = width;
    this._height = height;
    this.renderer.setSize(width, height, false);
    this.overlayScene.updateCamera(width, height);
  }

  /**
   * Clear and render the overlay scene.
   * @param {object} camera - The main application camera (unused directly but
   *   accepted for interface compatibility).
   */
  render(camera) {
    this.renderer.clear();
    this.renderer.render(this.overlayScene.scene, this.overlayScene.camera);
  }

  /**
   * Add a spherical marker at a world-space position.
   * @param {string} id - Unique identifier for the marker.
   * @param {THREE.Vector3} worldPosition - World-space position.
   * @param {number} [size=3] - Marker radius in world units.
   * @returns {THREE.Mesh} The created marker mesh.
   */
  addMarker(id, worldPosition, size = 3) {
    return this.overlayScene.addMarker(id, worldPosition, size);
  }

  /**
   * Remove a marker by its id.
   * @param {string} id
   */
  removeMarker(id) {
    this.overlayScene.removeMarker(id);
  }

  /**
   * Add a polyline through a list of world-space points.
   * @param {string} id - Unique identifier for the line.
   * @param {THREE.Vector3[]} points - Array of world-space points.
   * @returns {THREE.Line} The created line object.
   */
  addLine(id, points) {
    return this.overlayScene.addLine(id, points);
  }

  /**
   * Remove a line by its id.
   * @param {string} id
   */
  removeLine(id) {
    this.overlayScene.removeLine(id);
  }

  /**
   * Remove all markers and lines from the overlay scene.
   */
  clear() {
    this.overlayScene.clear();
  }

  /**
   * Dispose all Three.js resources (scene objects, geometries, materials,
   * and the WebGL renderer).
   */
  dispose() {
    this.overlayScene.dispose();
    this.renderer.dispose();
  }
}
