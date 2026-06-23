# Phase 2 — Priority Queue + LOD System

## Goal

Replace Nuvola's current stride-based LOD with Potree's greedy priority-queue traversal. Nodes are selected based on projected screen size (screen-space error), respecting a hard point budget.

## Microtasks

### 2.1 Enhance `PriorityQueue.js` (if needed)

- If Phase 1 `PriorityQueue.js` is already complete, this step is a review.
- Ensure `pop()` returns `{node, weight}`.
- Ensure `push()` is O(log n).
- Add `remove(node)` if needed (mark-and-sweep, or rebuild).
- Add `contains(node)` check.

**Files:** `script_js/potree/PriorityQueue.js`
**Depends on:** 1.2
**Verify:** Push 10K nodes, pop all, verify correct order.

---

### 2.2 Create `VisibilitySystem.js`

- Core LOD selection algorithm, ported from Potree's `updateVisibility()`.
- Class `VisibilitySystem`:
  - `selectNodes(camera, octreeGeometry, pointBudget, options)`:
    1. Compute frustum from camera view-projection matrix (Three.js `Frustum.setFromProjectionMatrix`).
    2. Compute camera position in object space.
    3. Initialize priority queue with root node at `weight = MAX_VALUE`.
    4. While queue not empty:
       a. Pop highest-weight node.
       b. **Frustum cull**: `frustum.intersectsBox(node.aabb)`. If outside, skip.
       c. **Budget check**: `accumulatedPoints + node.numPoints > pointBudget`. If exceeded, skip.
       d. Add node to `visibleNodes` list.
       e. Compute projected radius for children:
          ```
          let distance = cameraPos.distanceTo(node.boundingSphere.center);
          let projFactor = (0.5 * domHeight) / (tan(fov/2) * Math.max(distance, 1e-6));
          let screenPixelRadius = node.boundingSphere.radius * projFactor;
          ```
       f. If `screenPixelRadius < minimumNodePixelSize` (default 150): skip children (no further subdivision).
       g. Else: push all children with `weight = screenPixelRadius`.
    5. Return `{visibleNodes, numVisiblePoints}`.
  - `setMinimumNodePixelSize(size)` — default 150.
  - `setPointBudget(budget)` — default 1,000,000.

- Separate accumulated point count per point cloud (supports multiple clouds in future).
- Track `numVisiblePoints` across all nodes.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 1.1 (Three.js Frustum, Box3, Vector3), 2.1
**Verify:** Feed a known octree + camera, verify visible nodes match expected count. Frustum-culled nodes are excluded.

---

### 2.3 Replace `PointCloud.getDrawCall()` with priority-queue LOD

- Modify `PointCloud` class:
  - Add `visibilitySystem` property.
  - Replace `getDrawCall(camera, viewportW, viewportH)`:
    1. Compute point budget from `app.pointBudget` or `MAX_BUDGET`.
    2. Call `visibilitySystem.selectNodes(camera, this.octreeGeometry, budget, {viewportW, viewportH})`.
    3. Collect indices from visible nodes: for each visible node, if node has geometry data, concatenate its index range.
    4. Apply uniform stride if visible count > budget (same fallback as current code).
    5. Return `{indices: Uint32Array|null, count, nodes: OctreeGeometryNode[]}`.

- Nodes array is needed by the renderer (Phase 4) to know which VAOs to bind.
- For now (pre-streaming, Phase 1 eager loading), all nodes in visible list have geometry data loaded.

**Files:** `script_js/model/PointCloud.js`
**Depends on:** 2.2, 1.5
**Verify:** Moving camera changes visible node set. Point budget is respected.

---

### 2.4 Expose point budget in UI

- Add to `index.html` sidebar:
  ```html
  <div class="panel">
    <h2>Point Budget</h2>
    <select id="point-budget">
      <option value="500000">500K</option>
      <option value="1000000" selected>1M</option>
      <option value="5000000">5M</option>
      <option value="10000000">10M</option>
      <option value="20000000">20M</option>
    </select>
  </div>
  ```
- Wire in `ui-controller.js`:
  - On change: `app.pointBudget = parseInt(value)`.
  - Trigger camera dirty to re-run LOD.
- Show stats: "Visible: X / Budget: Y" in the stats panel.

**Files:** `index.html`, `script_js/view/ui-controller.js`
**Depends on:** 2.3
**Verify:** Changing budget in UI immediately changes visible point count.

---

### 2.5 Add camera-projected size computation helpers

- In `VisibilitySystem.js` or a new `script_js/potree/math-utils.js`:
  - `computeProjectedRadius(sphere, camera, viewportHeight, fov)`:
    Compute screen-space radius of a bounding sphere.
  - `computeFrustum(camera)` — build Three.js `Frustum` from camera's projection * view.
  - `nodeScreenBounds(node, camera)` — project node AABB to screen coordinates (for future use).

- These are internal helpers used by `selectNodes()`.

**Files:** `script_js/potree/math-utils.js` (optional, or inline in VisibilitySystem)
**Depends on:** 1.1
**Verify:** Projected radius decreases with distance; matches Potree's values for same inputs.

---

### 2.6 Verification

- Load a Potree dataset.
- Toggle point budget: 500K, 1M, 5M. Observe visible quality.
- Rotate camera: LOD changes smoothly, budget is respected.
- Log: `console.log(visibleNodes.length, visiblePoints)` should never exceed budget.
- Compare count of visible nodes with camera pointing at dense vs. sparse areas.
