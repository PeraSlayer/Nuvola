#!/usr/bin/env python3
"""
Convert LAS/PLY point cloud files to Potree v2.0 streaming format.

Usage:
    python3 convert-to-potree.py input.las output_dir/
    python3 convert-to-potree.py input.ply output_dir/
    python3 convert-to-potree.py input.ply.gz output_dir/

Options:
    --max-depth N        Maximum octree depth (default: 6)
    --min-leaf N         Minimum points per leaf node (default: 20000)
"""

import argparse
import gzip
import json
import os
import struct
import sys
import time

import numpy as np


# ═══════════════════════════════════════════════════════════════════════════════
#  LAS Reader
# ═══════════════════════════════════════════════════════════════════════════════

LAS_RGB_OFFSET = {
    2: 20,   3: 28,   7: 26,   8: 34,   10: 30,
}


def read_las(filepath):
    """Read LAS/LAZ file. Returns (positions f32, colors u8, intensity u16)."""
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 227:
        raise ValueError('File too small for LAS header')

    if data[0:4] != b'LASF':
        raise ValueError('Missing LASF signature')

    major = data[24]
    minor = data[25]
    header_size = struct.unpack_from('<H', data, 94)[0]
    point_offset = struct.unpack_from('<I', data, 96)[0]
    point_format = data[104]
    record_len = struct.unpack_from('<H', data, 105)[0]
    legacy_count = struct.unpack_from('<I', data, 107)[0]

    point_count = legacy_count
    if major == 1 and minor >= 4 and header_size >= 375:
        lo = struct.unpack_from('<I', data, 247)[0]
        hi = struct.unpack_from('<I', data, 251)[0]
        c64 = lo + (hi << 32)
        if 0 < c64 <= 1_000_000_000:
            point_count = c64

    if not (0 < point_count <= 500_000_000):
        raise ValueError(f'Invalid point count: {point_count}')

    scale = (
        struct.unpack_from('<d', data, 131)[0],
        struct.unpack_from('<d', data, 139)[0],
        struct.unpack_from('<d', data, 147)[0],
    )
    offset = (
        struct.unpack_from('<d', data, 155)[0],
        struct.unpack_from('<d', data, 163)[0],
        struct.unpack_from('<d', data, 171)[0],
    )

    has_color = point_format in LAS_RGB_OFFSET
    rgb_off = LAS_RGB_OFFSET.get(point_format, -1)

    print(f'  LAS v{major}.{minor}, format {point_format}, {point_count:,} points')

    positions = np.zeros((point_count, 3), dtype=np.float32)
    colors = np.zeros((point_count, 3), dtype=np.uint8)
    intensity = np.zeros(point_count, dtype=np.uint16)

    chunk = 2_000_000
    for start in range(0, point_count, chunk):
        end = min(start + chunk, point_count)
        n = end - start

        for i in range(n):
            p = point_offset + (start + i) * record_len
            if p + record_len > len(data):
                break

            x = struct.unpack_from('<i', data, p)[0]
            y = struct.unpack_from('<i', data, p + 4)[0]
            z = struct.unpack_from('<i', data, p + 8)[0]
            positions[start + i] = (
                x * scale[0] + offset[0],
                y * scale[1] + offset[1],
                z * scale[2] + offset[2],
            )

            intensity[start + i] = struct.unpack_from('<H', data, p + 12)[0]

            if has_color and rgb_off >= 0:
                r = struct.unpack_from('<H', data, p + rgb_off)[0] >> 8
                g = struct.unpack_from('<H', data, p + rgb_off + 2)[0] >> 8
                b = struct.unpack_from('<H', data, p + rgb_off + 4)[0] >> 8
                colors[start + i] = (r, g, b)
            else:
                colors[start + i] = (180, 180, 200)

        pct = end * 100 // point_count
        print(f'\r  Reading: {end:,} / {point_count:,} ({pct}%)', end='', flush=True)
    print()

    return positions, colors, intensity, point_count, has_color


# ═══════════════════════════════════════════════════════════════════════════════
#  PLY Reader
# ═══════════════════════════════════════════════════════════════════════════════

_TYPE_SIZES = {
    'char': 1, 'int8': 1, 'uchar': 1, 'uint8': 1,
    'short': 2, 'int16': 2, 'ushort': 2, 'uint16': 2,
    'int': 4, 'int32': 4, 'uint': 4, 'uint32': 4,
    'float': 4, 'float32': 4, 'double': 8, 'float64': 8,
}

_STRUCT_FMT = {
    'char': 'b', 'int8': 'b', 'uchar': 'B', 'uint8': 'B',
    'short': 'h', 'int16': 'h', 'ushort': 'H', 'uint16': 'H',
    'int': 'i', 'int32': 'i', 'uint': 'I', 'uint32': 'I',
    'float': 'f', 'float32': 'f', 'double': 'd', 'float64': 'd',
}


def read_ply(filepath):
    """Read PLY (ASCII, binary LE/BE, optionally .gz). Returns (positions f32, colors u8, intensity u16 or None)."""
    if filepath.endswith('.gz'):
        with gzip.open(filepath, 'rb') as f:
            raw = f.read()
    else:
        with open(filepath, 'rb') as f:
            raw = f.read()

    # ── Parse header ──────────────────────────────────────────────────────────
    hdr_end = raw.find(b'end_header\n')
    if hdr_end == -1:
        raise ValueError('PLY header not found')

    header_text = raw[:hdr_end + len(b'end_header\n')].decode('ascii', errors='replace')
    lines = header_text.strip().split('\n')
    if lines[0].strip() != 'ply':
        raise ValueError('Not a PLY file')

    fmt_type = None
    vertex_count = 0
    properties = []
    in_vertex = False

    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if parts[0] == 'format':
            fmt_type = parts[1]
        elif parts[0] == 'element':
            in_vertex = (parts[1] == 'vertex')
            if in_vertex:
                vertex_count = int(parts[2])
        elif parts[0] == 'property' and in_vertex:
            if parts[1] == 'list':
                properties.append({'name': parts[-1], 'type': 'list', 'count_type': parts[2], 'item_type': parts[3]})
            else:
                properties.append({'name': parts[-1], 'type': parts[1]})

    if not fmt_type or not vertex_count:
        raise ValueError('Invalid PLY header')

    print(f'  PLY {fmt_type}, {vertex_count:,} vertices')
    for p in properties:
        print(f'    property {p["type"]:>6s} {p["name"]}')

    data_start = hdr_end + len(b'end_header\n')

    # ── Find property indices ─────────────────────────────────────────────────
    prop_names = [p['name'].lower() for p in properties]

    def _find(names):
        for n in names:
            try:
                return prop_names.index(n)
            except ValueError:
                pass
        return -1

    ix = _find(['x'])
    iy = _find(['y'])
    iz = _find(['z'])
    ir = _find(['red', 'r'])
    ig = _find(['green', 'g'])
    ib = _find(['blue', 'b'])
    ii = _find(['intensity', 'scalar_intensity', 'i', 'reflectance'])

    if ix < 0 or iy < 0 or iz < 0:
        raise ValueError('PLY missing x/y/z properties')

    has_color = ir >= 0 and ig >= 0 and ib >= 0
    has_intensity = ii >= 0

    positions = np.zeros((vertex_count, 3), dtype=np.float32)
    colors = np.zeros((vertex_count, 3), dtype=np.uint8)
    intensity = np.zeros(vertex_count, dtype=np.float64) if has_intensity else None

    # ── Read data ─────────────────────────────────────────────────────────────
    chunk = 500_000
    if fmt_type == 'ascii':
        _read_ply_ascii(raw, data_start, vertex_count, properties,
                        ix, iy, iz, ir, ig, ib, ii,
                        positions, colors, intensity, chunk)
    elif fmt_type == 'binary_little_endian':
        _read_ply_binary(raw, data_start, vertex_count, properties,
                         ix, iy, iz, ir, ig, ib, ii,
                         positions, colors, intensity, True, chunk)
    elif fmt_type == 'binary_big_endian':
        _read_ply_binary(raw, data_start, vertex_count, properties,
                         ix, iy, iz, ir, ig, ib, ii,
                         positions, colors, intensity, False, chunk)
    else:
        raise ValueError(f'Unsupported PLY format: {fmt_type}')

    # ── Post-process colors ───────────────────────────────────────────────────
    if not has_color:
        if intensity is not None and intensity.max() > intensity.min():
            i_norm = (intensity - intensity.min()) / (intensity.max() - intensity.min())
            grey = (i_norm * 255).astype(np.uint8)
            colors[:, 0] = grey
            colors[:, 1] = grey
            colors[:, 2] = grey
        else:
            colors[:] = (180, 180, 200)

    # ── Convert intensity to uint16 for Potree ────────────────────────────────
    if has_intensity and intensity is not None:
        i_min = intensity.min()
        i_max = intensity.max()
        if i_max > i_min:
            intensity_u16 = ((intensity - i_min) / (i_max - i_min) * 65535).astype(np.uint16)
        else:
            intensity_u16 = np.full(vertex_count, 32768, dtype=np.uint16)
    else:
        intensity_u16 = None

    return positions, colors, intensity_u16, vertex_count, has_color


def _read_ply_ascii(raw, start, count, props, ix, iy, iz, ir, ig, ib, ii,
                    pos, col, inten, chunk):
    """Read PLY ASCII in chunks, writing into preallocated arrays."""
    text = raw[start:].decode('utf-8', errors='replace')
    lines = text.strip().split('\n')
    for v, line in enumerate(lines):
        if v >= count:
            break
        line = line.strip()
        if not line:
            continue
        vals = line.split()
        needed = max(ix, iy, iz)
        if ir >= 0: needed = max(needed, ir)
        if ig >= 0: needed = max(needed, ig)
        if ib >= 0: needed = max(needed, ib)
        if ii >= 0: needed = max(needed, ii)
        if len(vals) <= needed:
            continue

        pos[v, 0] = _float(vals[ix])
        pos[v, 1] = _float(vals[iy])
        pos[v, 2] = _float(vals[iz])

        if ir >= 0 and ig >= 0 and ib >= 0:
            col[v] = (
                _clamp(int(_float(vals[ir])), 0, 255),
                _clamp(int(_float(vals[ig])), 0, 255),
                _clamp(int(_float(vals[ib])), 0, 255),
            )

        if ii >= 0 and inten is not None:
            inten[v] = _float(vals[ii])

        if (v + 1) % chunk == 0:
            pct = (v + 1) * 100 // count
            print(f'\r  Parsing ASCII: {v+1:,} / {count:,} ({pct}%)', end='', flush=True)
    print()


def _read_ply_binary(raw, start, count, props, ix, iy, iz, ir, ig, ib, ii,
                     pos, col, inten, little_endian, chunk):
    """Read PLY binary in a loop, writing into preallocated arrays."""
    endian = '<' if little_endian else '>'

    offsets = []
    stride = 0
    for p in props:
        offsets.append(stride)
        if p['type'] != 'list':
            stride += _TYPE_SIZES.get(p['type'], 4)

    float_color_types = ('float', 'float32', 'float64', 'double')

    for v in range(count):
        base = start + v * stride
        if base + stride > len(raw):
            break

        pos[v, 0] = _read_field(raw, base + offsets[ix], props[ix]['type'], endian)
        pos[v, 1] = _read_field(raw, base + offsets[iy], props[iy]['type'], endian)
        pos[v, 2] = _read_field(raw, base + offsets[iz], props[iz]['type'], endian)

        if ir >= 0 and ig >= 0 and ib >= 0:
            r = _read_field(raw, base + offsets[ir], props[ir]['type'], endian)
            g = _read_field(raw, base + offsets[ig], props[ig]['type'], endian)
            b = _read_field(raw, base + offsets[ib], props[ib]['type'], endian)
            if props[ir]['type'] in float_color_types:
                col[v] = (_clamp(int(r * 255), 0, 255),
                          _clamp(int(g * 255), 0, 255),
                          _clamp(int(b * 255), 0, 255))
            else:
                col[v] = (_clamp(int(r), 0, 255),
                          _clamp(int(g), 0, 255),
                          _clamp(int(b), 0, 255))

        if ii >= 0 and inten is not None:
            inten[v] = _read_field(raw, base + offsets[ii], props[ii]['type'], endian)

        if (v + 1) % chunk == 0:
            pct = (v + 1) * 100 // count
            print(f'\r  Parsing binary: {v+1:,} / {count:,} ({pct}%)', end='', flush=True)
    print()


def _read_field(raw, offset, ptype, endian):
    fmt = _STRUCT_FMT.get(ptype, 'f')
    return struct.unpack_from(endian + fmt, raw, offset)[0]


def _float(s):
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0.0


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ═══════════════════════════════════════════════════════════════════════════════
#  Octree builder + Potree v2.0 writer
# ═══════════════════════════════════════════════════════════════════════════════

def build_and_write_potree(positions, colors, intensity, output_dir,
                           max_depth=6, min_leaf=20000):
    """Build multi-level octree and write Potree v2.0 output."""
    os.makedirs(output_dir, exist_ok=True)
    n = positions.shape[0]
    t0 = time.time()
    has_intensity = intensity is not None

    bbox = [
        float(positions[:, 0].min()), float(positions[:, 1].min()),
        float(positions[:, 2].min()),
        float(positions[:, 0].max()), float(positions[:, 1].max()),
        float(positions[:, 2].max()),
    ]

    print(f'  Bounds: X[{bbox[0]:.2f}, {bbox[3]:.2f}] '
          f'Y[{bbox[1]:.2f}, {bbox[4]:.2f}] '
          f'Z[{bbox[2]:.2f}, {bbox[5]:.2f}]')

    # Build octree
    print('  Building octree...')
    all_idx = np.arange(n, dtype=np.uint32)
    root = _octree_build(positions, all_idx, bbox, 0, max_depth, min_leaf)

    nodes = []
    _octree_collect(root, nodes)

    internal = sum(1 for nd in nodes if nd['child_mask'] != 0)
    leaves = sum(1 for nd in nodes if nd['child_mask'] == 0)
    leaf_pts = sum(nd['num_points'] for nd in nodes if nd['child_mask'] == 0)
    print(f'  Nodes: {len(nodes)} (internal: {internal}, leaf: {leaves}), '
          f'leaf points: {leaf_pts:,}')

    # Per-point byte layout: POS(12) + RGB(3) [+ INTENSITY(2)] = 15 or 17 bytes
    bytes_per_point = 15 + (2 if has_intensity else 0)
    attr_fmt = '<fffBBB' + ('H' if has_intensity else '')

    # Write octree.bin
    octree_path = os.path.join(output_dir, 'octree.bin')
    print(f'  Writing octree.bin ({bytes_per_point} B/point)...')
    with open(octree_path, 'wb') as f:
        for i, node in enumerate(nodes):
            node['byte_offset'] = f.tell()
            if node['num_points'] > 0 and len(node['indices']) > 0:
                idxs = node['indices']
                # Pack all points for this node at once for speed
                for idx in idxs:
                    x, y, z = positions[idx]
                    r, g, b = colors[idx]
                    if has_intensity:
                        f.write(struct.pack(attr_fmt,
                            float(x), float(y), float(z),
                            int(r), int(g), int(b),
                            int(intensity[idx])))
                    else:
                        f.write(struct.pack(attr_fmt,
                            float(x), float(y), float(z),
                            int(r), int(g), int(b)))
            node['byte_size'] = f.tell() - node['byte_offset']
            if (i + 1) % 1000 == 0:
                print(f'\r    {i + 1}/{len(nodes)} nodes', end='', flush=True)
    print()

    octree_mb = os.path.getsize(octree_path) / (1024 * 1024)
    print(f'    octree.bin: {octree_mb:.1f} MB')

    # Write hierarchy.bin
    hier_path = os.path.join(output_dir, 'hierarchy.bin')
    with open(hier_path, 'wb') as f:
        for node in nodes:
            f.write(struct.pack('<BBiqq',
                node['type'],
                node['child_mask'],
                node['num_points'],
                node['byte_offset'],
                node['byte_size'],
            ))
    hier_size = os.path.getsize(hier_path)
    print(f'    hierarchy.bin: {hier_size} bytes ({len(nodes)} entries)')

    # ── Metadata ──────────────────────────────────────────────────────────────
    span = max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]) * 1.05
    cx = (bbox[0] + bbox[3]) / 2
    cy = (bbox[1] + bbox[4]) / 2
    cz = (bbox[2] + bbox[5]) / 2
    half = span / 2

    attributes = [
        {"name": "POSITION_CARTESIAN", "type": "float", "size": 12,
         "numElements": 3, "elementSize": 4},
        {"name": "RGB", "type": "uint8", "size": 3,
         "numElements": 3, "elementSize": 1},
    ]
    if has_intensity:
        attributes.append({
            "name": "INTENSITY", "type": "uint16", "size": 2,
            "numElements": 1, "elementSize": 2, "minSize": 2,
        })

    metadata = {
        "version": "2.0",
        "name": os.path.basename(output_dir),
        "description": f"Converted — {n:,} points",
        "points": n,
        "spacing": span / 1000.0,
        "scale": 1.0,
        "offset": [0, 0, 0],
        "boundingBox": {
            "lx": cx - half, "ly": cy - half, "lz": cz - half,
            "ux": cx + half, "uy": cy + half, "uz": cz + half,
        },
        "tightBoundingBox": {
            "lx": bbox[0], "ly": bbox[1], "lz": bbox[2],
            "ux": bbox[3], "uy": bbox[4], "uz": bbox[5],
        },
        "attributes": attributes,
        "hierarchy": {"firstChunkSize": len(nodes)},
        "projection": None,
    }

    meta_path = os.path.join(output_dir, 'metadata.json')
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    elapsed = time.time() - t0
    print(f'  Done in {elapsed:.1f}s → {output_dir}/')


def _octree_build(positions, indices, bbox, depth, max_depth, min_leaf):
    n = len(indices)
    if n == 0:
        return {'type': 1, 'child_mask': 0, 'num_points': 0,
                'indices': np.array([], dtype=np.uint32), 'children': []}

    if n <= min_leaf or depth >= max_depth:
        return {'type': 1, 'child_mask': 0, 'num_points': n,
                'indices': indices, 'children': []}

    lx, ly, lz, ux, uy, uz = bbox
    mx, my, mz = (lx + ux) / 2, (ly + uy) / 2, (lz + uz) / 2

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
        child = _octree_build(positions, child_idx, child_bboxes[o],
                              depth + 1, max_depth, min_leaf)
        children.append(child)

    return {'type': 2, 'child_mask': child_mask, 'num_points': 0,
            'indices': np.array([], dtype=np.uint32), 'children': children}


def _octree_collect(node, out):
    out.append(node)
    for child in node['children']:
        _octree_collect(child, out)


# ═══════════════════════════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description='Convert LAS/PLY to Potree v2.0 streaming format')
    parser.add_argument('input', help='Input file (.las, .laz, .ply, .ply.gz)')
    parser.add_argument('output_dir', nargs='?', default=None,
                        help='Output directory (default: <input>_potree/)')
    parser.add_argument('--max-depth', type=int, default=6,
                        help='Max octree depth (default: 6)')
    parser.add_argument('--min-leaf', type=int, default=20000,
                        help='Min points per leaf (default: 20000)')
    args = parser.parse_args()

    filepath = args.input
    if not os.path.isfile(filepath):
        print(f'Error: file not found: {filepath}', file=sys.stderr)
        sys.exit(1)

    # Derive output directory name
    output_dir = args.output_dir
    if not output_dir:
        base = os.path.basename(filepath)
        # Strip .gz first, then strip .ply/.las/.laz
        if base.endswith('.gz'):
            base = base[:-3]
        output_dir = os.path.splitext(base)[0] + '_potree'

    fn = filepath.lower()

    print(f'Input:  {filepath}')
    print(f'Output: {output_dir}/')
    print(f'Octree: max_depth={args.max_depth}  min_leaf={args.min_leaf}')
    print()

    # ── Parse input ───────────────────────────────────────────────────────────
    if fn.endswith('.las') or fn.endswith('.laz'):
        positions, colors, intensity, count, _has_c = read_las(filepath)
    elif fn.endswith('.ply') or fn.endswith('.ply.gz') or \
         (fn.endswith('.gz') and '.ply' in fn):
        positions, colors, intensity, count, _has_c = read_ply(filepath)
    else:
        print('Error: unsupported format. Use .las, .laz, .ply, or .ply.gz',
              file=sys.stderr)
        sys.exit(1)

    print(f'  Loaded {count:,} points  '
          f'pos={positions.shape}  col={colors.shape}'
          + (f'  int={intensity.shape}' if intensity is not None else ''))
    print()

    # ── Convert ───────────────────────────────────────────────────────────────
    build_and_write_potree(positions, colors, intensity, output_dir,
                           args.max_depth, args.min_leaf)


if __name__ == '__main__':
    main()
