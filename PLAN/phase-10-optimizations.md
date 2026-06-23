# Phase 10 — Advanced Optimizations

## Goal

Improve rendering performance, memory efficiency, and visual quality through targeted optimizations. Each microtask is independent and can be implemented in any order.

## Microtasks

### 10.1 VBO pooling

- Problem: creating/destroying VAOs and VBOs per node causes GPU allocation churn.
- Solution: `BufferPool` class that pre-allocates a pool of GPU buffers of fixed sizes (e.g., 64KB, 256KB, 1MB, 4MB, 16MB).
- When `uploadNode(node)` is called:
  1. Find a pool buffer large enough for the node's data.
  2. `gl.bufferSubData` into the pool region.
  3. Store pool offset on the node.
- When node is evicted:
  1. Mark pool region as free (free list).
- Pool grows on demand (up to `maxGPUBytes`).
- Reduces `gl.bufferData` calls (which are expensive — they cause GPU sync).

**Files:** `script_js/rendering-app/renderer.js` (or new `script_js/rendering-app/BufferPool.js`)
**Depends on:** 4.1
**Verify:** GPU alloc/dealloc rate is near-zero during steady-state streaming. Only initial pool creation allocates.

---

### 10.2 Draw call batching (indirect draw)

- Problem: each visible node requires a separate `gl.drawArrays` or `gl.drawElements` call.
- Solution: if `gl.drawArraysIndirect` is available (WebGL2 via `WEBGL_multi_draw` or `gl.drawElementsIndirect`):
  1. Accumulate all visible nodes' draw commands into a `DrawArraysIndirectCommand` buffer.
  2. Issue one `multiDrawElementsIndirect` call per frame.
  3. Group compatible nodes (same VAO layout, same shader) into batches.
- Fallback: if indirect draw not available, keep per-node draw calls.

- Status: WebGL 2.0 does NOT natively include indirect draw. It requires `WEBGL_multi_draw` extension, available in Chrome 86+/Firefox 80+. Check `gl.getExtension('WEBGL_multi_draw')`.

- Implementation:
  ```javascript
  const ext = gl.getExtension('WEBGL_multi_draw');
  if (ext) {
    ext.multiDrawElementsInstancedWEBGL(
      gl.POINTS, counts, gl.UNSIGNED_INT, offsets, 0, counts.length
    );
  }
  ```

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 4.1
**Verify:** With extension available, single indirect draw replaces N per-node draws. Performance improves with 50+ visible nodes.

---

### 10.3 Coalesced GPU uploads

- Problem: uploading one node's data per frame causes many small `gl.bufferData` calls.
- Solution: batch pending uploads into a single larger transfer.
- `NodeLoader` signals when decode is complete.
- The renderer queues newly loaded nodes in a pending upload list.
- Once per frame (or when pending list size > threshold), upload all pending data in one `gl.bufferData` call to a staging buffer, then copy to individual VBO regions (via `gl.copyBufferSubData`).

OR simpler approach:

- Use `gl.bufferSubData` into pre-allocated pool regions (combine with 10.1).
- The pool already avoids per-node allocations.

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 10.1
**Verify:** Chrome GPU trace shows fewer, larger buffer uploads.

---

### 10.4 Visibility caching

- Problem: running `selectNodes()` every frame is wasteful when camera hasn't moved.
- Solution: cache LOD output for N frames when camera is stationary.
- Implementation:
  ```javascript
  _cachedVisibleNodes = [];
  _cacheFrameCount = 0;
  _cacheStale = true;

  selectNodes(camera, ...) {
    if (!_cacheStale && _cacheFrameCount++ < 3) {
      return _cachedVisibleNodes;
    }
    // ... actual algorithm ...
    _cachedVisibleNodes = result;
    _cacheFrameCount = 0;
    _cacheStale = false;
    return result;
  }
  ```
- `_cacheStale` is set to true when:
  - `camera.markDirty()` is called.
  - `pointBudget` changes.
  - Octree hierarchy changes (new nodes loaded).
  - After N frames even without changes (to pick up newly loaded nodes).

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 2.2
**Verify:** With stationary camera, LOD selection runs every 3 frames instead of every frame. CPU time drops.

---

### 10.5 Prefetch on camera velocity

- Enhancement of the basic prefetch from Phase 7.4.
- Predict camera position 1-2 seconds ahead based on velocity.
- Run lightweight LOD selection from predicted position.
- Add predicted-visible nodes to loading queue at lower priority.
- Use `performance.now()` timestamps for velocity calculation.

**Files:** `script_js/main/main.js`, `script_js/potree/VisibilitySystem.js`
**Depends on:** 7.4 (already exists, this is refinement)
**Verify:** Panning the camera loads nodes ahead of movement. Going in reverse: already-loaded nodes are reused.

---

### 10.6 SIMD decoder worker

- Problem: binary decoding in the worker is a hot loop converting bytes to typed arrays.
- Solution: use typed array views and bulk copy, avoid per-point loops where possible.
- Specific optimizations for `DecoderWorker.js`:
  - `Int32Array` view on buffer for position decoding (instead of loop with `DataView`).
  - `Uint16Array` view for intensity/classification.
  - `Uint8Array` view for RGB colors (already batches).
  - Use `Float32Array` constructor with buffer slice for position if already float32.
  - For quantized positions: use `Int32Array` + multiply by scale (loop, but vectorizable by engine).
- JavaScript engines already JIT-compile these loops well; the main benefit is avoiding `DataView` overhead.

**Files:** `script_js/potree/DecoderWorker.js`
**Depends on:** 1.4
**Verify:** Profile decoder: time per 1M points should match or beat Potree's decoder.

---

### 10.7 Progressive loading priority

- Problem: when camera moves, all newly visible nodes compete for bandwidth.
- Solution: assign loading priority based on:
  1. Screen coverage (larger projected size = higher priority).
  2. Distance (closer = higher priority).
  3. Depth in octree (shallow = higher prio — loads coarse representation faster).
- Sorting the `unloadedQueue` before processing:
  ```javascript
  unloadedQueue.sort((a, b) => {
    return b.projectedSize - a.projectedSize;
  });
  ```
- Allows coarse geometry to appear quickly, then refine.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 3.3
**Verify:** When camera moves, large/near nodes load before small/distant ones.

---

### 10.8 Background thread for LRU + visibility (optional)

- Problem: `freeMemory()` and `selectNodes()` can be expensive (O(N log N)).
- Solution: run them on a background thread via a Web Worker if the octree data is available there.
- Complexity: octree hierarchy must be transferable or cloned to worker.
- This is a significant refactor. Only do if profiler shows these steps as bottlenecks.
- For most datasets (< 200M points), the single-threaded approach is fast enough (< 2ms per frame for LOD selection).

**Files:** (new worker file) — optional
**Depends on:** profiling showing bottleneck

---

### 10.9 Verification

- Load a 500M+ point dataset.
- Full pan/orbit: stable 30+ FPS.
- GPU memory stable (< 512MB).
- Node loading: visible coarse nodes appear within 200ms, refinement within 1s.
- With multi-draw: single indirect draw per frame (or few batches).
- With VBO pool: no GPU allocation churn during streaming.
- Without optimizations disabled: verify correct fallback.
- Compare final FPS to Phase 9 baseline: optimized version should be 20-50% faster.
