/*
===============================================================================
File: minimap.js

Questo modulo definisce la MiniMap, cioe la piccola vista dall'alto della
nuvola di punti. Riceve la cloud, la camera e le dimensioni del renderer, poi
disegna una rappresentazione compatta dell'estensione spaziale dei dati.

Per evitare lavoro inutile a ogni frame, la parte statica della nuvola viene
disegnata una sola volta su un canvas offscreen e riutilizzata come cache. A
ogni aggiornamento vengono ridisegnati solo lo sfondo, la cache e l'indicatore
dinamico della camera: posizione centrale e direzione di osservazione.

Serve come strumento di orientamento: permette all'utente di capire rapidamente
dove si trova nella scena e in quale direzione sta guardando.
===============================================================================
*/

/** Top-down minimap showing a cached point cloud overview and camera view direction. */
export class MiniMap {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // NUOVO: Canvas offscreen per memorizzare i punti statici
    this.bgCanvas = document.createElement('canvas');
    this.bgCtx = this.bgCanvas.getContext('2d');
    this.isCached = false;
  }

  draw(cloud, camera, rendererW, rendererH) {
    if (!cloud) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    
    // 1. Inizializza la cache se non esiste
    if (!this.isCached) {
      this.bgCanvas.width = w;
      this.bgCanvas.height = h;
      this._cachePointCloud(cloud, w, h);
      this.isCached = true;
    }

    // 2. Disegna lo sfondo e la nuvola cachata (operazione istantanea)
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.bgCanvas, 0, 0);

    // 3. Disegna SOLO la telecamera dinamica
    const b = cloud.bounds;
    const spanX = b.max[0] - b.min[0] || 1;
    const spanY = b.max[1] - b.min[1] || 1;
    const pad = 8;
    const scale = Math.min((w - pad*2) / spanX, (h - pad*2) / spanY);

    const toMap = (x, y) => [
      pad + (x - b.min[0]) * scale,
      h - pad - (y - b.min[1]) * scale,
    ];

    const [cx, cy] = toMap(cloud.center[0], cloud.center[1]);
    ctx.strokeStyle = '#3fb950';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI*2);
    ctx.stroke();

    const angle = camera._rotAngle - camera.viewOffsetRad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(angle) * 12, cy - Math.cos(angle) * 12);
    ctx.stroke();
  }

  // NUOVO: Metodo isolato per disegnare i punti una volta sola
  _cachePointCloud(cloud, w, h) {
    const ctx = this.bgCtx;
    const b = cloud.bounds;
    const spanX = b.max[0] - b.min[0] || 1;
    const spanY = b.max[1] - b.min[1] || 1;
    const pad = 8;
    const scale = Math.min((w - pad*2) / spanX, (h - pad*2) / spanY);

    const toMap = (x, y) => [
      pad + (x - b.min[0]) * scale,
      h - pad - (y - b.min[1]) * scale,
    ];

    const [x0, y0] = toMap(b.min[0], b.min[1]);
    const [x1, y1] = toMap(b.max[0], b.max[1]);
    ctx.strokeStyle = '#30363d';
    ctx.strokeRect(x0, y1, x1 - x0, y0 - y1);

    ctx.fillStyle = 'rgba(88,166,255,0.35)';
    const step = Math.max(1, Math.floor(cloud.count / 800));
    const p = cloud.positions;
    if (!p) return;
    for (let i = 0; i < cloud.count; i += step) {
      const [mx, my] = toMap(p[i*3], p[i*3+1]);
      ctx.fillRect(mx, my, 1, 1);
    }
  }
}
