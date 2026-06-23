# Phase 4 — GPU Rendering Enhancements

## Goal

Adapt the WebGL2 renderer to handle per-node VAOs, multiple point size modes, classification colors, and a unified shader that supports both isometric (existing) and perspective (FPS) projection.

## Microtasks

### 4.1 Refactor renderer for per-node VAOs

- Current: single `_cloudVao` + `_dynamicIndexVao` for the whole cloud.
- New: `OctreeGeometryNode` stores its own VAO and VBOs.

- Add to `Renderer`:
  - `uploadNode(node)`:
    1. Create VAO for the node.
    2. Create VBO for positions (Float32Array), upload via `gl.bufferData`.
    3. Create VBO for colors (Uint8Array), upload.
    4. If intensity present: create VBO for intensity (Float32Array), upload.
    5. Store handles on `node.gpuVAO`, `node.gpuVBOs`.
    6. `lru.touch(node)`.
  - `removeNode(node)`:
    1. `gl.deleteVertexArray(node.gpuVAO)`.
    2. `gl.deleteBuffer(vbo)` for each VBO.
    3. Null out node GPU references.
  - `renderVisibleNodes(nodes, camera, opts)`:
    1. Bind FBO (existing).
    2. For each visible node:
       a. Bind `node.gpuVAO`.
       b. Apply uniforms (same per-frame).
       c. Issue draw call with points count from `node.numPoints`.
    3. Run lighting pass (existing).

- Uniform application optimization: set once per frame (not per node) since all nodes use the same shader program.

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 1.5 (OctreeGeometryNode), 3.4 (streaming PointCloud)
**Verify:** Node VAOs created on load, deleted on eviction. Multiple nodes render correctly.

---

### 4.2 Add point size type uniforms

- New uniforms in vertex shader:
  - `u_pointSizeType`: int (0 = FIXED, 1 = ATTENUATED, 2 = ADAPTIVE).
  - `u_pointSize`: float (base size in pixels).
  - `u_spacing`: float (node spacing from metadata).
  - `u_screenWidth`: float (for perspective projection factor).

- Enum in JS:
  ```javascript
  const POINT_SIZE_TYPE = Object.freeze({
    FIXED: 0,
    ATTENUATED: 1,
    ADAPTIVE: 2,
  });
  ```

- FIXED: `gl_PointSize = clamp(u_pointSize, 1.0, 50.0)`.
- ATTENUATED: `gl_PointSize = u_pointSize * u_spacing * u_screenWidth / (2.0 * distance * tan(fov/2))`.
- ADAPTIVE: stub for now (Phase 6 fills in). Fallback to ATTENUATED.

**Files:** `script_js/rendering-app/shader.js`, `script_js/rendering-app/renderer.js`
**Depends on:** 4.1
**Verify:** Switch between fixed and attenuated, see point sizes change correctly.

---

### 4.3 Add perspective camera uniforms to shader

- When `u_cameraMode = 1` (perspective/FPS):
  - Replace the isometric projection math with standard perspective:
    ```
    vec4 viewPos = u_viewMatrix * vec4(local, 1.0);
    gl_Position = u_projMatrix * viewPos;
    ```
  - Existing isometric path remains for `u_cameraMode = 0`.

- New uniforms:
  - `u_cameraMode`: int (0 = isometric, 1 = perspective).
  - `u_viewMatrix`: mat4.
  - `u_projMatrix`: mat4.

- In `renderer.render()`: check `camera.mode`, set `u_cameraMode`, upload the appropriate matrix.

**Files:** `script_js/rendering-app/shader.js`, `script_js/rendering-app/renderer.js`
**Depends on:** 4.1, 5.1 (FPS camera exists)
**Verify:** Switch between isometric and FPS modes, both render correctly.

---

### 4.4 Add classification color mode

- New color type `CLASSIFICATION` (value 4 in `u_colorMode`).
- In shader:
  ```glsl
  // ASPRS standard classification colors (16 entries)
  const vec3 CLASS_COLORS[16] = vec3[16](
    vec3(0.5, 0.5, 0.5),   // 0 = never classified
    vec3(1.0, 0.0, 0.0),   // 1 = unassigned
    vec3(1.0, 1.0, 0.0),   // 2 = ground
    vec3(0.0, 1.0, 0.0),   // 3 = low vegetation
    ...
  );
  int classification = int(a_classification);
  v_color = CLASS_COLORS[min(classification, 15)];
  ```
- Requires new attribute `a_classification` (uint8).
- New VBO upload in `uploadNode()` when classification data exists.
- Attribute layout: `gl.vertexAttribPointer(loc, 1, gl.UNSIGNED_BYTE, false, 0, 0)`.

**Files:** `script_js/rendering-app/shader.js`, `script_js/rendering-app/renderer.js`, `script_js/potree/DecoderWorker.js` (add classification output)
**Depends on:** 4.1
**Verify:** Load a classified Potree dataset, switch to classification mode, see ASPRS colors.

---

### 4.5 Classification color UI

- Add button to color mode panel: "Classification".
- Only enabled when dataset has classification attribute.

**Files:** `index.html`, `script_js/view/ui-controller.js`
**Depends on:** 4.4

---

### 4.6 Point size UI controls

- Point Size Type dropdown: Fixed / Attenuated / Adaptive.
- Point Size slider (range 1-50, default 5).
- Wire to `app.pointSizeType` and `app.pointSize`.

**Files:** `index.html`, `script_js/view/ui-controller.js`
**Depends on:** 4.2
**Verify:** Changing point size slider immediately updates rendered point size.

---

### 4.7 Verification

- All color modes work with streaming Potree data: RGB, Height, Intensity, Classification.
- Point size modes switch correctly.
- Camera mode switch (isometric ↔ FPS) works.
- Per-node VAOs are created/deleted correctly on load/unload.
- GPU memory tracking in stats panel.
