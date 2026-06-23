import {
  POINT_VERTEX_SHADER,
  POINT_FRAGMENT_SHADER,
  QUAD_VERTEX_SHADER,
  LIGHT_FRAGMENT_SHADER,
} from './shader.js';

const COLOR_MODE_VALUE = Object.freeze({
  rgb: 0,
  height: 1,
  intensity: 2,
  depth: 3,
  classification: 4,
});

const DEFAULT_LIGHT_DIR = Object.freeze([0.5, 0.5, 1]);
const BYTES_PER_POINT_GPU = 12 + 3 + 4 + 1; // position(3×4) + color(3) + intensity(4) + classification(1)
const MAX_DEVICE_PIXEL_RATIO = 2;
const DEFAULT_AMBIENT = 0.25;
const DEFAULT_POINT_SIZE = 3.0;

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
    const prev = this.refs.get(key);
    if (prev && prev.length === 2 && prev[0] === val[0] && prev[1] === val[1]) return;
    this.refs.set(key, new Float32Array(val));
    this.gl.uniform2fv(loc, val);
  }

  uniform3fv(loc, key, val) {
    const prev = this.refs.get(key);
    if (prev && prev.length === 3 && prev[0] === val[0] && prev[1] === val[1] && prev[2] === val[2]) return;
    this.refs.set(key, new Float32Array(val));
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

    this._cloud = null;
    this._cloudVao = null;
    this._lastDrawCount = 0;
    this._gpuBytes = 0;
    this._depthRB = null;
    this._fboValid = false;
    this._lightTexel = [1, 1];

    this._dynamicIndexBuf = null;
    this._dynamicIndexVao = null;
    this._dynamicIndexBufSize = 0;

    this._benchFrameMs = 0;
    this._contextLost = false;

    this._initShaders();
    this._initBuffers();
    this._initFBO();

    this._onContextLost = (e) => { e.preventDefault(); this._contextLost = true; };
    this._onContextRestored = () => { this._contextLost = false; this._initShaders(); this._initBuffers(); this._initFBO(); if (this.width > 0) this._setupFBO(this.width, this.height); };
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
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

  _initShaders() {
    const gl = this.gl;

    const vsPoint = this._compile(gl.VERTEX_SHADER, POINT_VERTEX_SHADER);
    const fsPoint = this._compile(gl.FRAGMENT_SHADER, POINT_FRAGMENT_SHADER);
    this.progPoint = this._link(vsPoint, fsPoint);
    gl.deleteShader(vsPoint);
    gl.deleteShader(fsPoint);

    const vsQuad = this._compile(gl.VERTEX_SHADER, QUAD_VERTEX_SHADER);
    const fsLight = this._compile(gl.FRAGMENT_SHADER, LIGHT_FRAGMENT_SHADER);
    this.progLight = this._link(vsQuad, fsLight);
    gl.deleteShader(vsQuad);
    gl.deleteShader(fsLight);

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
      useCloudTransform: gl.getUniformLocation(this.progPoint, 'u_useCloudTransform'),
      cloudRot: gl.getUniformLocation(this.progPoint, 'u_cloudRot'),
      cloudScale: gl.getUniformLocation(this.progPoint, 'u_cloudScale'),
      pointSize: gl.getUniformLocation(this.progPoint, 'u_pointSize'),
      pointSizeType: gl.getUniformLocation(this.progPoint, 'u_pointSizeType'),
      cameraMode: gl.getUniformLocation(this.progPoint, 'u_cameraMode'),
      viewMatrix: gl.getUniformLocation(this.progPoint, 'u_viewMatrix'),
      projMatrix: gl.getUniformLocation(this.progPoint, 'u_projMatrix'),
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
    this.attrClass = gl.getAttribLocation(this.progPoint, 'a_classification');
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
    return Math.min(value || 1, MAX_DEVICE_PIXEL_RATIO);
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

  _setupFBO(w, h) {
    const gl = this.gl;
    this._configureRGBA8Texture(this.colorTex, w, h);
    this._configureRGBA8Texture(this.depthTex, w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    if (this._depthRB) gl.deleteRenderbuffer(this._depthRB);
    this._depthRB = this._requireResource(gl.createRenderbuffer(), 'depth renderbuffer');
    gl.bindRenderbuffer(gl.RENDERBUFFER, this._depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._depthRB);

    this._fboValid = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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

    this._setupFBO(this.width, this.height);
  }

  _ensureResources() {
    this._contextLost = false;
    if (this.progPoint && this.progLight) return;
    this._initShaders();
    this._initBuffers();
    this._initFBO();
    if (this.width > 0 && this.height > 0) {
      this._setupFBO(this.width, this.height);
    }
  }

  uploadPointCloud(cloud) {
    this._ensureResources();
    const gl = this.gl;
    this._disposeCloudVAOs();
    this._cloud = cloud;
    this._lastDrawCount = 0;

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

    if (this._dynamicIndexVao) gl.deleteVertexArray(this._dynamicIndexVao);
    if (this._dynamicIndexBuf) gl.deleteBuffer(this._dynamicIndexBuf);
    this._dynamicIndexVao = this._createCloudVAO(cloud);
    this._dynamicIndexBuf = this._requireResource(gl.createBuffer(), 'dynamic index buffer');
    gl.bindVertexArray(this._dynamicIndexVao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW);
    this._dynamicIndexBufSize = 4;

    gl.bindVertexArray(null);

    if (!cloud.octreeGeometry) {
      cloud.colors = null;
      cloud.intensity = null;
    }
  }

  _disposeCloudVAOs() {
    const gl = this.gl;
    if (this._cloudVao) { gl.deleteVertexArray(this._cloudVao); this._cloudVao = null; }
    if (this._dynamicIndexVao) { gl.deleteVertexArray(this._dynamicIndexVao); this._dynamicIndexVao = null; }
    if (this._dynamicIndexBuf) { gl.deleteBuffer(this._dynamicIndexBuf); this._dynamicIndexBuf = null; }
    this._dynamicIndexBufSize = 0;
  }

  uploadNode(node) {
    const gl = this.gl;
    const gd = node.geometryData;
    if (!gd || !gd.position) return;
    const numPoints = gd.numPoints;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vboPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, gd.position, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attrPos);
    gl.vertexAttribPointer(this.attrPos, 3, gl.FLOAT, false, 0, 0);

    let colData = gd.color;
    if (!colData) {
      colData = new Uint8Array(numPoints * 3);
      for (let i = 0; i < numPoints * 3; i++) colData[i] = 180;
    }
    const vboCol = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, colData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attrCol);
    gl.vertexAttribPointer(this.attrCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    let intData = gd.intensity;
    if (!intData) {
      intData = new Float32Array(numPoints);
    }
    const vboInt = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vboInt);
    gl.bufferData(gl.ARRAY_BUFFER, intData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attrInt);
    gl.vertexAttribPointer(this.attrInt, 1, gl.FLOAT, false, 0, 0);

    let classData = gd.classification;
    if (!classData) {
      classData = new Uint8Array(numPoints);
    }
    const vboClass = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vboClass);
    gl.bufferData(gl.ARRAY_BUFFER, classData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.attrClass);
    gl.vertexAttribPointer(this.attrClass, 1, gl.UNSIGNED_BYTE, false, 0, 0);

    gl.bindVertexArray(null);

    node.gpuVAO = vao;
    node._gpuVboPos = vboPos;
    node._gpuVboCol = vboCol;
    node._gpuVboInt = vboInt;
    node._gpuVboClass = vboClass;

    node.onDispose((n) => this.removeNode(n));

    this._gpuBytes += numPoints * BYTES_PER_POINT_GPU;
  }

  removeNode(node) {
    const gl = this.gl;
    if (node.gpuVAO) { gl.deleteVertexArray(node.gpuVAO); node.gpuVAO = null; }
    if (node._gpuVboPos) { gl.deleteBuffer(node._gpuVboPos); node._gpuVboPos = null; }
    if (node._gpuVboCol) { gl.deleteBuffer(node._gpuVboCol); node._gpuVboCol = null; }
    if (node._gpuVboInt) { gl.deleteBuffer(node._gpuVboInt); node._gpuVboInt = null; }
    if (node._gpuVboClass) { gl.deleteBuffer(node._gpuVboClass); node._gpuVboClass = null; }
    const numPoints = node.numPoints || 0;
    this._gpuBytes -= numPoints * BYTES_PER_POINT_GPU;
    if (this._gpuBytes < 0) this._gpuBytes = 0;
  }

  dispose() {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._disposeCloudVAOs();

    if (this.vboPos)  { gl.deleteBuffer(this.vboPos);  this.vboPos = null; }
    if (this.vboCol)  { gl.deleteBuffer(this.vboCol);  this.vboCol = null; }
    if (this.vboInt)  { gl.deleteBuffer(this.vboInt);  this.vboInt = null; }
    if (this._quadVao) { gl.deleteVertexArray(this._quadVao); this._quadVao = null; }

    if (this.fbo)      { gl.deleteFramebuffer(this.fbo);    this.fbo = null; }
    if (this.colorTex) { gl.deleteTexture(this.colorTex);   this.colorTex = null; }
    if (this.depthTex) { gl.deleteTexture(this.depthTex);   this.depthTex = null; }
    if (this._depthRB) { gl.deleteRenderbuffer(this._depthRB); this._depthRB = null; }

    if (this.progPoint) { gl.deleteProgram(this.progPoint); this.progPoint = null; }
    if (this.progLight) { gl.deleteProgram(this.progLight); this.progLight = null; }

    this._cloud = null;
    this._gpuBytes = 0;
    this._lastDrawCount = 0;
    this._pointUniforms = null;
    this._lightUniforms = null;
    this._fboValid = false;
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
    return { frameMs: this._benchFrameMs };
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

    if (cloud.intensity && this.attrInt >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboInt);
      gl.enableVertexAttribArray(this.attrInt);
      gl.vertexAttribPointer(this.attrInt, 1, gl.FLOAT, false, 0, 0);
    } else if (this.attrInt >= 0) {
      gl.disableVertexAttribArray(this.attrInt);
      gl.vertexAttrib1f(this.attrInt, 0.5);
    }

    if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    return vao;
  }



  _uploadDynamicIndices(buf, count) {
    const gl = this.gl;
    const needed = count * 4;
    if (needed > this._dynamicIndexBufSize) {
      const cap = Math.max(needed, this._dynamicIndexBufSize * 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      this._dynamicIndexBufSize = cap;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._dynamicIndexBuf);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, buf);
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

    const cameraMode = u.u_cameraMode || 0;
    apply.uniform1i(up.cameraMode, 'point.cameraMode', cameraMode);
    if (cameraMode === 1 && u.u_viewMatrix && u.u_projMatrix) {
      this.gl.uniformMatrix4fv(up.viewMatrix, false, u.u_viewMatrix);
      this.gl.uniformMatrix4fv(up.projMatrix, false, u.u_projMatrix);
    }
  }

  render(camera, cloud, opts = {}) {
    if (this._contextLost) return 0;
    const t0 = performance.now();
    if (!cloud) return 0;

    const gl = this.gl;
    const colorMode = opts.colorMode || 'rgb';
    const lightDir = opts.lightDir || DEFAULT_LIGHT_DIR;
    const ambient = opts.ambient != null ? opts.ambient : DEFAULT_AMBIENT;
    const shading = opts.shading !== false;

    const drawCall = cloud.getDrawCall(camera, this.width, this.height);
    const drawCount = drawCall.count;
    const hasIndices = !!drawCall.indices;
    const nodes = drawCall.nodes;

    const hasPoints = drawCount > 0 || (nodes && nodes.length > 0);

    const modeVal = COLOR_MODE_VALUE[colorMode] != null ? COLOR_MODE_VALUE[colorMode] : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.progPoint);

    this._applyCameraUniforms(camera, cloud);
    this._pointUniforms.uniform1i(this.uPoint.colorMode, 'point.colorMode', modeVal);

    const pointSize = opts.pointSize != null ? opts.pointSize : DEFAULT_POINT_SIZE;
    const pointSizeType = opts.pointSizeType != null ? opts.pointSizeType : 1;
    this._pointUniforms.uniform1f(this.uPoint.pointSize, 'point.pointSize', pointSize);
    this._pointUniforms.uniform1i(this.uPoint.pointSizeType, 'point.pointSizeType', pointSizeType);

    const useCloudTransform = opts.useCloudTransform ? 1 : 0;
    gl.uniform1i(this.uPoint.useCloudTransform, useCloudTransform);
    if (useCloudTransform) {
      gl.uniform3fv(this.uPoint.cloudRot, new Float32Array(opts.cloudRot || [0, 0, 0]));
      gl.uniform3fv(this.uPoint.cloudScale, new Float32Array(opts.cloudScale || [1, 1, 1]));
    }

    if (hasPoints) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);

      if (nodes) {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node.gpuVAO) continue;
          gl.bindVertexArray(node.gpuVAO);
          gl.drawArrays(gl.POINTS, 0, node.numPoints);
        }
      } else if (hasIndices) {
        if (!this._dynamicIndexVao) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return 0;
        }
        gl.bindVertexArray(this._dynamicIndexVao);
        this._uploadDynamicIndices(drawCall.indices, drawCount);
        gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
      } else {
        if (!this._cloudVao) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return 0;
        }
        gl.bindVertexArray(this._cloudVao);
        gl.drawArrays(gl.POINTS, 0, drawCount);
      }

      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);

      if (nodes) {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node.gpuVAO) continue;
          gl.bindVertexArray(node.gpuVAO);
          gl.drawArrays(gl.POINTS, 0, node.numPoints);
        }
      } else if (hasIndices) {
        gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
      } else {
        gl.drawArrays(gl.POINTS, 0, drawCount);
      }

      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    }

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
    this._benchFrameMs = performance.now() - t0;

    return drawCount;
  }

}
