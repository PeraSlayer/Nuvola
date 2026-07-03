/**
 * @file ui-controller.js
 * @description Centralises the wiring between the DOM and the application
 *   state. UIController registers event handlers for buttons, file inputs,
 *   sliders, checkboxes, dropdowns, and navigation controls, translating
 *   user actions into method calls on App, Camera, and Renderer.
 *
 *   Also handles drag-and-drop file loading, slider value display updates,
 *   view-snap button synchronisation, colour-mode selection, point-size
 *   controls, lighting/background parameters, measurement toggling, VR
 *   streaming, and mobile sidebar toggle. The goal is to keep UI logic
 *   separate from the core loading and rendering code.
 */

/**
 * Wires every DOM control (sidebar buttons, sliders, dropdowns) to the App's
 * state. Also handles the drag-and-drop overlay and updates the stats panel.
 */
export class UIController {
  /**
   * @param {import('./main.js').App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;
    this._bind();
  }

  /**
   * Bind all DOM event listeners. Each control queries its element by id,
   * attaches the appropriate event handler, and updates the app state.
   * @private
   */
  _bind() {
    const a = this.app;
    const $ = (id) => document.getElementById(id);

    // --- Load / file input -------------------------------------------------
    $('btn-load').onclick = () => $('file-input').click();
    $('file-input').onchange = (e) => { if (e.target.files[0]) a.loadFile(e.target.files[0]); };
    $('btn-load-potree').onclick = () => {
      const url = $('potree-url').value.trim();
      if (url) a.loadPotreeDataset(url);
    };
    $('potree-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = e.target.value.trim();
        if (url) a.loadPotreeDataset(url);
      }
    });

    // --- Zoom slider -------------------------------------------------------
    $('zoom-slider').oninput = (e) => {
      const z1 = +e.target.value;
      const r = a.renderer;
      a.camera.zoomAt(z1 / a.camera.zoom, r.width * 0.5, r.height * 0.5, r.width, r.height);
      $('zoom-val').textContent = a.camera.zoom.toFixed(1);
    };

    // --- Rotation ----------------------------------------------------------
    $('btn-rot-left').onclick  = () => { a.camera.rotateLeft();  if (a.cloud) a._fitView(); };
    $('btn-rot-right').onclick = () => { a.camera.rotateRight(); if (a.cloud) a._fitView(); };

    a._updateViewButtons();

    document.querySelectorAll('.snap-btn').forEach(btn => {
      btn.onclick = () => {
        a.snapToView(btn.dataset.view);
        $('zoom-slider').value = a.camera.zoom;
        $('zoom-val').textContent = a.camera.zoom.toFixed(1);
      };
    });

    $('btn-reset').onclick = () => {
      a.camera.reset();
      if (a.cloud) a._fitView();
      $('zoom-slider').value = a.camera.zoom;
      $('zoom-val').textContent = a.camera.zoom.toFixed(1);
    };

    // --- Color mode buttons ------------------------------------------------
    document.querySelectorAll('.mode-btns button').forEach(btn => {
      btn.onclick = () => {
        a.colorMode = btn.dataset.mode;
        document.querySelectorAll('.mode-btns button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        a.camera.markDirty();
      };
    });

    // --- Point Size -------------------------------------------------------
    $('point-size-type').onchange = (e) => {
      a.pointSizeType = +e.target.value;
      a.camera.markDirty();
    };
    $('point-size').oninput = (e) => {
      a.pointSize = +e.target.value;
      $('point-size-val').textContent = (+e.target.value).toFixed(1);
      a.camera.markDirty();
    };
    $('sketch-opacity').oninput = (e) => {
      a.sketchfabOpacity = +e.target.value;
      $('sketch-opacity-val').textContent = +e.target.value === 0 ? 'Off' : (+e.target.value * 100).toFixed(0) + '%';
      a.camera.markDirty();
    };
    $('dreamy').oninput = (e) => {
      a.dreamy = +e.target.value;
      $('dreamy-val').textContent = +e.target.value === 0 ? 'Off' : (+e.target.value * 100).toFixed(0) + '%';
      a.camera.markDirty();
    };

    // --- Lighting ----------------------------------------------------------
    $('light-az').oninput  = (e) => { a.lightAz  = +e.target.value; $('light-az-val').textContent  = a.lightAz  + '°'; a.camera.markDirty(); };
    $('light-el').oninput  = (e) => { a.lightEl  = +e.target.value; $('light-el-val').textContent  = a.lightEl  + '°'; a.camera.markDirty(); };
    $('light-amb').oninput = (e) => { a.lightAmb = +e.target.value/100; $('light-amb-val').textContent = a.lightAmb.toFixed(2); a.camera.markDirty(); };
    $('chk-shading').onchange = (e) => { a.shading = e.target.checked; a.camera.markDirty(); };

    // --- Background -------------------------------------------------------
    $('chk-sky').onchange = (e) => { a.skyEnabled = e.target.checked; a.camera.markDirty(); };
    $('sky-color-top').oninput = (e) => {
      const hex = e.target.value;
      a.skyColorTop = [
        parseInt(hex.substr(1, 2), 16) / 255,
        parseInt(hex.substr(3, 2), 16) / 255,
        parseInt(hex.substr(5, 2), 16) / 255,
      ];
      a.camera.markDirty();
    };
    $('sky-color-bottom').oninput = (e) => {
      const hex = e.target.value;
      a.skyColorBottom = [
        parseInt(hex.substr(1, 2), 16) / 255,
        parseInt(hex.substr(3, 2), 16) / 255,
        parseInt(hex.substr(5, 2), 16) / 255,
      ];
      a.camera.markDirty();
    };

    // --- Measurement -------------------------------------------------------
    $('btn-measure').onclick = () => {
      const on = a.measurement.toggle();
      $('btn-measure').classList.toggle('active', on);
      $('btn-measure').textContent = on ? 'Measuring… (click 2 pts)' : 'Measure Distance';
    };
    $('btn-clear-measure').onclick = () => a.clearMeasurement();

    // --- VR Mode -----------------------------------------------------------
    $('btn-stream').onclick = () => {
      if (a._streaming) {
        a.stopStreaming();
      } else {
        a.startStreaming();
      }
    };

    // --- Mobile sidebar toggle --------------------------------------------
    $('toggle-sidebar').onclick = () => $('sidebar').classList.toggle('open');

    // --- Drag & drop -------------------------------------------------------
    const main = $('main');
    const overlay = $('drop-overlay');
    ['dragenter','dragover'].forEach(ev =>
      main.addEventListener(ev, (e) => { e.preventDefault(); overlay.classList.add('visible'); }));
    ['dragleave','drop'].forEach(ev =>
      main.addEventListener(ev, (e) => { e.preventDefault(); overlay.classList.remove('visible'); }));
    main.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) a.loadFile(f);
    });
  }

  /** Update the stats panel (removed from UI, kept for compatibility) */
  updateStats(fps, lodCount, totalCount) {
  }
}
