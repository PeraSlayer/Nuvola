import * as THREE from 'three';

export class OverlayScene {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 100;

    this._markers = new Map();
    this._lines = new Map();

    this._markerGeometry = new THREE.SphereGeometry(1, 16, 16);
    this._markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x58a6ff,
      transparent: true,
      opacity: 0.9,
    });

    this._lineMaterial = new THREE.LineBasicMaterial({
      color: 0x58a6ff,
      linewidth: 2,
    });
  }

  addMarker(id, position, size = 3) {
    const mesh = new THREE.Mesh(this._markerGeometry, this._markerMaterial.clone());
    mesh.position.copy(position);
    mesh.scale.setScalar(size);
    mesh.userData.id = id;
    this.scene.add(mesh);
    this._markers.set(id, mesh);
    return mesh;
  }

  removeMarker(id) {
    const mesh = this._markers.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.material.dispose();
      this._markers.delete(id);
    }
  }

  addLine(id, points) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, this._lineMaterial.clone());
    line.userData.id = id;
    this.scene.add(line);
    this._lines.set(id, line);
    return line;
  }

  removeLine(id) {
    const line = this._lines.get(id);
    if (line) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      this._lines.delete(id);
    }
  }

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

  updateCamera(width, height) {
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.clear();
    this._markerGeometry.dispose();
    this._markerMaterial.dispose();
    this._lineMaterial.dispose();
  }
}
