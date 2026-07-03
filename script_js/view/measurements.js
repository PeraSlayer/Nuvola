/**
 * @file measurements.js
 * @description Measurement tool that lets the user pick two points on the
 *   point cloud and computes horizontal, vertical, and Euclidean distances
 *   in 3D world coordinates. Visual feedback is provided via overlay markers
 *   and a connecting line through the Three.js overlay renderer, with a
 *   legacy 2D canvas fallback.
 */

import * as THREE from 'three';

/**
 * Two-point 3D distance measurement tool.
 * Stores point indices into the cloud and computes horizontal / vertical /
 * Euclidean distances in the cloud's original world coordinates.
 */
export class MeasurementTool {
  constructor() {
    /** @type {boolean} Whether the tool is currently active. */
    this.active = false;
    /** @type {number[]} Indices into the point cloud for the two picked points. */
    this.points = [];
    /** @type {number[][]} Screen positions of the picked points for overlay. */
    this.markers = [];

    /** @type {THREE.Mesh[]} Three.js marker meshes for the two measured points. */
    this._markerMeshes = [];
    /** @type {THREE.Line|null} Three.js line mesh connecting the two points. */
    this._lineMesh = null;
  }

  /**
   * Toggle the measurement tool on/off.
   * @returns {boolean} New active state.
   */
  toggle() {
    this.active = !this.active;
    if (!this.active) this.clear();
    return this.active;
  }

  /**
   * Clear all picked points and visual elements.
   */
  clear() {
    this.points = [];
    this.markers = [];
    this._markerMeshes = [];
    this._lineMesh = null;
  }

  /**
   * Handle a click on the canvas. Picks the nearest point in the cloud and
   * stores its index and screen position.
   * @param {object} cloud - Point cloud object with `.pickNearest()` and `.positions`.
   * @param {object} camera - Camera object (unused, passed for API consistency).
   * @param {object} renderer - Renderer used for picking.
   * @param {number} sx - Screen X coordinate of the click.
   * @param {number} sy - Screen Y coordinate of the click.
   * @returns {boolean} True when both points have been captured (measurement complete).
   */
  onClick(cloud, camera, renderer, sx, sy) {
    if (!this.active) return false;
    const idx = cloud.pickNearest(camera, renderer, sx, sy);
    if (idx < 0) return false;
    const p = cloud.positions;
    this.points.push(idx);
    this.markers.push([sx, sy]);
    return this.points.length >= 2;
  }

  /**
   * Compute horizontal, vertical, and Euclidean distances between the two
   * picked points in 3D world units.
   * @param {object} cloud - Point cloud object with `.positions` Float32Array.
   * @returns {object|null} Object with {horizontal, vertical, euclidean, p0, p1}
   *   or null if fewer than 2 points are selected.
   */
  getDistances(cloud) {
    if (this.points.length < 2) return null;
    const p = cloud.positions;
    const i0 = this.points[0], i1 = this.points[1];
    const x0 = p[i0*3],   y0 = p[i0*3+1], z0 = p[i0*3+2];
    const x1 = p[i1*3],   y1 = p[i1*3+1], z1 = p[i1*3+2];
    const dx = x1-x0, dy = y1-y0, dz = z1-z0;
    const horizontal = Math.sqrt(dx*dx + dy*dy);
    const vertical   = Math.abs(dz);
    const euclidean  = Math.sqrt(dx*dx + dy*dy + dz*dz);
    return { horizontal, vertical, euclidean, p0: [x0,y0,z0], p1: [x1,y1,z1] };
  }

  /**
   * Update Three.js marker meshes and the connecting line in the overlay
   * renderer. Clears previous visuals first.
   * @param {object} cloud - Point cloud object with `.positions`.
   * @param {object} overlayRenderer - {@link ThreeOverlayRenderer} instance.
   */
  updateMeshes(cloud, overlayRenderer) {
    if (!cloud || !overlayRenderer) return;

    overlayRenderer.clear();

    if (this.points.length === 0) return;

    const p = cloud.positions;

    for (let i = 0; i < this.points.length; i++) {
      const idx = this.points[i];
      const x = p[idx*3], y = p[idx*3+1], z = p[idx*3+2];
      const worldPos = new THREE.Vector3(x, y, z);
      overlayRenderer.addMarker(`measure_${i}`, worldPos, 3);
    }

    if (this.points.length >= 2) {
      const [a, b] = this.points;
      const ax = p[a*3], ay = p[a*3+1], az = p[a*3+2];
      const bx = p[b*3], by = p[b*3+1], bz = p[b*3+2];
      const linePoints = [
        new THREE.Vector3(ax, ay, az),
        new THREE.Vector3(bx, by, bz),
      ];
      overlayRenderer.addLine('measure_line', linePoints);
    }
  }

  /**
   * Legacy 2D canvas fallback for drawing markers and the connecting line.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} cloud - Point cloud object with `.positions`.
   * @param {object} camera - Camera with `.project(x, y, z)`.
   * @param {object} renderer - (unused, kept for API compatibility).
   */
  drawOverlay(ctx, cloud, camera, renderer) {
    if (!this.points.length) return;
    const p = cloud.positions;
    ctx.strokeStyle = '#58a6ff';
    ctx.fillStyle = '#58a6ff';
    ctx.lineWidth = 2;
    for (const idx of this.points) {
      const [sx, sy] = camera.project(p[idx*3], p[idx*3+1], p[idx*3+2]);
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.strokeStyle = '#58a6ff';
    }
    if (this.points.length >= 2) {
      const [a, b] = this.points;
      const [ax, ay] = camera.project(p[a*3],   p[a*3+1],   p[a*3+2]);
      const [bx, by] = camera.project(p[b*3],   p[b*3+1],   p[b*3+2]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }
}
