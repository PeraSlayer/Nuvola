import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DEFAULT_CHUNK_SIZE = 1_000_000;
const DEFAULT_LEAF_SIZE = 5000;
const DEFAULT_MAX_DEPTH = 12;

export class StreamingOctreeBuilder {
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

  _insertPoint(point) {
    let node = this.root;
    const path = ['r'];

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

    node.pointIndices.push(point);
    node.numPoints++;

    for (let i = path.length - 2; i >= 0; i--) {
      const parent = this.nodes.get(path[i]);
      const ci = parseInt(path[i + 1].slice(-1), 10);
      parent.childMask |= (1 << ci);
    }
  }

  _getChildIndex(point, bounds) {
    const mx = (bounds.min[0] + bounds.max[0]) * 0.5;
    const my = (bounds.min[1] + bounds.max[1]) * 0.5;
    const mz = (bounds.min[2] + bounds.max[2]) * 0.5;
    return ((point.x >= mx ? 1 : 0) << 2) | ((point.y >= my ? 1 : 0) << 1) | (point.z >= mz ? 1 : 0);
  }

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

  _flushFullNodes() {
    for (const [name, node] of this.nodes) {
      if (name === 'r') continue;
      if (node.pointIndices.length >= this.leafSize * 2) {
        this._finalizeNode(node);
      }
    }
  }

  _finalizeNode(node) {
    if (node._finalized) return;
    node._finalized = true;
    this.leafNodes.push(node);
    this.allNodes.push(node);
  }

  async finish() {
    for (const [name, node] of this.nodes) {
      if (!node._finalized && node.numPoints > 0) {
        this._finalizeNode(node);
      }
    }

    this.allNodes.unshift(this.root);

    return {
      root: this.root,
      allNodes: this.allNodes,
      leafNodes: this.leafNodes,
      totalPoints: this.totalPoints,
    };
  }
}

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
  if (chunk.length > 0) {
    builder.addPoints(chunk);
  }

  return await builder.finish();
}
