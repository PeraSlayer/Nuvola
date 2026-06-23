import { PriorityQueue } from './PriorityQueue.js';
import * as THREE from 'three';

const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const VIEWPORT_CULL_MARGIN_PX = 40;
const _tmpVec = new THREE.Vector3();

export class VisibilitySystem {
  constructor() {
    this.pointBudget = 1000000;
    this.minimumNodePixelSize = 150;
    this.maxNodesLoadingPerFrame = 4;
    this._queue = new PriorityQueue();
    this._lastFrame = 0;
    this._numNodesLoading = 0;
  }

  selectNodes(camera, octreeGeometry, viewportW, viewportH, budget) {
    if (!octreeGeometry || !octreeGeometry.root) {
      return { visibleNodes: [], unloadedNodes: [], numVisiblePoints: 0 };
    }

    const b = budget != null ? budget : this.pointBudget;
    const root = octreeGeometry.root;

    const isFps = camera.activeMode === 'fps';

    this._queue.clear();
    this._queue.push(root, Number.MAX_VALUE);

    const visibleNodes = [];
    const unloadedNodes = [];
    let accumulated = 0;

    const cp = isFps ? this._extractCameraParamsFPS(camera) : this._extractCameraParams(camera);

    while (!this._queue.isEmpty()) {
      const element = this._queue.pop();
      const node = element.node;

      if (!this._isNodeVisible(node, cp, viewportW, viewportH, isFps)) continue;

      if (accumulated + node.getNumPoints() > b) continue;

      accumulated += node.getNumPoints();
      visibleNodes.push(node);

      if (!node.loaded && node.geometry === octreeGeometry) {
        if (node.byteSize > 0n && node.numPoints > 0) {
          unloadedNodes.push(node);
        }
      }

      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          if (child.numPoints === 0) continue;
          const size = isFps
            ? this._computeProjectedNodeFPS(child, cp, viewportW, viewportH)
            : this._computeProjectedNode(child, cp, viewportW, viewportH).width;
          if (size < this.minimumNodePixelSize) continue;
          this._queue.push(child, size);
        }
      }
    }

    this._lastFrame++;
    return { visibleNodes, unloadedNodes, numVisiblePoints: accumulated };
  }

  _extractCameraParams(camera) {
    const cp = {
      cx: 0, cy: 0, cz: 0,
      cosX: 1, sinX: 0,
      cosY: 1, sinY: 0,
      c: 1, s: 0,
      zoom: 1, panX: 0, panY: 0,
    };

    if (camera._cloudCenter) {
      cp.cx = camera._cloudCenter[0];
      cp.cy = camera._cloudCenter[1];
      cp.cz = camera._cloudCenter[2];
    }

    if (camera.rotationXDeg !== undefined) {
      const rx = camera.rotationXDeg * Math.PI / 180;
      cp.cosX = Math.cos(rx);
      cp.sinX = Math.sin(rx);
    }

    if (camera.rotationYDeg !== undefined) {
      const ry = camera.rotationYDeg * Math.PI / 180;
      cp.cosY = Math.cos(ry);
      cp.sinY = Math.sin(ry);
    }

    if (camera.rotAngle !== undefined) {
      cp.c = Math.cos(camera.rotAngle);
      cp.s = Math.sin(camera.rotAngle);
    }

    if (camera.zoom !== undefined) cp.zoom = camera.zoom;
    if (camera.panX !== undefined) cp.panX = camera.panX;
    if (camera.panY !== undefined) cp.panY = camera.panY;

    return cp;
  }

  _extractCameraParamsFPS(camera) {
    const fpsCam = camera.fpsCamera;
    fpsCam.update();
    const frustum = fpsCam.getFrustum();
    const position = fpsCam.getWorldPosition();
    return {
      frustum,
      position,
      isFps: true,
    };
  }

  _projectNodeBounds(node, cp, out) {
    const bb = node.boundingBox;
    if (!bb) return false;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    const corners = [
      [bb.min.x, bb.min.y, bb.min.z],
      [bb.max.x, bb.min.y, bb.min.z],
      [bb.min.x, bb.max.y, bb.min.z],
      [bb.max.x, bb.max.y, bb.min.z],
      [bb.min.x, bb.min.y, bb.max.z],
      [bb.max.x, bb.min.y, bb.max.z],
      [bb.min.x, bb.max.y, bb.max.z],
      [bb.max.x, bb.max.y, bb.max.z],
    ];

    for (let ci = 0; ci < 8; ci++) {
      let lx = corners[ci][0] - cp.cx;
      let ly = corners[ci][1] - cp.cy;
      let lz = corners[ci][2] - cp.cz;

      if (cp.sinX) {
        const y1 = ly * cp.cosX - lz * cp.sinX;
        const z1 = ly * cp.sinX + lz * cp.cosX;
        ly = y1; lz = z1;
      }
      if (cp.sinY) {
        const x1 = lx * cp.cosY + lz * cp.sinY;
        const z2 = -lx * cp.sinY + lz * cp.cosY;
        lx = x1; lz = z2;
      }

      const rx = lx * cp.c - ly * cp.s;
      const ry = lx * cp.s + ly * cp.c;
      const sx = (rx - ry) * cp.zoom + cp.panX;
      const sy = ((rx + ry) * 0.5 - lz) * cp.zoom + cp.panY;

      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    out.minX = minX; out.maxX = maxX; out.minY = minY; out.maxY = maxY;
    return true;
  }

  _isNodeVisible(node, cp, w, h, isFps) {
    if (isFps) {
      const bb = node.boundingBox;
      if (!bb) return true;
      const box = new THREE.Box3(
        new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
        new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
      );
      return cp.frustum.intersectsBox(box);
    }
    if (!this._projectNodeBounds(node, cp, _proj)) return true;
    const p = _proj;
    if (p.maxX < -VIEWPORT_CULL_MARGIN_PX || p.minX > w + VIEWPORT_CULL_MARGIN_PX || p.maxY < -VIEWPORT_CULL_MARGIN_PX || p.minY > h + VIEWPORT_CULL_MARGIN_PX) return false;
    return true;
  }

  _computeProjectedNode(node, cp, w, h) {
    this._projectNodeBounds(node, cp, _proj);
    return {
      width: _proj.maxX - _proj.minX,
      height: _proj.maxY - _proj.minY,
      area: (_proj.maxX - _proj.minX) * (_proj.maxY - _proj.minY),
    };
  }

  _computeProjectedNodeFPS(node, cp) {
    const bb = node.boundingBox;
    if (!bb) return 1000;
    _tmpVec.set(
      (bb.min.x + bb.max.x) * 0.5,
      (bb.min.y + bb.max.y) * 0.5,
      (bb.min.z + bb.max.z) * 0.5,
    );
    const dist = cp.position.distanceTo(_tmpVec);
    const size = bb.max.x - bb.min.x;
    return dist > 0 ? (size / dist) * 1000 : 10000;
  }
}
