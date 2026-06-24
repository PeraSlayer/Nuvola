import * as THREE from 'three';

let _nodeIdCounter = 0;

export class OctreeGeometryNode {
  constructor(name, geometry, boundingBox) {
    this.id = _nodeIdCounter++;
    this.name = name;
    this.geometry = geometry;
    this.boundingBox = boundingBox.clone();
    this.boundingSphere = new THREE.Sphere();
    boundingBox.getBoundingSphere(this.boundingSphere);
    this.tightBoundingBox = boundingBox.clone();

    this.index = name === 'r' ? -1 : parseInt(name.slice(-1), 10);
    this.depth = name === 'r' ? 0 : name.length - 1;

    this.spacing = geometry.spacing / Math.pow(2, this.depth);

    this.numPoints = 0;
    this.byteOffset = 0n;
    this.byteSize = 0n;

    this.children = null;
    this.hasChildren = 0;

    this.loaded = false;
    this.loading = false;
    this.geometryData = null;
    this.gpuNode = null;

    this._oneTimeDisposeHandlers = [];
    this._loadCallbacks = [];
    this._disposed = false;
  }

  getNumPoints() {
    return this.numPoints;
  }

  getLevel() {
    return this.depth;
  }

  isLoaded() {
    return this.loaded;
  }

  isGeometryNode() {
    return true;
  }

  getBoundingBox() {
    return this.boundingBox;
  }

  getBoundingSphere() {
    return this.boundingSphere;
  }

  onLoad(callback) {
    this._loadCallbacks.push(callback);
  }

  onDispose(callback) {
    this._oneTimeDisposeHandlers.push(callback);
  }

  load() {
    return this.geometry.loader.loadNode(this);
  }

  loadChildren() {
    if (!this.children || this.children.length === 0) {
      return this.geometry.loader.loadChildren(this);
    }
    return null;
  }

  addChild(child) {
    if (!this.children) this.children = [];
    this.children.push(child);
    this.hasChildren |= (1 << child.index);
  }

  getChild(name) {
    if (!this.children) return null;
    for (let i = 0; i < this.children.length; i++) {
      if (this.children[i].name === name) return this.children[i];
    }
    return null;
  }

  dispose() {
    for (const handler of this._oneTimeDisposeHandlers) {
      handler(this);
    }
    this._oneTimeDisposeHandlers.length = 0;
    this.geometryData = null;
    this._disposed = true;
  }

  disposeDescendants() {
    if (!this.children) return;
    for (const child of this.children) {
      child.disposeDescendants();
      child.dispose();
    }
    this.children = null;
    this.hasChildren = 0;
  }
}

export class OctreeGeometry {
  constructor() {
    this.root = null;
    this.boundingBox = new THREE.Box3();
    this.tightBoundingBox = new THREE.Box3();
    this.spacing = 0;
    this.scale = 1;
    this.offset = new THREE.Vector3();
    this.projection = null;
    this.numNodes = 0;
    this.totalPoints = 0;
    this.loader = null;
    this.attributes = [];
    this.url = '';
  }
}
