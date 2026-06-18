/*
===============================================================================
File: main.js

Questo e il punto di ingresso dell'applicazione Nuvola. Importa camera,
renderer, loader dei formati supportati, modello della nuvola di punti,
strumenti di misura, minimappa e controller dell'interfaccia; poi li collega
in una singola classe App.

Il file gestisce il ciclo di vita principale: selezione o drag-and-drop dei
file, riconoscimento del formato, caricamento dei dati, decompressione LAZ,
creazione della PointCloud, inizializzazione della vista,
aggiornamento dei pannelli UI e render loop. Contiene anche un worker inline
che prepara dati pesanti come bounds, centro, livelli LOD, tile e griglia di
picking senza bloccare il thread principale del browser.

In pratica coordina tutto cio che succede tra input utente, dati caricati e
visualizzazione WebGL.
===============================================================================
*/

import { PLYLoader }       from '../file_loader/ply-loader.js';
import { LASLoader }       from '../file_loader/las-loader.js';
import { decompressLAZ }   from '../file_loader/laz-decompressor.js';
import { XYZLoader }       from '../file_loader/xyz-loader.js';
import { RXPLoader }       from '../file_loader/rxp-loader.js';
import { PointCloud }      from '../model/PointCloud.js';
import { Camera }          from '../model/camera.js';
import { CloudTransform }  from '../model/transform.js';
import { Gizmo }           from '../view/gizmo.js';
import { Renderer }        from '../rendering-app/renderer.js';
import { MeasurementTool } from '../view/measurements.js';
import { MiniMap }         from '../view/minimap.js';
import { UIController }    from '../view/ui-controller.js';


/**
 * Read a LAS/LAZ file: transparently decompresses LAZ before returning the buffer.
 * @param {File} file
 * @param {string} format 'LAS' or 'LAZ'
 * @returns {Promise<ArrayBuffer>}
 */
async function _readLASFile(file, format) {
  const buf = await file.arrayBuffer();
  if (format === 'LAZ') {
    try {
      return await decompressLAZ(buf);
    } catch (err) {
      throw new Error('LAZ decompression failed: ' + err.message);
    }
  }
  return buf;
}

const APP_OCTREE_WORKER = `
function _octBuild(positions, indices, bounds, depth, maxDepth, leafSize) {
  var count = indices.length;
  var node = { min:[bounds[0],bounds[1],bounds[2]], max:[bounds[3],bounds[4],bounds[5]], depth:depth, count:count, indices:null, children:null };
  if (count <= leafSize || depth >= maxDepth) { node.indices = indices; return node; }
  var mx = (bounds[0]+bounds[3])*0.5, my = (bounds[1]+bounds[4])*0.5, mz = (bounds[2]+bounds[5])*0.5;
  var c0=[],c1=[],c2=[],c3=[],c4=[],c5=[],c6=[],c7=[];
  for (var j = 0; j < count; j++) {
    var idx = indices[j];
    var px = positions[idx*3], py = positions[idx*3+1], pz = positions[idx*3+2];
    var ci = ((px<mx?0:1)<<2)|((py<my?0:1)<<1)|(pz<mz?0:1);
    if (ci===0){c0.push(idx)}else if(ci===1){c1.push(idx)}else if(ci===2){c2.push(idx)}else if(ci===3){c3.push(idx)}else if(ci===4){c4.push(idx)}else if(ci===5){c5.push(idx)}else if(ci===6){c6.push(idx)}else{c7.push(idx)};
  }
  var cb=[[bounds[0],bounds[1],bounds[2],mx,my,mz],[mx,bounds[1],bounds[2],bounds[3],my,mz],[bounds[0],my,bounds[2],mx,bounds[4],mz],[mx,my,bounds[2],bounds[3],bounds[4],mz],[bounds[0],bounds[1],mz,mx,my,bounds[5]],[mx,bounds[1],mz,bounds[3],my,bounds[5]],[bounds[0],my,mz,mx,bounds[4],bounds[5]],[mx,my,mz,bounds[3],bounds[4],bounds[5]]];
  var ch = [];
  var lists = [c0,c1,c2,c3,c4,c5,c6,c7];
  for (var k = 0; k < 8; k++) { if (lists[k].length > 0) ch.push(_octBuild(positions, new Uint32Array(lists[k]), cb[k], depth+1, maxDepth, leafSize)); }
  node.children = ch.length > 0 ? ch : null;
  if (!node.children) { node.indices = indices; return node; }
  return node;
}

function buildOctree(positions, count, bounds, maxDepth, leafSize) {
  var all = new Uint32Array(count);
  for (var j = 0; j < count; j++) all[j] = j;
  return _octBuild(positions, all, [bounds.min[0],bounds.min[1],bounds.min[2],bounds.max[0],bounds.max[1],bounds.max[2]], 0, maxDepth||12, leafSize||2000);
}

function collectLeafBufs(node, arr) {
  if (node.indices) { arr.push(node.indices.buffer); return; }
  if (node.children) { for (var k = 0; k < node.children.length; k++) collectLeafBufs(node.children[k], arr); }
}

self.onmessage = function(e) {
  try {
    var d = e.data;
    if (!d || !d.positions || !d.colors || !d.count) {
      self.postMessage({ error: 'Invalid data received by worker' });
      return;
    }
    var p = d.positions, c = d.colors, i = d.intensity, n = d.count;
    var b = { min: [1/0,1/0,1/0], max: [-1/0,-1/0,-1/0] }, iM = 1/0, iX = -1/0;
    for (var j = 0; j < n; j++) {
      var x = p[j*3], y = p[j*3+1], z = p[j*3+2];
      if (x < b.min[0]) b.min[0] = x; if (y < b.min[1]) b.min[1] = y; if (z < b.min[2]) b.min[2] = z;
      if (x > b.max[0]) b.max[0] = x; if (y > b.max[1]) b.max[1] = y; if (z > b.max[2]) b.max[2] = z;
      if (i) { var v = i[j]; if (v < iM) iM = v; if (v > iX) iX = v; }
    }
    var ct = [(b.min[0]+b.max[0])*0.5,(b.min[1]+b.max[1])*0.5,(b.min[2]+b.max[2])*0.5];
    var iMin = i ? iM : 0, iMax = i ? (iX===iM?iX+1:iX) : 1;
    var octree = buildOctree(p, n, b, 12, 2000);

    var pc2 = 128, pgc = pc2*pc2;
    var sx = b.max[0]-b.min[0]||1, sy = b.max[1]-b.min[1]||1;
    var pgCounts = new Uint32Array(pgc);
    for (var j = 0; j < n; j++) { var gx = Math.min(pc2-1,Math.floor(((p[j*3]-b.min[0])/sx)*pc2)); var gy = Math.min(pc2-1,Math.floor(((p[j*3+1]-b.min[1])/sy)*pc2)); pgCounts[gy*pc2+gx]++; }
    var pgOffsets = new Uint32Array(pgc+1);
    for (var _c = 0; _c < pgc; _c++) pgOffsets[_c+1] = pgOffsets[_c] + pgCounts[_c];
    var pgFlat = new Uint32Array(n);
    var pgCursor = new Uint32Array(pgc);
    for (var j = 0; j < n; j++) { var gx = Math.min(pc2-1,Math.floor(((p[j*3]-b.min[0])/sx)*pc2)); var gy = Math.min(pc2-1,Math.floor(((p[j*3+1]-b.min[1])/sy)*pc2)); var _cell = gy*pc2+gx; pgFlat[pgOffsets[_cell] + pgCursor[_cell]++] = j; }
    var tr = [p.buffer, c.buffer]; if (i) tr.push(i.buffer);
    collectLeafBufs(octree, tr);
    tr.push(pgFlat.buffer, pgOffsets.buffer, pgCounts.buffer);
    self.postMessage({ positions:p, colors:c, intensity:i, bounds:b, center:ct, zMin:b.min[2], zMax:b.max[2], intensityMin:iMin, intensityMax:iMax, octree:octree, pickGrid:pgFlat, pickOffsets:pgOffsets, pickCounts:pgCounts, pickCells:pc2 }, tr);
  } catch(err) {
    self.postMessage({ error: err.message });
  }
};
`;

/** Main application orchestrating camera, renderer, loaders, UI, and the render loop. */
class App {
  constructor() {
    this.canvas = document.getElementById('glcanvas');

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;width:100%;height:100%';
    document.getElementById('main').appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.plyLoader = new PLYLoader();
    this.lasLoader = new LASLoader();
    this.xyzLoader = new XYZLoader();
    this.rxpLoader = new RXPLoader();

    this.renderer    = new Renderer(this.canvas);
    this.camera      = new Camera();
    this.measurement = new MeasurementTool();
    this.minimap     = new MiniMap(document.getElementById('minimap-canvas'));
    this.ui          = new UIController(this);
    this.cloudTransform = new CloudTransform();
    this.gizmo         = new Gizmo();

    this.cloud        = null;
    this.colorMode    = 'rgb';
    this.lightAz      = 315;
    this.lightEl      = 45;
    this.lightAmb     = 0.25;
    this.shading      = true;

    this.enableRangeDecimation = true;
    this.minPointsForDetail = 50000;
    this.maxDistanceRatio = 1.0;

    this._fps = 0;
    this._frames = 0;
    this._lastFpsTime = performance.now();
    this._lastTime    = performance.now();

    this._dragging  = false;
    this._lastMouse = [0, 0];
    this._minimapFrame = 0;
    this._hudEl = document.getElementById('hud');

    this._disposed = false;
    this._loading = false;
    this._activeWorker = null;
    this._abortController = new AbortController();

    this._bindInput();
    this._resize();
    requestAnimationFrame((t) => this._loop(t));
  }

  getLightDir() {
    const az = this.lightAz * Math.PI / 180;
    const el = this.lightEl * Math.PI / 180;
    return [
      Math.cos(el) * Math.sin(az),
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
    ];
  }

  /**
   * View direction (from scene toward camera) for SH evaluation.
   * Derived from the isometric camera's rotation — not the FPS camera.
   */
  _getViewDir() {
    const angle = this.camera.rotAngle;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const cx = -(c + s);
    const cy = -(c - s);
    const cz = 1;
    const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
    return [cx / len, cy / len, cz / len];
  }

  getDecimationOptions() {
    return {
      enableRangeDecimation: this.enableRangeDecimation,
      minPointsForDetail: this.minPointsForDetail,
      maxDistanceRatio: this.maxDistanceRatio,
    };
  }

  _fitView() {
    const target = this.cloud;
    if (!target) return;
    const w = this.renderer.width, h = this.renderer.height;
    if (target.bounds && target.center) {
      this.camera.fitToBounds(target, w, h);
    } else {
      this.camera.fitToBounds(this.cloud || { bounds: {min:[0,0,0],max:[1,1,1]}, center:[0,0,0] }, w, h);
    }
    document.getElementById('zoom-slider').value = this.camera.zoom;
    document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    this.camera.markDirty();
  }

  _drawGizmo(ctx) {
    if (!this.cloud) return;
    const w = this.overlayCanvas.width, h = this.overlayCanvas.height;
    const cam = this.camera;
    const ref = cam.refCenter;

    const ox = cam.project(ref[0], ref[1], ref[2]);

    const pts = [
      cam.project(ref[0] + 1, ref[1], ref[2]),
      cam.project(ref[0], ref[1] + 1, ref[2]),
      cam.project(ref[0], ref[1], ref[2] + 1),
    ];

    const cols = ['#ff6b6b', '#51cf66', '#5c7cfa'];
    const lbls = ['X', 'Y', 'Z'];

    const gizmoX = w - 80, gizmoY = h - 80;
    const size = 40;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(gizmoX, gizmoY, size + 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(13,17,23,0.8)';
    ctx.fill();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.stroke();

    for (let i = 0; i < 3; i++) {
      const dx = pts[i][0] - ox[0];
      const dy = pts[i][1] - ox[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) continue;
      const ux = (dx / len) * size;
      const uy = (dy / len) * size;

      ctx.beginPath();
      ctx.moveTo(gizmoX, gizmoY);
      ctx.lineTo(gizmoX + ux, gizmoY + uy);
      ctx.strokeStyle = cols[i];
      ctx.lineWidth = 2.5;
      ctx.stroke();

      const lx = gizmoX + ux * 1.15;
      const ly = gizmoY + uy * 1.15;
      ctx.fillStyle = cols[i];
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(lbls[i], lx, ly);
    }
    ctx.restore();
  }

  snapToView(view) {
    const cam = this.camera;
    switch (view) {
      case 'top':
        cam.rotationXDeg = 0;
        cam.rotationYDeg = 0;
        break;
      case 'front':
        cam.rotationXDeg = 90;
        cam.rotationYDeg = 0;
        break;
      case 'right':
        cam.rotationXDeg = 90;
        cam.rotationYDeg = -90;
        break;
      case 'back':
        cam.rotationXDeg = -90;
        cam.rotationYDeg = 0;
        break;
    }
    cam.setView(0);
    cam.markDirty();
    if (this.cloud) this._fitView();
    this._updateViewButtons();
  }

  _resize() {
    const main = document.getElementById('main');
    const w = main.clientWidth, h = main.clientHeight;
    this.renderer.resize(w, h);
    this.camera.setViewport(this.renderer.width, this.renderer.height);
    this.overlayCanvas.width  = this.renderer.width;
    this.overlayCanvas.height = this.renderer.height;
    this.overlayCanvas.style.width  = w + 'px';
    this.overlayCanvas.style.height = h + 'px';
    if (this.cloud) this._fitView();
    this.camera.markDirty();
  }

  _updateViewButtons() {
    const labels = this.camera.eightDir
      ? ['N','NE','E','SE','S','SW','W','NW']
      : ['N','E','S','W'];
    const grid = document.getElementById('view-btns');
    grid.innerHTML = '';
    grid.classList.toggle('eight', this.camera.eightDir);
    labels.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.view = String(i);
      if (i === this.camera.viewIndex) btn.classList.add('active');
      btn.onclick = () => {
        this.camera.setView(i);
        grid.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.cloud) this._fitView();
      };
      grid.appendChild(btn);
    });
  }

  _bindInput() {
    const c = this.canvas;
    const signal = this._abortController.signal;

    c.addEventListener('mousedown', (e) => {
      if (this.measurement.active && e.button === 0) return;
      if (this.gizmo.mode !== 'none' && this.cloud && e.button === 0) {
        const rect = c.getBoundingClientRect();
        const dpr = this.renderer.width / rect.width;
        const sx = (e.clientX - rect.left) * dpr;
        const sy = (e.clientY - rect.top) * dpr;
        const hit = this.gizmo.hitTest(sx, sy, this.camera, this.cloud);
        if (hit) {
          this.gizmo.startDrag(hit, sx, sy);
          this.camera.markDirty();
          return;
        }
      }
      this._dragging = true;
      this._lastMouse = [e.clientX, e.clientY];
      this._dragButton = e.button;
    }, { signal });
    window.addEventListener('mousemove', (e) => {
      if (this._dragging && e.which === 0) this._dragging = false;
    }, { signal });
    window.addEventListener('mouseup', (e) => {
      if (this.gizmo.isActive()) this.gizmo.endDrag();
      if (e.button === this._dragButton) this._dragging = false;
    }, { signal });
    c.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top) * dpr;
      if (this.gizmo.isActive()) {
        this.gizmo.onDrag(sx, sy, this.camera, this.cloud, this.cloudTransform);
        this.camera.markDirty();
        return;
      }
      if (this.gizmo.mode !== 'none' && this.cloud && !this._dragging) {
        this.gizmo.setHovered(this.gizmo.hitTest(sx, sy, this.camera, this.cloud));
      }
      if (!this._dragging) return;
      const dx = (e.clientX - this._lastMouse[0]) * dpr;
      const dy = (e.clientY - this._lastMouse[1]) * dpr;
      this._lastMouse = [e.clientX, e.clientY];
      if (this._dragButton === 2) {
        this.camera.panX += dx;
        this.camera.panY += dy;
        this.camera.markDirty();
      } else {
        this.camera.rotateHorizontal(-dx * 0.003);
        this.camera.rotateVertical(-dy * 0.15);
      }
    }, { signal });
    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top)  * dpr;
      const factor = e.deltaY > 0 ? 0.85 : 1.15;
      this.camera.zoomAt(factor, sx, sy, this.renderer.width, this.renderer.height);
      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    }, { passive: false, signal });

    let lastClickTime = 0;
    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.camera.reset();
      if (this.cloud) this._fitView();
      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    }, { signal });

    window.addEventListener('keydown', (e) => {
      if (!this.cloud) return;
      const panSpeed = 20;

      switch(e.key.toLowerCase()) {
        case 'arrowup':
        case 'w':
          e.preventDefault();
          this.camera.panY += panSpeed;
          this.camera.markDirty();
          break;
        case 'arrowdown':
        case 's':
          e.preventDefault();
          this.camera.panY -= panSpeed;
          this.camera.markDirty();
          break;
        case 'arrowleft':
        case 'a':
          e.preventDefault();
          this.camera.panX -= panSpeed;
          this.camera.markDirty();
          break;
        case 'arrowright':
        case 'd':
          e.preventDefault();
          this.camera.panX += panSpeed;
          this.camera.markDirty();
          break;
        case 'q':
          e.preventDefault();
          this.camera.rotateLeft();
          this._fitView();
          break;
        case 'e':
          e.preventDefault();
          this.camera.rotateRight();
          this._fitView();
          break;
        case '+':
        case '=':
          e.preventDefault();
          this.camera.zoomAt(1.15, this.renderer.width * 0.5, this.renderer.height * 0.5, this.renderer.width, this.renderer.height);
          document.getElementById('zoom-slider').value = this.camera.zoom;
          document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
          break;
        case '-':
        case '_':
          e.preventDefault();
          this.camera.zoomAt(0.85, this.renderer.width * 0.5, this.renderer.height * 0.5, this.renderer.width, this.renderer.height);
          document.getElementById('zoom-slider').value = this.camera.zoom;
          document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
          break;
        case 'r':
          e.preventDefault();
          this.camera.reset();
          this._fitView();
          document.getElementById('zoom-slider').value = this.camera.zoom;
          document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
          break;
        case 'g':
          e.preventDefault();
          this.gizmo.toggleMode();
          if (this.gizmo.mode === 'none') this.cloudTransform.reset();
          this.camera.markDirty();
          break;
      }
    }, { signal });

    let lastTouchDist = 0;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        if (this.gizmo.mode !== 'none' && this.cloud) {
          const rect = c.getBoundingClientRect();
          const dpr = this.renderer.width / rect.width;
          const sx = (e.touches[0].clientX - rect.left) * dpr;
          const sy = (e.touches[0].clientY - rect.top) * dpr;
          const hit = this.gizmo.hitTest(sx, sy, this.camera, this.cloud);
          if (hit) {
            this.gizmo.startDrag(hit, sx, sy);
            this.camera.markDirty();
            this._dragging = false;
            return;
          }
        }
        this._dragging = true;
        this._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx*dx + dy*dy);
      }
    }, { passive: true, signal });
    c.addEventListener('touchmove', (e) => {
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      if (e.touches.length === 1) {
        if (this.gizmo.isActive()) {
          const sx = (e.touches[0].clientX - rect.left) * dpr;
          const sy = (e.touches[0].clientY - rect.top) * dpr;
          this.gizmo.onDrag(sx, sy, this.camera, this.cloud, this.cloudTransform);
          this.camera.markDirty();
          return;
        }
        if (this._dragging) {
          const dx = (e.touches[0].clientX - this._lastMouse[0]) * dpr;
          const dy = (e.touches[0].clientY - this._lastMouse[1]) * dpr;
          this._lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
          this.camera.rotateHorizontal(-dx * 0.003);
          this.camera.rotateVertical(-dy * 0.15);
        }
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastTouchDist > 0) {
          const mx = ((e.touches[0].clientX + e.touches[1].clientX) * 0.5 - rect.left) * dpr;
          const my = ((e.touches[0].clientY + e.touches[1].clientY) * 0.5 - rect.top)  * dpr;
          this.camera.zoomAt(dist / lastTouchDist, mx, my, this.renderer.width, this.renderer.height);
          document.getElementById('zoom-slider').value = this.camera.zoom;
          document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
        }
        lastTouchDist = dist;
      }
    }, { passive: true, signal });
    c.addEventListener('touchend', () => {
      if (this.gizmo.isActive()) this.gizmo.endDrag();
      this._dragging = false;
    }, { signal });

    c.addEventListener('click', (e) => {
      if (!this.measurement.active || !this.cloud) return;
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top)  * dpr;
      if (this.measurement.onClick(this.cloud, this.camera, this.renderer, sx, sy)) {
        this.camera.markDirty();
        this._showMeasurement();
      }
    }, { signal });

    window.addEventListener('resize', () => this._resize(), { signal });
  }

  async loadFile(file) {
    if (this._loading) { console.warn('Load already in progress'); return; }
    this._loading = true;
    let loader = null;
    let format = 'unknown';
    let readMethod = null;

    if (PLYLoader.isPLYFile(file)) {
      loader = this.plyLoader;
      format = 'PLY';
      readMethod = PLYLoader.readFile;
    } else if (LASLoader.isLASFile(file)) {
      loader = this.lasLoader;
      format = file.name.toLowerCase().endsWith('.laz') ? 'LAZ' : 'LAS';
      readMethod = (f) => _readLASFile(f, format);
    } else if (XYZLoader.isXYZFile(file)) {
      loader = this.xyzLoader;
      format = 'XYZ/TXT';
      readMethod = XYZLoader.readFile;
    } else if (RXPLoader.isRXPFile(file)) {
      loader = this.rxpLoader;
      format = 'RXP';
      readMethod = RXPLoader.readFile;
    } else {
      alert(`Unsupported format.\n\nSupported: .ply, .ply.gz, .las, .laz, .xyz, .txt, .pts, .rxp`);
      return;
    }

    this._abortController.abort();
    this._abortController = new AbortController();
    this._bindInput();

    if (this.cloud) {
      this.cloud.dispose();
      this.cloud = null;
    }
    this.minimap.clearCache();
    this.clearMeasurement();
    this.cloudTransform.reset();
    this.gizmo.setMode('none');

    const loading = document.getElementById('loading');
    loading.classList.add('visible');
    document.getElementById('loading-text').textContent = `Loading ${file.name}…`;

    let buf, data, procResult;
    try {
      if (file.size > 500 * 1024 * 1024) {
        throw new Error(`File troppo grande (${(file.size / 1024 / 1024).toFixed(1)}MB). Limite: 500MB.`);
      }

      buf = await readMethod(file);
      document.getElementById('loading-text').textContent = `Parsing ${format}…`;

      if (format === 'PLY') {
        data = await loader.load(buf);
      } else if (format === 'LAS' || format === 'LAZ') {
        data = await loader.load(buf, format === 'LAZ');
      } else if (format === 'RXP') {
        data = await loader.load(buf);
      } else {
        data = await loader.load(buf);
      }
      buf = null;

      if (!data || !data.count || data.count === 0) {
        throw new Error('Nessun punto valido trovato nel file.');
      }

      document.getElementById('loading-text').textContent = `Building LOD & index…`;

      procResult = await new Promise((resolve, reject) => {
        const blob = new Blob([APP_OCTREE_WORKER], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);

        this._activeWorker = worker;

        const timeout = setTimeout(() => {
          this._activeWorker = null;
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          reject(new Error('Worker timeout: LOD building took too long'));
        }, 60000);

        worker.onmessage = (e) => {
          this._activeWorker = null;
          clearTimeout(timeout);
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data);
        };
        worker.onerror = (e) => {
          this._activeWorker = null;
          clearTimeout(timeout);
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          reject(new Error(e.message || 'Worker error'));
        };
        const t = [data.positions.buffer, data.colors.buffer];
        if (data.intensity) t.push(data.intensity.buffer);
        worker.postMessage({
          positions: data.positions,
          colors: data.colors,
          intensity: data.intensity || null,
          count: data.count,
        }, t);
      });

      if (procResult.positions) {
        const p = procResult.positions;
        for (let i = 0; i < Math.min(100, procResult.count); i++) {
          if (!isFinite(p[i*3]) || !isFinite(p[i*3+1]) || !isFinite(p[i*3+2])) {
            throw new Error('Il file contiene coordinate non valide (NaN/Infinity).');
          }
        }
      }

      this.cloud = new PointCloud({
        count: data.count,
        positions: procResult.positions,
        colors: procResult.colors,
        intensity: procResult.intensity || null,
        hasColor: data.hasColor,
        hasIntensity: data.hasIntensity,
        bounds: procResult.bounds,
        center: procResult.center,
        zMin: procResult.zMin,
        zMax: procResult.zMax,
        intensityMin: procResult.intensityMin,
        intensityMax: procResult.intensityMax,
        octree: procResult.octree,
        pickGrid: procResult.pickGrid,
        pickOffsets: procResult.pickOffsets,
        pickCounts: procResult.pickCounts,
        pickCells: procResult.pickCells,
      });
      data = null;
      procResult = null;

      this.renderer.uploadPointCloud(this.cloud);
      this.camera.setRefCenter(this.cloud.center);
      this._fitView();
      this.renderer.render(this.camera, this.cloud, {
        colorMode: this.colorMode,
        lightDir:  this.getLightDir(),
        ambient:   this.lightAmb,
        shading:   this.shading,
      });

      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
      document.getElementById('rot-offset').value = this.camera.viewOffsetDeg;
      document.getElementById('rot-offset-val').textContent = this.camera.viewOffsetDeg + '°';
      document.getElementById('file-info').innerHTML =
        `${file.name}<br/>${this.cloud.count.toLocaleString()} points<br/>${format}<br/>` +
        (this.cloud.hasColor ? 'RGB ✓  ' : '') +
        (this.cloud.hasIntensity ? 'Intensity ✓' : '');

    } catch (err) {
      console.error(err);
      alert(`Failed to load ${format} file: ${err.message}`);
      this.renderer._ensureResources();
    } finally {
      data = null;
      procResult = null;
      buf = null;
      this._loading = false;
      loading.classList.remove('visible');
    }
  }

  _showMeasurement() {
    const d = this.measurement.getDistances(this.cloud);
    if (!d) return;
    const el = document.getElementById('measure-info');
    el.classList.add('visible');
    el.innerHTML =
      `<div class="title">Measurement</div>` +
      `Horizontal: <b>${d.horizontal.toFixed(3)}</b> m<br/>` +
      `Vertical: <b>${d.vertical.toFixed(3)}</b> m<br/>` +
      `Euclidean: <b>${d.euclidean.toFixed(3)}</b> m<br/>` +
      `<span style="color:#8b949e;font-size:0.7rem">P0 (${d.p0.map(v => v.toFixed(2)).join(', ')}) → P1 (${d.p1.map(v => v.toFixed(2)).join(', ')})</span>`;
  }

  clearMeasurement() {
    this.measurement.clear();
    document.getElementById('measure-info').classList.remove('visible');
    document.getElementById('btn-measure').classList.remove('active');
    document.getElementById('btn-measure').textContent = 'Measure Distance';
    this.measurement.active = false;
  }

  _loop(now) {
    if (this._disposed) return;

    try {
      const dt = (now - this._lastTime) / 1000;
      this._lastTime = now;

      this.camera.update(dt);

      let needsRender = false;
      const hasGeo = !!this.cloud;
      if (hasGeo) {
        const cameraDirty = this.camera.consumeDirty();
        const transformDirty = this.cloudTransform.consumeDirty();
        needsRender = cameraDirty || transformDirty;
      }
      if (this.gizmo.mode !== 'none') needsRender = true;
      let lodCount = this.renderer._lastDrawCount;

      if (needsRender) {
        lodCount = this.renderer.render(this.camera, this.cloud, {
          colorMode: this.colorMode,
          lightDir:  this.getLightDir(),
          ambient:   this.lightAmb,
          shading:   this.shading,
        });

        if ((this._minimapFrame++ & 3) === 0) {
          this.minimap.draw(this.cloud, this.camera, this.renderer.width, this.renderer.height);
        }

        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        this._drawGizmo(this.overlayCtx);
        if (this.gizmo.mode !== 'none' && this.cloud) {
          this.gizmo.draw(this.overlayCtx, this.camera, this.cloud);
        }
        if (this.measurement.points.length) {
          this.measurement.drawOverlay(this.overlayCtx, this.cloud, this.camera, this.renderer);
        }
        if (this.gizmo.mode !== 'none') {
            const ctx = this.overlayCtx;
            ctx.save();
            ctx.fillStyle = 'rgba(13,17,23,0.85)';
            ctx.fillRect(12, 12, 120, 32);
            ctx.fillStyle = '#e6edf3';
            ctx.font = '13px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('Gizmo: ' + this.gizmo.getModeLabel(), 20, 30);
            ctx.restore();
          }
      }

      this._frames++;
      if (now - this._lastFpsTime >= 1000) {
        this._fps = this._frames * 1000 / (now - this._lastFpsTime);
        this._frames = 0;
        this._lastFpsTime = now;
        this.ui.updateStats(this._fps, lodCount, this.cloud ? this.cloud.count : 0);

        if (hasGeo) {
          const views = ['N','E','S','W','NE','SE','SW','NW'];
          const vi = this.camera.viewIndex;
          const bench = this.renderer.getBench();
          this._hudEl.innerHTML =
            `<b>Nuvola</b> 2.5D Viewer<br/>` +
            `View: <b>${views[vi] || vi}</b>  Zoom: <b>${this.camera.zoom.toFixed(1)}×</b><br/>` +
            `FPS: <b>${this._fps.toFixed(0)}</b>  Mode: <b>${this.colorMode}</b><br/>` +
            `<span style="font-size:0.65rem;color:#8b949e">LOD: <b>${bench.frameMs.toFixed(1)}</b>ms</span>`;
        }
      }
    } catch (err) {
      console.error('[_loop] Render loop error:', err);
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._disposed = true;
    this._abortController.abort();
    if (this._activeWorker) {
      this._activeWorker.terminate();
      this._activeWorker = null;
    }
    this.renderer.dispose();
    if (this.cloud) {
      this.cloud.dispose();
      this.cloud = null;
    }
    this.minimap.clearCache();
    if (this.overlayCanvas && this.overlayCanvas.parentNode) {
      this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
      this.overlayCanvas = null;
    }
    this.plyLoader.dispose();
    this.lasLoader.dispose();
    this.xyzLoader.dispose();
    this.rxpLoader.dispose();
  }
}

try {
  window.app = new App();
  window.__NUVOLA_READY = true;
} catch (err) {
  console.error(err);
  document.body.innerHTML =
    '<div style="padding:2rem;font-family:sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh">' +
    '<h1 style="color:#f85149">Nuvola failed to start</h1>' +
    '<p>' + err.message + '</p>' +
    '<p style="color:#8b949e;margin-top:1rem">WebGL2 is required. Serve via HTTP and use a modern browser with GPU acceleration.</p></div>';
}
