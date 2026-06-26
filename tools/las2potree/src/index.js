#!/usr/bin/env node
import { readLASHeader, readAllPoints, readPoints } from './las-reader.js';
import { buildOctree } from './octree-builder.js';
import { buildOctreeStreaming } from './octree-builder-streaming.js';
import { writePotreeDataset, writePotreeDatasetStreaming } from './binary-writer.js';
import { resolve, basename } from 'path';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log(`
Usage: node src/index.js <input.las|input.laz> <output-dir> [options]

Options:
  --max-depth <n>    Max octree depth (default: 12)
  --leaf-size <n>    Points per leaf node (default: 5000)
  --streaming        Use streaming mode for large files (> 1B points)
  --memory-limit <MB> Max memory to use in MB (default: 4096)

Example:
  node src/index.js ~/data/scan.las ./datasets/scan/
  node src/index.js ~/data/huge.las ./datasets/huge/ --streaming --memory-limit 8192
  `);
  process.exit(1);
}

const inputPath = resolve(args[0]);
const outputDir = resolve(args[1]);

let maxDepth = 12;
let leafSize = 5000;
let streaming = false;
let memoryLimitMB = 4096;

for (let i = 2; i < args.length; i++) {
  if (args[i] === '--max-depth') maxDepth = parseInt(args[++i], 10);
  if (args[i] === '--leaf-size') leafSize = parseInt(args[++i], 10);
  if (args[i] === '--streaming') streaming = true;
  if (args[i] === '--memory-limit') memoryLimitMB = parseInt(args[++i], 10);
}

async function main() {
  const name = basename(inputPath);
  console.log(`\n=== LAS → Potree Converter ===\n`);
  console.log(`Input:  ${inputPath}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Options: maxDepth=${maxDepth}, leafSize=${leafSize}, streaming=${streaming}, memoryLimit=${memoryLimitMB}MB\n`);

  console.log('Reading LAS header...');
  const t0 = performance.now();
  const header = await readLASHeader(inputPath);

  console.log(`  Version: ${header.versionMajor}.${header.versionMinor}`);
  console.log(`  Point format: ${header.pointFormat}`);
  console.log(`  Point count: ${header.pointCount.toLocaleString()}`);
  console.log(`  Record length: ${header.pointRecordLength} bytes`);
  console.log(`  Has color: ${header.hasColor}`);
  console.log(`  Has GPS time: ${header.hasGpsTime}`);
  console.log(`  Bounds: [${header.minX.toFixed(2)}, ${header.minY.toFixed(2)}, ${header.minZ.toFixed(2)}] → [${header.maxX.toFixed(2)}, ${header.maxY.toFixed(2)}, ${header.maxZ.toFixed(2)}]`);
  console.log(`  Scale: [${header.scaleX}, ${header.scaleY}, ${header.scaleZ}]`);
  console.log(`  Offset: [${header.offsetX}, ${header.offsetY}, ${header.offsetZ}]`);

  const bounds = {
    min: [header.minX, header.minY, header.minZ],
    max: [header.maxX, header.maxY, header.maxZ],
  };

  const estimatedMemoryMB = (header.pointCount * 100) / (1024 * 1024);
  const useStreaming = streaming || estimatedMemoryMB > memoryLimitMB;

  if (useStreaming) {
    console.log(`\nUsing streaming mode (estimated ${estimatedMemoryMB.toFixed(0)}MB needed)...`);

    console.log('\nBuilding octree (streaming)...');
    const t3 = performance.now();

    async function* pointGenerator() {
      let lastReport = 0;
      for await (const chunk of readPoints(inputPath, header)) {
        for (const p of chunk) {
          yield p;
        }
        const processed = Math.min(header.pointCount, lastReport + chunk.length);
        if (processed - lastReport >= 1000000) {
          lastReport = processed;
          console.log(`  Progress: ${(processed / header.pointCount * 100).toFixed(1)}% (${processed.toLocaleString()} points)`);
        }
      }
    }

    const result = await buildOctreeStreaming(
      pointGenerator(),
      bounds,
      {
        maxDepth,
        leafSize,
        outputDir,
        onProgress: ({ totalPoints, nodeCount }) => {
          if (totalPoints % 5000000 === 0) {
            console.log(`  Octree: ${totalPoints.toLocaleString()} points, ${nodeCount} nodes`);
          }
        },
      }
    );
    const t4 = performance.now();
    console.log(`  Octree built in ${((t4 - t3) / 1000).toFixed(1)}s`);

    console.log('\nWriting Potree dataset (streaming)...');
    const t5 = performance.now();

    async function* pointGeneratorForWrite() {
      for await (const chunk of readPoints(inputPath, header)) {
        for (const p of chunk) {
          yield p;
        }
      }
    }

    const stats = await writePotreeDatasetStreaming(
      result.root,
      pointGeneratorForWrite(),
      bounds,
      outputDir,
      ({ processedPoints, totalBytes }) => {
        console.log(`  Write progress: ${processedPoints.toLocaleString()} points, ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
      }
    );
    const t6 = performance.now();
    console.log(`  Written in ${((t6 - t5) / 1000).toFixed(1)}s`);

    console.log(`\n=== Results ===`);
    console.log(`  Total points: ${stats.totalPoints.toLocaleString()}`);
    console.log(`  Total nodes: ${stats.totalNodes}`);
    console.log(`  Leaf nodes: ${stats.leafNodes}`);
    console.log(`  octree.bin: ${(stats.octreeSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  hierarchy.bin: ${(stats.hierarchySize / 1024).toFixed(1)} KB`);
    console.log(`  Total time: ${((t6 - t0) / 1000).toFixed(1)}s`);
    console.log(`\nDone! Serve with: node tools/serve-datasets.js\n`);
  } else {
    console.log('\nReading points...');
    const t1 = performance.now();
    const points = await readAllPoints(inputPath, header);
    const t2 = performance.now();
    console.log(`  ${points.length.toLocaleString()} points read in ${((t2 - t1) / 1000).toFixed(1)}s`);

    console.log('\nBuilding octree...');
    const t3 = performance.now();
    const root = buildOctree(points, bounds, maxDepth, leafSize);
    const t4 = performance.now();
    console.log(`  Octree built in ${((t4 - t3) / 1000).toFixed(1)}s`);

    console.log('\nWriting Potree dataset...');
    const t5 = performance.now();
    const stats = writePotreeDataset(root, points, bounds, outputDir);
    const t6 = performance.now();
    console.log(`  Written in ${((t6 - t5) / 1000).toFixed(1)}s`);

    console.log(`\n=== Results ===`);
    console.log(`  Total points: ${stats.totalPoints.toLocaleString()}`);
    console.log(`  Total nodes: ${stats.totalNodes}`);
    console.log(`  Leaf nodes: ${stats.leafNodes}`);
    console.log(`  octree.bin: ${(stats.octreeSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  hierarchy.bin: ${(stats.hierarchySize / 1024).toFixed(1)} KB`);
    console.log(`  Total time: ${((t6 - t0) / 1000).toFixed(1)}s`);
    console.log(`\nDone! Serve with: node tools/serve-datasets.js\n`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
