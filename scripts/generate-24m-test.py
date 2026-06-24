#!/usr/bin/env python3
"""Generate a ~24 million point multi-level Potree v2.0 dataset for large-scale testing."""

import json
import struct
import os
import time
import sys

import numpy as np

NUM_POINTS = 24_000_000
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'example', 'large-test')
MAX_DEPTH = 5
MIN_LEAF = 20000

SEED = 42
BBOX = [-50, -50, -50, 50, 50, 50]  # lx, ly, lz, ux, uy, uz


def main():
    t0 = time.time()

    rng = np.random.default_rng(SEED)

    print(f"Generating {NUM_POINTS:,} points...")
    positions = rng.uniform(BBOX[0], BBOX[3], (NUM_POINTS, 3)).astype(np.float32)
    colors = rng.integers(0, 256, (NUM_POINTS, 3), dtype=np.uint8)

    tmin = positions.min(axis=0).astype(np.float64)
    tmax = positions.max(axis=0).astype(np.float64)

    print("Building octree...")
    all_idx = np.arange(NUM_POINTS, dtype=np.uint32)
    root = _build_octree(positions, all_idx, BBOX, 0, MAX_DEPTH, MIN_LEAF)

    print("Collecting nodes...")
    nodes = []
    _collect_nodes(root, nodes)

    internal_count = sum(1 for n in nodes if n['child_mask'] != 0)
    leaf_count = sum(1 for n in nodes if n['child_mask'] == 0)
    leaf_points = sum(n['num_points'] for n in nodes if n['child_mask'] == 0)
    print(f"  Total nodes: {len(nodes)}  (internal: {internal_count}, leaf: {leaf_count})")
    print(f"  Sum of leaf points: {leaf_points:,}")

    # Write octree.bin (only leaf nodes write data)
    os.makedirs(OUT_DIR, exist_ok=True)
    octree_path = os.path.join(OUT_DIR, 'octree.bin')
    print(f"Writing octree.bin...")
    with open(octree_path, 'wb') as f:
        for i, node in enumerate(nodes):
            node['byte_offset'] = f.tell()
            if node['num_points'] > 0 and len(node['indices']) > 0:
                for idx in node['indices']:
                    x, y, z = positions[idx]
                    r, g, b = colors[idx]
                    f.write(struct.pack('<fffBBB', x, y, z, r, g, b))
            node['byte_size'] = f.tell() - node['byte_offset']
            if (i + 1) % 1000 == 0 or i == len(nodes) - 1:
                print(f"\r  Nodes written: {i + 1}/{len(nodes)}", end='', flush=True)
    print()

    octree_size = os.path.getsize(octree_path)
    print(f"  octree.bin: {octree_size / (1024*1024):.1f} MB")

    # Write hierarchy.bin
    hier_path = os.path.join(OUT_DIR, 'hierarchy.bin')
    print(f"Writing hierarchy.bin ({len(nodes)} entries)...")
    with open(hier_path, 'wb') as f:
        for node in nodes:
            entry = struct.pack(
                '<BBiqq',
                node['type'],
                node['child_mask'],
                node['num_points'],
                node['byte_offset'],
                node['byte_size'],
            )
            f.write(entry)

    hier_size = os.path.getsize(hier_path)
    print(f"  hierarchy.bin: {hier_size} bytes ({len(nodes)} entries)")

    # Bounding box for metadata
    span = max(tmax[0] - tmin[0], tmax[1] - tmin[1], tmax[2] - tmin[2]) * 1.05
    cx = (tmin[0] + tmax[0]) / 2
    cy = (tmin[1] + tmax[1]) / 2
    cz = (tmin[2] + tmax[2]) / 2
    half = span / 2

    metadata = {
        "version": "2.0",
        "name": "large-test",
        "description": f"Synthetic {NUM_POINTS:,} point test dataset",
        "points": NUM_POINTS,
        "spacing": span / 1000.0,
        "scale": 1.0,
        "offset": [0, 0, 0],
        "boundingBox": {
            "lx": cx - half, "ly": cy - half, "lz": cz - half,
            "ux": cx + half, "uy": cy + half, "uz": cz + half,
        },
        "tightBoundingBox": {
            "lx": float(tmin[0]), "ly": float(tmin[1]), "lz": float(tmin[2]),
            "ux": float(tmax[0]), "uy": float(tmax[1]), "uz": float(tmax[2]),
        },
        "attributes": [
            {"name": "POSITION_CARTESIAN", "type": "float", "size": 12, "numElements": 3, "elementSize": 4},
            {"name": "RGB", "type": "uint8", "size": 3, "numElements": 3, "elementSize": 1},
        ],
        "hierarchy": {
            "firstChunkSize": len(nodes),
        },
        "projection": None,
    }

    meta_path = os.path.join(OUT_DIR, 'metadata.json')
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")
    print(f"Output: {OUT_DIR}/")


def _build_octree(positions, indices, bbox, depth, max_depth, min_leaf):
    """Build octree. Internal nodes (type 2) hold no data; leaf nodes (type 1) hold data."""
    n = len(indices)
    if n == 0:
        return {'type': 1, 'child_mask': 0, 'num_points': 0, 'indices': np.array([], dtype=np.uint32),
                'children': []}

    if n <= min_leaf or depth >= max_depth:
        return {'type': 1, 'child_mask': 0, 'num_points': n, 'indices': indices,
                'children': []}

    lx, ly, lz, ux, uy, uz = bbox
    mx = (lx + ux) * 0.5
    my = (ly + uy) * 0.5
    mz = (lz + uz) * 0.5

    pts = positions[indices]
    gx = (pts[:, 0] >= mx).astype(np.uint8)
    gy = (pts[:, 1] >= my).astype(np.uint8)
    gz = (pts[:, 2] >= mz).astype(np.uint8)
    octant = (gx << 2) | (gy << 1) | gz

    children = []
    child_mask = 0
    child_bboxes = [
        [lx, ly, lz, mx, my, mz], [lx, ly, mz, mx, my, uz],
        [lx, my, lz, mx, uy, mz], [lx, my, mz, mx, uy, uz],
        [mx, ly, lz, ux, my, mz], [mx, ly, mz, ux, my, uz],
        [mx, my, lz, ux, uy, mz], [mx, my, mz, ux, uy, uz],
    ]

    for o in range(8):
        child_idx = indices[octant == o]
        if len(child_idx) == 0:
            continue
        child_mask |= (1 << o)
        child = _build_octree(positions, child_idx, child_bboxes[o], depth + 1, max_depth, min_leaf)
        children.append(child)

    # Internal node: type 2, no own point data
    return {'type': 2, 'child_mask': child_mask, 'num_points': 0,
            'indices': np.array([], dtype=np.uint32), 'children': children}


def _collect_nodes(node, out):
    """Depth-first collection for hierarchy serialization (parent before children)."""
    out.append(node)
    for child in node['children']:
        _collect_nodes(child, out)


if __name__ == '__main__':
    main()
