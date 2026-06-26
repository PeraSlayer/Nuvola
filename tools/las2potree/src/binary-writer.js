import { writeFileSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { collectNodes, collectLeafNodes } from './octree-builder.js';

const ATTRIBUTES = [
  { name: 'POSITION_CARTESIAN', size: 12 },
  { name: 'RGBA', size: 4 },
  { name: 'INTENSITY', size: 2 },
  { name: 'CLASSIFICATION', size: 1 },
];

const STRIDE = ATTRIBUTES.reduce((s, a) => s + a.size, 0);
const CHUNK_SIZE_BYTES = 256 * 1024 * 1024;

export function writePotreeDataset(root, points, bounds, outputDir) {
  mkdirSync(outputDir, { recursive: true });

  const allNodes = collectNodes(root);
  const leafNodes = collectLeafNodes(root);

  let currentOffset = 0n;
  const octreeBuffers = [];

  for (const leaf of leafNodes) {
    const n = leaf.pointIndices.length;
    if (n === 0) continue;

    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    const intensities = new Uint16Array(n);
    const classifications = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const p = points[leaf.pointIndices[i]];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 4] = p.r;
      colors[i * 4 + 1] = p.g;
      colors[i * 4 + 2] = p.b;
      colors[i * 4 + 3] = 255;
      intensities[i] = p.intensity;
      classifications[i] = p.classification || 0;
    }

    const totalBytes = n * STRIDE;
    const buf = new ArrayBuffer(totalBytes);
    const view = new Uint8Array(buf);
    let off = 0;

    const posBytes = new Uint8Array(positions.buffer);
    if (off + posBytes.byteLength > totalBytes) {
      console.error(`Buffer overflow: off=${off}, posBytes=${posBytes.byteLength}, total=${totalBytes}, n=${n}`);
      throw new Error('Buffer overflow writing positions');
    }
    view.set(posBytes, off);
    off += posBytes.byteLength;

    if (off + colors.byteLength > totalBytes) {
      console.error(`Buffer overflow: off=${off}, colors=${colors.byteLength}, total=${totalBytes}, n=${n}`);
      throw new Error('Buffer overflow writing colors');
    }
    view.set(colors, off);
    off += colors.byteLength;

    const intBytes = new Uint8Array(intensities.buffer);
    if (off + intBytes.byteLength > totalBytes) {
      console.error(`Buffer overflow: off=${off}, intBytes=${intBytes.byteLength}, total=${totalBytes}, n=${n}`);
      throw new Error('Buffer overflow writing intensities');
    }
    view.set(intBytes, off);
    off += intBytes.byteLength;

    if (off + classifications.byteLength > totalBytes) {
      console.error(`Buffer overflow: off=${off}, classifications=${classifications.byteLength}, total=${totalBytes}, n=${n}`);
      throw new Error('Buffer overflow writing classifications');
    }
    view.set(classifications, off);

    leaf.byteOffset = currentOffset;
    leaf.byteSize = BigInt(buf.byteLength);
    currentOffset += leaf.byteSize;

    octreeBuffers.push(Buffer.from(buf));
  }

  computeNodeOffsets(root);

  const octreeBin = Buffer.concat(octreeBuffers);
  writeFileSync(join(outputDir, 'octree.bin'), octreeBin);

  const hierarchyBuf = writeHierarchy(root, allNodes);
  writeFileSync(join(outputDir, 'hierarchy.bin'), hierarchyBuf);

  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const spacing = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const metadata = {
    version: '2.0',
    boundingBox: {
      lx: bounds.min[0], ly: bounds.min[1], lz: bounds.min[2],
      ux: bounds.max[0], uy: bounds.max[1], uz: bounds.max[2],
    },
    spacing,
    scale: 1,
    offset: 0,
    attributes: ATTRIBUTES,
    hierarchy: { firstChunkSize: allNodes.length },
  };

  writeFileSync(join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  return {
    totalPoints: points.length,
    totalNodes: allNodes.length,
    leafNodes: leafNodes.length,
    octreeSize: octreeBin.length,
    hierarchySize: hierarchyBuf.length,
  };
}

export async function writePotreeDatasetStreaming(root, pointIterator, bounds, outputDir, onProgress) {
  mkdirSync(outputDir, { recursive: true });

  const allNodes = collectNodes(root);
  const leafNodes = collectLeafNodes(root);

  let currentOffset = 0n;
  let totalBytes = 0;
  const stream = createWriteStream(join(outputDir, 'octree.bin'));

  let processedPoints = 0;
  const leafMap = new Map();
  for (const leaf of leafNodes) {
    leafMap.set(leaf.name, { leaf, points: [] });
  }

  for await (const point of pointIterator) {
    let node = root;
    while (node.depth < (root.maxDepth || 12) && !node.pointIndices) {
      const ci = ((point.x >= (node.bounds.min[0] + node.bounds.max[0]) * 0.5 ? 1 : 0) << 2) |
                 ((point.y >= (node.bounds.min[1] + node.bounds.max[1]) * 0.5 ? 1 : 0) << 1) |
                 (point.z >= (node.bounds.min[2] + node.bounds.max[2]) * 0.5 ? 1 : 0);
      const childName = node.name + ci;
      const child = node.children?.find(c => c.name === childName);
      if (!child) break;
      node = child;
    }

    const entry = leafMap.get(node.name);
    if (entry) {
      entry.points.push(point);
    }
    processedPoints++;

    if (processedPoints % 1000000 === 0 && onProgress) {
      onProgress({ processedPoints, totalBytes });
    }
  }

  for (const [name, entry] of leafMap) {
    const { leaf, points } = entry;
    const n = points.length;
    if (n === 0) continue;

    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    const intensities = new Uint16Array(n);
    const classifications = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const p = points[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 4] = p.r;
      colors[i * 4 + 1] = p.g;
      colors[i * 4 + 2] = p.b;
      colors[i * 4 + 3] = 255;
      intensities[i] = p.intensity;
      classifications[i] = p.classification || 0;
    }

    const nodeBytes = n * STRIDE;
    const buf = Buffer.alloc(nodeBytes);
    let off = 0;
    buf.set(new Uint8Array(positions.buffer), off); off += positions.byteLength;
    buf.set(colors, off); off += colors.byteLength;
    buf.set(new Uint8Array(intensities.buffer), off); off += intensities.byteLength;
    buf.set(classifications, off);

    leaf.byteOffset = currentOffset;
    leaf.byteSize = BigInt(buf.byteLength);
    currentOffset += leaf.byteSize;
    totalBytes += buf.byteLength;

    stream.write(buf);
  }

  await new Promise((resolve, reject) => {
    stream.end((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  computeNodeOffsets(root);

  const hierarchyBuf = writeHierarchy(root, allNodes);
  writeFileSync(join(outputDir, 'hierarchy.bin'), hierarchyBuf);

  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const spacing = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const metadata = {
    version: '2.0',
    boundingBox: {
      lx: bounds.min[0], ly: bounds.min[1], lz: bounds.min[2],
      ux: bounds.max[0], uy: bounds.max[1], uz: bounds.max[2],
    },
    spacing,
    scale: 1,
    offset: 0,
    attributes: ATTRIBUTES,
    hierarchy: { firstChunkSize: allNodes.length },
  };

  writeFileSync(join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  return {
    totalPoints: processedPoints,
    totalNodes: allNodes.length,
    leafNodes: leafNodes.length,
    octreeSize: totalBytes,
    hierarchySize: hierarchyBuf.length,
  };
}

function computeNodeOffsets(node) {
  if (node.pointIndices) {
    return;
  }

  if (node.children.length > 0) {
    node.byteOffset = node.children[0].byteOffset;
    let totalSize = 0n;
    for (const child of node.children) {
      computeNodeOffsets(child);
      totalSize += child.byteSize;
    }
    node.byteSize = totalSize;
  }
}

function writeHierarchy(root, allNodes) {
  const encoder = new TextEncoder();
  const chunks = [];

  for (const node of allNodes) {
    const nameBytes = encoder.encode(node.name);
    const nameLen = nameBytes.length;

    if (nameLen <= 63) {
      const entrySize = 1 + nameLen + 22;
      const buf = Buffer.alloc(entrySize);
      let off = 0;

      buf[off] = 0x80 | (nameLen & 0x3F);
      off += 1;

      buf.set(nameBytes, off);
      off += nameLen;

      buf[off] = node.childMask;
      off += 1;

      buf[off] = 0;
      off += 1;

      buf.writeUInt32LE(node.numPoints, off);
      off += 4;

      buf.writeBigInt64LE(node.byteOffset, off);
      off += 8;

      buf.writeBigInt64LE(node.byteSize, off);

      chunks.push(buf);
    }
  }

  return Buffer.concat(chunks);
}
