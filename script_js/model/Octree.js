const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const VIEWPORT_CULL_MARGIN_PX = 40;

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

export function projectBounds(node, cp, out) {
  const cx0 = node.min[0], cx1 = node.max[0];
  const cy0 = node.min[1], cy1 = node.max[1];
  const cz0 = node.min[2], cz1 = node.max[2];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

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

function visibleOnScreen(proj, w, h) {
  return !(proj.maxX < -VIEWPORT_CULL_MARGIN_PX || proj.minX > w + VIEWPORT_CULL_MARGIN_PX || proj.maxY < -VIEWPORT_CULL_MARGIN_PX || proj.minY > h + VIEWPORT_CULL_MARGIN_PX);
}

export function collectVisibleLeaves(node, cp, w, h, out) {
  if (node.count === 0) return;
  projectBounds(node, cp, _proj);
  if (!visibleOnScreen(_proj, w, h)) return;
  if (node.indices) { out.push(node.indices); return; }
  if (node.children) { for (let i = 0; i < node.children.length; i++) collectVisibleLeaves(node.children[i], cp, w, h, out); }
}

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

export function collectAllLeafBuffers(node, bufs) {
  if (node.indices) { bufs.push(node.indices.buffer); return; }
  if (node.children) { for (let i = 0; i < node.children.length; i++) collectAllLeafBuffers(node.children[i], bufs); }
}
