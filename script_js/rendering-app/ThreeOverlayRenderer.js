import * as THREE from 'three';
import { OverlayScene } from './OverlayScene.js';

export class ThreeOverlayRenderer {
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

    this.overlayScene = new OverlayScene();
    this._width = 1;
    this._height = 1;
  }

  setSize(width, height) {
    this._width = width;
    this._height = height;
    this.renderer.setSize(width, height, false);
    this.overlayScene.updateCamera(width, height);
  }

  render(camera) {
    this.renderer.clear();
    this.renderer.render(this.overlayScene.scene, this.overlayScene.camera);
  }

  addMarker(id, worldPosition, size = 3) {
    return this.overlayScene.addMarker(id, worldPosition, size);
  }

  removeMarker(id) {
    this.overlayScene.removeMarker(id);
  }

  addLine(id, points) {
    return this.overlayScene.addLine(id, points);
  }

  removeLine(id) {
    this.overlayScene.removeLine(id);
  }

  clear() {
    this.overlayScene.clear();
  }

  dispose() {
    this.overlayScene.dispose();
    this.renderer.dispose();
  }
}
