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
import { LASTilingLoader } from '../file_loader/las-tiling-loader.js';
import { decompressLAZ }   from '../file_loader/laz-decompressor.js';
import { XYZLoader }       from '../file_loader/xyz-loader.js';
import { RXPLoader }       from '../file_loader/rxp-loader.js';
import { E57Loader }        from '../file_loader/e57-loader.js';
import { PointCloud }      from '../model/PointCloud.js';
import { CameraController } from '../potree/CameraController.js';
import { CloudTransform }  from '../model/transform.js';
import { Gizmo }           from '../view/gizmo.js';
import { Renderer }        from '../rendering-app/renderer.js';
import { ThreeOverlayRenderer } from '../rendering-app/ThreeOverlayRenderer.js';

import { MeasurementTool } from '../view/measurements.js';
import { MiniMap }         from '../view/minimap.js';
import { UIController }    from '../view/ui-controller.js';
import { FPSControls }     from '../view/fps-controls.js?v=3';
import { VRMode }          from '../view/vr-mode.js';
import * as THREE from 'three';
import { PotreeLoader }    from '../potree/PotreeLoader.js';
import { bindInput }        from './input.js';


/**
 * Read a LAS/LAZ file: transparently decompresses LAZ before returning the buffer.
 * For LAS files > 2GB, returns a File reference for chunked reading.
 * @param {File} file
 * @param {string} format 'LAS' or 'LAZ'
 * @returns {Promise<ArrayBuffer|{file, type}>}
 */
async function _readLASFile(file, format) {
  if (format === 'LAZ') {
    // Per file LAZ, verifica la dimensione prima di caricare
    // Il limite pratico è circa 500MB compressi (che diventano ~1.5GB decompressi)
    const MAX_LAZ_SIZE = 500 * 1024 * 1024; // 500MB
    
    if (file.size > MAX_LAZ_SIZE) {
      throw new Error(
        `File LAZ troppo grande (${(file.size / 1024 / 1024).toFixed(1)}MB). ` +
        `Limite: ${MAX_LAZ_SIZE / 1024 / 1024}MB compressi.\n\n` +
        `Opzioni:\n` +
        `1. Decomprimi offline: laszip -i ${file.name} -o ${file.name.replace('.laz', '.las')}\n` +
        `2. Converti in formato streaming con las2potree\n` +
        `3. Usa un file LAS non compresso`
      );
    }
    
    const buf = await file.arrayBuffer();
    try {
      return await decompressLAZ(buf);
    } catch (err) {
      throw new Error('LAZ decompression failed: ' + err.message);
    }
  }
  // LAS non compresso
  if (file.size >= 2 * 1024 * 1024 * 1024) {
    // File grande (>=2GB): usa chunked reading
    return { file, type: 'las-file' };
  } else {
    // File piccolo (<2GB): carica in memoria
    return await file.arrayBuffer();
  }
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
  var cb=[[bounds[0],bounds[1],bounds[2],mx,my,mz],[bounds[0],bounds[1],mz,mx,my,bounds[5]],[bounds[0],my,bounds[2],mx,bounds[4],mz],[bounds[0],my,mz,mx,bounds[4],bounds[5]],[mx,bounds[1],bounds[2],bounds[3],my,mz],[mx,bounds[1],mz,bounds[3],my,bounds[5]],[mx,my,bounds[2],bounds[3],bounds[4],mz],[mx,my,mz,bounds[3],bounds[4],bounds[5]]];
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

    this.threeCanvas = document.createElement('canvas');
    this.threeCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;width:100%;height:100%';
    document.getElementById('main').appendChild(this.threeCanvas);
    this.threeOverlay = new ThreeOverlayRenderer(this.threeCanvas);

    this.plyLoader = new PLYLoader();
    this.lasLoader = new LASLoader();
    this.lasTilingLoader = new LASTilingLoader();
    this.xyzLoader = new XYZLoader();
    this.rxpLoader = new RXPLoader();
    this.e57Loader = new E57Loader();

    this.renderer    = new Renderer(this.canvas);
    this.camera      = new CameraController();
    this.fpsControls = new FPSControls(this.canvas, this.camera);
    this.measurement = new MeasurementTool();
    this.minimap     = new MiniMap(document.getElementById('minimap-canvas'));
    this.ui          = new UIController(this);
    this.cloudTransform = new CloudTransform();
    this.gizmo         = new Gizmo();
    this.vrMode        = new VRMode(this);

    this.cloud        = null;
    this.colorMode    = 'rgb';
    this.lightAz      = 315;
    this.lightEl      = 45;
    this.lightAmb     = 0.25;
    this.shading      = true;

    this.enableRangeDecimation = true;
    this.minPointsForDetail = 50000;
    this.maxDistanceRatio = 1.0;
    this._pointBudget = 200000;
    this._autoScaleBudget = true;
    this.pointSize = 3.0;
    this.pointSizeType = 1;
    this.sketchfabOpacity = 0;
    this.dreamy = 0;
    this.skyEnabled = true;
    this.skyColorTop = [0.4, 0.6, 0.9];
    this.skyColorBottom = [0.7, 0.85, 1.0];

    this._fps = 0;
    this._frames = 0;
    this._lastFpsTime = performance.now();
    this._lastTime    = performance.now();

    this._profile = { selectMs: 0, rebuildMs: 0, cpuMs: 0, pointMs: 0, lightMs: 0, totalMs: 0 };
    this._dragging  = false;
    this._dragButton = -1;
    this._tilingMode = false;
    
    // Streaming
    this._streamPeer = null;
    this._streaming = false;
    this._streamQuality = 0.5;
    this._streamLoop = null;
    this._lastMouse = [0, 0];
    this._minimapFrame = 0;
    this._hudEl = document.getElementById('hud');

    this._disposed = false;
    this._loading = false;
    this._activeWorker = null;
    this._potreeLoader = null;
    this._abortController = new AbortController();

    bindInput(this);
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

  get pointBudget() {
    return this._pointBudget;
  }

  set pointBudget(val) {
    this._pointBudget = val;
    if (this.cloud) {
      this.cloud.pointBudget = val;
    }
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
      this._updateBudgetSlider();
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
    this.threeCanvas.width  = this.renderer.width;
    this.threeCanvas.height = this.renderer.height;
    this.threeCanvas.style.width  = w + 'px';
    this.threeCanvas.style.height = h + 'px';
    this.threeOverlay.setSize(this.renderer.width, this.renderer.height);
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

  async loadPotreeDataset(url) {
    if (this._loading) { console.warn('Load already in progress'); return; }
    this._loading = true;

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
    document.getElementById('loading-text').textContent = 'Loading Potree dataset…';

    try {
      if (this._potreeLoader) this._potreeLoader.dispose();
      const loader = new PotreeLoader();
      this._potreeLoader = loader;
      const geometry = await loader.load(url);

      document.getElementById('loading-text').textContent = 'Preparing…';

      const bb = geometry.boundingBox;
      const _center = new THREE.Vector3();
      bb.getCenter(_center);
      const center = [_center.x, _center.y, _center.z];

      const hasIntensity = geometry.attributes.some(a => a.name === 'INTENSITY');
      const hasClassification = geometry.attributes.some(a => a.name === 'CLASSIFICATION');
      const data = {
        count: geometry.totalPoints || 0,
        positions: null,
        colors: null,
        intensity: null,
        hasColor: geometry.attributes.some(a => a.name === 'RGBA' || a.name === 'RGB'),
        hasIntensity,
        hasClassification,
        bounds: { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] },
        center,
        zMin: bb.min.z,
        zMax: bb.max.z,
        intensityMin: 0,
        intensityMax: hasIntensity ? 1 : 0,
        octreeGeometry: geometry,
      };

      this.cloud = new PointCloud(data);
      this.cloud.renderer = this.renderer;
      if (this.cloud.lru) {
        this.cloud.lru.setGPUBudget(this.renderer.detectedVRAM_MB);
      }
      const autoBudget = this._autoScaleBudget
        ? Math.floor(this.renderer.batchCapacity * 0.6)
        : this._pointBudget;
      this.cloud.pointBudget = autoBudget;
      if (data.bounds) {
        const dx = data.bounds.max[0] - data.bounds.min[0];
        const dy = data.bounds.max[1] - data.bounds.min[1];
        const dz = data.bounds.max[2] - data.bounds.min[2];
        const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.cloud.maxVisibleDistance = Math.max(diag * 0.3, 50);
      }

      this.camera.setRefCenter(this.cloud.center);
      this._fitView();
      this.camera.markDirty();

      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
      const rotOffset2 = document.getElementById('rot-offset');
      if (rotOffset2) rotOffset2.value = this.camera.viewOffsetDeg;
      const rotOffsetVal2 = document.getElementById('rot-offset-val');
      if (rotOffsetVal2) rotOffsetVal2.textContent = this.camera.viewOffsetDeg + '°';
      document.getElementById('file-info').innerHTML =
        `${url}<br/>${this.cloud.count.toLocaleString()} points<br/>Potree v2.0 (streaming)<br/>` +
        (this.cloud.hasColor ? 'RGB ✓  ' : '') +
        (this.cloud.hasIntensity ? 'Intensity ✓  ' : '') +
        (this.cloud.hasClassification ? 'Class. ✓' : '');
      this._updateClassificationButton();

      this._streamStartTime = performance.now();

    } catch (err) {
      console.error(err);
      alert(`Failed to load Potree dataset: ${err.message}`);
      this.renderer.restoreGPUState();
    } finally {
      this._loading = false;
      loading.classList.remove('visible');
    }
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
    } else if (E57Loader.isE57File(file)) {
      loader = this.e57Loader;
      format = 'E57';
      readMethod = (f) => f;
    } else {
      alert(`Unsupported format.\n\nSupported: .ply, .ply.gz, .las, .laz, .xyz, .txt, .pts, .rxp, .e57`);
      return;
    }

    this._abortController.abort();
    this._abortController = new AbortController();
    bindInput(this);

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
      if (format !== 'LAS' && format !== 'LAZ' && format !== 'E57' && file.size > 4 * 1024 * 1024 * 1024) {
        throw new Error(`File troppo grande (${(file.size / 1024 / 1024).toFixed(1)}MB). Limite: 4GB.`);
      }

      buf = await readMethod(file);
      document.getElementById('loading-text').textContent = `Parsing ${format}…`;

      if (format === 'PLY') {
        data = await loader.load(buf);
      } else if (format === 'LAS' || format === 'LAZ') {
        // Per file LAS grandi (>2GB), usa il tiling loader
        if (format === 'LAS' && file.size >= 2 * 1024 * 1024 * 1024) {
          document.getElementById('loading-text').textContent = `Initializing tiling system…`;
          await this.lasTilingLoader.init(file, (progress) => {
            document.getElementById('loading-text').textContent = 
              `Initializing tiling system… ${(progress * 100).toFixed(0)}%`;
          });
          
          // Carica i chunk iniziali
          document.getElementById('loading-text').textContent = `Loading chunks…`;
          const visibleChunks = this.lasTilingLoader.getVisibleChunks(this.camera, this.renderer.width, this.renderer.height);
          await this.lasTilingLoader.loadVisibleChunks(visibleChunks, (progress) => {
            document.getElementById('loading-text').textContent = 
              `Loading chunks… ${(progress * 100).toFixed(0)}%`;
          });
          
          // Combina i chunk in un unico dataset per ora
          // In futuro si può fare un rendering multi-chunk
          const loadedChunks = this.lasTilingLoader.getLoadedChunks();
          let totalCount = 0;
          let totalPositions = 0;
          let totalColors = 0;
          let totalIntensity = 0;
          
          for (const chunk of loadedChunks) {
            totalCount += chunk.count;
            totalPositions += chunk.positions.length;
            totalColors += chunk.colors.length;
            totalIntensity += chunk.intensity.length;
          }
          
          const positions = new Float32Array(totalPositions);
          const colors = new Uint8Array(totalColors);
          const intensity = new Float32Array(totalIntensity);
          
          let posOffset = 0;
          let colOffset = 0;
          let intOffset = 0;
          let minI = Infinity, maxI = -Infinity;
          
          for (const chunk of loadedChunks) {
            positions.set(chunk.positions, posOffset);
            colors.set(chunk.colors, colOffset);
            intensity.set(chunk.intensity, intOffset);
            
            posOffset += chunk.positions.length;
            colOffset += chunk.colors.length;
            intOffset += chunk.intensity.length;
            
            if (chunk.minI < minI) minI = chunk.minI;
            if (chunk.maxI > maxI) maxI = chunk.maxI;
          }
          
          data = {
            positions: positions,
            colors: colors,
            intensity: intensity,
            count: totalCount,
            hasColor: true,
            hasIntensity: true
          };
          
          this._tilingMode = true;
        } else {
          // LASLoader.load() si aspetta:
          // - Per LAS piccolo: ArrayBuffer
          // - Per LAS grande: { file, type: 'las-file' }
          // - Per LAZ: il buffer è già decompresso, quindi isCompressed=false
          data = await loader.load(buf, false);
          this._tilingMode = false;
        }
      } else if (format === 'RXP') {
        data = await loader.load(buf);
      } else if (format === 'E57') {
        if (file.size > 2 * 1024 * 1024 * 1024) {
          data = await loader.loadLargeFile(buf);
        } else {
          if (buf instanceof File || buf instanceof Blob) {
            buf = await buf.arrayBuffer();
          }
          data = await loader.load(buf);
        }
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
      if (this.cloud.octreeGeometry) {
        if (this.cloud.lru) {
          this.cloud.lru.setGPUBudget(this.renderer.detectedVRAM_MB);
        }
        const autoBudget = this._autoScaleBudget
          ? Math.floor(this.renderer.batchCapacity * 0.6)
          : this._pointBudget;
        this.cloud.pointBudget = autoBudget;
        if (this.cloud.bounds) {
          const dx = this.cloud.bounds.max[0] - this.cloud.bounds.min[0];
          const dy = this.cloud.bounds.max[1] - this.cloud.bounds.min[1];
          const dz = this.cloud.bounds.max[2] - this.cloud.bounds.min[2];
          const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
          this.cloud.maxVisibleDistance = Math.max(diag * 0.3, 50);
        }
      }
      this._fitView();
      this.renderer.render(this.camera, this.cloud, {
        colorMode: this.colorMode,
        lightDir:  this.getLightDir(),
        ambient:   this.lightAmb,
        shading:   this.shading,
        useCloudTransform: this.gizmo.mode !== 'none',
        cloudRot: this.cloudTransform.rotation,
        cloudScale: this.cloudTransform.scale,
        pointSize: this.pointSize,
        pointSizeType: this.pointSizeType,
        sketchfabOpacity: this.sketchfabOpacity,
        dreamy: this.dreamy,
        skyEnabled: this.skyEnabled,
        skyColorTop: this.skyColorTop,
        skyColorBottom: this.skyColorBottom,
      });

      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
      const rotOffset = document.getElementById('rot-offset');
      if (rotOffset) rotOffset.value = this.camera.viewOffsetDeg;
      const rotOffsetVal = document.getElementById('rot-offset-val');
      if (rotOffsetVal) rotOffsetVal.textContent = this.camera.viewOffsetDeg + '°';
      document.getElementById('file-info').innerHTML =
        `${file.name}<br/>${this.cloud.count.toLocaleString()} points<br/>${format}<br/>` +
        (this.cloud.hasColor ? 'RGB ✓  ' : '') +
        (this.cloud.hasIntensity ? 'Intensity ✓' : '');
      this._updateBudgetSlider();
      this._updateClassificationButton();

    } catch (err) {
      console.error(err);
      alert(`Failed to load ${format} file: ${err.message}`);
      this.renderer.restoreGPUState();
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

      this.fpsControls.update(dt);
      this.camera.update(dt);

      let needsRender = false;
      const hasGeo = !!this.cloud;
      if (hasGeo) {
        const cameraDirty = this.camera.consumeDirty();
        const transformDirty = this.cloudTransform.consumeDirty();
        const nodeLoaded = this.cloud.consumeNeedsRender();
        if (cameraDirty && this.cloud && this.cloud.octreeGeometry) {
          this.cloud.visibilitySystem.invalidateCache();
        }
        needsRender = cameraDirty || transformDirty || nodeLoaded;
      }
      if (this.gizmo.mode !== 'none') needsRender = true;
      let lodCount = this.renderer._lastDrawCount;

      if (needsRender) {
        lodCount = this.renderer.render(this.camera, this.cloud, {
          colorMode: this.colorMode,
          lightDir:  this.getLightDir(),
          ambient:   this.lightAmb,
          shading:   this.shading,
          useCloudTransform: this.gizmo.mode !== 'none',
          cloudRot: this.cloudTransform.rotation,
          cloudScale: this.cloudTransform.scale,
          pointSize: this.pointSize,
          pointSizeType: this.pointSizeType,
          sketchfabOpacity: this.sketchfabOpacity,
          dreamy: this.dreamy,
          skyEnabled: this.skyEnabled,
          skyColorTop: this.skyColorTop,
          skyColorBottom: this.skyColorBottom,
        });

        if (this.cloud && this.cloud.lru) {
          this.cloud.lru.freeMemory();
        }

        // Quando lo streaming è attivo, salta tutti i calcoli non essenziali
        if (!this._streaming) {
          if ((this._minimapFrame++ & 3) === 0) {
            this.minimap.draw(this.cloud, this.camera, this.renderer.width, this.renderer.height);
          }

          this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
          this._drawGizmo(this.overlayCtx);
          if (this.gizmo.mode !== 'none' && this.cloud) {
            this.gizmo.draw(this.overlayCtx, this.camera, this.cloud);
          }
          if (this.measurement.points.length) {
            this.measurement.updateMeshes(this.cloud, this.threeOverlay);
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

          this.threeOverlay.render(this.camera);
        }
      }

      this._frames++;
      if (now - this._lastFpsTime >= 1000) {
        this._fps = this._frames * 1000 / (now - this._lastFpsTime);
        this._frames = 0;
        this._lastFpsTime = now;
        
        // Quando lo streaming è attivo, salta anche l'aggiornamento HUD
        if (!this._streaming) {
          this.ui.updateStats(this._fps, lodCount, this.cloud ? this.cloud.count : 0);

          if (hasGeo) {
            const views = ['N','E','S','W','NE','SE','SW','NW'];
            const vi = this.camera.viewIndex;
            const camLabel = this.camera.activeMode === 'fps'
              ? `Drone`
              : `${views[vi] || vi}`;
            this._hudEl.innerHTML =
              `<b>${camLabel}</b> · ${this._fps.toFixed(0)} FPS<br/>` +
              `${this.cloud.count.toLocaleString()} points`;
          }
        }
      }
    } catch (err) {
      console.error('[_loop] Render loop error:', err);
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  _updateClassificationButton() {
    const btn = document.querySelector('.mode-btns button[data-mode="classification"]');
    if (!btn) return;
    const hasClass = this.cloud && this.cloud.hasClassification;
    btn.disabled = !hasClass;
    btn.style.opacity = hasClass ? '' : '0.35';
    btn.style.pointerEvents = hasClass ? '' : 'none';
    if (!hasClass && this.colorMode === 'classification') {
      this.colorMode = 'rgb';
      document.querySelectorAll('.mode-btns button').forEach(b => b.classList.remove('active'));
      const rgbBtn = document.querySelector('.mode-btns button[data-mode="rgb"]');
      if (rgbBtn) rgbBtn.classList.add('active');
    }
  }

  dispose() {
    this._disposed = true;
    this._abortController.abort();
    this.fpsControls.dispose();
    this.vrMode.dispose();
    this.stopStreaming();
    if (this._activeWorker) {
      this._activeWorker.terminate();
      this._activeWorker = null;
    }
    this.renderer.dispose();
    this.threeOverlay.dispose();
    if (this.cloud) {
      this.cloud.dispose();
      this.cloud = null;
    }
    this.minimap.clearCache();
    if (this.overlayCanvas && this.overlayCanvas.parentNode) {
      this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
      this.overlayCanvas = null;
    }
    if (this.threeCanvas && this.threeCanvas.parentNode) {
      this.threeCanvas.parentNode.removeChild(this.threeCanvas);
      this.threeCanvas = null;
    }
    this.plyLoader.dispose();
    this.lasLoader.dispose();
    this.xyzLoader.dispose();
    this.rxpLoader.dispose();
    this.e57Loader.dispose();
    if (this._potreeLoader) {
      this._potreeLoader.dispose();
      this._potreeLoader = null;
    }
  }

  _updateBudgetSlider() {
    const budget = this.cloud ? this.cloud.visibilitySystem.pointBudget : this._pointBudget;
    const slider = document.getElementById('point-budget');
    const val = document.getElementById('point-budget-val');
    const autoChk = document.getElementById('chk-auto-budget');
    if (slider) slider.value = budget;
    const label = budget >= 1e6 ? (budget / 1e6).toFixed(1) + 'M' : Math.floor(budget / 1000) + 'k';
    if (val) val.textContent = label;
    if (autoChk) autoChk.checked = this._autoScaleBudget;
  }

  async toggleVR() {
    if (this.vrMode.isActive) {
      await this.vrMode.endSession();
      document.getElementById('btn-vr').textContent = 'Enter VR';
      document.getElementById('btn-vr').classList.remove('active');
    } else {
      try {
        await this.vrMode.startSession();
        document.getElementById('btn-vr').textContent = 'Exit VR';
        document.getElementById('btn-vr').classList.add('active');
      } catch (err) {
        alert('Impossibile avviare la modalità VR: ' + err.message);
      }
    }
  }

  async startStreaming() {
    if (this._streaming) return;
    
    const peerId = '1';
    console.log('[Stream] Inizializzazione PeerJS con ID:', peerId);
    
    this._streamPeer = new Peer(peerId, {
      host: window.location.hostname,
      port: 3001,
      path: '/peerjs',
      debug: 2
    });
    
    this._streamPeer.on('open', (id) => {
      console.log('[Stream] ✓ PeerJS pronto, ID:', id);
      this._streaming = true;
      
      const btn = document.getElementById('btn-stream');
      if (btn) {
        btn.textContent = 'Stop Streaming';
        btn.classList.add('active');
      }
      
      const info = document.getElementById('stream-info');
      if (info) {
        info.textContent = 'Streaming attivo ✓ (WebRTC 60fps)';
        info.style.color = '#34c759';
      }
    });
    
    this._streamPeer.on('connection', (conn) => {
      console.log('[Stream] ✓ Connessione dati ricevuta da client, ID:', conn.connectionId);
      
      conn.on('open', () => {
        console.log('[Stream] ✓ Connessione dati aperta, ID:', conn.connectionId);
      });
      
      conn.on('data', (data) => {
        console.log('[Stream] ✓ Dati ricevuti su connessione', conn.connectionId, ':', data);
        if (data.type === 'signal') {
          console.log('[Stream] Applicando segnale:', data);
          if (data.yaw) {
            console.log('[Stream] Yaw:', data.yaw);
            this.camera._rotAngle += data.yaw;
          }
          if (data.pitch) {
            console.log('[Stream] Pitch:', data.pitch);
            this.camera.rotationXDeg += data.pitch * 180 / Math.PI;
            this.camera.rotationXDeg = Math.max(-89, Math.min(89, this.camera.rotationXDeg));
          }
          if (data.zoom) {
            console.log('[Stream] Zoom:', data.zoom);
            this.camera.zoom += data.zoom * 0.1;
            this.camera.zoom = Math.max(0.1, Math.min(10, this.camera.zoom));
          }
          if (data.panX) {
            console.log('[Stream] PanX:', data.panX);
            this.camera.panX += data.panX * 50;
          }
          if (data.panY) {
            console.log('[Stream] PanY:', data.panY);
            this.camera.panY += data.panY * 50;
          }
          this.camera.markDirty();
          console.log('[Stream] ✓ Camera aggiornata, markDirty() chiamato');
        }
        else if (data.type === 'reset') {
          console.log('[Stream] Reset view ricevuto');
          this.camera._rotAngle = 0;
          this.camera.rotationXDeg = 0;
          this.camera.zoom = 1;
          this.camera.panX = 0;
          this.camera.panY = 0;
          this.camera.markDirty();
        }
        else if (data.type === 'ping') {
          console.log('[Stream] Ping ricevuto dal client su connessione', conn.connectionId);
        }
      });
      
      conn.on('close', () => {
        console.log('[Stream] Connessione dati chiusa, ID:', conn.connectionId);
      });
      
      conn.on('error', (err) => {
        console.error('[Stream] Errore connessione dati:', err);
      });
    });
    
    this._streamPeer.on('call', (call) => {
      console.log('[Stream] Client in chiamata');
      
      const mediaStream = this.canvas.captureStream(60);
      mediaStream.getTracks().forEach((track, i) => {
        console.log(`[Stream] Track ${i}:`, track.kind, track.label, 'enabled:', track.enabled, 'readyState:', track.readyState);
      });

      call.answer(mediaStream);
      console.log('[Stream] Risposta inviata con media stream');
      
      call.on('stream', (remoteStream) => {
        console.log('[Stream] Stream remoto ricevuto');
      });
      
      call.on('close', () => {
        console.log('[Stream] Client disconnesso');
      });
      
      call.on('error', (err) => {
        console.error('[Stream] Errore chiamata:', err);
      });
    });
    
    this._streamPeer.on('error', (err) => {
      console.error('[Stream] Errore PeerJS:', err);
      const info = document.getElementById('stream-info');
      if (info) {
        info.textContent = 'Errore: ' + err.type;
        info.style.color = '#ff3b30';
      }
    });
  }

  stopStreaming() {
    if (!this._streaming) return;
    
    this._streaming = false;
    
    if (this._streamPeer) {
      this._streamPeer.destroy();
      this._streamPeer = null;
    }
    
    const btn = document.getElementById('btn-stream');
    if (btn) {
      btn.textContent = 'Start Streaming';
      btn.classList.remove('active');
    }
    
    const info = document.getElementById('stream-info');
    if (info) {
      info.textContent = 'Stream fermato';
      info.style.color = '';
    }
    
    console.log('[Stream] Streaming fermato');
  }
}

try {
  window.app = new App();
  window.__NUVOLA_READY = true;
  
  // Carica automaticamente points.ply all'avvio
  (async () => {
    try {
      const response = await fetch('./points.ply');
      if (response.ok) {
        const blob = await response.blob();
        const file = new File([blob], 'points.ply', { type: 'application/octet-stream' });
        await window.app.loadFile(file);
      }
    } catch (err) {
      console.warn('Auto-load points.ply failed:', err.message);
    }
  })();
} catch (err) {
  console.error(err);
  document.body.innerHTML =
    '<div style="padding:2rem;font-family:sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh">' +
    '<h1 style="color:#f85149">Nuvola failed to start</h1>' +
    '<p>' + err.message + '</p>' +
    '<p style="color:#8b949e;margin-top:1rem">WebGL2 is required. Serve via HTTP and use a modern browser with GPU acceleration.</p></div>';
}
