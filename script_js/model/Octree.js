/**
 * @file Octree.js
 * @description Octree utilities for the Nuvola 2.5D point-cloud viewer.
 *              Provides camera-parameter extraction, isometric screen-space
 *              projection of octree node bounding boxes, viewport-culling,
 *              visible-leaf collection, and helpers for flattening the octree
 *              into linear GPU-friendly index buffers.
 */

/**
 * Reusable scratch object for projecting node bounds to screen space.
 * Avoids per-call allocations during tree traversal.
 */
const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

/**
 * Frustum margin (in pixels) added beyond the viewport edges so that nodes
 * just outside the screen are still considered visible — prevents pop-in
 * during fast panning.
 */
const VIEWPORT_CULL_MARGIN_PX = 40;

/**
 * Extracts a flat dictionary of isometric camera parameters from a {@link Camera}
 * instance, pre-computing trig values used during screen-space projection.
 *
 * @param {import('./camera.js').Camera} camera
 * @returns {{cx: number, cy: number, cz: number, cosX: number, sinX: number, cosY: number, sinY: number, c: number, s: number, zoom: number, panX: number, panY: number}}
 */
export function extractCamParams(camera) {
  const rxd = camera.rotationXDeg, ryd = camera.rotationYDeg;
  const rx = rxd * Math.PI / 180, ry = ryd * Math.PI / 180;
  return {
    cx: camera._cloudCenter[0], cy: camera._cloudCenter[1], cz: camera._cloudCenter[2],
    cosX: Math.cos(rx), sinX: Math.sin(rx),
    cosY: Math.cos(ry), sinY: Math.sin(ry),
    c: Math.cos(camera.rotAngle), s: Math.sin(camera.rotAngle),
    zoom: camera.zoom, panX: camera.panX, panY: camera.panY,
  };
}

/**
 * Projects the eight corners of an octree node's bounding box into
 * isometric screen space and writes the axis-aligned screen-space bounds
 * into the provided output object.
 *
 * @param {{min: number[], max: number[]}} node - Octree node with [min,max] world-space bounds.
 * @param {{cx: number, cy: number, cz: number, cosX: number, sinX: number, cosY: number, sinY: number, c: number, s: number, zoom: number, panX: number, panY: number}} cp - Camera parameters from {@link extractCamParams}.
 * @param {{minX: number, maxX: number, minY: number, maxY: number}} out - Object receiving the screen-space AABB.
 */
export function projectBounds(node, cp, out) {
  const cx0 = node.min[0], cx1 = node.max[0];
  const cy0 = node.min[1], cy1 = node.max[1];
  const cz0 = node.min[2], cz1 = node.max[2];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  // Iterate over the eight corners via bit flags for each axis.
  for (let ci = 0; ci < 8; ci++) {
    const x = ci & 1 ? cx1 : cx0;
    const y = ci & 2 ? cy1 : cy0;
    const z = ci & 4 ? cz1 : cz0;
    let lx = x - cp.cx, ly = y - cp.cy, lz = z - cp.cz;
    if (cp.sinX) { const y1 = ly * cp.cosX - lz * cp.sinX; const z1 = ly * cp.sinX + lz * cp.cosX; ly = y1; lz = z1; }
    if (cp.sinY) { const x1 = lx * cp.cosY + lz * cp.sinY; const z2 = -lx * cp.sinY + lz * cp.cosY; lx = x1; lz = z2; }
    const rr = lx * cp.c - ly * cp.s;
    const rry = lx * cp.s + ly * cp.c;
    const sx = (rr - rry) * cp.zoom + cp.panX;
    const sy = ((rr + rry) * 0.5 - lz) * cp.zoom + cp.panY;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  out.minX = minX; out.maxX = maxX; out.minY = minY; out.maxY = maxY;
}

/**
 * Tests whether a screen-space AABB overlaps the viewport rectangle
 * (including a margin for gradual culling).
 *
 * @param {{minX: number, maxX: number, minY: number, maxY: number}} proj
 * @param {number} w - Viewport width in pixels.
 * @param {number} h - Viewport height in pixels.
 * @returns {boolean}
 */
function visibleOnScreen(proj, w, h) {
  return !(proj.maxX < -VIEWPORT_CULL_MARGIN_PX || proj.minX > w + VIEWPORT_CULL_MARGIN_PX || proj.maxY < -VIEWPORT_CULL_MARGIN_PX || proj.minY > h + VIEWPORT_CULL_MARGIN_PX);
}

/**
 * Recursively collects the index arrays of all visible leaf nodes in the
 * octree, pushing each leaf's {@link node.indices} into the output array.
 *
 * @param {{count: number, indices?: Uint32Array, children?: Array, min: number[], max: number[]}} node
 * @param {{cx: number, cy: number, cz: number, cosX: number, sinX: number, cosY: number, sinY: number, c: number, s: number, zoom: number, panX: number, panY: number}} cp
 * @param {number} w
 * @param {number} h
 * @param {Uint32Array[]} out - Accumulator for visible leaf index buffers.
 */
export function collectVisibleLeaves(node, cp, w, h, out) {
  if (node.count === 0) return;
  projectBounds(node, cp, _proj);
  if (!visibleOnScreen(_proj, w, h)) return;
  if (node.indices) { out.push(node.indices); return; }
  if (node.children) { for (let i = 0; i < node.children.length; i++) collectVisibleLeaves(node.children[i], cp, w, h, out); }
}

/**
 * Flattens all leaf index arrays of the octree into a single output buffer,
 * starting at the position tracked by {@link offset.current}. Used to
 * consolidate visible indices into a contiguous GPU range.
 *
 * @param {{indices?: Uint32Array, children?: Array}} node
 * @param {Uint32Array} outBuf - Destination buffer.
 * @param {{current: number}} offset - Mutable pointer into outBuf.
 */
export function flattenTree(node, outBuf, offset) {
  if (node.indices) {
    outBuf.set(node.indices, offset.current);
    offset.current += node.indices.length;
    return;
  }
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      flattenTree(node.children[i], outBuf, offset);
    }
  }
}

/**
 * Collects the underlying ArrayBuffer of every leaf node's index array.
 * Useful for bulk GPU buffer operations (e.g. multi-draw indirect).
 *
 * @param {{indices?: Uint32Array, children?: Array}} node
 * @param {ArrayBuffer[]} bufs - Accumulator for ArrayBuffer references.
 */
export function collectAllLeafBuffers(node, bufs) {
  if (node.indices) { bufs.push(node.indices.buffer); return; }
  if (node.children) { for (let i = 0; i < node.children.length; i++) collectAllLeafBuffers(node.children[i], bufs); }
}
