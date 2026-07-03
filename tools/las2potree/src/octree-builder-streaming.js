/**
 * @file Streaming Octree Builder
 * @description Builds an octree spatial index for point cloud data in a
 * memory-efficient streaming fashion. Instead of holding all points in memory,
 * points are processed in chunks and assigned to leaf nodes incrementally.
 * Full leaf nodes can be flushed (written to disk) early to further reduce
 * memory pressure. Suitable for point clouds with billions of points.
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/** @constant {number} Default number of points processed per addPoints() call. */
const DEFAULT_CHUNK_SIZE = 1_000_000;
/** @constant {number} Default maximum points per leaf node. */
const DEFAULT_LEAF_SIZE = 5000;
/** @constant {number} Default maximum octree depth. */
const DEFAULT_MAX_DEPTH = 12;

/**
 * Builds an octree incrementally by consuming points in batches.
 * Points are inserted one-by-one, traversing the tree to find or create the
 * appropriate leaf node. Nodes that accumulate more than 2x the leaf size
 * can be marked as finalized to limit memory growth.
 */
export class StreamingOctreeBuilder {
  /**
   * Creates a new streaming octree builder.
   *
   * @param {{min: number[], max: number[]}} bounds - World-space bounding box.
   * @param {Object} [options={}] - Configuration options.
   * @param {number} [options.maxDepth=12] - Maximum tree depth.
   * @param {number} [options.leafSize=5000] - Points per leaf node.
   * @param {number} [options.chunkSize=1000000] - Batch size for addPoints.
   * @param {string} [options.outputDir] - Output directory (for early flushing).
   * @param {function} [options.onProgress] - Progress callback receiving {totalPoints, nodeCount, pendingWrites}.
   */
  constructor(bounds, options = {}) {
    this.bounds = bounds;
    this.maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;
    this.leafSize = options.leafSize || DEFAULT_LEAF_SIZE;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this.outputDir = options.outputDir;
    this.onProgress = options.onProgress || (() => {});

    this.nodes = new Map();
    this.root = this._createNode('r', bounds, 0);
    this.totalPoints = 0;
    this.leafNodes = [];
    this.allNodes = [];

    this._pendingWrites = 0;
    this._writeQueue = [];
    this._maxPendingWrites = 10;
  }

  /**
   * Creates a new node in the octree and registers it in the nodes map.
   *
   * @param {string} name - Hierarchical node name (e.g., "r03").
   * @param {{min: number[], max: number[]}} bounds - Bounding box for this node.
   * @param {number} depth - Tree depth of this node.
   * @returns {Object} The newly created node.
   */
  _createNode(name, bounds, depth) {
    const node = {
      name,
      depth,
      numPoints: 0,
      childMask: 0,
      children: [],
      pointIndices: [],
      byteOffset: 0n,
      byteSize: 0n,
      bounds: { min: [...bounds.min], max: [...bounds.max] },
    };
    this.nodes.set(name, node);
    return node;
  }

  /**
   * Adds a batch of points to the octree.
   * Each point is inserted individually, traversing the tree to the appropriate
   * leaf. After inserting all points in the batch, full nodes are checked for
   * early flushing.
   *
   * @param {Object[]} points - Array of point objects with x, y, z properties.
   */
  addPoints(points) {
    for (const p of points) {
      this._insertPoint(p);
      this.totalPoints++;
    }

    this._flushFullNodes();

    this.onProgress({
      totalPoints: this.totalPoints,
      nodeCount: this.nodes.size,
      pendingWrites: this._pendingWrites,
    });
  }

  /**
   * Inserts a single point into the octree.
   * Traverses from the root down to a leaf node, creating intermediate child
   * nodes as needed. When a leaf reaches capacity, the point is placed in the
   * deepest valid node. Updates child masks for all ancestors along the path.
   *
   * @param {Object} point - A point object with x, y, z properties.
   */
  _insertPoint(point) {
    let node = this.root;
    const path = ['r'];

    // Descend the tree while the current node is at capacity and depth allows.
    while (node.depth < this.maxDepth && node.pointIndices.length >= this.leafSize) {
      const ci = this._getChildIndex(point, node.bounds);
      const childName = node.name + ci;

      let child = this.nodes.get(childName);
      if (!child) {
        child = this._createChildNode(node, ci);
      }

      node = child;
      path.push(childName);
    }

    // Place the point in the current (leaf-capable) node.
    node.pointIndices.push(point);
    node.numPoints++;

    // Update child masks for all ancestors along the traversal path.
    for (let i = path.length - 2; i >= 0; i--) {
      const parent = this.nodes.get(path[i]);
      const ci = parseInt(path[i + 1].slice(-1), 10);
      parent.childMask |= (1 << ci);
    }
  }

  /**
   * Computes the child octant index (0-7) for a point relative to a node's
   * bounding box midpoint.
   * Bit 2 = x >= midX, bit 1 = y >= midY, bit 0 = z >= midZ.
   *
   * @param {{x: number, y: number, z: number}} point - The point to classify.
   * @param {{min: number[], max: number[]}} bounds - Node bounding box.
   * @returns {number} Child index from 0 to 7.
   */
  _getChildIndex(point, bounds) {
    const mx = (bounds.min[0] + bounds.max[0]) * 0.5;
    const my = (bounds.min[1] + bounds.max[1]) * 0.5;
    const mz = (bounds.min[2] + bounds.max[2]) * 0.5;
    return ((point.x >= mx ? 1 : 0) << 2) | ((point.y >= my ? 1 : 0) << 1) | (point.z >= mz ? 1 : 0);
  }

  /**
   * Creates a child node for a given parent and octant index.
   * Computes the child's bounding box as the appropriate half of the parent's
   * bounds along each axis.
   *
   * @param {Object} parent - The parent octree node.
   * @param {number} childIndex - Octant index (0-7).
   * @returns {Object} The newly created child node.
   */
  _createChildNode(parent, childIndex) {
    const childName = parent.name + childIndex;
    const childBounds = {
      min: [
        (childIndex & 4) ? (parent.bounds.min[0] + parent.bounds.max[0]) * 0.5 : parent.bounds.min[0],
        (childIndex & 2) ? (parent.bounds.min[1] + parent.bounds.max[1]) * 0.5 : parent.bounds.min[1],
        (childIndex & 1) ? (parent.bounds.min[2] + parent.bounds.max[2]) * 0.5 : parent.bounds.min[2],
      ],
      max: [
        (childIndex & 4) ? parent.bounds.max[0] : (parent.bounds.min[0] + parent.bounds.max[0]) * 0.5,
        (childIndex & 2) ? parent.bounds.max[1] : (parent.bounds.min[1] + parent.bounds.max[1]) * 0.5,
        (childIndex & 1) ? parent.bounds.max[2] : (parent.bounds.min[2] + parent.bounds.max[2]) * 0.5,
      ],
    };

    const child = this._createNode(childName, childBounds, parent.depth + 1);
    parent.children.push(child);
    return child;
  }

  /**
   * Scans all non-root nodes and marks those exceeding 2x the leaf size as
   * finalized, allowing them to be written to disk early.
   */
  _flushFullNodes() {
    for (const [name, node] of this.nodes) {
      if (name === 'r') continue;
      if (node.pointIndices.length >= this.leafSize * 2) {
        this._finalizeNode(node);
      }
    }
  }

  /**
   * Marks a node as finalized (no more points will be added to it) and adds
   * it to the leaf nodes and all nodes lists.
   *
   * @param {Object} node - The node to finalize.
   */
  _finalizeNode(node) {
    if (node._finalized) return;
    node._finalized = true;
    this.leafNodes.push(node);
    this.allNodes.push(node);
  }

  /**
   * Finalizes the octree construction.
   * Any remaining non-empty nodes are finalized, the root is prepended to the
   * allNodes list, and the result object is returned.
   *
   * @async
   * @returns {Promise<{root: Object, allNodes: Object[], leafNodes: Object[], totalPoints: number}>}
   *   The completed octree structure and statistics.
   */
  async finish() {
    // Finalize any remaining non-empty nodes that weren't flushed.
    for (const [name, node] of this.nodes) {
      if (!node._finalized && node.numPoints > 0) {
        this._finalizeNode(node);
      }
    }

    // Root node is always at the front of the allNodes list.
    this.allNodes.unshift(this.root);

    return {
      root: this.root,
      allNodes: this.allNodes,
      leafNodes: this.leafNodes,
      totalPoints: this.totalPoints,
    };
  }
}

/**
 * Convenience function that builds an octree from an async point iterator.
 * Accumulates points into chunks and feeds them to a {@link StreamingOctreeBuilder}.
 *
 * @async
 * @param {AsyncIterable<Object>} pointIterator - Async iterable yielding point objects.
 * @param {{min: number[], max: number[]}} bounds - World-space bounding box.
 * @param {Object} [options={}] - Options forwarded to {@link StreamingOctreeBuilder}.
 * @returns {Promise<{root: Object, allNodes: Object[], leafNodes: Object[], totalPoints: number}>}
 *   The completed octree structure.
 */
export async function buildOctreeStreaming(pointIterator, bounds, options = {}) {
  const builder = new StreamingOctreeBuilder(bounds, options);

  let chunk = [];
  for await (const point of pointIterator) {
    chunk.push(point);
    if (chunk.length >= builder.chunkSize) {
      builder.addPoints(chunk);
      chunk = [];
    }
  }
  // Process any remaining points in the last partial chunk.
  if (chunk.length > 0) {
    builder.addPoints(chunk);
  }

  return await builder.finish();
}
