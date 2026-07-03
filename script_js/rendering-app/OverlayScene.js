/**
 * @file OverlayScene.js
 * @description Manages a Three.js scene used for rendering overlay elements
 *   (markers and lines) on top of the main point-cloud view. Uses an
 *   orthographic camera matching the logical canvas dimensions so that
 *   overlay geometry is drawn in screen-space.
 */

import * as THREE from 'three';

/**
 * Three.js overlay scene hosting spherical markers and polylines.
 * The camera is orthographic and configured to match the canvas size;
 * call `updateCamera(width, height)` whenever the viewport is resized.
 */
export class OverlayScene {
  constructor() {
    /** @type {THREE.Scene} */
    this.scene = new THREE.Scene();
    /** @type {THREE.OrthographicCamera} */
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 100;

    /** @type {Map<string, THREE.Mesh>} */
    this._markers = new Map();
    /** @type {Map<string, THREE.Line>} */
    this._lines = new Map();

    /** @type {THREE.SphereGeometry} Shared geometry for all markers. */
    this._markerGeometry = new THREE.SphereGeometry(1, 16, 16);
    /** @type {THREE.MeshBasicMaterial} Template material (cloned per marker). */
    this._markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x58a6ff,
      transparent: true,
      opacity: 0.9,
    });

    /** @type {THREE.LineBasicMaterial} Template line material (cloned per line). */
    this._lineMaterial = new THREE.LineBasicMaterial({
      color: 0x58a6ff,
      linewidth: 2,
    });
  }

  /**
   * Create and add a spherical marker to the scene.
   * @param {string} id - Unique identifier used for later removal.
   * @param {THREE.Vector3} position - World-space position.
   * @param {number} [size=3] - Uniform scale applied to the sphere.
   * @returns {THREE.Mesh}
   */
  addMarker(id, position, size = 3) {
    const mesh = new THREE.Mesh(this._markerGeometry, this._markerMaterial.clone());
    mesh.position.copy(position);
    mesh.scale.setScalar(size);
    mesh.userData.id = id;
    this.scene.add(mesh);
    this._markers.set(id, mesh);
    return mesh;
  }

  /**
   * Remove a marker and dispose its material.
   * @param {string} id
   */
  removeMarker(id) {
    const mesh = this._markers.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.material.dispose();
      this._markers.delete(id);
    }
  }

  /**
   * Create and add a polyline through a list of world-space points.
   * @param {string} id - Unique identifier.
   * @param {THREE.Vector3[]} points - Array of world-space positions.
   * @returns {THREE.Line}
   */
  addLine(id, points) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, this._lineMaterial.clone());
    line.userData.id = id;
    this.scene.add(line);
    this._lines.set(id, line);
    return line;
  }

  /**
   * Remove a line and dispose its geometry and material.
   * @param {string} id
   */
  removeLine(id) {
    const line = this._lines.get(id);
    if (line) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      this._lines.delete(id);
    }
  }

  /**
   * Remove all markers and lines, disposing their resources.
   */
  clear() {
    for (const [id, mesh] of this._markers) {
      this.scene.remove(mesh);
      mesh.material.dispose();
    }
    this._markers.clear();

    for (const [id, line] of this._lines) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this._lines.clear();
  }

  /**
   * Update the orthographic camera frustum to match the given canvas dimensions.
   * @param {number} width - Logical CSS width in pixels.
   * @param {number} height - Logical CSS height in pixels.
   */
  updateCamera(width, height) {
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Dispose all scene objects and shared resources.
   */
  dispose() {
    this.clear();
    this._markerGeometry.dispose();
    this._markerMaterial.dispose();
    this._lineMaterial.dispose();
  }
}
