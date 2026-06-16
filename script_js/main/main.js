import { PLYLoader }       from '../file_loader/ply-loader.js';
import { LASLoader }       from '../file_loader/las-loader.js';
import { decompressLAZ }   from '../file_loader/laz-decompressor.js';
import { XYZLoader }       from '../file_loader/xyz-loader.js';
import { RXPLoader }       from '../file_loader/rxp-loader.js';
import { PointCloud }      from '../model/PointCloud.js';
import { GaussianCloud }   from '../model/gaussian-cloud.js';
import { Camera }          from '../model/camera.js';
import { FPSCamera }       from '../model/fps-camera.js';
import { CloudTransform }  from '../model/transform.js';
import { Gizmo }           from '../view/gizmo.js';
import { Renderer }        from '../rendering-app/renderer.js';
import { MeasurementTool } from '../view/measurements.js';
import { MiniMap }         from '../view/minimap.js';
import { UIController }    from '../view/ui-controller.js';
import { TileManager }     from '../model/TileManager.js';

class App {
  constructor() {
    this.canvas = document.getElementById('glcanvas');

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;width:100%;height:100%';
    document.getElementById('main').appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.plyLoader = new PLYLoader({ maxPoints: 50000000 });
    this.lasLoader = new LASLoader({ maxPoints: 50000000 });
    this.xyzLoader = new XYZLoader();
    this.rxpLoader = new RXPLoader();

    this.renderer    = new Renderer(this.canvas);
    this.camera      = new Camera();
    this.fpsCamera   = new FPSCamera();
    this.measurement = new MeasurementTool();
    this.minimap     = new MiniMap(document.getElementById('minimap-canvas'));
    this.ui          = new UIController(this);
    this.cloudTransform = new CloudTransform();
    this.gizmo         = new Gizmo();
    this.tileManager  = new TileManager();

    this.cloud        = null;
    this.gaussianCloud = null;
    this.gaussianMode  = false;
    this.colorMode    = 'rgb';
    this.lightAz      = 315;
    this.lightEl      = 45;
    this.lightAmb     = 0.25;
    this.shading      = true;
    this.fpsMode      = false;
    this.gaussianDensity = 1.0;

    this.enableRangeDecimation = true;
    this.minPointsForDetail = 1000000;
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

    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
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

  _getViewDir() {
    const angle = this.camera._rotAngle;
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
      defaultZoom: this.camera._defaultZoom,
    };
  }

  _fitView() {
    const target = this.gaussianMode ? this.gaussianCloud : this.cloud;
    if (!target) return;
    const w = this.renderer.width, h = this.renderer.height;
    if (target.bounds && target.center) {
      this.camera.fitToBounds(target, w, h, this.camera._targetAngle);
    } else {
      this.camera.fitToBounds(this.cloud || { bounds: {min:[0,0,0],max:[1,1,1]}, center:[0,0,0] }, w, h, this.camera._targetAngle);
    }
    document.getElementById('zoom-slider').value = this.camera.zoom;
    document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    this.camera.markDirty();
  }

  _drawGizmo(ctx) {
    if (!this.cloud) return;
    const w = this.overlayCanvas.width, h = this.overlayCanvas.height;
    const cam = this.camera;
    const ref = cam._refCenter;

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
    if (this.cloud || this.gaussianCloud) this._fitView();
    this._updateViewButtons();
  }

  toggleFPSMode() {
    this.fpsMode = !this.fpsMode;
    const hudEl = document.getElementById('hud');
    if (this.fpsMode) {
      hudEl.style.display = 'none';
      document.body.style.cursor = 'grab';
      document.getElementById('control-title-iso').textContent = 'FPS Mode:';
      document.getElementById('control-iso').style.display = 'none';
      document.getElementById('control-fps').style.display = 'inline';
      document.getElementById('keyboard-iso').style.display = 'none';
      document.getElementById('keyboard-fps').style.display = 'inline';

      this.measurement.active = false;
      document.getElementById('btn-measure').classList.remove('active');
      document.getElementById('btn-measure').textContent = 'Measure Distance';
      this.gizmo.setMode('none');

      if (this.cloud) {
        const center = this.cloud.center;
        const b = this.cloud.bounds;
        const span = Math.max(
          b.max[0] - b.min[0],
          b.max[1] - b.min[1],
          1
        );
        const height = b.max[2] - b.min[2] || span * 0.5;
        const dist = span * 1.2;
        this.fpsCamera.position = [
          center[0] - dist * 0.5,
          center[1] + height * 0.5 + dist * 0.4,
          center[2] + dist * 0.5,
        ];
        this.fpsCamera.pitch = -Math.PI / 5;
        this.fpsCamera.yaw = Math.PI / 4;
        this.fpsCamera._velocity = [0, 0, 0];
        this.fpsCamera.markDirty();
      } else {
        this.fpsCamera.reset();
      }
    } else {
      hudEl.style.display = 'block';
      document.body.style.cursor = 'default';
      document.getElementById('control-title-iso').textContent = 'Isometric Mode:';
      document.getElementById('control-iso').style.display = 'inline';
      document.getElementById('control-fps').style.display = 'none';
      document.getElementById('keyboard-iso').style.display = 'inline';
      document.getElementById('keyboard-fps').style.display = 'none';
      if (this.cloud) this._fitView();
    }
  }

  toggleGaussianMode() {
    this.gaussianMode = !this.gaussianMode;
    const cb = document.getElementById('chk-gaussian');
    if (cb) cb.checked = this.gaussianMode;

    if (this.gaussianMode) {
      if (this.fpsMode) this.toggleFPSMode();
      if (this.cloud && !this.gaussianCloud) {
        this.gaussianCloud = GaussianCloud.fromPointCloud(this.cloud);
        this.renderer.uploadGaussianCloud(this.gaussianCloud);
      }
    }
    this.camera.markDirty();
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
    this.renderer._uniformState = {};
    this.renderer._lightState = {};
    if (this.cloud) this._fitView();
    this.camera.markDirty();
    this.fpsCamera.markDirty();
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
        if (this.cloud || this.gaussianCloud) this._fitView();
      };
      grid.appendChild(btn);
    });
  }

  _bindInput() {
    const c = this.canvas;

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
    });
    window.addEventListener('mousemove', (e) => {
      if (this._dragging && e.which === 0) this._dragging = false;
    });
    window.addEventListener('mouseup', (e) => {
      if (this.gizmo.isActive()) this.gizmo.endDrag();
      if (e.button === this._dragButton) this._dragging = false;
    });
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
      if (this.fpsMode) return;
      const dx = (e.clientX - this._lastMouse[0]) * dpr;
      const dy = (e.clientY - this._lastMouse[1]) * dpr;
      this._lastMouse = [e.clientX, e.clientY];
      if (this._dragButton === 2) {
        this.camera.panX += dx;
        this.camera.panY += dy;
        this.camera.markDirty();
      } else {
        this.camera.rotateHorizontal(-dx * 0.003);
        this.camera.rotateVertical(dy * 0.15);
      }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.fpsMode) return;
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top)  * dpr;
      const factor = e.deltaY > 0 ? 0.85 : 1.15;
      this.camera.zoomAt(factor, sx, sy, this.renderer.width, this.renderer.height);
      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    }, { passive: false });

    let lastClickTime = 0;
    c.addEventListener('dblclick', (e) => {
      if (this.fpsMode) return;
      e.preventDefault();
      this.camera.reset();
      if (this.cloud) this._fitView();
      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
    });

    window.addEventListener('keydown', (e) => {
      if (!this.cloud && !this.gaussianCloud) return;
      const panSpeed = 20;

      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        this.toggleFPSMode();
        return;
      }

      if (this.gaussianMode) {
        if (e.key.toLowerCase() === 'r') {
          e.preventDefault();
          this.camera.reset();
          this._fitView();
          document.getElementById('zoom-slider').value = this.camera.zoom;
          document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
        }
        return;
      }

      if (this.fpsMode) return;

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
    });

    let lastTouchDist = 0;
    c.addEventListener('touchstart', (e) => {
      if (this.fpsMode) return;
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
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (this.fpsMode) return;
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
          this.camera.rotateVertical(dy * 0.15);
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
    }, { passive: true });
    c.addEventListener('touchend', () => {
      if (this.gizmo.isActive()) this.gizmo.endDrag();
      this._dragging = false;
    });

    c.addEventListener('click', (e) => {
      if (this.fpsMode) return;
      if (!this.measurement.active || !this.cloud) return;
      const rect = c.getBoundingClientRect();
      const dpr = this.renderer.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top)  * dpr;
      if (this.measurement.onClick(this.cloud, this.camera, this.renderer, sx, sy)) {
        this._showMeasurement();
      }
    });
  }

  async loadFile(file) {
    let loader = null;
    let format = 'unknown';
    const isLAZ = file.name.toLowerCase().endsWith('.laz');

    if (PLYLoader.isPLYFile(file)) {
      loader = this.plyLoader;
      format = 'PLY';
    } else if (LASLoader.isLASFile(file)) {
      loader = this.lasLoader;
      format = isLAZ ? 'LAZ' : 'LAS';
    } else if (XYZLoader.isXYZFile(file)) {
      loader = this.xyzLoader;
      format = 'XYZ/TXT';
    } else if (RXPLoader.isRXPFile(file)) {
      loader = this.rxpLoader;
      format = 'RXP';
    } else {
      alert(`Unsupported format.\n\nSupported: .ply, .ply.gz, .las, .laz, .xyz, .txt, .pts, .rxp`);
      return;
    }

    if (this.cloud) {
      this.renderer.dispose();
      this.cloud.dispose();
      this.cloud = null;
      if (this.gaussianCloud) {
        this.gaussianCloud.dispose();
        this.gaussianCloud = null;
      }
      this.minimap.clearCache();
      this.clearMeasurement();
      this.renderer.init();
    }
    this.cloudTransform.reset();
    this.gizmo.setMode('none');

    const loading = document.getElementById('loading');
    loading.classList.add('visible');
    document.getElementById('loading-text').textContent = `Loading ${file.name}…`;

    try {
      document.getElementById('loading-text').textContent = `Parsing ${format}…`;
      const result = await loader.load(file);

      if (!result || (result.count === undefined)) {
        throw new Error(result && result.error || 'Loader returned no data');
      }

      this.cloud = new PointCloud({
        count: result.count,
        hasColor: result.hasColor,
        hasIntensity: result.hasIntensity,
        bounds: result.bounds,
        center: result.center,
        zMin: result.zMin,
        zMax: result.zMax,
        intensityMin: result.intensityMin,
        intensityMax: result.intensityMax,
        positions: result.positions,
        colors: result.colors,
        intensity: result.intensity || null,
        tileManager: this.tileManager,
      });

      this.renderer.uploadPointCloud(this.cloud);
      this.tileManager && this.tileManager.dispose && this.tileManager.dispose();
      if (result.tiles) {
        this.tileManager.registerTileMetadata(result.tiles);
      }

      this.camera.setRefCenter(this.cloud.center);
      this._fitView();

      if (this.gaussianMode) {
        this.renderer.renderSplats(this.camera, this.gaussianCloud, {
          viewDir: this._getViewDir(),
          ambient: this.lightAmb,
        });
      } else {
        this.renderer.render(this.camera, this.cloud, {
          colorMode: this.colorMode,
          lightDir:  this.getLightDir(),
          ambient:   this.lightAmb,
          shading:   this.shading,
          decimationOptions: this.getDecimationOptions(),
          cloudTransform: this.cloudTransform,
        });
      }

      document.getElementById('zoom-slider').value = this.camera.zoom;
      document.getElementById('zoom-val').textContent = this.camera.zoom.toFixed(1);
      document.getElementById('rot-offset').value = this.camera.viewOffsetDeg;
      document.getElementById('rot-offset-val').textContent = this.camera.viewOffsetDeg + '°';
      document.getElementById('file-info').innerHTML =
        `${file.name}<br/>${this.cloud.count.toLocaleString()} points<br/>${format}<br/>` +
        (this.cloud.hasColor ? 'RGB ✓  ' : '') +
        (this.cloud.hasIntensity ? 'Intensity ✓' : '');

      setTimeout(() => this.renderer.generateDepthAtlas(
        this.cloud, this.camera.eightDir ? 8 : 4
      ), 100);
    } catch (err) {
      console.error(err);
      alert(`Failed to load ${format} file: ${err.message}`);
    } finally {
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

    const dt = (now - this._lastTime) / 1000;
    this._lastTime = now;

    if (this.fpsMode) {
      this.fpsCamera.update(dt);
    } else {
      this.camera.update(dt);
    }

    let needsRender = false;
    const hasGeo = this.gaussianMode ? !!this.gaussianCloud : !!this.cloud;
    if (hasGeo) {
      if (this.fpsMode) {
        needsRender = this.fpsCamera.consumeDirty() || this.measurement.active;
      } else {
        needsRender = this.camera.consumeDirty() || this.cloudTransform.consumeDirty() || this.measurement.active;
      }
    }
    if (this.gizmo.mode !== 'none') needsRender = true;
    let lodCount = this.renderer._lastDrawCount;

    if (needsRender) {
      if (this.gaussianMode && this.gaussianCloud) {
        const zoomDensity = Math.min(1.0, Math.max(0.3, this.camera.zoom * 0.1));
        const densityFactor = zoomDensity * this.gaussianDensity;
        lodCount = this.renderer.renderSplats(this.camera, this.gaussianCloud, {
          viewDir: this._getViewDir(),
          ambient: this.lightAmb,
          densityFactor: densityFactor,
        });
      } else if (!this.gaussianMode) {
        lodCount = this.renderer.render(this.camera, this.cloud, {
          colorMode: this.colorMode,
          lightDir:  this.getLightDir(),
          ambient:   this.lightAmb,
          shading:   this.shading,
          decimationOptions: this.getDecimationOptions(),
          fpsMode:   this.fpsMode,
          fpsCamera: this.fpsMode ? this.fpsCamera : null,
          cloudTransform: this.cloudTransform,
        });
      }

      if (!this.fpsMode && !this.gaussianMode && (this._minimapFrame++ & 3) === 0) {
        this.minimap.draw(this.cloud, this.camera, this.renderer.width, this.renderer.height);
      }

      if (!this.gaussianMode) {
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        this._drawGizmo(this.overlayCtx);
        if (this.gizmo.mode !== 'none' && this.cloud && !this.fpsMode) {
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
    }

    this._frames++;
    if (now - this._lastFpsTime >= 1000) {
      this._fps = this._frames * 1000 / (now - this._lastFpsTime);
      this._frames = 0;
      this._lastFpsTime = now;
      this.ui.updateStats(this._fps, lodCount, this.cloud ? this.cloud.count : 0);

      if (this.fpsMode && this.cloud) {
        const pos = this.fpsCamera.position;
        const pitch = (this.fpsCamera.pitch * 180 / Math.PI).toFixed(0);
        const yaw = (this.fpsCamera.yaw * 180 / Math.PI).toFixed(0);
        this._hudEl.innerHTML =
          `<b>FPS Explorer</b><br/>` +
          `Pos: <b>[${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}, ${pos[2].toFixed(1)}]</b><br/>` +
          `Dir: Pitch <b>${pitch}°</b> Yaw <b>${yaw}°</b><br/>` +
          `FPS: <b>${this._fps.toFixed(0)}</b>  Mode: <b>${this.colorMode}</b>`;
      } else if (hasGeo) {
        const views = ['N','E','S','W','NE','SE','SW','NW'];
        const vi = this.camera.viewIndex;
        const modeLabel = this.gaussianMode ? 'Gaussian' : this.colorMode;
        const bench = this.renderer.getBench();
        const benchLine = this.gaussianMode
          ? `Sort: <b>${bench.sortMs.toFixed(1)}</b>ms  Cull: <b>${bench.cullMs.toFixed(1)}</b>ms`
          : `LOD: <b>${bench.pointMs.toFixed(1)}</b>ms`;
        this._hudEl.innerHTML =
          `<b>Nuvola</b> 2.5D Viewer<br/>` +
          `View: <b>${views[vi] || vi}</b>  Zoom: <b>${this.camera.zoom.toFixed(1)}×</b><br/>` +
          `FPS: <b>${this._fps.toFixed(0)}</b>  Mode: <b>${modeLabel}</b><br/>` +
          `<span style="font-size:0.65rem;color:#8b949e">${benchLine}</span>`;
      }
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._disposed = true;
    if (this.cloud) {
      this.renderer.dispose();
      this.cloud.dispose();
      this.cloud = null;
      if (this.gaussianCloud) {
        this.gaussianCloud.dispose();
        this.gaussianCloud = null;
      }
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
