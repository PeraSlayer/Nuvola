import * as THREE from 'three';
import { OctreeGeometry } from './PotreeOctree.js';
import { NodeLoader } from './NodeLoader.js';

export class PotreeLoader {
  async load(url) {
    const loader = new NodeLoader();
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

    await loader.loadHierarchyAll(geometry);

    return geometry;
  }
}
