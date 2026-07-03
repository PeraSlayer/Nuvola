/**
 * @file transform.js
 * @description Lightweight cloud-level affine transformation container for the
 *              Nuvola 2.5D point-cloud viewer. Stores rotation (Euler, degrees)
 *              and scale, exposes dirty-tracking, and supports identity checks
 *              and reset. Used by the renderer to apply user-editable transforms
 *              without modifying the source point data.
 */

export class CloudTransform {
  constructor() {
    /** @type {number[]} Euler rotation in degrees [x, y, z]. */
    this.rotation = [0, 0, 0];
    /** @type {number[]} Scale factors per axis [x, y, z]. */
    this.scale = [1, 1, 1];
    this._dirty = true;
  }

  /**
   * Returns true when the transform is the identity (no rotation, unit scale).
   * @returns {boolean}
   */
  get isIdentity() {
    return this.rotation[0] === 0 && this.rotation[1] === 0 && this.rotation[2] === 0
      && this.scale[0] === 1 && this.scale[1] === 1 && this.scale[2] === 1;
  }

  /**
   * Marks the transform as modified so consumers can react.
   */
  markDirty() {
    this._dirty = true;
  }

  /**
   * Returns the current dirty flag and clears it atomically.
   * @returns {boolean}
   */
  consumeDirty() {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  /**
   * Resets rotation and scale to identity and marks dirty.
   */
  reset() {
    this.rotation = [0, 0, 0];
    this.scale = [1, 1, 1];
    this.markDirty();
  }
}
