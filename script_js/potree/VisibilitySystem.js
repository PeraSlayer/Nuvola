import { PriorityQueue } from './PriorityQueue.js';
import * as THREE from 'three';

const _box = new THREE.Box3();
const _tmpVec = new THREE.Vector3();
const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
const _corners = new Array(8);
for (let i = 0; i < 8; i++) _corners[i] = new THREE.Vector3();
const VIEWPORT_CULL_MARGIN_PX = 20;
const UNCONDITIONAL_VISIBLE_LEVEL = 2;
const MIN_PIXEL_ISOMETRIC = 250;
const MIN_PIXEL_FPS = 250;

export class VisibilitySystem {
  constructor() {
    this.pointBudget = 1000000;
    this._maxNodesLoadingPerFrame = 16;
    this.maxVisibleDistance = Infinity;
    this._queue = new PriorityQueue();
    this._numNodesLoading = 0;
    this._frameCounter = 0;

    this._cacheStale = true;
    this._cachedResult = null;
    this._cacheFrameCount = 0;
    this._projCache = new Map();
    this._cp = {
      cx: 0, cy: 0, cz: 0,
      cosX: 1, sinX: 0,
      cosY: 1, sinY: 0,
      c: 1, s: 0,
      zoom: 1, panX: 0, panY: 0,
    };

    this._prefetchEnabled = true;
    this._prefetchBudget = 4;
    this._lastCameraPos = null;
    this._cameraVelocity = null;
  }

  set maxNodesLoadingPerFrame(val) {
    this._maxNodesLoadingPerFrame = Math.max(4, Math.min(64, val));
  }

  get maxNodesLoadingPerFrame() {
    return this._maxNodesLoadingPerFrame;
  }

  get numNodesLoading() {
    return this._numNodesLoading;
  }

  incrementNodeLoading() {
    this._numNodesLoading++;
  }

  decrementNodeLoading() {
    this._numNodesLoading--;
  }

  invalidateCache() {
    this._cacheStale = true;
  }

  selectNodes(camera, octreeGeometry, viewportW, viewportH, budget) {
    if (!octreeGeometry || !octreeGeometry.root) {
      return { visibleNodes: [], unloadedNodes: [], numVisiblePoints: 0 };
    }

    if (!this._cacheStale && this._cacheFrameCount < 3) {
      this._cacheFrameCount++;
      return this._cachedResult;
    }

    this._frameCounter++;
    const b = budget != null ? budget : this.pointBudget;
    const root = octreeGeometry.root;
    const isFps = camera.activeMode === 'fps';

    if (isFps) {
      camera.update();
    }

    if (camera._cloudCenter && !camera._cloudCenter[0]) {
      const bb = octreeGeometry.boundingBox;
      camera._cloudCenter = [
        (bb.min.x + bb.max.x) / 2,
        (bb.min.y + bb.max.y) / 2,
        (bb.min.z + bb.max.z) / 2,
      ];
    }

    const result = isFps
      ? this.collectFPSNodes(root, camera, viewportH, b)
      : this.collectOverviewNodes(root, camera, b, viewportW, viewportH);

    this._cachedResult = {
      visibleNodes: result.visibleNodes,
      unloadedNodes: result.unloadedNodes,
      numVisiblePoints: result.numVisiblePoints,
    };
    this._cacheStale = false;
    this._cacheFrameCount = 0;

    return result;
  }

  collectOverviewNodes(root, camera, budget, viewportW, viewportH) {
    const cp = this._extractCameraParams(camera);
    const minPixel = MIN_PIXEL_ISOMETRIC;
    const visibleNodes = [];
    const unloadedNodes = [];
    let accumulated = 0;

    this._queue.clear();
    this._projCache.clear();
    this._queue.push(root, Number.MAX_VALUE);

    while (!this._queue.isEmpty()) {
      const node = this._queue.pop().node;
      const np = node.getNumPoints();
      if (np === 0) continue;
      if (accumulated + np > budget) break;

      const projected = this._computeProjectedNodeIsometric(node, cp, viewportW, viewportH);
      
      if (projected.width === 0 && projected.height === 0) {
        continue;
      }
      
      const screenSize = Math.max(projected.width, projected.height);

      if (screenSize >= minPixel && node.hasChildren) {
        if (!node.children || node.children.length === 0) {
          node.loadChildren();
        }
        if (node.children && node.children.length > 0) {
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (child.numPoints === 0) continue;
            const childProjected = this._computeProjectedNodeIsometric(child, cp, viewportW, viewportH);
            const childScreenSize = Math.max(childProjected.width, childProjected.height);
            
            if (childScreenSize === 0) continue;
            
            this._projCache.set(child, childScreenSize);
            this._queue.push(child, childScreenSize || minPixel);
          }
          continue;
        }
      }

      accumulated += np;
      visibleNodes.push(node);

      if (!node.loaded && !node.loading && node.byteSize > 0n && node.numPoints > 0) {
        unloadedNodes.push(node);
      }
    }

    unloadedNodes.sort((a, b) => {
      const sa = this._projCache.get(a) || minPixel;
      const sb = this._projCache.get(b) || minPixel;
      return sb - sa;
    });

    return { visibleNodes, unloadedNodes, numVisiblePoints: accumulated };
  }

  collectFPSNodes(root, camera, viewportH, budget) {
    const frustum = camera.getFrustum();
    const position = camera.getWorldPosition();
    const fovRad = camera.perspectiveCamera.fov * Math.PI / 180;
    const minPixel = MIN_PIXEL_FPS;
    const projNumerator = 0.5 * viewportH / Math.tan(fovRad * 0.5);

    const visibleNodes = [];
    const unloadedNodes = [];
    let accumulated = 0;

    this._queue.clear();
    this._queue.push(root, Number.MAX_VALUE);

    while (!this._queue.isEmpty()) {
      const entry = this._queue.pop();
      const node = entry.node;

      const bb = node.boundingBox;
      if (!bb) continue;

      _box.copy(bb);
      if (!frustum.intersectsBox(_box)) continue;

      const np = node.getNumPoints();
      if (accumulated + np > budget) break;

      const sphere = node.boundingSphere;
      if (sphere && sphere.radius > 0) {
        _tmpVec.copy(sphere.center);
        const dist = position.distanceTo(_tmpVec);

        if (dist > this.maxVisibleDistance) continue;

        if (dist > sphere.radius) {
          const screenPixelRadius = sphere.radius * projNumerator / dist;

          if (screenPixelRadius < minPixel * 0.5 && node.getLevel() > UNCONDITIONAL_VISIBLE_LEVEL) {
            continue;
          }
        }
      }

      accumulated += np;
      visibleNodes.push(node);

      if (!node.loaded && !node.loading && node.byteSize > 0n && node.numPoints > 0) {
        unloadedNodes.push(node);
      }

      if (node.hasChildren && (!node.children || node.children.length === 0)) {
        node.loadChildren();
      }

      if (!node.children || node.children.length === 0) continue;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.numPoints === 0) continue;

        const childSphere = child.boundingSphere;
        if (!childSphere || childSphere.radius <= 0) continue;

        _tmpVec.copy(childSphere.center);
        const dist = position.distanceTo(_tmpVec);

        if (dist > this.maxVisibleDistance) continue;

        if (dist > childSphere.radius) {
          const screenPixelRadius = childSphere.radius * projNumerator / dist;

          if (screenPixelRadius < minPixel && child.getLevel() > UNCONDITIONAL_VISIBLE_LEVEL) {
            continue;
          }

          this._queue.push(child, screenPixelRadius);
        } else {
          this._queue.push(child, Number.MAX_VALUE);
        }
      }
    }

    unloadedNodes.sort((a, b) => {
      const da = position.distanceTo(a.boundingSphere.center);
      const db = position.distanceTo(b.boundingSphere.center);
      return (b.boundingSphere.radius / Math.max(db, 1e-6))
           - (a.boundingSphere.radius / Math.max(da, 1e-6));
    });

    return { visibleNodes, unloadedNodes, numVisiblePoints: accumulated };
  }

  _extractCameraParams(camera) {
    const cp = this._cp;
    cp.cx = 0; cp.cy = 0; cp.cz = 0;
    cp.cosX = 1; cp.sinX = 0;
    cp.cosY = 1; cp.sinY = 0;
    cp.c = 1; cp.s = 0;
    cp.zoom = 1; cp.panX = 0; cp.panY = 0;

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

  _isNodeVisibleIsometric(node, cp, w, h) {
    const bb = node.boundingBox;
    if (!bb) return true;

    const cx = bb.min.x, cx1 = bb.max.x;
    const cy = bb.min.y, cy1 = bb.max.y;
    const cz = bb.min.z, cz1 = bb.max.z;

    _corners[0].set(cx, cy, cz);
    _corners[1].set(cx1, cy, cz);
    _corners[2].set(cx, cy1, cz);
    _corners[3].set(cx1, cy1, cz);
    _corners[4].set(cx, cy, cz1);
    _corners[5].set(cx1, cy, cz1);
    _corners[6].set(cx, cy1, cz1);
    _corners[7].set(cx1, cy1, cz1);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (let ci = 0; ci < 8; ci++) {
      const corner = _corners[ci];
      let lx = corner.x - cp.cx;
      let ly = corner.y - cp.cy;
      let lz = corner.z - cp.cz;

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

    if (maxX < -VIEWPORT_CULL_MARGIN_PX || minX > w + VIEWPORT_CULL_MARGIN_PX ||
        maxY < -VIEWPORT_CULL_MARGIN_PX || minY > h + VIEWPORT_CULL_MARGIN_PX) {
      return false;
    }

    _proj.minX = minX; _proj.maxX = maxX;
    _proj.minY = minY; _proj.maxY = maxY;
    return true;
  }

  _computeProjectedNodeIsometric(node, cp, w, h) {
    if (!this._isNodeVisibleIsometric(node, cp, w, h)) {
      return { width: 0, height: 0 };
    }
    return {
      width: _proj.maxX - _proj.minX,
      height: _proj.maxY - _proj.minY,
    };
  }
}
