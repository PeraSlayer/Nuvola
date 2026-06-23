# Phase 6 — Visibility Texture + Adaptive Point Size

## Goal

Implement Potree's visible-nodes texture for per-point continuous LOD fading. This enables the `ADAPTIVE` point size mode where each point's size is determined by which LOD level covers its position, producing smooth transitions between octree levels.

## Microtasks

### 6.1 Assign texture coordinates to visible nodes

- After `VisibilitySystem.selectNodes()` returns the visible node list, assign each node a position in a 2D texture.
- Extend `VisibilitySystem`:
  - `buildVisibilityTextureData(visibleNodes)`:
    1. Sort nodes by depth (root first).
    2. Flatten into a 1D array, depth-first order.
    3. Assign sequential texel indices (0, 1, 2, ...).
    4. Compute texture size: next power of two that fits all nodes (e.g., 32 nodes → 8×8 texture, 256 nodes → 16×16).
    5. Build `Uint8Array` of RGBA texels, one per node:
       - R: `childMask` (bitmask: which children are also visible). If no children, 0.
       - G: `siblingOffset` (bytes to next sibling in texture). Encodes how many texels to skip to reach the next sibling at the same depth. 0 if last sibling.
       - B: (upper bits of siblingOffset, for >255 offsets).
       - A: `densityLOD` — computed from the node's point density vs. parent density.
    6. Return `{data, width, height}`.

- The encoding follows Potree's `PointCloudOctree.computeVisibilityTextureData()`.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 2.2
**Verify:** With 10 visible nodes, texture data has correct childMask and siblingOffsets.

---

### 6.2 Upload visibility texture to GPU

- Add to `Renderer`:
  - `visibilityTexture`: WebGL texture.
  - `uploadVisibilityTexture(visData)`:
    1. `gl.activeTexture(TEXTURE2)`.
    2. `gl.bindTexture(TEXTURE_2D, visibilityTexture)`.
    3. `gl.texImage2D(..., gl.RGBA, gl.UNSIGNED_BYTE, visData.data)`.
    4. `gl.texParameteri` with NEAREST/CLAMP_TO_EDGE.
    5. Bind to uniform `u_visibilityTexture`.

- Upload every frame where `visibleNodes` changed.

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 6.1
**Verify:** Texture uploads without GL errors.

---

### 6.3 Add `getLOD()` function to vertex shader

- Port Potree's `getLOD()` from `pointcloud.vs` into our vertex shader.
- The function walks the visibility texture to determine the LOD depth at a given point position:

```glsl
float getLOD() {
  int nodeIndex = 0; // root
  vec3 pos = a_position;

  for (int i = 0; i < 50; i++) { // max 50 levels
    ivec2 texCoord = ivec2(nodeIndex % texWidth, nodeIndex / texWidth);
    vec4 texel = texelFetch(u_visibilityTexture, texCoord, 0);

    float childMask = texel.r * 255.0;
    float siblingOffset = texel.g * 255.0 + texel.b * 255.0 * 256.0;

    // Determine which octant this point falls into
    vec3 center = (nodeMin + nodeMax) * 0.5;
    int childIndex = (pos.x >= center.x ? 4 : 0)
                   + (pos.y >= center.y ? 2 : 0)
                   + (pos.z >= center.z ? 1 : 0);

    if ((int(childMask) & (1 << childIndex)) == 0) {
      // This child is not visible: stop here
      return float(i);
    }

    // Move to child
    nodeIndex += int(siblingOffset);
    // Update node bounds (passed via uniforms or computed from metadata)
  }

  return 50.0;
}
```

- Wire into `ADAPTIVE` point size mode:
  ```glsl
  float lod = getLOD();
  float attenuation = clamp(lod / maxLOD, 0.0, 1.0);
  gl_PointSize = u_pointSize * attenuation;
  ```

- This requires node AABBs per level (can be passed as texture or uniforms). Simpler approach: pass `u_spacing` and `u_level` metadata, compute approximate size from depth.

**Files:** `script_js/rendering-app/shader.js`
**Depends on:** 6.2
**Verify:** ADAPTIVE point size mode produces different sizes at LOD boundaries. No visual popping when nodes load/unload.

---

### 6.4 Wire adaptive size into render pipeline

- In `renderer.render()`:
  - After `selectNodes()`, if point size type is `ADAPTIVE`:
    - Call `visibilitySystem.buildVisibilityTextureData(visibleNodes)`.
    - Call `uploadVisibilityTexture(visData)`.
    - Set `u_pointSizeType = 2`.
  - If not adaptive: skip texture upload (bind null/default).

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 6.3
**Verify:** Toggling ADAPTIVE mode in UI shows the effect in rendered output.

---

### 6.5 Verification

- Load a Potree dataset with multiple LOD levels.
- Enable ADAPTIVE point size.
- Rotate camera (nodes change LOD level).
- Verify: point sizes transition smoothly at LOD boundaries.
- Compare with Potree's adaptive mode: behavior should match.
- Performance: no frame drops from texture upload (only upload when visible nodes change).
