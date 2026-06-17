# Bug Report — Nuvola v3

## Indice

1. [Memoria — Leak su ricaricamento file](#1-memoria--leak-su-ricaricamento-file)
2. [FPS — Misura dimezza gli FPS](#2-fps--misura-dimezza-gli-fps)
3. [Input — Rotazione mouse invertita](#3-input--rotazione-mouse-invertita)
4. [UI — Troppa roba nell'interfaccia](#4-ui--troppa-roba-nellinterfaccia)

---

## 1. Memoria — Leak su ricaricamento file

### Causa radice

In `main.js:668-669` l'ordine di dispose è sbagliato:

```js
// main.js — loadFile()
this.cloud.dispose();       // riga 668: DISTRUGGE lodLevels (li setta a null)
this.renderer.dispose();    // riga 669: POI tenta di iterarli → CRASH + leak
```

`Renderer._disposeCloudVAOs()` (renderer.js:311) itera `this._cloud.lodLevels` per eliminare i GPU buffer (`lod._gpuVao`, `lod._gpuBuf`). Ma lodLevels è già null perché `PointCloud.dispose()` lo ha azzerato prima. Il metodo crascha con TypeError e tutti i GPU buffer restano allocati nella GPU, causando leak di memoria video crescente a ogni reload.

### Sotto-problemi

| ID | Problema | File | Riga/e | Fix |
|---|---|---|---|---|
| 1.1 | Ordine dispose invertito | `main.js` | 668-669 | Chiamare `renderer.dispose()` PRIMA di `cloud.dispose()` |
| 1.2 | Null guard mancante in `_disposeCloudVAOs` | `renderer.js` | 311 | Aggiungere `if (!this._cloud?.lodLevels) return;` |
| 1.3 | Minimap cache mai invalidata | `minimap.js` | (tutto) | Aggiungere `invalidateCache()` e chiamarla in `loadFile()` |
| 1.4 | GaussianCloud senza dispose | `gaussian-cloud.js` | — | Aggiungere `dispose()`, chiamarlo in `loadFile()` |
| 1.5 | Renderer.dispose() non elimina oggetti WebGL | `renderer.js` | 317-331 | Aggiungere `gl.deleteBuffer/Vao/Fbo/Texture/Program` |
| 1.6 | Event listener mai rimossi | `main.js` | 398-638 | Rimuovere listener in `App.dispose()` |

---

## 2. FPS — Misura dimezza gli FPS

### Causa radice

In `main.js:815-817`:

```js
// Riga 817 — versione isometrica:
needsRender = this.camera.consumeDirty() || this.cloudTransform.consumeDirty() || this.measurement.active;
```

Quando `measurement.active === true`, `needsRender` è `true` su OGNI frame, attivando l'intero pipeline WebGL (`renderer.render()` con draw di milioni di punti) anche quando la camera è ferma. Questo consuma ~4ms extra per frame, portando il frame time da ~4ms (240 FPS) a ~8ms (120 FPS).

### Sotto-problemi

| ID | Problema | File | Riga/e | Fix |
|---|---|---|---|---|
| 2.1 | `measurement.active` forza render perpetuo | `main.js` | 815, 817 | Rimuovere `|| this.measurement.active`. Invece chiamare `camera.markDirty()` dentro `onClick` |
| 2.2 | `console.log` in `selectLOD()` | `PointCloud.js` | 324 | Rimuovere `console.log` o metterlo sotto debug flag |
| 2.3 | `_pickGrid` mai usato in `pickNearest()` | `PointCloud.js` | 407-424 | Usare la griglia 128×128 invece di scan lineare (opzionale — secondario) |

### Fix 2.1 — Dettaglio

```js
// PRIMA — main.js:815-817 (dentro _loop):
needsRender = this.camera.consumeDirty() || this.measurement.active;

// DOPO:
needsRender = this.camera.consumeDirty();
```

E nel click handler (main.js:628-638):
```js
// Aggiungere markerDirty() dopo onClick
if (this.measurement.onClick(this.cloud, this.camera, this.renderer, sx, sy)) {
  this.camera.markDirty();   // ← forza un render per mostrare il marker
  this._showMeasurement();
}
```

---

## 3. Input — Rotazione mouse invertita

### Causa radice

In `main.js:449-450`:

```js
this.camera.rotateHorizontal(-dx * 0.003);   // dx è NEGATO
this.camera.rotateVertical( dy * 0.015);      // dy NON è negato — inconsistente
```

L'asse X è negato, l'asse Y no. Quando l'utente trascina verso l'alto (dy < 0), il valore non negato viene passato a `rotateVertical`, che interpreta un movimento verso l'alto come se fosse verso il basso.

I metodi `rotateHorizontal(delta)` e `rotateVertical(delta)` in `camera.js` semplicemente sommano il delta ricevuto. Il bug è puramente nei call site in `main.js`.

| ID | Problema | File | Riga/e | Fix |
|---|---|---|---|---|
| 3.1 | Segno dy sbagliato nel mouse handler | `main.js` | 450 | `rotateVertical(dy * 0.015)` → `rotateVertical(-dy * 0.015)` |
| 3.2 | Segno dy sbagliato nel touch handler | `main.js` | 607 | Stesso fix |

---

## 4. UI — Troppa roba nell'interfaccia

### Cosa tenere

1. **File Loader**: pulsante "Open Point Cloud", input file, info file caricato
2. **Rotazione assi**: slider X, Y, Z della rotazione
3. **Modalità colore**: pulsanti RGB, Height, Intensity, Depth

### Cosa rimuovere — tutto il resto

| ID | Area | Elementi da rimuovere |
|---|---|---|
| 4.1 | **View panel** (parziale) | Zoom slider (`#zoom-slider`, `#zoom-val`), pulsanti cardinali (`#view-btns`), rotate left/right (`#btn-rot-left`, `#btn-rot-right`), snap view (`.view-snap`, `.snap-btn`), 8-dir checkbox (`#chk-8dir`), smooth rotation (`#chk-smooth-rot`), reset view (`#btn-reset`) |
| 4.2 | **Render Mode panel** (intero) | Gaussian toggle (`#chk-gaussian`), density slider (`#gaussian-density`, `#gaussian-density-val`), info text |
| 4.3 | **Point Decimation panel** (intero) | Range decimation checkbox (`#chk-range-decimation`), min detail slider (`#min-detail-points`, `#min-detail-val`), max dist ratio slider (`#max-dist-ratio`, `#max-dist-ratio-val`) |
| 4.4 | **Lighting panel** (intero) | Azimuth (`#light-az`, `#light-az-val`), elevation (`#light-el`, `#light-el-val`), ambient (`#light-amb`, `#light-amb-val`), shading checkbox (`#chk-shading`) |
| 4.5 | **Measure panel** (intero) | Measure button (`#btn-measure`), clear button (`#btn-clear-measure`), measure info (`#measure-info`) |
| 4.6 | **Stats panel** (intero) | Stats info (`#stats-info`) |
| 4.7 | **Controls / Help** (intero) | Isometric mode help (`#control-iso`), FPS help (`#control-fps`), keyboard help isometric (`#keyboard-iso`), keyboard help FPS (`#keyboard-fps`) |
| 4.8 | **Overlay / HUD** (intero) | Drop overlay (`#drop-overlay`), HUD (`#hud`), minimap (`#minimap`, `#minimap-canvas`), loading overlay (`#loading`, `#loading-text`) |
| 4.9 | **Sidebar toggle** | Toggle sidebar button (`#toggle-sidebar`) |

### Sotto-problemi JS

| ID | Cosa rimuovere | File | Dettaglio |
|---|---|---|---|
| 4.10 | Import/istanze | `main.js` | `MeasurementTool`, `MiniMap`, `Gizmo`, `GaussianCloud`, `FPSCamera`, `CloudTransform` (import + construct lines) |
| 4.11 | Proprietà stato | `main.js` | `this.lightAz`, `this.lightEl`, `this.lightAmb`, `this.shading`, `this.gaussianDensity`, `this.enableRangeDecimation`, `this.minPointsForDetail`, `this.maxDistanceRatio`, `this.gaussianMode`, `this.gaussianCloud`, `this.fpsMode` |
| 4.12 | Metodi interi | `main.js` | `getLightDir()`, `getDecimationOptions()`, `toggleFPSMode()`, `toggleGaussianMode()`, `snapToView()`, `_drawGizmo()`, `_updateViewButtons()`, `clearMeasurement()`, `_showMeasurement()` |
| 4.13 | Semplificare `_loop()` | `main.js` | Rimuovere: minimap.draw, gizmo draw, measurement drawOverlay, FPS HUD update, HUD HTML generazione |
| 4.14 | Semplificare `_bindInput()` | `main.js` | Rimuovere: gizmo hit-test in mousedown, measurement click handler, tasto T/G/R, FPS mode, zoom slider DOM update |
| 4.15 | Semplificare `loadFile()` | `main.js` | Rimuovere: Gaussian mode path, lighting params, decimation opts, gizmo reset, zoom slider DOM write |
| 4.16 | Semplificare `_fitView()` | `main.js` | Rimuovere zoom slider DOM writes |
| 4.17 | Semplificare `_resize()` | `main.js` | Rimuovere zoom slider refit? |
| 4.18 | Semplificare `ui-controller.js` | `ui-controller.js` | Rimuovere bindings: zoom slider, rot left/right, 8-dir, snap, smooth rot, reset view, lighting, decimation, measure, gaussian, sidebar toggle, drag-drop. Semplificare `updateStats()` |
| 4.19 | Semplificare `styles.css` | `styles.css` | Rimuovere regole per: .btn-grid.eight, .view-snap/snap-btn, #drop-overlay, #hud, #minimap, #measure-info, #loading/.spinner/@keyframes spin, #toggle-sidebar, responsive minimap |
| 4.20 | Eliminare file | `script_js/view/` | Cancellare: `measurements.js`, `minimap.js`, `gizmo.js` |
| 4.21 | Eliminare file | `script_js/model/` | Cancellare: `gaussian-cloud.js`, `fps-camera.js`, `transform.js` |

---

## Ordine di esecuzione consigliato

```
Fase 1: UI (Problema 4)
  4.19 styles.css
  4.8  index.html (pannelli + overlay)
  4.21+4.20 Eliminare file non usati
  4.10 main.js import/istanze
  4.11 main.js proprietà
  4.12 main.js metodi
  4.13 main.js _loop()
  4.14 main.js _bindInput()
  4.15 main.js loadFile()
  4.16 main.js _fitView()
  4.17 main.js _resize()
  4.18 ui-controller.js

Fase 2: Rotazione (Problema 3)
  3.1 main.js:450
  3.2 main.js:607

Fase 3: FPS (Problema 2)
  2.1 main.js:815/817 + click handler
  2.2 PointCloud.js:324

Fase 4: Memoria (Problema 1)
  1.2 renderer.js:311
  1.1 main.js:668-669
  1.5 renderer.js:317-331 (dispose completo)
  1.4 gaussian-cloud.js dispose()
  1.3 minimap.js invalidateCache()
  1.6 main.js event listener cleanup
```

---

## Dipendenze

```
Fase 1 (UI) → prerequisito per TUTTE le altre
  └── Rimuove codice che altrimenti dovresti modificare in Fase 2/3/4

Fase 2 (Rotation) → indipendente
Fase 3 (FPS) → indipendente
Fase 4 (Memoria) → dipende da Fase 1 (alcuni fix toccano file modificati in Fase 1)
```
