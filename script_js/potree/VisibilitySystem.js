/**
 * @file VisibilitySystem.js
 * @description Determines which octree nodes should be visible and/or loaded
 *   for the current camera state. Implements two visibility strategies:
 *     - **Isometric**: Uses a custom 2.5D projection that tests AABB corners
 *       against the viewport after applying rotation and pan transforms.
 *     - **FPS**: Uses standard 3D frustum culling plus projected sphere-size
 *       tests to balance detail vs. performance.
 *   Produces ordered lists of visible/unloaded nodes for the renderer.
 */

import { PriorityQueue } from './PriorityQueue.js';
import * as THREE from 'three';

/** Reusable Box3 for frustum intersection tests. */
const _box = new THREE.Box3();
/** Reusable Vector3 for distance calculations. */
const _tmpVec = new THREE.Vector3();
/** Reusable projected bounds rectangle. */
const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
/** Pre-allocated array of 8 corner vectors for AABB projection. */
const _corners = new Array(8);
for (let i = 0; i < 8; i++) _corners[i] = new THREE.Vector3();
/** Pixel margin beyond the viewport edges within which nodes are still
 *  considered visible (prevents pop-in at edges). */
const VIEWPORT_CULL_MARGIN_PX = 10;
/** Octree levels below this value are always considered visible regardless of
 *  screen projection size. */
const UNCONDITIONAL_VISIBLE_LEVEL = 2;
/** Minimum projected screen size (in pixels) for an isometric node to be
 *  considered detailed enough to refine. */
const MIN_PIXEL_ISOMETRIC = 250;
/** Minimum projected screen radius (in pixels) for an FPS node to be visible. */
const MIN_PIXEL_FPS = 300;

/**
 * Manages octree-node visibility determination and loading prioritization.
 * Caches results for a configurable number of frames to amortize cost.
 *
 * @class VisibilitySystem
 */
export class VisibilitySystem {
  constructor() {
    /** @type {number} Soft limit on total points visible at once. */
    this.pointBudget = 1000000;
    /** @type {number} Cap on concurrent node loads per frame. */
    this._maxNodesLoadingPerFrame = 16;
    /** @type {number} Maximum world-space distance for node visibility. */
    this.maxVisibleDistance = Infinity;
    /** @type {PriorityQueue} Priority queue used during node selection passes. */
    this._queue = new PriorityQueue();
    /** @type {number} Current number of nodes loading across the system. */
    this._numNodesLoading = 0;
    /** @type {number} Monotonic frame counter for cache invalidation. */
    this._frameCounter = 0;

    /** @type {boolean} Whether the cached result is stale. */
    this._cacheStale = true;
    /** @type {Object|null} Cached selection result. */
    this._cachedResult = null;
    /** @type {number} Consecutive frames the cache has been reused. */
    this._cacheFrameCount = 0;
    /** @type {Map<OctreeGeometryNode, number>} Cached projected screen sizes
     *   for isometric unloaded-node sorting. */
    this._projCache = new Map();
    /** @type {Object} Cached isometric camera parameters to avoid
     *   re-extracting sub-values each frame. */
    this._cp = {
      cx: 0, cy: 0, cz: 0,
      cosX: 1, sinX: 0,
      cosY: 1, sinY: 0,
      c: 1, s: 0,
      zoom: 1, panX: 0, panY: 0,
    };

    /** @type {boolean} Whether speculative prefetching is enabled. */
    this._prefetchEnabled = true;
    /** @type {number} Maximum concurrent prefetch loads. */
    this._prefetchBudget = 4;
    /** @type {THREE.Vector3|null} Camera position from the previous frame. */
    this._lastCameraPos = null;
    /** @type {THREE.Vector3|null} Per-frame camera velocity estimate. */
    this._cameraVelocity = null;
  }

  /**
   * Sets the maximum number of nodes that can start loading per frame.
   * Clamped to [4, 64].
   * @param {number} val
   */
  set maxNodesLoadingPerFrame(val) {
    this._maxNodesLoadingPerFrame = Math.max(4, Math.min(64, val));
  }

  /**
   * @returns {number}
   */
  get maxNodesLoadingPerFrame() {
    return this._maxNodesLoadingPerFrame;
  }

  /**
   * @returns {number}
   */
  get numNodesLoading() {
    return this._numNodesLoading;
  }

  /** Increments the global loading counter. */
  incrementNodeLoading() {
    this._numNodesLoading++;
  }

  /** Decrements the global loading counter. */
  decrementNodeLoading() {
    this._numNodesLoading--;
  }

  /** Marks the cached visibility result as stale, forcing a recompute. */
  invalidateCache() {
    this._cacheStale = true;
  }

  /**
   * Main entry point. Returns lists of visible and unloaded nodes for the
   * current camera state. Results are cached and reused for up to 3 frames
   * unless explicitly invalidated.
   *
   * @param {CameraController} camera The current camera controller.
   * @param {OctreeGeometry} octreeGeometry The root octree geometry.
   * @param {number} viewportW Viewport width in pixels.
   * @param {number} viewportH Viewport height in pixels.
   * @param {number} [budget] Override for the point budget (defaults to
   *   {@link pointBudget}).
   * @returns {{visibleNodes: OctreeGeometryNode[], unloadedNodes: OctreeGeometryNode[], numVisiblePoints: number}}
   */
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

    // Ensure camera cloud center is valid for isometric projection
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

  /**
   * Isometric (overview) node collector. Walks the octree top-down using a
   * custom 2.5D projection that transforms AABB corners through the isometric
   * camera's rotation/pan/zoom pipeline. Nodes whose projected screen size
   * exceeds {@link MIN_PIXEL_ISOMETRIC} are refined into children; others are
   * added to the visible set.
   *
   * @param {OctreeGeometryNode} root
   * @param {CameraController} camera
   * @param {number} budget Point budget.
   * @param {number} viewportW Viewport width.
   * @param {number} viewportH Viewport height.
   * @returns {{visibleNodes: OctreeGeometryNode[], unloadedNodes: OctreeGeometryNode[], numVisiblePoints: number}}
   */
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

      // If the node is large enough on screen, descend into children
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

    // Sort unloaded nodes by projected screen size (largest first) for
    // prioritized loading
    unloadedNodes.sort((a, b) => {
      const sa = this._projCache.get(a) || minPixel;
      const sb = this._projCache.get(b) || minPixel;
      return sb - sa;
    });

    return { visibleNodes, unloadedNodes, numVisiblePoints: accumulated };
  }

  /**
   * FPS (free-look) node collector. Uses frustum culling and projected
   * sphere-size tests. Nodes whose bounding-sphere projection subtends
   * less than {@link MIN_PIXEL_FPS} pixels are skipped (unless they are
   * shallow enough, per {@link UNCONDITIONAL_VISIBLE_LEVEL}).
   *
   * @param {OctreeGeometryNode} root
   * @param {CameraController} camera
   * @param {number} viewportH Viewport height in pixels (needed for sphere projection).
   * @param {number} budget Point budget.
   * @returns {{visibleNodes: OctreeGeometryNode[], unloadedNodes: OctreeGeometryNode[], numVisiblePoints: number}}
   */
  collectFPSNodes(root, camera, viewportH, budget) {
    const frustum = camera.getFrustum();
    const position = camera.getWorldPosition();
    const fovRad = camera.perspectiveCamera.fov * Math.PI / 180;
    const minPixel = MIN_PIXEL_FPS;
    // Precompute the projection numerator: screen-space extent per unit radius at unit distance
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

        // Perspective projection: screen radius ≈ (radius * projNumerator) / dist
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

      // Enqueue children with their projected screen radius as priority
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

    // Sort unloaded nodes by projected angular size (largest first)
    unloadedNodes.sort((a, b) => {
      const da = position.distanceTo(a.boundingSphere.center);
      const db = position.distanceTo(b.boundingSphere.center);
      return (b.boundingSphere.radius / Math.max(db, 1e-6))
           - (a.boundingSphere.radius / Math.max(da, 1e-6));
    });

    return { visibleNodes, unloadedNodes, numVisiblePoints: accumulated };
  }

  /**
   * Extracts commonly used camera parameters into a plain object for fast
   * access inside the isometric projection loop, avoiding repeated property
   * lookups and trig evaluations.
   *
   * @private
   * @param {CameraController} camera
   * @returns {Object} Cached camera parameters.
   */
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

  /**
   * Tests whether an octree node is visible within the isometric viewport.
   * Projects all 8 corners of the node's AABB through the isometric camera
   * transform and checks against the viewport rectangle (with margin).
   *
   * @private
   * @param {OctreeGeometryNode} node
   * @param {Object} cp Cached camera parameters from {@link _extractCameraParams}.
   * @param {number} w Viewport width.
   * @param {number} h Viewport height.
   * @returns {boolean} True if at least partially inside the viewport.
   */
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
      // Translate to cloud-center origin
      let lx = corner.x - cp.cx;
      let ly = corner.y - cp.cy;
      let lz = corner.z - cp.cz;

      // Apply rotation around X axis
      if (cp.sinX) {
        const y1 = ly * cp.cosX - lz * cp.sinX;
        const z1 = ly * cp.sinX + lz * cp.cosX;
        ly = y1; lz = z1;
      }
      // Apply rotation around Y axis
      if (cp.sinY) {
        const x1 = lx * cp.cosY + lz * cp.sinY;
        const z2 = -lx * cp.sinY + lz * cp.cosY;
        lx = x1; lz = z2;
      }

      // Isometric projection formula: screen_x = (rx - ry)*zoom + panX,
      //                                screen_y = ((rx+ry)*0.5 - lz)*zoom + panY
      const rx = lx * cp.c - ly * cp.s;
      const ry = lx * cp.s + ly * cp.c;
      const sx = (rx - ry) * cp.zoom + cp.panX;
      const sy = ((rx + ry) * 0.5 - lz) * cp.zoom + cp.panY;

      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    // Cull if the entire projected rectangle is outside the viewport margin
    if (maxX < -VIEWPORT_CULL_MARGIN_PX || minX > w + VIEWPORT_CULL_MARGIN_PX ||
        maxY < -VIEWPORT_CULL_MARGIN_PX || minY > h + VIEWPORT_CULL_MARGIN_PX) {
      return false;
    }

    _proj.minX = minX; _proj.maxX = maxX;
    _proj.minY = minY; _proj.maxY = maxY;
    return true;
  }

  /**
   * Computes the projected screen-space rectangle for an octree node
   * under the isometric camera. Returns zero-size if fully outside the viewport.
   *
   * @private
   * @param {OctreeGeometryNode} node
   * @param {Object} cp Cached camera parameters.
   * @param {number} w Viewport width.
   * @param {number} h Viewport height.
   * @returns {{width: number, height: number}}
   */
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
