/*
===============================================================================
File: measurements.js

Questo modulo contiene MeasurementTool, lo strumento che consente di misurare
distanze tra due punti della nuvola. Quando lo strumento e attivo, i click
sulla vista vengono convertiti in indici di punti tramite il picking della
PointCloud; il modulo conserva i due punti scelti e calcola le distanze.

Le misure restituite includono componente orizzontale, componente verticale e
distanza euclidea completa in coordinate 3D originali. Il file contiene anche
la logica per disegnare sull'overlay i marker e la linea che collega i punti
selezionati.

Non carica dati e non renderizza la scena principale: lavora come layer di
interazione sopra renderer, camera e cloud.
===============================================================================
*/

import * as THREE from 'three';

// =============================================================================
// MeasurementTool
//
// Two-point 3D distance measurement. Stores point indices into the cloud
// and computes horizontal / vertical / Euclidean distances in the cloud's
// original world coordinates.
// ============================================================================

/** Two-point 3D distance measurement tool. */
export class MeasurementTool {
  constructor() {
    this.active = false;
    this.points = [];   // indices into point cloud
    this.markers = [];  // screen positions for overlay
    
    this._markerMeshes = [];
    this._lineMesh = null;
  }

  toggle() {
    this.active = !this.active;
    if (!this.active) this.clear();
    return this.active;
  }

  clear() {
    this.points = [];
    this.markers = [];
    this._markerMeshes = [];
    this._lineMesh = null;
  }

  /** Handle click; returns true once both points have been captured. */
  onClick(cloud, camera, renderer, sx, sy) {
    if (!this.active) return false;
    const idx = cloud.pickNearest(camera, renderer, sx, sy);
    if (idx < 0) return false;
    const p = cloud.positions;
    this.points.push(idx);
    this.markers.push([sx, sy]);
    return this.points.length >= 2;
  }

  /** Compute horizontal, vertical, and Euclidean distances in 3D world units. */
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

  /** Update Three.js meshes for markers and line. */
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

  /** Draw the markers and the line connecting them (legacy 2D canvas fallback). */
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
