/**
 * @file Octree Builder
 * @description Builds an in-memory octree spatial index for point cloud data.
 * Recursively subdivides the bounding box into 8 octants, distributing points
 * into child nodes until each node contains no more than `leafSize` points or
 * reaches the `maxDepth` limit. Used to generate the hierarchical structure
 * consumed by the Potree binary writer.
 */

/**
 * Builds an octree from an array of points and their bounding box.
 * Creates an index array mapping into the points array, then recursively
 * subdivides to form the tree.
 *
 * @param {Object[]} points - Array of point objects with x, y, z properties.
 * @param {{min: number[], max: number[]}} bounds - World-space bounding box.
 * @param {number} [maxDepth=12] - Maximum tree depth before stopping subdivision.
 * @param {number} [leafSize=5000] - Maximum points per leaf node.
 * @returns {Object} The root node of the octree.
 */
export function buildOctree(points, bounds, maxDepth = 12, leafSize = 5000) {
  const indices = new Uint32Array(points.length);
  for (let i = 0; i < points.length; i++) indices[i] = i;

  return _buildNode(points, indices, bounds, 0, maxDepth, leafSize, 'r');
}

/**
 * Recursively builds a single octree node.
 * If the number of indices is within the leaf threshold or max depth is
 * reached, the node becomes a leaf storing the indices directly.
 * Otherwise, it splits the bounding box at its midpoint into 8 octants and
 * distributes points among child nodes.
 *
 * @param {Object[]} points - Full array of all point objects.
 * @param {Uint32Array} indices - Indices into `points` belonging to this node.
 * @param {{min: number[], max: number[]}} bounds - Bounding box for this node.
 * @param {number} depth - Current tree depth (0 = root).
 * @param {number} maxDepth - Maximum allowed tree depth.
 * @param {number} leafSize - Maximum points per leaf node.
 * @param {string} name - Hierarchical name string (e.g., "r", "r0", "r03").
 * @returns {Object} The constructed octree node.
 */
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

  // Stop subdividing if the node is small enough or at max depth.
  if (indices.length <= leafSize || depth >= maxDepth) {
    node.pointIndices = indices;
    return node;
  }

  // Compute the bounding box midpoint for octant splitting.
  const mx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const my = (bounds.min[1] + bounds.max[1]) * 0.5;
  const mz = (bounds.min[2] + bounds.max[2]) * 0.5;

  const octants = [[], [], [], [], [], [], [], []];

  // Assign each point index to one of 8 octants based on position relative to midpoint.
  // Child index: bit 2 = x >= mx, bit 1 = y >= my, bit 0 = z >= mz.
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const p = points[idx];
    const ci = ((p.x >= mx ? 1 : 0) << 2) | ((p.y >= my ? 1 : 0) << 1) | (p.z >= mz ? 1 : 0);
    octants[ci].push(idx);
  }

  // Recurse into non-empty octants.
  for (let ci = 0; ci < 8; ci++) {
    if (octants[ci].length === 0) continue;

    node.childMask |= (1 << ci);

    // Calculate the precise bounding box for this child octant.
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

/**
 * Collects all nodes from the octree in a depth-first traversal into a flat array.
 * The root node is included first.
 *
 * @param {Object} node - The current octree node.
 * @param {Object[]} [result=[]] - Accumulator array (modified in place).
 * @returns {Object[]} The flat array of all nodes in the tree.
 */
export function collectNodes(node, result = []) {
  result.push(node);
  for (const child of node.children) {
    collectNodes(child, result);
  }
  return result;
}

/**
 * Collects only the leaf nodes (nodes that have non-null pointIndices with
 * at least one point) from the octree in depth-first order.
 *
 * @param {Object} node - The current octree node.
 * @param {Object[]} [result=[]] - Accumulator array (modified in place).
 * @returns {Object[]} The flat array of all leaf nodes in the tree.
 */
export function collectLeafNodes(node, result = []) {
  if (node.pointIndices && node.pointIndices.length > 0) {
    result.push(node);
  }
  for (const child of node.children) {
    collectLeafNodes(child, result);
  }
  return result;
}
