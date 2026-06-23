# Phase 8 — Picking

## Goal

Replace Nuvola's current 2D-grid-based picking with Potree's offscreen-render approach: render visible nodes with point indices encoded as colors, read back pixels, and reconstruct the picked point.

## Microtasks

### 8.1 Create picking material/shader

- New fragment shader variant that outputs point index instead of color.
- In `shader.js`, add `PICKING_FRAGMENT_SHADER`:
  - Encodes `gl_VertexID` (point index within the draw call) into RGB:
    ```glsl
    uint idx = uint(gl_VertexID);
    fragColor = vec4(
      float((idx >> 0) & 0xFFu) / 255.0,
      float((idx >> 8) & 0xFFu) / 255.0,
      float((idx >> 16) & 0xFFu) / 255.0,
      float(nodeIndex) / 255.0  // alpha = node index (up to 255 nodes)
    );
    ```
  - RGBA = 24-bit point index (16M max per node) + 8-bit node index (256 nodes max per pick pass).
  - For larger node counts: use two passes or extend to 32-bit (RGBA = 24-bit index + 8-bit node, then read twice).

- Vertex shader for picking: same as main `POINT_VERTEX_SHADER` (positions unchanged).
- No lighting pass needed for picking.

**Files:** `script_js/rendering-app/shader.js`
**Depends on:** 4.1
**Verify:** Render a node with picking shader, read back pixels, decode to indices.

---

### 8.2 Create `PickingSystem.js`

- Class `PickingSystem`:
  - Constructor takes `(renderer)`.
  - `pick(camera, cloud, sx, sy, pickWindowSize = 65)`:
    1. Get visible nodes from cloud's visibility system.
    2. Create a small offscreen framebuffer (or reuse the main FBO at reduced size).
    3. Save current FBO state.
    4. Bind picking FBO, set scissor test around `(sx - windowSize/2, sy - windowSize/2, windowSize, windowSize)`.
    5. Clear.
    6. Use picking shader program.
    7. For each visible node:
       a. Bind node VAO.
       b. Set `nodeIndex` uniform.
       c. Draw points.
    8. `gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buffer)`.
    9. Restore FBO.
    10. For each pixel in buffer:
        a. Decode RGB → point index within node.
        b. Decode alpha → node index.
        c. Look up node from visible nodes list.
        d. Read point position from `node.geometryData.positions[index]`.
        e. Convert to world space.
        f. Return the closest hit to window center.
    11. Return `null` if no hit.

  - `_decodeIndex(r, g, b, a)` → `{pointIndex, nodeIndex}`.
  - `_pickShader`: compiled `progPick` from vertex + picking fragment.

- Picking uses the same camera uniforms as the main render pass.

**Files:** `script_js/potree/PickingSystem.js`
**Depends on:** 8.1
**Verify:** Click on a point → returns correct world-space coordinate. Click on empty space → null.

---

### 8.3 Integrate picking with Measurement tool

- Modify `MeasurementTool.onClick()`:
  - If Potree mode (streaming PointCloud), call `PickingSystem.pick()` instead of `cloud.pickNearest()`.
  - The return format is compatible: `{pointIndex, position, color, intensity}`.

- Keep existing `cloud.pickNearest()` as fallback for non-streaming clouds (small PLY/LAS files).

**Files:** `script_js/view/measurements.js`
**Depends on:** 8.2
**Verify:** Click on a point in measurement mode → P0/P1 are set correctly, distances display.

---

### 8.4 Integration with Gizmo

- Gizmo already uses overlay canvas and hit-testing via projected screen positions.
- Gizmo does not need picking; it works independently.
- No change needed.

**Files:** none
**Depends on:** nothing

---

### 8.5 Picking visuals

- Draw a small crosshair or circle at the picked point (overlay canvas).
- Show picked point info in HUD or sidebar:
  - "Point: index=12345"
  - "Position: (12.34, 56.78, 9.01)"
  - "Color: RGB(128, 200, 64)"
  - "Intensity: 0.75"

- This is optional but helpful for debugging.

**Files:** `script_js/main/main.js` (click handler), `index.html` (info panel)
**Depends on:** 8.3

---

### 8.6 Verification

- Load Potree dataset.
- Click on various points:
  - Each click returns a valid picked point near the cursor.
  - Coordinates are in world space (correct magnitude).
- Measure distance: P0 → P1 with picking works correctly.
- Click on empty space between points: no pick (null).
- Pick near edges: still returns points (edge tolerance = windowSize/2 pixels).
- Performance: picking does not drop main render frame rate (< 5ms per pick).
