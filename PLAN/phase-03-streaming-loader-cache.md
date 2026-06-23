# Phase 3 — Streaming Loader + LRU Cache

## Goal

Replace eager loading with on-demand node streaming. Nodes are loaded from `octree.bin` via HTTP Range requests only when visible. Unused nodes are evicted via LRU. The entire dataset is never held in RAM.

## Microtasks

### 3.1 Create `LRUCache.js`

- Doubly-linked-list LRU, ported from Potree's `LRU.js`.
- Class `LRUCache`:
  - `first`: node (least recently used)
  - `last`: node (most recently used)
  - `items`: Map<node.id, LRUItem>
  - `numPoints`: total points in cache
  - Properties: `maxNumPoints` (default = pointBudget × 2)
  - `touch(node)`: move to end (most recently used). If not in list, append.
  - `remove(node)`: unlink from list.
  - `getLRUItem()`: return `first` (the eviction candidate).
  - `freeMemory()`: while `numPoints > maxNumPoints`, evict `first` node, call `node.dispose()`, decrement `numPoints`.

- `LRUItem` wraps a node with `prev`/`next` pointers.

**Files:** `script_js/potree/LRUCache.js`
**Depends on:** nothing
**Verify:** Add 10 nodes, touch some, verify LRU order. Evict nodes, verify dispose called.

---

### 3.2 Make `NodeLoader.loadNode()` streaming-aware

- `NodeLoader` gains a global cache reference (`lru`).
- `loadNode(node, options)`:
  1. If `node.loaded`, return immediately.
  2. Begin loading: set `node.loading = true`.
  3. Fetch range from `octree.bin` via `fetch(url, {headers: {Range: ...}})`.
  4. On response: get ArrayBuffer.
  5. If `encoding === 'BROTLI'`: decompress via `DecompressionStream` or skip (throw warning).
  6. Send buffer + attribute definitions to `DecoderWorker` via `WorkerPool`.
  7. On decode complete: store in `node.geometryData`, set `node.loaded = true`, `node.loading = false`.
  8. `lru.touch(node)`.
  9. Call `node.onLoad()` callbacks (for renderer to create VAO, etc.).

- Add node lifecycle events:
  - `node.on('loaded', callback)` — called when geometry data arrives.
  - `node.on('disposed', callback)` — called when evicted.
  - These are simple callback lists on the node.

**Files:** `script_js/potree/NodeLoader.js`
**Depends on:** 1.6, 3.1
**Verify:** Load a single node on demand. Multiple sequential loads work. Loading a second time returns cached.

---

### 3.3 Modify `VisibilitySystem` for streaming integration

- `selectNodes()` outputs two lists:
  1. `visibleNodes: OctreeGeometryNode[]` — loaded and visible.
  2. `unloadedQueue: OctreeGeometryNode[]` — visible but not yet loaded.

- Add `maxNodesLoadingPerFrame` (default 4).
- `scheduleLoading(unloadedQueue, lru, nodeLoader)`:
  1. Sort unloaded queue by priority (weight from LOD selection).
  2. Take first `maxNodesLoadingPerFrame` items.
  3. For each: call `node.load()` (which triggers NodeLoader).
  4. Track `numNodesLoading` globally, skip if > `maxNodesLoading`.

- After loading nodes, renderer creates VAOs for newly loaded nodes.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 2.2, 3.2
**Verify:** Only `maxNodesLoadingPerFrame` requests are in flight at once.

---

### 3.4 Modify `PointCloud` for streaming data model

- Remove `positions`, `colors`, `intensity` as flat arrays (those are now per-node).
- `PointCloud` now references:
  - `octreeGeometry`: the `OctreeGeometry` (hierarchy).
  - `lru`: the shared `LRUCache`.
  - `visibilitySystem`: the `VisibilitySystem`.

- `getDrawCall()` changes:
  - Call `visibilitySystem.selectNodes()` → get visible nodes + unloaded queue.
  - `visibilitySystem.scheduleLoading(unloadedQueue)`.
  - Collect indices from loaded visible nodes.
  - Return `{indices, count, nodes: visibleNodes}`.
  - The `nodes` array tells the renderer which VAOs to bind.

- `dispose()` must evict all nodes from LRU.
- `computeBounds()` is no longer needed (bounds come from metadata).

**Files:** `script_js/model/PointCloud.js`
**Depends on:** 3.3
**Verify:** Point cloud renders progressively — nodes pop in as they load.

---

### 3.5 Add progressive render loop integration

- In `App._loop()`, after camera update:
  1. Check if camera dirty or `_frameNeedsLODUpdate`.
  2. Call `cloud.getDrawCall()` → triggers LOD selection + loading scheduling.
  3. If new nodes were loaded this frame (via callbacks), mark for re-render.
  4. Call `renderer.render()` with visible nodes.
  5. After render: `lru.freeMemory()` to evict excess.

- Add loading spinner behavior:
  - Show spinner when `numNodesLoading > 0`.
  - Hide when all visible nodes are loaded.
  - Text: "Streaming nodes: X loaded / Y visible".

- Track loading progress for HUD:
  - `nodesLoaded`, `totalNodesInHierarchy`, `pointsLoaded`, `pointsBudget`.

**Files:** `script_js/main/main.js`
**Depends on:** 3.4
**Verify:** Loading spinner appears briefly when rotating camera (new nodes needed). Points appear progressively.

---

### 3.6 Handle hierarchy lazy loading

- When traversing the octree, if a node's children are not yet parsed from `hierarchy.bin`:
  - Fetch the next hierarchy chunk via Range request.
  - Parse children and populate the node.
  - Then continue LOD traversal.

- `NodeLoader.loadHierarchyChunk(node)`:
  1. Fetch range from `hierarchy.bin`.
  2. Parse 22-byte entries.
  3. Create `OctreeGeometryNode` objects for each child.
  4. Attach to parent `node.children`.
  5. Return number of children created.

- This means the hierarchy itself streams in as needed, not just point data.

**Files:** `script_js/potree/NodeLoader.js`, `script_js/potree/VisibilitySystem.js`
**Depends on:** 3.2
**Verify:** Rotate camera to see new area → hierarchy loads → point data loads for visible nodes.

---

### 3.7 Verification

- Load a large Potree dataset (100M+ points) via URL.
- Verify memory usage stays within budget × 2 (browser task manager).
- Rotate/pan camera: new nodes load progressively.
- Wait for stabilization: all visible nodes loaded, no flickering.
- After loading completes, switch to a far-away view: LRU evicts nodes, memory drops.
- Network tab: only Range requests for visible nodes, no full-file loads.
