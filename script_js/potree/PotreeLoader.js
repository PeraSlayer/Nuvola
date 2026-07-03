/**
 * @file PotreeLoader.js
 * @description High-level loader for Potree-format point-cloud octrees.
 *   Orchestrates metadata retrieval, octree-geometry construction, and
 *   hierarchy-tree loading via {@link NodeLoader}. Returns a fully
 *   initialized {@link OctreeGeometry} ready for rendering.
 */

import * as THREE from 'three';
import { OctreeGeometry } from './PotreeOctree.js';
import { NodeLoader } from './NodeLoader.js';

/**
 * Central entry point for loading Potree point-cloud data.
 *
 * @class PotreeLoader
 */
export class PotreeLoader {
  /**
   * Creates a new PotreeLoader. The internal NodeLoader is lazily created
   * during {@link load}.
   */
  constructor() {
    /** @type {NodeLoader|null} */
    this._loader = null;
  }

  /**
   * Loads a Potree dataset from the given URL.
   * Fetches metadata.json, builds the bounding box from its contents,
   * creates an {@link OctreeGeometry}, and recursively loads the
   * hierarchy tree rooted at 'r'.
   *
   * @async
   * @param {string} url Base URL of the Potree dataset directory (must
   *   contain metadata.json, octree.bin, and hierarchy.bin).
   * @returns {Promise<OctreeGeometry>} The fully initialized octree geometry.
   * @throws {Error} If metadata.json cannot be fetched.
   */
  async load(url) {
    if (this._loader) this._loader.dispose();

    const loader = new NodeLoader();
    this._loader = loader;
    const metadata = await loader.loadMetadata(url);

    const geometry = new OctreeGeometry();
    geometry.url = url;
    geometry.loader = loader;
    geometry.attributes = metadata.attributes || [];

    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(
        metadata.boundingBox ? metadata.boundingBox.lx : -1,
        metadata.boundingBox ? metadata.boundingBox.ly : -1,
        metadata.boundingBox ? metadata.boundingBox.lz : -1,
      ),
      new THREE.Vector3(
        metadata.boundingBox ? metadata.boundingBox.ux : 1,
        metadata.boundingBox ? metadata.boundingBox.uy : 1,
        metadata.boundingBox ? metadata.boundingBox.uz : 1,
      ),
    );

    if (metadata.tightBoundingBox) {
      geometry.tightBoundingBox = new THREE.Box3(
        new THREE.Vector3(
          metadata.tightBoundingBox.lx,
          metadata.tightBoundingBox.ly,
          metadata.tightBoundingBox.lz,
        ),
        new THREE.Vector3(
          metadata.tightBoundingBox.ux,
          metadata.tightBoundingBox.uy,
          metadata.tightBoundingBox.uz,
        ),
      );
    }

    geometry.spacing = metadata.spacing || 1;
    geometry.scale = metadata.scale || 1;

    if (metadata.offset) {
      geometry.offset = new THREE.Vector3(
        metadata.offset[0] || 0,
        metadata.offset[1] || 0,
        metadata.offset[2] || 0,
      );
    }

    geometry.projection = metadata.projection || null;

    geometry.root = await loader.loadHierarchyRoot(geometry);

    return geometry;
  }

  /**
   * Disposes of the underlying NodeLoader, terminating worker threads
   * and freeing associated resources.
   */
  dispose() {
    if (this._loader) {
      this._loader.dispose();
      this._loader = null;
    }
  }
}
