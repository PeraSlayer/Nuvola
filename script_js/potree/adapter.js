import * as THREE from 'three';

/**
 * Temporary bridge: converts eagerly-loaded Potree OctreeGeometry
 * into the flat array format that Nuvola's PointCloud expects.
 * Replaced in Phase 2 by streaming-aware getDrawCall().
 */

export function octreeGeometryToPointCloud(geometry) {
  const allNodes = [];
  collectNodes(geometry.root, allNodes);

  let totalPoints = 0;
  for (const node of allNodes) {
    if (node.geometryData && node.geometryData.position) {
      totalPoints += node.geometryData.numPoints;
    }
  }

  if (totalPoints === 0) {
    throw new Error('No point data found in Potree dataset');
  }

  const positions = new Float32Array(totalPoints * 3);
  const colors = new Uint8Array(totalPoints * 3);
  const hasColor = allNodes.some(n => n.geometryData && n.geometryData.color);
  const hasIntensity = allNodes.some(n => n.geometryData && n.geometryData.intensity);
  const intensity = hasIntensity ? new Float32Array(totalPoints) : null;

  let offset = 0;
  let iOff = 0;
  for (const node of allNodes) {
    if (!node.geometryData || !node.geometryData.position) continue;
    const n = node.geometryData.numPoints;
    const srcPos = node.geometryData.position;
    positions.set(srcPos, offset * 3);

    node._flatIndexStart = offset;

    if (hasColor && node.geometryData.color) {
      colors.set(node.geometryData.color, offset * 3);
    } else {
      for (let i = 0; i < n; i++) {
        colors[offset * 3 + i * 3] = 180;
        colors[offset * 3 + i * 3 + 1] = 180;
        colors[offset * 3 + i * 3 + 2] = 200;
      }
    }

    if (hasIntensity && node.geometryData.intensity) {
      intensity.set(node.geometryData.intensity, iOff);
    }
    offset += n;
    iOff += n;
  }

  const bounds = geometry.boundingBox;
  const center = new THREE.Vector3();
  bounds.getCenter(center);
  const size = new THREE.Vector3();
  bounds.getSize(size);

  const leafSize = 2000;
  const maxDepth = 12;
  const allIndices = new Uint32Array(totalPoints);
  for (let i = 0; i < totalPoints; i++) allIndices[i] = i;
  const octree = buildFlatOctree(positions, allIndices, bounds, 0, maxDepth, leafSize);

  const pgc = 128;
  const pickCells = pgc;
  const pgSize = pgc * pgc;
  const pgCounts = new Uint32Array(pgSize);
  const sx = size.x || 1;
  const sy = size.y || 1;
  for (let j = 0; j < totalPoints; j++) {
    const gx = Math.min(pgc - 1, Math.floor(((positions[j * 3] - bounds.min.x) / sx) * pgc));
    const gy = Math.min(pgc - 1, Math.floor(((positions[j * 3 + 1] - bounds.min.y) / sy) * pgc));
    pgCounts[gy * pgc + gx]++;
  }
  const pgOffsets = new Uint32Array(pgSize + 1);
  for (let c = 0; c < pgSize; c++) pgOffsets[c + 1] = pgOffsets[c] + pgCounts[c];
  const pgFlat = new Uint32Array(totalPoints);
  const pgCursor = new Uint32Array(pgSize);
  for (let j = 0; j < totalPoints; j++) {
    const gx = Math.min(pgc - 1, Math.floor(((positions[j * 3] - bounds.min.x) / sx) * pgc));
    const gy = Math.min(pgc - 1, Math.floor(((positions[j * 3 + 1] - bounds.min.y) / sy) * pgc));
    const cell = gy * pgc + gx;
    pgFlat[pgOffsets[cell] + pgCursor[cell]++] = j;
  }

  return {
    count: totalPoints,
    positions,
    colors,
    intensity,
    hasColor,
    hasIntensity,
    bounds: {
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    },
    center: [center.x, center.y, center.z],
    zMin: bounds.min.z,
    zMax: bounds.max.z,
    intensityMin: hasIntensity ? 0 : 0,
    intensityMax: hasIntensity ? 1 : 1,
    octree,
    octreeGeometry: geometry,
    pickGrid: pgFlat,
    pickOffsets: pgOffsets,
    pickCounts: pgCounts,
    pickCells,
  };
}

function collectNodes(node, out) {
  out.push(node);
  if (node.children) {
    for (const child of node.children) {
      collectNodes(child, out);
    }
  }
}

function buildFlatOctree(positions, indices, bounds, depth, maxDepth, leafSize) {
  const count = indices.length;
  const node = {
    min: [bounds.min.x, bounds.min.y, bounds.min.z],
    max: [bounds.max.x, bounds.max.y, bounds.max.z],
    depth,
    count,
    indices: null,
    children: null,
  };
  if (count <= leafSize || depth >= maxDepth) {
    node.indices = indices;
    return node;
  }
  const mx = (bounds.min.x + bounds.max.x) * 0.5;
  const my = (bounds.min.y + bounds.max.y) * 0.5;
  const mz = (bounds.min.z + bounds.max.z) * 0.5;
  const c0 = [], c1 = [], c2 = [], c3 = [], c4 = [], c5 = [], c6 = [], c7 = [];
  for (let j = 0; j < count; j++) {
    const idx = indices[j];
    const px = positions[idx * 3], py = positions[idx * 3 + 1], pz = positions[idx * 3 + 2];
    const ci = ((px < mx ? 0 : 1) << 2) | ((py < my ? 0 : 1) << 1) | (pz < mz ? 0 : 1);
    switch (ci) {
      case 0: c0.push(idx); break;
      case 1: c1.push(idx); break;
      case 2: c2.push(idx); break;
      case 3: c3.push(idx); break;
      case 4: c4.push(idx); break;
      case 5: c5.push(idx); break;
      case 6: c6.push(idx); break;
      case 7: c7.push(idx); break;
    }
  }
  const cb = [
    [bounds.min.x, bounds.min.y, bounds.min.z, mx, my, mz],
    [bounds.min.x, bounds.min.y, mz, mx, my, bounds.max.z],
    [bounds.min.x, my, bounds.min.z, mx, bounds.max.y, mz],
    [bounds.min.x, my, mz, mx, bounds.max.y, bounds.max.z],
    [mx, bounds.min.y, bounds.min.z, bounds.max.x, my, mz],
    [mx, bounds.min.y, mz, bounds.max.x, my, bounds.max.z],
    [mx, my, bounds.min.z, bounds.max.x, bounds.max.y, mz],
    [mx, my, mz, bounds.max.x, bounds.max.y, bounds.max.z],
  ];
  const lists = [c0, c1, c2, c3, c4, c5, c6, c7];
  const ch = [];
  for (let k = 0; k < 8; k++) {
    if (lists[k].length > 0) {
      const childBounds = {
        min: { x: cb[k][0], y: cb[k][1], z: cb[k][2] },
        max: { x: cb[k][3], y: cb[k][4], z: cb[k][5] },
      };
      ch.push(buildFlatOctree(positions, new Uint32Array(lists[k]), childBounds, depth + 1, maxDepth, leafSize));
    }
  }
  node.children = ch.length > 0 ? ch : null;
  if (!node.children) node.indices = indices;
  return node;
}
