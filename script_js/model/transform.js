export class CloudTransform {
  constructor() {
    this.rotation = [0, 0, 0];
    this.scale = [1, 1, 1];
    this._dirty = true;
  }

  get isIdentity() {
    return this.rotation[0] === 0 && this.rotation[1] === 0 && this.rotation[2] === 0
      && this.scale[0] === 1 && this.scale[1] === 1 && this.scale[2] === 1;
  }

  markDirty() {
    this._dirty = true;
  }

  consumeDirty() {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  reset() {
    this.rotation = [0, 0, 0];
    this.scale = [1, 1, 1];
    this.markDirty();
  }
}
