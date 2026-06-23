# Phase 1 — Potree v2.0 Format Support

## Goal

Load Potree-format datasets (`metadata.json` + `hierarchy.bin` + `octree.bin`) into a navigable octree structure. This phase does **not** stream — all nodes are loaded eagerly to validate format parsing. Streaming comes in Phase 3.

## Microtasks

### 1.1 Add Three.js CDN dependency

- Add to `index.html`:
  ```html
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"
    }
  }
  </script>
  ```
- Verify: `import * as THREE from 'three'` resolves in browser console.

**Files:** `index.html`
**Depends on:** nothing
**Verify:** Open browser console, `import * as THREE from 'three'` returns the module.

---

### 1.2 Create `PriorityQueue.js`

- Binary max-heap ported from Potree's `BinaryHeap.js`.
- `push(node, weight)` — inserts with priority weight.
- `pop()` — returns highest-weight element.
- `size()` / `isEmpty()`.
- Internally a flat array with sift-up/sift-down.

**Files:** `script_js/potree/PriorityQueue.js`
**Depends on:** nothing (pure JS, no Three.js needed)
**Verify:** Unit test in console: push 10 items with varying weights, verify pop order.

---

### 1.3 Create `WorkerPool.js`

- Pool of reusable Web Workers, ported from Potree's `WorkerPool.js`.
- `getWorker(url)` — returns a worker (creates if pool empty).
- `returnWorker(worker)` — returns worker to pool.
- `maxWorkers` default = 4.

**Files:** `script_js/potree/WorkerPool.js`
**Depends on:** nothing
**Verify:** Pool reuses workers across multiple load calls.

---

### 1.4 Create `DecoderWorker.js`

- Inline Web Worker (string blob, same pattern as existing Nuvola workers).
- Receives: raw `ArrayBuffer` + attribute definitions (name, type, size, encoding).
- Decodes interleaved binary from Potree's octree.bin per-node layout.
- Returns typed arrays per attribute: `{position, color, intensity, classification, returnNumber, ...}`.
- Position attributes: `POSITION_CARTESIAN` (float32×3, optionally quantized).
- Color attributes: `RGBA` (uint8×4, normalized).
- Intensity: `INTENSITY` (uint16 → float32 normalized).
- Port attribute decoding logic from Potree's `BinaryDecoderWorker.js` (simple unpacking, no LAS-specifics).

**Files:** `script_js/potree/DecoderWorker.js`
**Depends on:** nothing
**Verify:** Feed a known octree.bin node chunk, verify decoded positions/colors match Potree output.

---

### 1.5 Create `PotreeOctree.js`

- **`OctreeGeometry`** class:
  - root: `OctreeGeometryNode`
  - `boundingBox`: THREE.Box3
  - `tightBoundingBox`: THREE.Box3
  - `spacing`: number (from metadata)
  - `scale`: number
  - `offset`: THREE.Vector3
  - `projection`: string (optional)
  - `numNodes`: number
  - `loader`: reference to `NodeLoader`

- **`OctreeGeometryNode`** class:
  - `name`: string (`"r"`, `"r0"`, `"r01"`, ...)
  - `aabb`: THREE.Box3
  - `index`: number (0-7 octant, -1 for root)
  - `depth`: number
  - `spacing`: number
  - `numPoints`: number
  - `byteOffset`: BigInt (into octree.bin)
  - `byteSize`: BigInt
  - `children`: `OctreeGeometryNode[]` (8 slots, sparse)
  - `hasChildren`: bitmask (0-255)
  - `loaded`: boolean
  - `oneTimeDisposeHandlers`: []
  - `geometryData`: `{position, color, intensity, ...}` or null
  - `gpuVAO`: WebGL VAO handle (populated in Phase 4)
  - Methods:
    - `getNumPoints()` → returns `numPoints`
    - `getLevel()` → returns `this.level || 0`
    - `isLoaded()` → returns `loaded`
    - `isGeometryNode()` → always true
    - `load()` → delegates to `loader.loadNode(this)`
    - `loadChildren()` → loads hierarchy chunk and populates children
    - `dispose()` → frees geometry data, marks unloaded
    - `getBoundingBox()` → returns `aabb`

**Files:** `script_js/potree/PotreeOctree.js`
**Depends on:** 1.1 (Three.js), 1.2 (PriorityQueue unused yet but imported)
**Verify:** Create a node tree manually, verify bounding box hierarchy, getNumPoints().

---

### 1.6 Create `NodeLoader.js`

- HTTP Range request loader for Potree v2.0 format.
- `load(url)` — fetches `metadata.json` from URL, returns parsed object.
- `loadHierarchy(geometry, node, urlHierarchy)` — fetches hierarchy.bin chunk for a node, parses child nodes, populates `node.children`. Hierarchy entry: 22 bytes per node (`[type, childMask, numPoints, byteOffset(8), byteSize(8)]`).
- `loadNode(node, urlOctree)` — fetches range from octree.bin, sends to `DecoderWorker`, stores result in `node.geometryData`, sets `node.loaded = true`.
- Handles BROTLI-encoded data if present (decompress via `DecompressionStream` if available, else skip).
- Uses `WorkerPool` for decoding workers.

**Files:** `script_js/potree/NodeLoader.js`
**Depends on:** 1.1 (Three.js for Box3/Vector3 math), 1.3, 1.4
**Verify:** Load a sample Potree dataset, verify hierarchy is correctly parsed.

---

### 1.7 Create `PotreeLoader.js`

- Orchestrator class.
- `PotreeLoader.load(url)`:
  1. `fetch(url)` → metadata.json (append `/metadata.json` to base URL).
  2. Parse metadata: boundingBox, spacing, scale, offset, attributes, hierarchy, encoding.
  3. Create `OctreeGeometry`.
  4. Create root node with metadata's bounding box.
  5. Call `loadHierarchy` on root to populate first hierarchy level.
  6. Load root node data via `loadNode`.
  7. Eagerly load all descendants (recursive hierarchy loading + node data loading). This is the non-streaming fallback — Phase 3 removes the eager load.
  8. Return completed `OctreeGeometry` + root node.

- `getUrlHierarchy(metadata, geometry)` — resolves the hierarchy.bin URL path.
- `getUrlOctree(metadata, geometry)` — resolves the octree.bin URL path.

**Files:** `script_js/potree/PotreeLoader.js`
**Depends on:** 1.1, 1.5, 1.6
**Verify:** Load a known Potree dataset, verify OctreeGeometry has correct bounding box, root node data matches expected point count.

---

### 1.8 Modify `main.js` — Add Potree load entry point

- Import Three.js: `import * as THREE from 'three'`.
- Import PotreeLoader.
- Add `App.loadPotreeDataset(url)` method:
  1. Create `PotreeLoader`.
  2. Call `.load(url)` → get octree geometry.
  3. Create a `PointCloud` from root node data (all points in memory for now).
  4. Upload to GPU via existing `renderer.uploadPointCloud()`.
  5. Fit view, render.
- Add UI in `index.html`: a button + URL input for Potree datasets.
  - Simple: an `input` for URL + "Load" button.
  - In `ui-controller.js`: wire the button to `app.loadPotreeDataset(url)`.

**Files:** `script_js/main/main.js`, `script_js/view/ui-controller.js`, `index.html`
**Depends on:** 1.7
**Verify:** User can enter a Potree dataset URL, see points rendered.

---

### 1.9 Wire Potree loader to existing PointCloud model (temporary bridge)

- Currently `PointCloud` expects all data upfront: `{positions, colors, intensity, count, bounds, center, octree, ...}`.
- Create a bridge function `octreeGeometryToPointCloud(geometry)` in a new file `script_js/potree/adapter.js`:
  - Extracts positions/colors/intensity from the eagerly-loaded root node.
  - Computes bounds and center.
  - Creates a flat `Uint32Array` for all point indices (simplified octree).
  - Returns a structure compatible with `new PointCloud(...)`.
- This is temporary — Phase 2 replaces `getDrawCall()` to work with Potree's node hierarchy instead.

**Files:** `script_js/potree/adapter.js`
**Depends on:** 1.5, 1.8
**Verify:** PointCloud renders with data from Potree format.

---

### 1.10 Verification

- Load a real Potree dataset (e.g., `https://potree.org/pointclouds/riegl/riegl_metadata.json`).
- Verify: metadata parsed, hierarchy loaded, points visible, camera fits to bounds.
- Console: no errors, expected point count matches Potree viewer.

**Depends on:** all 1.1–1.9
