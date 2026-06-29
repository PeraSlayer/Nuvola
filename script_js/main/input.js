const ROTATION_SENSITIVITY = 0.003;
const VERTICAL_ROTATION_SENSITIVITY = 0.15;
const ZOOM_FACTOR_IN = 1.15;
const ZOOM_FACTOR_OUT = 0.85;
const KEYBOARD_PAN_SPEED = 20;

/**
 * Binds all input events (mouse, keyboard, touch) to the App instance.
 * Uses AbortController signal for clean teardown.
 */
export function bindInput(app) {
  const c = app.canvas;
  const signal = app._abortController.signal;

  c.addEventListener('mousedown', (e) => {
    if (app.camera.activeMode === 'fps') return;
    if (app.measurement.active && e.button === 0) return;
    if (app.gizmo.mode !== 'none' && app.cloud && e.button === 0) {
      const rect = c.getBoundingClientRect();
      const dpr = app.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top) * dpr;
      const hit = app.gizmo.hitTest(sx, sy, app.camera, app.cloud);
      if (hit) {
        app.gizmo.startDrag(hit, sx, sy);
        app.camera.markDirty();
        return;
      }
    }
    app._dragging = true;
    app._lastMouse = [e.clientX, e.clientY];
    app._dragButton = e.button;
  }, { signal });

  window.addEventListener('mousemove', (e) => {
    if (app._dragging && e.which === 0) app._dragging = false;
  }, { signal });

  window.addEventListener('mouseup', (e) => {
    if (app.gizmo.isActive()) app.gizmo.endDrag();
    if (e.button === app._dragButton) app._dragging = false;
  }, { signal });

  c.addEventListener('mousemove', (e) => {
    if (app.camera.activeMode === 'fps') return;
    const rect = c.getBoundingClientRect();
    const dpr = app.renderer.width / rect.width;
    const sx = (e.clientX - rect.left) * dpr;
    const sy = (e.clientY - rect.top) * dpr;
    if (app.gizmo.isActive()) {
      app.gizmo.onDrag(sx, sy, app.camera, app.cloud, app.cloudTransform);
      app.camera.markDirty();
      return;
    }
    if (app.gizmo.mode !== 'none' && app.cloud && !app._dragging) {
      app.gizmo.setHovered(app.gizmo.hitTest(sx, sy, app.camera, app.cloud));
    }
    if (!app._dragging) return;
    const dx = (e.clientX - app._lastMouse[0]) * dpr;
    const dy = (e.clientY - app._lastMouse[1]) * dpr;
    app._lastMouse = [e.clientX, e.clientY];
    if (app._dragButton === 2) {
      // Pan relativo all'orientamento dell'oggetto
      const rotAngle = app.camera.rotAngle;
      const cosA = Math.cos(rotAngle);
      const sinA = Math.sin(rotAngle);
      // Trasforma il movimento del mouse nel sistema di riferimento dell'oggetto
      const panX = dx * cosA + dy * sinA;
      const panY = -dx * sinA + dy * cosA;
      app.camera.panX += panX;
      app.camera.panY += panY;
      app.camera.markDirty();
    } else {
      // Rotazione relativa all'orientamento dell'oggetto
      app.camera.rotateHorizontal(-dx * ROTATION_SENSITIVITY);
      app.camera.rotateVertical(-dy * VERTICAL_ROTATION_SENSITIVITY);
    }
  }, { signal });

  c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

  c.addEventListener('wheel', (e) => {
    if (app.camera.activeMode === 'fps') return;
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    const dpr = app.renderer.width / rect.width;
    const sx = (e.clientX - rect.left) * dpr;
    const sy = (e.clientY - rect.top)  * dpr;
    const factor = e.deltaY > 0 ? ZOOM_FACTOR_OUT : ZOOM_FACTOR_IN;
    app.camera.zoomAt(factor, sx, sy, app.renderer.width, app.renderer.height);
    document.getElementById('zoom-slider').value = app.camera.zoom;
    document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
  }, { passive: false, signal });

  c.addEventListener('dblclick', (e) => {
    e.preventDefault();
    app.camera.reset();
    if (app.cloud) app._fitView();
    document.getElementById('zoom-slider').value = app.camera.zoom;
    document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
  }, { signal });

  window.addEventListener('keydown', (e) => {
    if (!app.cloud) return;

    const key = e.key.toLowerCase();
    const isFps = app.camera.activeMode === 'fps';

    if (!isFps) {
      switch(key) {
        case 'arrowup':
        case 'w':
          e.preventDefault();
          app.camera.panY += KEYBOARD_PAN_SPEED;
          app.camera.markDirty();
          return;
        case 'arrowdown':
        case 's':
          e.preventDefault();
          app.camera.panY -= KEYBOARD_PAN_SPEED;
          app.camera.markDirty();
          return;
        case 'arrowleft':
        case 'a':
          e.preventDefault();
          app.camera.panX -= KEYBOARD_PAN_SPEED;
          app.camera.markDirty();
          return;
        case 'arrowright':
        case 'd':
          e.preventDefault();
          app.camera.panX += KEYBOARD_PAN_SPEED;
          app.camera.markDirty();
          return;
        case 'q':
          e.preventDefault();
          app.camera.rotateLeft();
          app._fitView();
          return;
        case 'e':
          e.preventDefault();
          app.camera.rotateRight();
          app._fitView();
          return;
        case '+':
        case '=':
          e.preventDefault();
          app.camera.zoomAt(ZOOM_FACTOR_IN, app.renderer.width * 0.5, app.renderer.height * 0.5, app.renderer.width, app.renderer.height);
          document.getElementById('zoom-slider').value = app.camera.zoom;
          document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
          return;
        case '-':
        case '_':
          e.preventDefault();
          app.camera.zoomAt(ZOOM_FACTOR_OUT, app.renderer.width * 0.5, app.renderer.height * 0.5, app.renderer.width, app.renderer.height);
          document.getElementById('zoom-slider').value = app.camera.zoom;
          document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
          return;
        case 'r':
          e.preventDefault();
          app.camera.reset();
          app._fitView();
          document.getElementById('zoom-slider').value = app.camera.zoom;
          document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
          return;
      }
    }

    switch(key) {
      case 'g':
        e.preventDefault();
        app.gizmo.toggleMode();
        if (app.gizmo.mode === 'none') app.cloudTransform.reset();
        app.camera.markDirty();
        break;
      case 'c':
        e.preventDefault();
        app.camera.switchMode();
        app.fpsControls.enabled = app.camera.activeMode === 'fps';
        if (app.cloud) app.camera.fitToBounds(app.cloud, app.renderer.width, app.renderer.height);
        app.camera.markDirty();
        break;
    }
  }, { signal });

  let lastTouchDist = 0;
  c.addEventListener('touchstart', (e) => {
    if (app.camera.activeMode === 'fps') return;
    if (e.touches.length === 1) {
      if (app.gizmo.mode !== 'none' && app.cloud) {
        const rect = c.getBoundingClientRect();
        const dpr = app.renderer.width / rect.width;
        const sx = (e.touches[0].clientX - rect.left) * dpr;
        const sy = (e.touches[0].clientY - rect.top) * dpr;
        const hit = app.gizmo.hitTest(sx, sy, app.camera, app.cloud);
        if (hit) {
          app.gizmo.startDrag(hit, sx, sy);
          app.camera.markDirty();
          app._dragging = false;
          return;
        }
      }
      app._dragging = true;
      app._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx*dx + dy*dy);
    }
  }, { passive: true, signal });

  c.addEventListener('touchmove', (e) => {
    if (app.camera.activeMode === 'fps') return;
    const rect = c.getBoundingClientRect();
    const dpr = app.renderer.width / rect.width;
    if (e.touches.length === 1) {
      if (app.gizmo.isActive()) {
        const sx = (e.touches[0].clientX - rect.left) * dpr;
        const sy = (e.touches[0].clientY - rect.top) * dpr;
        app.gizmo.onDrag(sx, sy, app.camera, app.cloud, app.cloudTransform);
        app.camera.markDirty();
        return;
      }
      if (app._dragging) {
        const dx = (e.touches[0].clientX - app._lastMouse[0]) * dpr;
        const dy = (e.touches[0].clientY - app._lastMouse[1]) * dpr;
        app._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
        app.camera.rotateHorizontal(-dx * ROTATION_SENSITIVITY);
        app.camera.rotateVertical(-dy * VERTICAL_ROTATION_SENSITIVITY);
      }
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist > 0) {
        const mx = ((e.touches[0].clientX + e.touches[1].clientX) * 0.5 - rect.left) * dpr;
        const my = ((e.touches[0].clientY + e.touches[1].clientY) * 0.5 - rect.top)  * dpr;
        app.camera.zoomAt(dist / lastTouchDist, mx, my, app.renderer.width, app.renderer.height);
        document.getElementById('zoom-slider').value = app.camera.zoom;
        document.getElementById('zoom-val').textContent = app.camera.zoom.toFixed(1);
      }
      lastTouchDist = dist;
    }
  }, { passive: true, signal });

  c.addEventListener('touchend', () => {
    if (app.gizmo.isActive()) app.gizmo.endDrag();
    app._dragging = false;
  }, { signal });

  c.addEventListener('click', (e) => {
    if (app.camera.activeMode === 'fps') return;
    if (!app.measurement.active || !app.cloud) return;
    const rect = c.getBoundingClientRect();
    const dpr = app.renderer.width / rect.width;
    const sx = (e.clientX - rect.left) * dpr;
    const sy = (e.clientY - rect.top)  * dpr;
    if (app.measurement.onClick(app.cloud, app.camera, app.renderer, sx, sy)) {
      app.camera.markDirty();
      app._showMeasurement();
    }
  }, { signal });

  window.addEventListener('resize', () => app._resize(), { signal });
}
