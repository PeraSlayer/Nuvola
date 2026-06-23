# Phase 9 — Eye-Dome Lighting (EDL)

## Goal

Add Eye-Dome Lighting as an optional post-processing pass. EDL enhances depth perception in point clouds by darkening edges (depth discontinuities), creating a pseudo-lighting effect. Ported from Potree's EDL implementation.

## Microtasks

### 9.1 Create EDL fragment shader

- New file `script_js/rendering-app/edl-shader.js`:
  - `EDL_VERTEX_SHADER`: fullscreen quad pass-through (same as `QUAD_VERTEX_SHADER`, or reuse directly).
  - `EDL_FRAGMENT_SHADER` — ported from Potree's `edl.fs`:

```glsl
#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uEDLColor;
uniform sampler2D uEDLDepth;
uniform float uScreenWidth;
uniform float uScreenHeight;
uniform float uEDLStrength;
uniform float uRadius;
uniform int uNumNeighbors; // default 8
out vec4 fragColor;

// Neighbor directions (8 equally spaced)
const vec2 NEIGHBORS[8] = vec2[8](...);

float response(float depth) {
    vec2 uvRadius = uRadius / vec2(uScreenWidth, uScreenHeight);
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
        vec2 uvNeighbor = v_uv + uvRadius * NEIGHBORS[i];
        float neighborDepth = texture(uEDLDepth, uvNeighbor).r;
        sum += max(0.0, depth - neighborDepth);
    }
    return sum / 8.0;
}

void main() {
    vec4 colorSample = texture(uEDLColor, v_uv);
    if (colorSample.a < 0.5) {
        fragColor = vec4(0.13, 0.15, 0.18, 1.0); // background
        return;
    }
    float depth = texture(uEDLDepth, v_uv).r;
    float res = response(depth);
    float shade = exp(-res * 300.0 * uEDLStrength);
    fragColor = vec4(colorSample.rgb * shade, 1.0);
}
```

- `uRadius`: EDL radius in pixels (default 3.0).
- `uEDLStrength`: effect strength (default 1.0, range 0.0–5.0).
- `uNumNeighbors`: number of neighbor samples (4–16, default 8).

- The depth texture input is the same depth produced by the main point pass (the R channel of `COLOR_ATTACHMENT1`).

**Files:** `script_js/rendering-app/edl-shader.js`
**Depends on:** nothing (standalone shaders)
**Verify:** WebGL compilation succeeds.

---

### 9.2 Create `EDL.js` class

- Class `EDL`:
  - `constructor(gl)`:
    - Compiles EDL program (`progEDL`) from vertex + fragment shaders.
    - Creates fullscreen quad VAO (same as existing `_quadVao`).
    - Stores uniform locations.
  - `render(colorTexture, depthTexture, width, height, camera, options)`:
    - Options: `{strength: 1.0, radius: 3.0, neighbors: 8}`.
    - `gl.disable(DEPTH_TEST)`.
    - Bind color to TEXTURE0, depth to TEXTURE1.
    - Set uniforms: screenWidth, screenHeight, strength, radius, neighbors.
    - `gl.drawArrays(TRIANGLE_STRIP, 0, 4)`.
  - `dispose()` — delete program.

- The EDL pass replaces the lighting pass when EDL is enabled.

**Files:** `script_js/potree/EDL.js`
**Depends on:** 9.1
**Verify:** EDL renders as a fullscreen pass without errors.

---

### 9.3 Integrate EDL into render pipeline

- In `renderer.js`:
  - Accept `edl` option in `render()`:
    ```javascript
    render(camera, cloud, opts = {}) {
      // ... existing point pass ...
      
      if (opts.edl && opts.edl.enabled) {
        // Fullscreen EDL pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._edlFbo || null);
        this.edl.render(this.colorTex, this.depthTex, this.width, this.height, camera, opts.edl);
        // If using intermediate FBO, blit to screen
      } else {
        // existing lighting pass
        this._lightPass();
      }
    }
    ```
  - Add `this.edl = new EDL(gl)` in constructor.
  - Context loss: re-create `EDL` on restore.

- When EDL is enabled:
  1. Point pass renders color + depth to FBO (same as today).
  2. Bind FBO's color + depth textures.
  3. Render EDL fullscreen quad → output to screen.
  4. `gl.bindFramebuffer(null)` before EDL (or use a second FBO).

- The existing lighting pass (`progLight`) is skipped when EDL is on.
- Optionally: use a second FBO (`_edlFbo`) to composite EDL, then blit to screen. Simpler: render EDL directly to screen (no FBO).

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 9.2
**Verify:** EDL toggle on/off shows clear visual difference. EDL-on shows edge enhancement.

---

### 9.4 Add EDL controls to UI

- In `index.html` Lighting panel:
  ```html
  <label><input type="checkbox" id="chk-edl" /> Eye-Dome Lighting</label>
  <div class="row" id="edl-strength-row">
    <label>EDL Strength</label>
    <input type="range" id="edl-strength" min="0" max="500" step="1" value="100" />
    <span class="val" id="edl-strength-val">1.0</span>
  </div>
  <div class="row" id="edl-radius-row">
    <label>EDL Radius</label>
    <input type="range" id="edl-radius" min="1" max="10" step="1" value="3" />
    <span class="val" id="edl-radius-val">3</span>
  </div>
  ```
- Wire in `ui-controller.js`:
  - `chk-edl` → `app.edlEnabled`.
  - `edl-strength` → `app.edlStrength` (divided by 100 for 0.0–5.0 range).
  - `edl-radius` → `app.edlRadius`.

**Files:** `index.html`, `script_js/view/ui-controller.js`
**Depends on:** 9.3
**Verify:** EDL checkbox enables/disables effect. Sliders change intensity and radius in real time.

---

### 9.5 EDL performance optimization

- EDL can be expensive (8+ texture samples per pixel).
- Optimization: reduce neighbor count when user moves camera quickly (adaptive quality).
- Option: downsample the depth buffer before EDL (render depth at half resolution).
- For now: direct implementation is fine. Optimize only if performance < 30fps.

**Files:** `script_js/potree/EDL.js`
**Depends on:** 9.3

---

### 9.6 Verification

- Visual: Enable EDL on a point cloud → edges are darkened, interior faces are brighter.
- Disable EDL → back to flat shading (or existing lighting).
- Adjust strength 0→5: subtle to extreme edge enhancement.
- Adjust radius 1→10: wider edge influence.
- Strength 0: EDL has no effect (passes through).
- Performance: stable 30+ FPS with EDL on at 1080p on mid-range GPU.
- Compare with Potree's EDL: visual match (same equation, same parameters).
