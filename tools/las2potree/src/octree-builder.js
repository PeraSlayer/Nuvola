export function buildOctree(points, bounds, maxDepth = 12, leafSize = 5000) {
  const indices = new Uint32Array(points.length);
  for (let i = 0; i < points.length; i++) indices[i] = i;

  return _buildNode(points, indices, bounds, 0, maxDepth, leafSize, 'r');
}

function _buildNode(points, indices, bounds, depth, maxDepth, leafSize, name) {
  const node = {
    name,
    depth,
    numPoints: indices.length,
    childMask: 0,
    children: [],
    pointIndices: null,
    byteOffset: 0n,
    byteSize: 0n,
  };

  if (indices.length <= leafSize || depth >= maxDepth) {
    node.pointIndices = indices;
    return node;
  }

  const mx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const my = (bounds.min[1] + bounds.max[1]) * 0.5;
  const mz = (bounds.min[2] + bounds.max[2]) * 0.5;

  const octants = [[], [], [], [], [], [], [], []];

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const p = points[idx];
    const ci = ((p.x >= mx ? 1 : 0) << 2) | ((p.y >= my ? 1 : 0) << 1) | (p.z >= mz ? 1 : 0);
    octants[ci].push(idx);
  }

  for (let ci = 0; ci < 8; ci++) {
    if (octants[ci].length === 0) continue;

    node.childMask |= (1 << ci);

    const childBounds = {
      min: [
        (ci & 4) ? mx : bounds.min[0],
        (ci & 2) ? my : bounds.min[1],
        (ci & 1) ? mz : bounds.min[2],
      ],
      max: [
        (ci & 4) ? bounds.max[0] : mx,
        (ci & 2) ? bounds.max[1] : my,
        (ci & 1) ? bounds.max[2] : mz,
      ],
    };

    const childName = name + ci;
    const child = _buildNode(points, new Uint32Array(octants[ci]), childBounds, depth + 1, maxDepth, leafSize, childName);
    node.children.push(child);
  }

  return node;
}

export function collectNodes(node, result = []) {
  result.push(node);
  for (const child of node.children) {
    collectNodes(child, result);
  }
  return result;
}

export function collectLeafNodes(node, result = []) {
  if (node.pointIndices && node.pointIndices.length > 0) {
    result.push(node);
  }
  for (const child of node.children) {
    collectLeafNodes(child, result);
  }
  return result;
}
