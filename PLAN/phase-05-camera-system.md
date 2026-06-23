# Phase 5 — Camera System: FPS + Isometric

## Goal

Add an FPS (first-person) perspective camera alongside Nuvola's existing isometric camera. The user can switch between modes. FPS mode uses Three.js `PerspectiveCamera` with orbit-style controls.

## Microtasks

### 5.1 Create `fps-camera.js`

- Class `FPSCamera`:
  - Wraps `THREE.PerspectiveCamera`.
  - Properties:
    - `target`: THREE.Vector3 (orbit center)
    - `yaw`: number (radians, rotation around Y)
    - `pitch`: number (radians, rotation around X)
    - `radius`: number (distance from target)
    - `fov`: number (default 60)
    - `near`/`far`: number
    - `position`: THREE.Vector3 (derived)
    - `dirty`: boolean
  - Methods:
    - `orbit(dyaw, dpitch)` — modifies yaw/pitch, clamps pitch to [-89°, 89°]. Marks dirty.
    - `pan(dx, dy)` — moves target in screen-space XY. Marks dirty.
    - `zoom(factor)` — multiplies radius. Clamps to [0.1, 10000]. Marks dirty.
    - `update()` — recomputes camera position from yaw/pitch/radius/target, sets camera transform. Clears dirty.
      ```
      position.x = target.x + radius * cos(pitch) * sin(yaw);
      position.y = target.y + radius * sin(pitch);
      position.z = target.z + radius * cos(pitch) * cos(yaw);
      camera.position.copy(position);
      camera.lookAt(target);
      ```
    - `getViewMatrix()` — returns `camera.matrixWorldInverse`.
    - `getProjectionMatrix()` — returns `camera.projectionMatrix`.
    - `getWorldPosition()` — returns position.
    - `getFrustum()` — builds `THREE.Frustum` from combined projection * view.
    - `setPosition(pos)` / `setTarget(targ)` / `setRadius(r)`.
    - `reset()` — defaults to yaw=0, pitch=-30°, radius=100.
    - `fitToBounds(box)` — computes radius and target from bounding box.

**Files:** `script_js/view/fps-camera.js`
**Depends on:** 1.1 (Three.js)
**Verify:** Create FPSCamera, call orbit/zoom, read position. The camera behaves like Three.js OrbitControls.

---

### 5.2 Create `fps-controls.js`

- Class `FPSControls` — input handler for FPS camera mode.
  - Constructor takes `(canvas, fpsCamera)`.
  - Left-drag: orbit.
  - Right-drag: pan.
  - Scroll: zoom.
  - Keyboard:
    - W / ArrowUp: move forward (along view direction projected to XZ).
    - S / ArrowDown: move backward.
    - A / ArrowLeft: strafe left.
    - D / ArrowRight: strafe right.
    - Shift: speed boost (2×).
  - Touch: single finger orbit, two-finger pinch zoom, two-finger pan.
  - All mouse/touch events registered via `AbortController` (same pattern as `App._bindInput`).
  - `dispose()` — removes event listeners.

- Movement logic (WASD):
  ```
  forward = camera.getWorldDirection().clone();
  forward.y = 0; forward.normalize();
  right = new THREE.Vector3().crossVectors(forward, UP);
  target.add(forward.multiplyScalar(-speed * dt)); // move target, not camera
  ```
  This moves the orbit target, so the camera follows.

**Files:** `script_js/view/fps-controls.js`
**Depends on:** 5.1
**Verify:** Left-drag orbits, right-drag pans, scroll zooms, WASD moves. Touch works on mobile.

---

### 5.3 Create `CameraController.js` (unified wrapper)

- Class `CameraController`:
  - Wraps both `Camera` (isometric, from Nuvola) and `FPSCamera` (perspective).
  - `activeMode`: `'isometric'` | `'fps'`.
  - `switchMode()` — toggles between cameras. Preserves view direction when possible.
  - `getActiveCamera()` — returns the current camera object.
  - `getViewMatrix()` — delegates to active camera.
  - `getProjectionMatrix()` — delegates to active camera.
  - `getFrustum()` — delegates to active camera.
  - `getUniforms(viewportW, viewportH, cloud)` — returns uniform block for renderer:
    - If isometric: same as current `Camera.getUniforms()`.
    - If FPS: returns perspective uniforms (viewMatrix, projMatrix, cameraMode=1, etc.).
  - `update(dt)` — calls `fpsCamera.update()` if dirty.
  - `markDirty()` / `consumeDirty()` — delegates.
  - `reset()` — resets active camera.

**Files:** `script_js/potree/CameraController.js`
**Depends on:** 5.1, also references existing `Camera` class
**Verify:** Switch between modes, each returns correct uniforms.

---

### 5.4 Integrate new cameras into `App`

- In `App` constructor:
  - Create `FPSCamera` + `FPSControls` alongside existing `Camera`.
  - Create `CameraController` wrapping both.
  - Default mode: `'isometric'`.

- Modify `_bindInput()`:
  - If `cameraMode === 'fps'`: enable `FPSControls`, disable isometric mouse handlers.
  - If `cameraMode === 'isometric'`: enable existing handlers, disable `FPSControls`.
  - Toggle via keyboard shortcut (e.g., `C` key).

- Modify `_loop()`:
  - Call `cameraController.update(dt)`.
  - Send uniforms from `cameraController.getUniforms()` to renderer.
  - When FPS camera moves (is dirty), force re-render + LOD update.

- Modify `_resize()`:
  - Update aspect ratio on FPS camera.

- When loading a dataset:
  - Call `fpsCamera.fitToBounds(cloudBounds)` to set initial position.

- Camera mode UI toggle:
  - Button in View panel: "Camera: Isometric" / "Camera: FPS".
  - Clicking toggles mode.

**Files:** `script_js/main/main.js`
**Depends on:** 5.3, 5.2
**Verify:** Switch to FPS mode, orbit around cloud. Switch back to isometric, view snaps to previous angle.

---

### 5.5 Adapt `VisibilitySystem` to work with both camera types

- `VisibilitySystem.selectNodes()` currently needs camera parameters (frustum, fov, viewport).
- Add adapter that extracts params from either camera type:
  - For FPS: use Three.js `PerspectiveCamera` directly (frustum, fov, position).
  - For isometric: construct a frustum from the isometric projection params (orthographic frustum).

- Helper: `extractCameraParams(cameraController, viewportW, viewportH)` → `{frustum, fov, position, viewport, cameraMode}`.

- Isometric frustum can be approximated: the isometric view projects to a fixed-direction orthographic view. Build `THREE.Frustum` from the orthographic bounds.

**Files:** `script_js/potree/VisibilitySystem.js`
**Depends on:** 5.3, 2.2
**Verify:** LOD selection works in both camera modes.

---

### 5.6 Update `renderer.render()` to accept camera mode

- The renderer receives pre-computed uniforms from `CameraController.getUniforms()`.
- The vertex shader already has `u_cameraMode` (from Phase 4.3).
- Renderer just applies the uniform block — it doesn't need to know which camera is active.

- Verify that the existing isometric render path is unchanged when `u_cameraMode = 0`.
- Verify perspective path when `u_cameraMode = 1`.

**Files:** `script_js/rendering-app/renderer.js`
**Depends on:** 5.4
**Verify:** Both paths produce correct visual output.

---

### 5.7 Verification

- Mode switch (key C or button): isometric ↔ FPS, both render correctly.
- FPS: orbit, pan, zoom, WASD all work smoothly.
- Isometric: all existing controls still work (8-direction, tilt, zoom slider).
- FPS: near/far clipping doesn't cut off the cloud.
- FPS: mouse sensitivity feels natural (adjustable via UI).
- Touch controls work in both modes.
