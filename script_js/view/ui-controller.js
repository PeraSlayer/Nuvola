/*
===============================================================================
File: ui-controller.js

Questo modulo centralizza il collegamento tra DOM e stato dell'applicazione.
UIController registra gli handler dei pulsanti, input file, slider, checkbox,
dropdown e controlli di navigazione, traducendo le azioni dell'utente in
chiamate sui metodi di App, Camera e Renderer.

Si occupa anche di parti pratiche dell'interfaccia come drag-and-drop dei file,
aggiornamento dei valori mostrati accanto agli slider, sincronizzazione dei
pulsanti di vista, opzioni di colore, dimensione punti, modalita FPS e pannelli
informativi.

Il suo scopo e mantenere la logica UI separata dal nucleo di caricamento e
rendering, cosi App puo orchestrare il sistema senza contenere direttamente
tutti i dettagli degli eventi DOM.
===============================================================================
*/

// =============================================================================
// UIController
//
// Wires every DOM control (sidebar buttons, sliders, dropdowns) to the App's
// state. Also handles the drag-and-drop overlay and updates the stats panel.
// ============================================================================

/** Wires DOM controls to the App state and handles drag-and-drop. */
export class UIController {
  /** @param {import('./main.js').App} app */
  constructor(app) {
    this.app = app;
    this._bind();
  }

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

    // --- Measurement -------------------------------------------------------
    $('btn-measure').onclick = () => {
      const on = a.measurement.toggle();
      $('btn-measure').classList.toggle('active', on);
      $('btn-measure').textContent = on ? 'Measuring… (click 2 pts)' : 'Measure Distance';
    };
    $('btn-clear-measure').onclick = () => a.clearMeasurement();

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
