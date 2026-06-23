#!/usr/bin/env python3
"""Generate a minimal Potree v2.0 test dataset for loader verification."""

import json
import struct
import os
import random

random.seed(42)

NUM_POINTS = 100
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'example', 'potree-test')

# Generate random points in a 10x10x10 box centered at origin
positions = []
colors = []
for _ in range(NUM_POINTS):
    x = random.uniform(-5, 5)
    y = random.uniform(-5, 5)
    z = random.uniform(-5, 5)
    positions.extend([x, y, z])
    r = random.randint(0, 255)
    g = random.randint(0, 255)
    b = random.randint(0, 255)
    colors.extend([r, g, b])

# Compute bounding box
min_x = min(positions[0::3])
max_x = max(positions[0::3])
min_y = min(positions[1::3])
max_y = max(positions[1::3])
min_z = min(positions[2::3])
max_z = max(positions[2::3])

# Make sure bounding box is not zero-size
span = max(max_x - min_x, max_y - min_y, max_z - min_z, 1.0) * 1.1
cx = (min_x + max_x) / 2
cy = (min_y + max_y) / 2
cz = (min_z + max_z) / 2
half = span / 2

# Write metadata.json
metadata = {
    "version": "2.0",
    "name": "potree-test",
    "description": "Synthetic test dataset",
    "spacing": 1.0,
    "scale": 1.0,
    "offset": [0, 0, 0],
    "boundingBox": {
        "lx": cx - half, "ly": cy - half, "lz": cz - half,
        "ux": cx + half, "uy": cy + half, "uz": cz + half,
    },
    "tightBoundingBox": {
        "lx": min_x, "ly": min_y, "lz": min_z,
        "ux": max_x, "uy": max_y, "uz": max_z,
    },
    "attributes": [
        {"name": "POSITION_CARTESIAN", "type": "float", "size": 12, "numElements": 3, "elementSize": 4},
        {"name": "RGB", "type": "uint8", "size": 3, "numElements": 3, "elementSize": 1},
    ],
    "hierarchy": {
        "firstChunkSize": 1,
    },
    "projection": None,
}

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, 'metadata.json'), 'w') as f:
    json.dump(metadata, f, indent=2)

# Write hierarchy.bin (one root entry, 22 bytes)
# Format: type(uint8), childMask(uint8), numPoints(uint32 LE), byteOffset(int64 LE), byteSize(int64 LE)
hier_entry = struct.pack(
    '<BBiqq',
    1,       # type = 1 (real data)
    0,       # childMask = 0 (no children)
    NUM_POINTS,
    0,       # byteOffset = 0 (start of octree.bin)
    0,       # byteSize = 0 (will be filled)
)
with open(os.path.join(OUT_DIR, 'hierarchy.bin'), 'wb') as f:
    f.write(hier_entry)

# Write octree.bin: interleaved POSITION_CARTESIAN (float32*3) + RGB (uint8*3)
# Total per point: 12 + 3 = 15 bytes
octree_data = bytearray()
for i in range(NUM_POINTS):
    # Position as float32 LE
    octree_data.extend(struct.pack('<fff', positions[i*3], positions[i*3+1], positions[i*3+2]))
    # RGB as uint8
    octree_data.extend(struct.pack('BBB', colors[i*3], colors[i*3+1], colors[i*3+2]))

# Update hierarchy.bin with actual byteSize
octree_size = len(octree_data)
hier_entry = struct.pack(
    '<BBiqq',
    1,       # type = 1 (real data)
    0,       # childMask = 0
    NUM_POINTS,
    0,       # byteOffset = 0
    octree_size,
)
with open(os.path.join(OUT_DIR, 'hierarchy.bin'), 'wb') as f:
    f.write(hier_entry)

with open(os.path.join(OUT_DIR, 'octree.bin'), 'wb') as f:
    f.write(octree_data)

print(f"Generated Potree test dataset in {OUT_DIR}")
print(f"  Points: {NUM_POINTS}")
print(f"  metadata.json: {json.dumps(metadata, indent=2)}")
print(f"  hierarchy.bin: {os.path.getsize(os.path.join(OUT_DIR, 'hierarchy.bin'))} bytes")
print(f"  octree.bin: {os.path.getsize(os.path.join(OUT_DIR, 'octree.bin'))} bytes")

# Verify by reading back
print("\nVerification:")
with open(os.path.join(OUT_DIR, 'hierarchy.bin'), 'rb') as f:
    data = f.read()
    t, cm, np, bo, bs = struct.unpack_from('<BBiqq', data, 0)
    print(f"  Root: type={t}, childMask={cm}, numPoints={np}, byteOffset={bo}, byteSize={bs}")
