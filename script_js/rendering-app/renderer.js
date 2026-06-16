import { Camera } from '../model/camera.js';
import { FPSCamera } from '../model/fps-camera.js';
import {
  POINT_VERTEX_SHADER,
  POINT_FRAGMENT_SHADER,
  QUAD_VERTEX_SHADER,
  LIGHT_FRAGMENT_SHADER,
} from './shader.js';

const MAX_VISIBLE = 10_000_000;
const RENDERER_VERSION = '2.0.0';

const COLOR_MODE_VALUE = Object.freeze({
  rgb: 0,
  height: 1,
  intensity: 2,
  depth: 3,
});

const DEFAULT_LIGHT_DIR = Object.freeze([0.5, 0.5, 1]);

class UniformGuard {
  constructor(gl) {
    this.gl = gl;
    this.scalars = new Map();
    this.refs = new Map();
  }

  uniform1f(loc, key, val) {
    if (this.scalars.get(key) === val) return;
    this.scalars.set(key, val);
    this.gl.uniform1f(loc, val);
  }

  uniform1i(loc, key, val) {
    if (this.scalars.get(key) === val) return;
    this.scalars.set(key, val);
    this.gl.uniform1i(loc, val);
  }

  uniform2fv(loc, key, val) {
    if (this.refs.get(key) === val) return;
    this.refs.set(key, val);
    this.gl.uniform2fv(loc, val);
  }

  uniform3fv(loc, key, val) {
    if (this.refs.get(key) === val) return;
    this.refs.set(key, val);
    this.gl.uniform3fv(loc, val);
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!this.gl) throw new Error('WebGL2 not supported');

    this.width = 0;
    this.height = 0;
    this.depthAtlas = null;

    this._cloud = null;
    this._cloudVao = null;
    this._lastLOD = null;
    this._lastDrawCount = 0;
    this._gpuBytes = 0;
    this._depthRB = null;
    this._fboValid = false;
    this._lightTexel = [1, 1];
    this._atlasResolution = [256, 256];
    this._atlasPan = [128, 128];

    this.pointSizeFactor = 0.6;

    this._dynamicIndexBuf = null;
    this._dynamicIndexVao = null;
    this._dynamicIndexBufSize = 0;
    this._cullIndices = null;

    this._benchPointMs = 0;
    this._benchCullMs = 0;

    this._uniformState = {};
    this._lightState = {};

    this._initShaders();
    this._initBuffers();
    this._initFBO();
  }

  _requireResource(resource, label) {
    if (!resource) throw new Error(`Failed to create ${label}`);
    return resource;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = this._requireResource(gl.createShader(type), 'shader');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'Shader compilation failed');
    }
    return sh;
  }

  _link(vs, fs) {
    const gl = this.gl;
    const prog = this._requireResource(gl.createProgram(), 'program');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'Program link failed');
    }
    return prog;
  }

  init() {
    this._initShaders();
    this._initBuffers();
    this._initFBO();
    this._fboValid = false;
    this.resize(this.width || this.canvas.width, this.height || this.canvas.height);
    this._uniformState = {};
    this._lightState = {};
  }

  _initShaders() {
    const gl = this.gl;

    this.progPoint = this._link(
      this._compile(gl.VERTEX_SHADER, POINT_VERTEX_SHADER),
      this._compile(gl.FRAGMENT_SHADER, POINT_FRAGMENT_SHADER)
    );
    this.progLight = this._link(
      this._compile(gl.VERTEX_SHADER, QUAD_VERTEX_SHADER),
      this._compile(gl.FRAGMENT_SHADER, LIGHT_FRAGMENT_SHADER)
    );

    this.uPoint = {
      resolution: gl.getUniformLocation(this.progPoint, 'u_resolution'),
      pan: gl.getUniformLocation(this.progPoint, 'u_pan'),
      zoom: gl.getUniformLocation(this.progPoint, 'u_zoom'),
      rot: gl.getUniformLocation(this.progPoint, 'u_rot'),
      rotX: gl.getUniformLocation(this.progPoint, 'u_rotX'),
      rotY: gl.getUniformLocation(this.progPoint, 'u_rotY'),
      rotZ: gl.getUniformLocation(this.progPoint, 'u_rotZ'),
      center: gl.getUniformLocation(this.progPoint, 'u_center'),
      zMin: gl.getUniformLocation(this.progPoint, 'u_zMin'),
      zMax: gl.getUniformLocation(this.progPoint, 'u_zMax'),
      depthMin: gl.getUniformLocation(this.progPoint, 'u_depthMin'),
      depthMax: gl.getUniformLocation(this.progPoint, 'u_depthMax'),
      iMin: gl.getUniformLocation(this.progPoint, 'u_iMin'),
      iMax: gl.getUniformLocation(this.progPoint, 'u_iMax'),
      colorMode: gl.getUniformLocation(this.progPoint, 'u_colorMode'),
      fpsMode: gl.getUniformLocation(this.progPoint, 'u_fpsMode'),
      useCloudTransform: gl.getUniformLocation(this.progPoint, 'u_useCloudTransform'),
      cloudRot: gl.getUniformLocation(this.progPoint, 'u_cloudRot'),
      cloudScale: gl.getUniformLocation(this.progPoint, 'u_cloudScale'),
      mvpMatrix: gl.getUniformLocation(this.progPoint, 'u_mvpMatrix'),
      pointSize: gl.getUniformLocation(this.progPoint, 'u_pointSize'),
    };

    this.uLight = {
      colorTex: gl.getUniformLocation(this.progLight, 'u_colorTex'),
      depthTex: gl.getUniformLocation(this.progLight, 'u_depthTex'),
      texel: gl.getUniformLocation(this.progLight, 'u_texel'),
      lightDir: gl.getUniformLocation(this.progLight, 'u_lightDir'),
      ambient: gl.getUniformLocation(this.progLight, 'u_ambient'),
      shading: gl.getUniformLocation(this.progLight, 'u_shading'),
    };

    this._pointUniforms = new UniformGuard(gl);
    this._lightUniforms = new UniformGuard(gl);
    this.attrPos = gl.getAttribLocation(this.progPoint, 'a_position');
    this.attrCol = gl.getAttribLocation(this.progPoint, 'a_color');
    this.attrInt = gl.getAttribLocation(this.progPoint, 'a_intensity');
  }

  _initBuffers() {
    const gl = this.gl;
    this.vboPos = this._requireResource(gl.createBuffer(), 'position buffer');
    this.vboCol = this._requireResource(gl.createBuffer(), 'color buffer');
    this.vboInt = this._requireResource(gl.createBuffer(), 'intensity buffer');
    this._quadVao = this._requireResource(gl.createVertexArray(), 'quad VAO');
  }

  _initFBO() {
    const gl = this.gl;
    this.fbo = this._requireResource(gl.createFramebuffer(), 'framebuffer');
    this.colorTex = this._requireResource(gl.createTexture(), 'color texture');
    this.depthTex = this._requireResource(gl.createTexture(), 'depth texture');
  }

  _devicePixelRatio(value = window.devicePixelRatio) {
    return Math.min(value || 1, 2);
  }

  _configureRGBA8Texture(tex, width, height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  resize(w, h) {
    const dpr = this._devicePixelRatio();
    const nw = Math.max(1, Math.floor(w * dpr));
    const nh = Math.max(1, Math.floor(h * dpr));
    if (nw === this.width && nh === this.height && this._fboValid) return;

    this.width = nw;
    this.height = nh;
    this._lightTexel = [1 / this.width, 1 / this.height];

    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    const gl = this.gl;

    this._configureRGBA8Texture(this.colorTex, this.width, this.height);
    this._configureRGBA8Texture(this.depthTex, this.width, this.height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    if (this._depthRB) gl.deleteRenderbuffer(this._depthRB);
    this._depthRB = this._requireResource(gl.createRenderbuffer(), 'depth renderbuffer');
    gl.bindRenderbuffer(gl.RENDERBUFFER, this._depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._depthRB);

    this._fboValid = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  uploadPointCloud(cloud) {
    const gl = this.gl;
    this._disposeCloudVAOs();
    this._cloud = cloud;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.colors, gl.STATIC_DRAW);

    if (cloud.intensity) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboInt);
      gl.bufferData(gl.ARRAY_BUFFER, cloud.intensity, gl.STATIC_DRAW);
    }

    this._gpuBytes = cloud.getGPUByteSize();
    this._cloudVao = this._createCloudVAO(cloud);

    this._lodGpuResources = [];
    for (const lod of cloud.lodLevels) {
      if (!lod.indices) continue;
      if (lod.indices.length > 5_000_000) continue;
      const buf = this._requireResource(gl.createBuffer(), 'LOD index buffer');
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lod.indices, gl.STATIC_DRAW);
      const vao = this._createCloudVAO(cloud, buf);
      this._lodGpuResources.push({ vao, buf });
      lod._gpuBuf = buf;
      lod._gpuVao = vao;
    }

    if (this._dynamicIndexVao) gl.deleteVertexArray(this._dynamicIndexVao);
    if (this._dynamicIndexBuf) gl.deleteBuffer(this._dynamicIndexBuf);
    this._dynamicIndexVao = this._createCloudVAO(cloud);
    this._dynamicIndexBuf = this._requireResource(gl.createBuffer(), 'dynamic index buffer');
    gl.bindVertexArray(this._dynamicIndexVao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW);
    this._dynamicIndexBufSize = 4;

    gl.bindVertexArray(null);
  }

  uploadGaussianCloud(cloud) {
    const gl = this.gl;
    this._disposeCloudVAOs();
    this._cloud = cloud;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, cloud.colors, gl.STATIC_DRAW);

    this._gpuBytes = cloud.getGPUByteSize();
    this._cloudVao = this._createCloudVAO(cloud);

    gl.bindVertexArray(null);
  }

  renderSplats(camera, cloud, opts = {}) {
    return 0;
  }

  _disposeCloudVAOs() {
    const gl = this.gl;
    if (this._cloudVao) { gl.deleteVertexArray(this._cloudVao); this._cloudVao = null; }
    if (this._dynamicIndexVao) { gl.deleteVertexArray(this._dynamicIndexVao); this._dynamicIndexVao = null; }
    if (this._dynamicIndexBuf) { gl.deleteBuffer(this._dynamicIndexBuf); this._dynamicIndexBuf = null; }
    this._dynamicIndexBufSize = 0;
    this._cullIndices = null;

    if (this._lodGpuResources) {
      for (const res of this._lodGpuResources) {
        if (res.vao) gl.deleteVertexArray(res.vao);
        if (res.buf) gl.deleteBuffer(res.buf);
      }
      this._lodGpuResources = null;
    }
    this._lastLOD = null;
  }

  dispose() {
    const gl = this.gl;
    this._disposeCloudVAOs();

    if (this.vboPos) { gl.deleteBuffer(this.vboPos); this.vboPos = null; }
    if (this.vboCol) { gl.deleteBuffer(this.vboCol); this.vboCol = null; }
    if (this.vboInt) { gl.deleteBuffer(this.vboInt); this.vboInt = null; }

    if (this.progPoint) { gl.deleteProgram(this.progPoint); this.progPoint = null; }
    if (this.progLight) { gl.deleteProgram(this.progLight); this.progLight = null; }

    if (this.fbo) { gl.deleteFramebuffer(this.fbo); this.fbo = null; }
    if (this.colorTex) { gl.deleteTexture(this.colorTex); this.colorTex = null; }
    if (this.depthTex) { gl.deleteTexture(this.depthTex); this.depthTex = null; }
    if (this._depthRB) { gl.deleteRenderbuffer(this._depthRB); this._depthRB = null; }

    if (this._quadVao) { gl.deleteVertexArray(this._quadVao); this._quadVao = null; }

    this._cloud = null;
    this._lastLOD = null;
    this._gpuBytes = 0;
    this._fboValid = false;
    this.depthAtlas = null;
    this._uniformState = {};
    this._lightState = {};
  }

  getMemoryMB() {
    let total = this._gpuBytes;
    if (this._dynamicIndexBuf) total += this._dynamicIndexBufSize;
    const fboTex = this.width * this.height * 4;
    total += fboTex * 2;
    total += this.width * this.height * 3;
    return (total / (1024 * 1024)).toFixed(1);
  }

  getBench() {
    return { pointMs: this._benchPointMs, cullMs: this._benchCullMs };
  }

  getStats(cloud, camera) {
    const memMB = this.getMemoryMB();
    const bench = this.getBench();
    const lod = this._lastLOD || {};
    return {
      modelPoints: cloud ? cloud.count : 0,
      lodLevel: lod.level != null ? lod.level : '—',
      lodCandidateCount: lod.count || 0,
      submittedCount: this._lastDrawCount || 0,
      hardCap: MAX_VISIBLE,
      drawPasses: 2,
      gpuMemMB: memMB,
      gpuMemLabel: 'estimated',
      bench,
    };
  }

  _createCloudVAO(cloud, indexBuffer = null) {
    const gl = this.gl;
    const vao = this._requireResource(gl.createVertexArray(), 'cloud VAO');

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboPos);
    gl.enableVertexAttribArray(this.attrPos);
    gl.vertexAttribPointer(this.attrPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboCol);
    gl.enableVertexAttribArray(this.attrCol);
    gl.vertexAttribPointer(this.attrCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    if (cloud.intensity) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboInt);
      gl.enableVertexAttribArray(this.attrInt);
      gl.vertexAttribPointer(this.attrInt, 1, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(this.attrInt);
      gl.vertexAttrib1f(this.attrInt, 0.5);
    }

    if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    return vao;
  }

  _cullScreenSpace(lod, camera, w, h, cloud, cloudTransform) {
    const t0 = performance.now();
    const positions = cloud.positions;
    const center = cloud.center;
    const indices = lod.indices;
    const srcCount = indices ? Math.min(indices.length, lod.count) : lod.count;

    const panX = camera.panX, panY = camera.panY;
    const zoomVal = camera.zoom;
    const angle = camera._rotAngle || 0;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);

    const rotX = camera.rotationXDeg * Math.PI / 180;
    const rotY = camera.rotationYDeg * Math.PI / 180;
    const rotZ = camera.rotationZDeg * Math.PI / 180;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
    const skipX = cosX === 1 && sinX === 0;
    const skipY = cosY === 1 && sinY === 0;
    const skipZ = cosZ === 1 && sinZ === 0;

    let useCloudXform = false;
    let cRx = 1, sRx = 0, cRy = 1, sRy = 0, cRz = 1, sRz = 0;
    let scX = 1, scY = 1, scZ = 1;
    if (cloudTransform && !cloudTransform.isIdentity) {
      useCloudXform = true;
      const rx = cloudTransform.rotation[0] * Math.PI / 180;
      const ry = cloudTransform.rotation[1] * Math.PI / 180;
      const rz = cloudTransform.rotation[2] * Math.PI / 180;
      cRx = Math.cos(rx); sRx = Math.sin(rx);
      cRy = Math.cos(ry); sRy = Math.sin(ry);
      cRz = Math.cos(rz); sRz = Math.sin(rz);
      scX = cloudTransform.scale[0];
      scY = cloudTransform.scale[1];
      scZ = cloudTransform.scale[2];
    }

    const cx = center[0], cy = center[1], cz = center[2];
    const margin = 40;

    if (!this._cullIndices || this._cullIndices.length < srcCount) {
      this._cullIndices = new Uint32Array(Math.max(srcCount, this._cullIndices ? this._cullIndices.length * 2 : 1024));
    }

    let visibleCount = 0;
    const limit = Math.min(srcCount, MAX_VISIBLE);

    for (let j = 0; j < limit; j++) {
      const i = indices ? indices[j] : j;
      let lx = positions[i*3] - cx, ly = positions[i*3+1] - cy, lz = positions[i*3+2] - cz;

      if (useCloudXform) {
        lx *= scX; ly *= scY; lz *= scZ;
        const y1 = ly*cRx - lz*sRx; const z1 = ly*sRx + lz*cRx; ly = y1; lz = z1;
        const x1 = lx*cRy + lz*sRy; const z2 = -lx*sRy + lz*cRy; lx = x1; lz = z2;
        const x2 = lx*cRz - ly*sRz; const y2 = lx*sRz + ly*cRz; lx = x2; ly = y2;
      }

      if (!skipX) { const y1 = ly*cosX - lz*sinX; const z1 = ly*sinX + lz*cosX; ly = y1; lz = z1; }
      if (!skipY) { const x1 = lx*cosY + lz*sinY; const z2 = -lx*sinY + lz*cosY; lx = x1; lz = z2; }
      if (!skipZ) { const x2 = lx*cosZ - ly*sinZ; const y2 = lx*sinZ + ly*cosZ; lx = x2; ly = y2; }

      const rx = lx*cosA - ly*sinA;
      const ry = lx*sinA + ly*cosA;

      const sx = (rx - ry)*zoomVal + panX;
      const sy = ((rx + ry)*0.5 - lz)*zoomVal + panY;

      if (sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin) {
        this._cullIndices[visibleCount++] = i;
      }
    }

    this._benchCullMs = performance.now() - t0;
    return { indices: this._cullIndices.subarray(0, visibleCount), count: visibleCount };
  }

  _uploadDynamicIndices(indices, count) {
    const gl = this.gl;
    const needed = count * 4;
    if (needed > this._dynamicIndexBufSize) {
      const cap = Math.max(needed, this._dynamicIndexBufSize * 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      this._dynamicIndexBufSize = cap;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices.subarray ? indices.subarray(0, count) : indices);
  }

  _applyCameraUniforms(camera, cloud) {
    const u = camera.getUniforms(this.width, this.height, cloud);

    const apply = this._pointUniforms;
    const up = this.uPoint;
    apply.uniform2fv(up.resolution, 'point.resolution', u.u_resolution);
    apply.uniform2fv(up.pan, 'point.pan', u.u_pan);
    apply.uniform1f(up.zoom, 'point.zoom', u.u_zoom);
    apply.uniform1f(up.rot, 'point.rot', u.u_rot);
    apply.uniform1f(up.rotX, 'point.rotX', u.u_rotX);
    apply.uniform1f(up.rotY, 'point.rotY', u.u_rotY);
    apply.uniform1f(up.rotZ, 'point.rotZ', u.u_rotZ);
    apply.uniform3fv(up.center, 'point.center', u.u_center);
    apply.uniform1f(up.zMin, 'point.zMin', u.u_zMin);
    apply.uniform1f(up.zMax, 'point.zMax', u.u_zMax);
    apply.uniform1f(up.depthMin, 'point.depthMin', u.u_depthMin);
    apply.uniform1f(up.depthMax, 'point.depthMax', u.u_depthMax);
    apply.uniform1f(up.iMin, 'point.iMin', u.u_iMin);
    apply.uniform1f(up.iMax, 'point.iMax', u.u_iMax);
  }

  _applyFPSCameraUniforms(fpsCamera, cloud) {
    const gl = this.gl;
    const mvp = fpsCamera.getMVP(this.width, this.height);
    gl.uniformMatrix4fv(this.uPoint.mvpMatrix, false, mvp);
    this._pointUniforms.uniform1f(this.uPoint.pointSize, 'point.fpsSize', 3.0);

    const zMin = cloud ? cloud.zMin - cloud.center[2] : 0;
    const zMax = cloud ? cloud.zMax - cloud.center[2] : 1;
    const center = cloud ? cloud.center : [0, 0, 0];
    const iMin = cloud && cloud.intensity ? cloud.intensityMin : 0;
    const iMax = cloud && cloud.intensity ? cloud.intensityMax : 1;

    this._pointUniforms.uniform3fv(this.uPoint.center, 'point.fpsCenter', center);
    this._pointUniforms.uniform1f(this.uPoint.zMin, 'point.fpsZMin', zMin);
    this._pointUniforms.uniform1f(this.uPoint.zMax, 'point.fpsZMax', zMax);
    this._pointUniforms.uniform1f(this.uPoint.iMin, 'point.fpsIMin', iMin);
    this._pointUniforms.uniform1f(this.uPoint.iMax, 'point.fpsIMax', iMax);
  }

  _selectLOD(cloud, zoom, opts = {}) {
    const levels = cloud.lodLevels;
    if (!levels || levels.length === 0) {
      return { level: -1, count: cloud.count, indices: null };
    }
    const minPoints = opts.minPointsForDetail || 1000000;
    const defaultZoom = opts.defaultZoom || zoom;
    const zoomRatio = zoom / defaultZoom;
    const target = Math.min(minPoints * zoomRatio, cloud.count);
    let best = levels[0];
    if (best.indices) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].count >= target) { best = levels[i]; break; }
      }
    }
    return best;
  }

  render(camera, cloud, opts = {}) {
    const t0 = performance.now();
    if (!cloud || !this._fboValid) return 0;

    const gl = this.gl;
    const colorMode = opts.colorMode || 'rgb';
    const lightDir = opts.lightDir || DEFAULT_LIGHT_DIR;
    const ambient = opts.ambient != null ? opts.ambient : 0.25;
    const shading = opts.shading !== false;
    const decimationOptions = opts.decimationOptions || {};
    const fpsMode = !!opts.fpsMode;
    const fpsCamera = opts.fpsCamera || null;
    const enableCulling = opts.enableCulling !== false;
    const cloudTransform = opts.cloudTransform || null;

    const lod = this._selectLOD(cloud, camera.zoom, decimationOptions);
    this._lastLOD = lod;

    let drawIndices, drawCount;
    if (lod && lod.indices) {
      drawCount = Math.min(lod.count, MAX_VISIBLE);
      drawIndices = { indices: lod.indices, count: drawCount };
    } else {
      drawCount = Math.min(cloud.count, MAX_VISIBLE);
      drawIndices = null;
    }

    const vao = (drawIndices && drawIndices.indices) ? this._dynamicIndexVao : this._cloudVao;
    if (drawIndices && drawIndices.indices) {
      gl.bindVertexArray(vao);
      this._uploadDynamicIndices(drawIndices.indices, drawCount);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.progPoint);

    if (fpsMode && fpsCamera) {
      this._applyFPSCameraUniforms(fpsCamera, cloud);
      this._pointUniforms.uniform1i(this.uPoint.fpsMode, 'point.fpsMode', 1);
    } else {
      this._applyCameraUniforms(camera, cloud);
      this._pointUniforms.uniform1i(this.uPoint.fpsMode, 'point.fpsMode', 0);
    }
    this._pointUniforms.uniform1i(this.uPoint.colorMode, 'point.colorMode', COLOR_MODE_VALUE[colorMode] != null ? COLOR_MODE_VALUE[colorMode] : 0);

    if (cloudTransform && !cloudTransform.isIdentity) {
      const r = cloudTransform.rotation;
      const s = cloudTransform.scale;
      gl.uniform1i(this.uPoint.useCloudTransform, 1);
      gl.uniform3f(this.uPoint.cloudRot, r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
      gl.uniform3f(this.uPoint.cloudScale, s[0], s[1], s[2]);
    } else {
      gl.uniform1i(this.uPoint.useCloudTransform, 0);
    }

    if (!(drawIndices && drawIndices.indices)) {
      gl.bindVertexArray(this._cloudVao);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.colorMask(false, false, false, false);

    if (drawIndices && drawIndices.indices) {
      gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.POINTS, 0, drawCount);
    }

    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);
    gl.disable(gl.BLEND);

    if (drawIndices && drawIndices.indices) {
      gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.POINTS, 0, drawCount);
    }

    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progLight);
    gl.bindVertexArray(this._quadVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    this._lightUniforms.uniform1i(this.uLight.colorTex, 'light.colorTex', 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    this._lightUniforms.uniform1i(this.uLight.depthTex, 'light.depthTex', 1);

    this._lightUniforms.uniform2fv(this.uLight.texel, 'light.texel', this._lightTexel);
    this._lightUniforms.uniform3fv(this.uLight.lightDir, 'light.lightDir', lightDir);
    this._lightUniforms.uniform1f(this.uLight.ambient, 'light.ambient', ambient);
    this._lightUniforms.uniform1i(this.uLight.shading, 'light.shading', shading ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this._lastDrawCount = drawCount;
    this._benchPointMs = performance.now() - t0;

    return drawCount;
  }

  _tileScreenVisible(tile, camera, w, h, center) {
    const b = tile.bounds;
    const cx = center[0], cy = center[1];
    const corners = [
      [b.min[0], b.min[1]], [b.max[0], b.min[1]],
      [b.min[0], b.max[1]], [b.max[0], b.max[1]],
    ];
    const angle = camera._rotAngle;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const panX = camera.panX, panY = camera.panY;
    const zoomVal = camera.zoom;
    const margin = 60;
    for (const [x, y] of corners) {
      const lx = x - cx, ly = y - cy;
      const rx = lx * cosA - ly * sinA;
      const ry = lx * sinA + ly * cosA;
      const sx = (rx - ry) * zoomVal + panX;
      const sy = ((rx + ry) * 0.5) * zoomVal + panY;
      if (sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin) return true;
    }
    return false;
  }

  renderTiles(camera, tileManager, tileCache, opts = {}) {
    if (!this._fboValid) return 0;
    const t0 = performance.now();
    const gl = this.gl;
    const w = this.width, h = this.height;
    const colorMode = opts.colorMode || 'rgb';
    const lightDir = opts.lightDir || DEFAULT_LIGHT_DIR;
    const ambient = opts.ambient != null ? opts.ambient : 0.25;
    const shading = opts.shading !== false;
    const cloud = opts.cloud;

    const visible = [];
    for (const tile of tileManager.tiles) {
      if (this._tileScreenVisible(tile, camera, w, h, cloud.center)) visible.push(tile);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.progPoint);

    this._applyCameraUniforms(camera, cloud);
    this._pointUniforms.uniform1i(this.uPoint.fpsMode, 'point.fpsMode', 0);
    this._pointUniforms.uniform1i(this.uPoint.colorMode, 'point.colorMode', COLOR_MODE_VALUE[colorMode] != null ? COLOR_MODE_VALUE[colorMode] : 0);
    gl.uniform1i(this.uPoint.useCloudTransform, 0);

    let totalCount = 0;
    for (const tile of visible) {
      const entry = tileCache.get(tile.id);
      if (!entry) {
        if (!tileCache.isLoading(tile.id)) {
          tileCache.loadTileAsync(tile.id, tile);
        }
        continue;
      }
      tileCache.touch(tile.id);
      gl.bindVertexArray(entry.vao);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);
      gl.drawArrays(gl.POINTS, 0, entry.count);

      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.POINTS, 0, entry.count);

      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.enable(gl.BLEND);

      totalCount += entry.count;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progLight);
    gl.bindVertexArray(this._quadVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    this._lightUniforms.uniform1i(this.uLight.colorTex, 'light.colorTex', 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    this._lightUniforms.uniform1i(this.uLight.depthTex, 'light.depthTex', 1);

    this._lightUniforms.uniform2fv(this.uLight.texel, 'light.texel', this._lightTexel);
    this._lightUniforms.uniform3fv(this.uLight.lightDir, 'light.lightDir', lightDir);
    this._lightUniforms.uniform1f(this.uLight.ambient, 'light.ambient', ambient);
    this._lightUniforms.uniform1i(this.uLight.shading, 'light.shading', shading ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this._lastDrawCount = totalCount;
    this._benchPointMs = performance.now() - t0;
    return totalCount;
  }

  generateDepthAtlas(cloud, numViews = 4) {
    if (!this._fboValid || !this._cloudVao) return;

    const gl = this.gl;
    const atlasSize = 256;
    const atlasPixelCount = atlasSize * atlasSize;
    const atlas = new Float32Array(atlasPixelCount * numViews);
    const colorAtlas = new Uint8Array(atlasPixelCount * numViews * 4);

    const tmpFbo = this._requireResource(gl.createFramebuffer(), 'atlas framebuffer');
    const tmpColor = this._requireResource(gl.createTexture(), 'atlas color texture');
    const tmpDepth = this._requireResource(gl.createTexture(), 'atlas depth texture');
    const tmpRB = this._requireResource(gl.createRenderbuffer(), 'atlas depth renderbuffer');

    try {
      this._configureRGBA8Texture(tmpColor, atlasSize, atlasSize);
      this._configureRGBA8Texture(tmpDepth, atlasSize, atlasSize);

      gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmpColor, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, tmpDepth, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, tmpRB);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, atlasSize, atlasSize);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, tmpRB);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return;

      const pixels = new Uint8Array(atlasPixelCount * 4);
      const depthPixels = new Uint8Array(atlasPixelCount * 4);
      const span = Math.max(
        cloud.bounds.max[0] - cloud.bounds.min[0],
        cloud.bounds.max[1] - cloud.bounds.min[1],
        1
      );

      gl.viewport(0, 0, atlasSize, atlasSize);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.useProgram(this.progPoint);
      gl.bindVertexArray(this._cloudVao);

      for (let v = 0; v < numViews; v++) {
        const rotAngle = (v / numViews) * Math.PI * 2;
        const dr = Camera.depthRange(cloud, rotAngle);

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const apply = this._pointUniforms;
        const up = this.uPoint;
        apply.uniform1i(up.fpsMode, 'point.atlasFps', 0);
        gl.uniform1i(up.useCloudTransform, 0);
        apply.uniform2fv(up.resolution, 'point.resolution', this._atlasResolution);
        apply.uniform2fv(up.pan, 'point.pan', this._atlasPan);
        apply.uniform3fv(up.center, 'point.center', cloud.center);
        apply.uniform1f(up.zoom, 'point.zoom', (atlasSize / span) * 0.8);
        apply.uniform1f(up.rot, 'point.rot', rotAngle);
        apply.uniform1f(up.rotX, 'point.rotX', 0);
        apply.uniform1f(up.rotY, 'point.rotY', 0);
        apply.uniform1f(up.rotZ, 'point.rotZ', 0);
        apply.uniform1f(up.zMin, 'point.zMin', cloud.zMin - cloud.center[2]);
        apply.uniform1f(up.zMax, 'point.zMax', cloud.zMax - cloud.center[2]);
        apply.uniform1f(up.depthMin, 'point.depthMin', dr.min);
        apply.uniform1f(up.depthMax, 'point.depthMax', dr.max);
        apply.uniform1f(up.iMin, 'point.iMin', cloud.intensityMin);
        apply.uniform1f(up.iMax, 'point.iMax', cloud.intensityMax);
        apply.uniform1i(up.colorMode, 'point.colorMode', 0);

        gl.drawArrays(gl.POINTS, 0, Math.min(cloud.count, 100000));

        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, atlasSize, atlasSize, gl.RGBA, gl.UNSIGNED_BYTE, depthPixels);

        const base = v * atlasPixelCount;
        for (let i = 0; i < atlasPixelCount; i++) {
          atlas[base + i] = depthPixels[i * 4] / 255;
        }

        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.readPixels(0, 0, atlasSize, atlasSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        colorAtlas.set(pixels, v * atlasPixelCount * 4);
      }

      this.depthAtlas = {
        size: atlasSize,
        views: numViews,
        depth: atlas,
        color: colorAtlas,
      };
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.deleteRenderbuffer(tmpRB);
      gl.deleteTexture(tmpDepth);
      gl.deleteTexture(tmpColor);
      gl.deleteFramebuffer(tmpFbo);
    }
  }
}
