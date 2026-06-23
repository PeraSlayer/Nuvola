# Phase 7 — Cache + Memory Management

## Goal

Refine the LRU cache from Phase 3 to include GPU memory tracking, configurable budget, node lifecycle management, and prefetch heuristics. Ensure smooth streaming without exceeding device memory.

## Microtasks

### 7.1 Add GPU memory accounting to LRU

- `LRUCache` already tracks `numPoints`. Now also track `gpuBytes` and `cpuBytes`.
- When a node is loaded:
  - `cpuBytes += node.geometryData.byteLength` (sum of all typed arrays).
  - `gpuBytes += node.gpuBytes` (set when `renderer.uploadNode()` is called).
- When a node is evicted:
  - `cpuBytes -= node.cpuBytes`, `gpuBytes -= node.gpuBytes`.
- Expose `getGPUUsage()` and `getCPUUsage()` methods.

- `freeMemory()` now uses weighted eviction:
  1. While `numPoints > maxPoints` OR `gpuBytes > maxGPUBytes` OR `cpuBytes > maxCPUBytes`:
     a. Get LRU candidate.
     b. `node.dispose()` (frees CPU data) → `renderer.removeNode(node)` (frees GPU data).
     c. Remove from LRU.
     d. Update counters.

- Configurable limits:
  - `maxNumPoints` = pointBudget × 2 (existing).
  - `maxGPUBytes` = 512MB (default, adjustable).
  - `maxCPUBytes` = 256MB (default, adjustable).

**Files:** `script_js/potree/LRUCache.js`
**Depends on:** 3.1
**Verify:** Load large dataset, watch memory stabilize. Eviction kicks in when limits are reached.

---

### 7.2 Implement node dispose lifecycle

- `OctreeGeometryNode.dispose()`:
  1. Set `loaded = false`.
  2. Null `geometryData` (allow GC).
  3. Call `oneTimeDisposeHandlers` (renderer registered its cleanup handler here).
  4. Mark dirty for parent hierarchy (optional).

- When a node is in LRU and gets evicted:
  - `lru.remove(node)`.
  - `node.dispose()`.
  - Parent node must retain children metadata (indices, AABB) even if children are evicted.
  - This means `geometryData` is freed but `aabb`, `numPoints`, `children[]` are kept.

- Prevent double-dispose: guard with `if (!this.loaded) return`.

**Files:** `script_js/potree/PotreeOctree.js`
**Depends on:** 7.1
**Verify:** Load dataset, pan to far view → nodes evicted. Pan back → nodes reloaded from octree.bin.

---

### 7.3 Connect LRU to render loop

- In `App._loop()`:
  1. After `renderer.render()`:
     ```javascript
     if (this.cloud && this.cloud.lru) {
       this.cloud.lru.freeMemory();
       this._lastGPUMem = this.renderer.getMemoryMB();
     }
     ```
  2. Update HUD with memory stats:
     ```
     Points: 1.2M / 5M budget
     GPU: 240MB
     Nodes: 48 loaded / 72 visible
     Cache: 85% (140MB / 512MB)
     ```

**Files:** `script_js/main/main.js`
**Depends on:** 7.2
**Verify:** HUD shows live memory stats. Memory doesn't grow unbounded when panning around a large dataset.

---

### 7.4 Add prefetch heuristic

- When camera is moving (detected via velocity = `(position - lastPosition) / dt`):
  - Predict future camera position `predicted = position + velocity * 1.0` (1 second ahead).
  - Run a lightweight LOD selection from the predicted position.
  - The unloaded nodes from the prediction are added to a low-priority prefetch queue.
  - Prefetch queue uses idle bandwidth (when `numNodesLoading < maxNodesLoading / 2`).
  - Prefetched nodes are loaded but not added to the visible set. They are touched in LRU (so they get a recent timestamp).

- Detection: if camera moved > 1% of scene radius in the last frame → prefetch.
- Counter-indication: if camera rotated but didn't translate, no prefetch (different nodes become visible, but the prediction is weak).

**Files:** `script_js/potree/VisibilitySystem.js`, `script_js/main/main.js`
**Depends on:** 7.3
**Verify:** Moving the camera loads nodes ahead of time. Stationary camera doesn't prefetch.

---

### 7.5 Add priority boost for near-camera nodes

- In `selectNodes()`, nodes whose `boundingSphere` contains (or nearly contains) the camera position get a priority boost:
  ```javascript
  if (distance < radius * 2) {
    weight *= 10; // camera inside or very close to node
  }
  ```
- These nodes should be loaded immediately because they have high screen coverage.
- This matches Potree's behavior of assigning `MAX_VALUE` weight when `distance - radius < 0`.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 2.2
**Verify:** Walking toward the cloud (FPS mode) loads nearby nodes first.

---

### 7.6 Verification

- Load a 200M+ point dataset.
- Pan around aggressively: memory stays within GPU budget.
- Stop moving: memory stabilizes, no further loading.
- Pan back to previously visited area: nodes load from cache (if not yet evicted) or from disk.
- FPS mode: walk through the cloud, nearby nodes load first.
- HUD shows accurate memory and node counts.
- Browser DevTools → Memory → no leaks (GC-collectable after dispose).
