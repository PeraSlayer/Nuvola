/**
 * @file renderer.js
 * @description WebGL2 point cloud renderer implementing a deferred shading pipeline.
 *   Uploads point cloud geometry into GPU buffers, renders points into a
 *   color+depth framebuffer (G-buffer), and then composites the result with a
 *   full-screen lighting pass. Supports both standard isometric projection and
 *   perspective (FPS) camera modes, multiple colour-mapping modes (rgb, height,
 *   intensity, depth, classification), dynamic batching of octree nodes,
 *   optional cloud-transform uniforms, sketchfab-style opacity, and dreamy glow.
 *
 *   Key classes:
 *     UniformGuard – avoids redundant WebGL uniform uploads.
 *     Renderer     – owns the GL context, shaders, buffers, FBO, and draw loop.
 */

import {
  POINT_VERTEX_SHADER,
  POINT_FRAGMENT_SHADER,
  DEPTH_VERTEX_SHADER,
  DEPTH_FRAGMENT_SHADER,
  QUAD_VERTEX_SHADER,
  LIGHT_FRAGMENT_SHADER,
} from './shader.js';

/** Enum mapping colour-mode strings to shader uniform values. */
const COLOR_MODE_VALUE = Object.freeze({
  rgb: 0,
  height: 1,
  intensity: 2,
  depth: 3,
  classification: 4,
});

/** Default light direction vector in eye space. */
const DEFAULT_LIGHT_DIR = Object.freeze([0.5, 0.5, 1]);

/** GPU memory footprint per point in bytes (positions + colour + intensity + classification + opacity). */
const BYTES_PER_POINT_GPU = 12 + 3 + 4 + 1 + 4; // position(3×4) + color(3) + intensity(4) + classification(1) + opacity(4)

/** Upper bound on device-pixel ratio to prevent excessive FBO sizes. */
const MAX_DEVICE_PIXEL_RATIO = 3;

/** Default ambient light contribution (0–1). */
const DEFAULT_AMBIENT = 0.25;

/** Default point size in screen pixels. */
const DEFAULT_POINT_SIZE = 3.0;

/** Base batch capacity when available VRAM is unknown. */
const BATCH_CAPACITY_BASE = 200_000;

/** Absolute upper limit on batch capacity regardless of VRAM. */
const BATCH_CAPACITY_CEILING = 50_000_000;

/**
 * Heuristic to determine how many points can be batched into a single
 * draw call based on the GPU's texture/buffer size limits.
 * @param {WebGL2RenderingContext} gl
 * @returns {number} Maximum points per batch buffer.
 */
function detectBatchCapacity(gl) {
  const dbgRender = gl.getExtension('WEBGL_debug_renderer_info');
  let vramMB = 512;
  if (dbgRender) {
    const vendor = gl.getParameter(dbgRender.UNMASKED_VENDOR_WEBGL) || '';
    const gpu = gl.getParameter(dbgRender.UNMASKED_RENDERER_WEBGL) || '';
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxBuf = gl.getParameter(gl.MAX_ARRAY_BUFFER_BINDING) || 0;
    if (maxTex >= 16384) vramMB = 8192;
    else if (maxTex >= 8192) vramMB = 4096;
    else if (maxTex >= 4096) vramMB = 2048;
    else vramMB = Math.max(512, maxBuf ? Math.floor(maxBuf / (1024 * 1024)) : 512);
  }
  const cap = Math.floor(BATCH_CAPACITY_BASE * (vramMB / 512));
  return Math.min(cap, BATCH_CAPACITY_CEILING);
}

/**
 * Estimate VRAM in megabytes, primarily used for LRU cache budgeting.
 * @param {WebGL2RenderingContext} gl
 * @returns {number} VRAM estimate in MB.
 */
function detectVRAM_MB(gl) {
  const dbgRender = gl.getExtension('WEBGL_debug_renderer_info');
  if (!dbgRender) return 512;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxBuf = gl.getParameter(gl.MAX_ARRAY_BUFFER_BINDING) || 0;
  if (maxTex >= 16384) return 8192;
  if (maxTex >= 8192) return 4096;
  if (maxTex >= 4096) return 2048;
  return Math.max(512, maxBuf ? Math.floor(maxBuf / (1024 * 1024)) : 512);
}

/**
 * Wrapper around WebGL2 uniform setters that skips calls when the value has
 * not changed since the last invocation, reducing redundant GPU traffic.
 */
class UniformGuard {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;
    /** @type {Map<string, number>} */
    this.scalars = new Map();
    /** @type {Map<string, Float32Array>} */
    this.refs = new Map();
  }

  /**
   * Set a 1-component float uniform (no-op if unchanged).
   * @param {WebGLUniformLocation} loc
   * @param {string} key - Unique key for deduplication.
   * @param {number} val
   */
  uniform1f(loc, key, val) {
    if (this.scalars.get(key) === val) return;
    this.scalars.set(key, val);
    this.gl.uniform1f(loc, val);
  }

  /**
   * Set a 1-component integer uniform (no-op if unchanged).
   * @param {WebGLUniformLocation} loc
   * @param {string} key - Unique key for deduplication.
   * @param {number} val
   */
  uniform1i(loc, key, val) {
    if (this.scalars.get(key) === val) return;
    this.scalars.set(key, val);
    this.gl.uniform1i(loc, val);
  }

  /**
   * Set a 2-float-vector uniform (no-op if unchanged).
   * @param {WebGLUniformLocation} loc
   * @param {string} key
   * @param {Float32Array|number[]} val
   */
  uniform2fv(loc, key, val) {
    const prev = this.refs.get(key);
    if (prev && prev.length === 2 && prev[0] === val[0] && prev[1] === val[1]) return;
    this.refs.set(key, new Float32Array(val));
    this.gl.uniform2fv(loc, val);
  }

  /**
   * Set a 3-float-vector uniform (no-op if unchanged).
   * @param {WebGLUniformLocation} loc
   * @param {string} key
   * @param {Float32Array|number[]} val
   */
  uniform3fv(loc, key, val) {
    const prev = this.refs.get(key);
    if (prev && prev.length === 3 && prev[0] === val[0] && prev[1] === val[1] && prev[2] === val[2]) return;
    this.refs.set(key, new Float32Array(val));
    this.gl.uniform3fv(loc, val);
  }

  /**
   * Set a 4x4 matrix uniform (no-op if all 16 elements are unchanged).
   * @param {WebGLUniformLocation} loc
   * @param {string} key
   * @param {Float32Array|number[]} val - Column-major 16-element array.
   */
  uniformMatrix4fv(loc, key, val) {
    const prev = this.refs.get(key);
    if (prev && prev.length === 16 && prev[0] === val[0] && prev[1] === val[1] &&
        prev[2] === val[2] && prev[3] === val[3] && prev[4] === val[4] &&
        prev[5] === val[5] && prev[6] === val[6] && prev[7] === val[7] &&
        prev[8] === val[8] && prev[9] === val[9] && prev[10] === val[10] &&
        prev[11] === val[11] && prev[12] === val[12] && prev[13] === val[13] &&
        prev[14] === val[14] && prev[15] === val[15]) return;
    this.refs.set(key, new Float32Array(val));
    this.gl.uniformMatrix4fv(loc, false, val);
  }
}

/**
 * WebGL2 deferred-shading point-cloud renderer.
 *
 * Owns the GL context, compiles/link shaders, manages vertex buffers and VAOs,
 * maintains a framebuffer with dual colour attachments (RGB + depth-encoded),
 * and runs a two-pass render loop: point splatting into the G-buffer followed by
 * a full-screen lighting pass. Supports dynamic index-buffer based draws for
 * octree LOD selection as well as a batched-draw path for multiple octree nodes.
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas - A canvas element that will receive the WebGL2 context.
   */
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

    /** @type {object|null} The uploaded point-cloud object. */
    this._cloud = null;
    /** @type {WebGLVertexArrayObject|null} VAO for single-cloud draws. */
    this._cloudVao = null;
    this._lastDrawCount = 0;
    this._gpuBytes = 0;
    /** @type {WebGLRenderbuffer|null} */
    this._depthRB = null;
    this._fboValid = false;
    /** @type {number[]} Inverse texture size for lighting pass. */
    this._lightTexel = [1, 1];

    /** @type {WebGLBuffer|null} Dynamic element array buffer for indexed draws. */
    this._dynamicIndexBuf = null;
    /** @type {WebGLVertexArrayObject|null} VAO that uses the dynamic index buffer. */
    this._dynamicIndexVao = null;
    this._dynamicIndexBufSize = 0;

    this._benchFrameMs = 0;
    /** @type {object|null} Per-frame profiling data. */
    this._profile = null;
    this._contextLost = false;

    /** @type {Float32Array} Scratch buffer for cloud rotation uniform. */
    this._cloudRotBuf = new Float32Array(3);
    /** @type {Float32Array} Scratch buffer for cloud scale uniform. */
    this._cloudScaleBuf = new Float32Array(3);

    this._batchCapacity = detectBatchCapacity(this.gl);
    this._detectedVRAM_MB = detectVRAM_MB(this.gl);
    this._suggestedLRUBudget = Math.floor(this._detectedVRAM_MB * 0.6) * 1024 * 1024;

    // Batch-mode GPU resources (allocated on first uploadNode call).
    /** @type {WebGLVertexArrayObject|null} */
    this._batchVao = null;
    /** @type {WebGLBuffer|null} */
    this._batchVboPos = null;
    /** @type {WebGLBuffer|null} */
    this._batchVboCol = null;
    /** @type {WebGLBuffer|null} */
    this._batchVboInt = null;
    /** @type {WebGLBuffer|null} */
    this._batchVboClass = null;
    /** @type {WebGLBuffer|null} */
    this._batchVboOpacity = null;
    /** @type {WebGLBuffer|null} */
    this._batchIndexBuf = null;
    this._batchTotalPoints = 0;
    this._batchDrawStart = 0;
    this._batchContiguous = true;
    this._batchIndexDirty = true;
    this._batchNextOffset = 0;
    /** @type {{offset:number, count:number}[]} Free regions in batch buffer. */
    this._batchFreeRegions = [];
    /** @type {(number|null)[]} Cached visible node ids for index-diff detection. */
    this._batchVisibleNodeIds = [];
    /** @type {(number|null)[]} */
    this._batchVisibleOffsets = [];
    /** @type {(number|null)[]} */
    this._batchVisibleCounts = [];
    /** @type {number[]} Alternating start/count pairs for batched draw runs. */
    this._batchRuns = [];

    this._initShaders();
    this._initBuffers();
    this._initFBO();

    this._onContextLost = (e) => { e.preventDefault(); this._contextLost = true; };
    this._onContextRestored = () => {
      this._contextLost = false;
      this._initShaders();
      this._initBuffers();
      this._initFBO();
      if (this.width > 0) this._setupFBO(this.width, this.height);
    };
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
  }

  /**
   * Throw an error if a WebGL resource (e.g. buffer, texture) failed to create.
   * @param {*} resource
   * @param {string} label - Human-readable name for the error message.
   * @returns {*} The resource, if valid.
   * @throws {Error}
   */
  _requireResource(resource, label) {
    if (!resource) throw new Error(`Failed to create ${label}`);
    return resource;
  }

  /**
   * Compile a shader from GLSL source.
   * @param {number} type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
   * @param {string} src - GLSL source string.
   * @returns {WebGLShader}
   * @throws {Error} on compilation failure.
   */
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

  /**
   * Link vertex and fragment shaders into a program.
   * @param {WebGLShader} vs - Compiled vertex shader.
   * @param {WebGLShader} fs - Compiled fragment shader.
   * @returns {WebGLProgram}
   * @throws {Error} on link failure.
   */
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

  /**
   * Create shader programs and cache uniform/attribute locations.
   * Called once at construction and on context restore.
   */
  _initShaders() {
    const gl = this.gl;

    const vsPoint = this._compile(gl.VERTEX_SHADER, POINT_VERTEX_SHADER);
    const fsPoint = this._compile(gl.FRAGMENT_SHADER, POINT_FRAGMENT_SHADER);
    this.progPoint = this._link(vsPoint, fsPoint);
    gl.deleteShader(vsPoint);
    gl.deleteShader(fsPoint);

    const vsDepth = this._compile(gl.VERTEX_SHADER, DEPTH_VERTEX_SHADER);
    const fsDepth = this._compile(gl.FRAGMENT_SHADER, DEPTH_FRAGMENT_SHADER);
    this.progDepth = this._link(vsDepth, fsDepth);
    gl.deleteShader(vsDepth);
    gl.deleteShader(fsDepth);

    const vsQuad = this._compile(gl.VERTEX_SHADER, QUAD_VERTEX_SHADER);
    const fsLight = this._compile(gl.FRAGMENT_SHADER, LIGHT_FRAGMENT_SHADER);
    this.progLight = this._link(vsQuad, fsLight);
    gl.deleteShader(vsQuad);
    gl.deleteShader(fsLight);

    /** @type {Object<string, WebGLUniformLocation>} */
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
      spacing: gl.getUniformLocation(this.progPoint, 'u_spacing'),
      cameraMode: gl.getUniformLocation(this.progPoint, 'u_cameraMode'),
      viewMatrix: gl.getUniformLocation(this.progPoint, 'u_viewMatrix'),
      projMatrix: gl.getUniformLocation(this.progPoint, 'u_projMatrix'),
      screenWidth: gl.getUniformLocation(this.progPoint, 'u_screenWidth'),
      screenHeight: gl.getUniformLocation(this.progPoint, 'u_screenHeight'),
      fov: gl.getUniformLocation(this.progPoint, 'u_fov'),
      sketchfabOpacity: gl.getUniformLocation(this.progPoint, 'u_sketchfabOpacity'),
      dreamy: gl.getUniformLocation(this.progPoint, 'u_dreamy'),
    };

    /** @type {Object<string, WebGLUniformLocation>} */
    this.uLight = {
      colorTex: gl.getUniformLocation(this.progLight, 'u_colorTex'),
      depthTex: gl.getUniformLocation(this.progLight, 'u_depthTex'),
      texel: gl.getUniformLocation(this.progLight, 'u_texel'),
      lightDir: gl.getUniformLocation(this.progLight, 'u_lightDir'),
      ambient: gl.getUniformLocation(this.progLight, 'u_ambient'),
      shading: gl.getUniformLocation(this.progLight, 'u_shading'),
      skyEnabled: gl.getUniformLocation(this.progLight, 'u_skyEnabled'),
      skyColorTop: gl.getUniformLocation(this.progLight, 'u_skyColorTop'),
      skyColorBottom: gl.getUniformLocation(this.progLight, 'u_skyColorBottom'),
    };

    this._pointUniforms = new UniformGuard(gl);
    this._lightUniforms = new UniformGuard(gl);
    this.attrPos = gl.getAttribLocation(this.progPoint, 'a_position');
    this.attrCol = gl.getAttribLocation(this.progPoint, 'a_color');
    this.attrInt = gl.getAttribLocation(this.progPoint, 'a_intensity');
    this.attrClass = gl.getAttribLocation(this.progPoint, 'a_classification');
    this.attrOpacity = gl.getAttribLocation(this.progPoint, 'a_opacity');

    /** @type {Object<string, WebGLUniformLocation>} */
    this.uDepth = {
      resolution: gl.getUniformLocation(this.progDepth, 'u_resolution'),
      pan: gl.getUniformLocation(this.progDepth, 'u_pan'),
      zoom: gl.getUniformLocation(this.progDepth, 'u_zoom'),
      rot: gl.getUniformLocation(this.progDepth, 'u_rot'),
      rotX: gl.getUniformLocation(this.progDepth, 'u_rotX'),
      rotY: gl.getUniformLocation(this.progDepth, 'u_rotY'),
      center: gl.getUniformLocation(this.progDepth, 'u_center'),
      cameraMode: gl.getUniformLocation(this.progDepth, 'u_cameraMode'),
      viewMatrix: gl.getUniformLocation(this.progDepth, 'u_viewMatrix'),
      projMatrix: gl.getUniformLocation(this.progDepth, 'u_projMatrix'),
    };
    this._depthUniforms = new UniformGuard(gl);
  }

  /**
   * Create the VBOs for single-cloud rendering and the full-screen quad VAO.
   * Also initialises batch buffers.
   */
  _initBuffers() {
    const gl = this.gl;

    this.vboPos = this._requireResource(gl.createBuffer(), 'position buffer');
    this.vboCol = this._requireResource(gl.createBuffer(), 'color buffer');
    this.vboInt = this._requireResource(gl.createBuffer(), 'intensity buffer');
    this.vboClass = this._requireResource(gl.createBuffer(), 'classification buffer');
    this.vboOpacity = this._requireResource(gl.createBuffer(), 'opacity buffer');
    this._quadVao = this._requireResource(gl.createVertexArray(), 'quad VAO');

    this._initBatchBuffers();
  }

  /**
   * Allocate (or re-create) the big batch vertex buffers and VAO.
   * The capacity is determined by `_batchCapacity`. Existing resources are
   * destroyed before new ones are created to allow resizing.
   */
  _initBatchBuffers() {
    const gl = this.gl;
    const cap = this._batchCapacity;

    if (this._batchVao) gl.deleteVertexArray(this._batchVao);
    this._batchVao = this._requireResource(gl.createVertexArray(), 'batch VAO');
    gl.bindVertexArray(this._batchVao);

    this._batchVboPos = this._requireResource(gl.createBuffer(), 'batch pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboPos);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attrPos);
    gl.vertexAttribPointer(this.attrPos, 3, gl.FLOAT, false, 0, 0);

    this._batchVboCol = this._requireResource(gl.createBuffer(), 'batch col');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboCol);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 3, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attrCol);
    gl.vertexAttribPointer(this.attrCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    this._batchVboInt = this._requireResource(gl.createBuffer(), 'batch int');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboInt);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attrInt);
    gl.vertexAttribPointer(this.attrInt, 1, gl.FLOAT, false, 0, 0);

    this._batchVboClass = this._requireResource(gl.createBuffer(), 'batch class');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboClass);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 1, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attrClass);
    gl.vertexAttribPointer(this.attrClass, 1, gl.UNSIGNED_BYTE, false, 0, 0);

    this._batchVboOpacity = this._requireResource(gl.createBuffer(), 'batch opac');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboOpacity);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attrOpacity);
    gl.vertexAttribPointer(this.attrOpacity, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    this._batchNextOffset = 0;
    this._batchFreeRegions = [];
    this._batchIndexDirty = true;
    this._batchTotalPoints = 0;
    this._batchDrawStart = 0;
    this._batchContiguous = true;
    this._batchVisibleNodeIds.length = 0;
    this._batchVisibleOffsets.length = 0;
    this._batchVisibleCounts.length = 0;
    this._batchRuns.length = 0;
  }

  /**
   * Create the framebuffer with two RGBA8 colour attachments and a depth
   * renderbuffer. Textures are created but their storage is allocated later
   * in `_setupFBO`.
   */
  _initFBO() {
    const gl = this.gl;
    this.fbo = this._requireResource(gl.createFramebuffer(), 'framebuffer');
    this.colorTex = this._requireResource(gl.createTexture(), 'color texture');
    this.depthTex = this._requireResource(gl.createTexture(), 'depth texture');
  }

  /**
   * Clamp the device-pixel ratio to a reasonable maximum.
   * @param {number} [value=window.devicePixelRatio]
   * @returns {number}
   */
  _devicePixelRatio(value = window.devicePixelRatio) {
    return Math.min(value || 1, MAX_DEVICE_PIXEL_RATIO);
  }

  /**
   * Configure a 2D RGBA8 texture with linear filtering and clamp-to-edge wrapping.
   * @param {WebGLTexture} tex
   * @param {number} width
   * @param {number} height
   */
  _configureRGBA8Texture(tex, width, height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /**
   * Resize the G-buffer textures and depth renderbuffer to match the current
   * canvas size. Must be called whenever the canvas changes size.
   * @param {number} w - Width in physical pixels.
   * @param {number} h - Height in physical pixels.
   */
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

  /**
   * Resize the canvas and internal framebuffer. CSS width/height are set to
   * the logical (CSS) size, while the GL backing store uses physical pixels.
   * @param {number} w - Logical (CSS) width.
   * @param {number} h - Logical (CSS) height.
   */
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

  /**
   * Re-initialise shaders, buffers, and FBO if they were lost due to a
   * WebGL context loss event.
   */
  _ensureResources() {
    this._contextLost = false;
    if (this.progPoint && this.progDepth && this.progLight) return;
    this._initShaders();
    this._initBuffers();
    this._initFBO();
    if (this.width > 0 && this.height > 0) {
      this._setupFBO(this.width, this.height);
    }
  }

  /**
   * Public method to explicitly restore GPU state after a context loss.
   */
  restoreGPUState() {
    this._ensureResources();
  }

  /**
   * Upload a full point cloud into the single-cloud VBOs and create its VAO.
   * Also sets up the dynamic index buffer used for octree-LOD indexed draws.
   * @param {object} cloud - Point cloud object with positions, colors, optional intensity/classification/opacity arrays.
   */
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

    if (cloud.classification) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboClass);
      gl.bufferData(gl.ARRAY_BUFFER, cloud.classification, gl.STATIC_DRAW);
    }

    if (cloud.opacity) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboOpacity);
      gl.bufferData(gl.ARRAY_BUFFER, cloud.opacity, gl.STATIC_DRAW);
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

    // Free CPU-side copies that are no longer needed when octree geometry is absent.
    if (!cloud.octreeGeometry) {
      cloud.colors = null;
      cloud.intensity = null;
    }
  }

  /**
   * Destroy the single-cloud VAOs and dynamic index buffer.
   */
  _disposeCloudVAOs() {
    const gl = this.gl;
    if (this._cloudVao) { gl.deleteVertexArray(this._cloudVao); this._cloudVao = null; }
    if (this._dynamicIndexVao) { gl.deleteVertexArray(this._dynamicIndexVao); this._dynamicIndexVao = null; }
    if (this._dynamicIndexBuf) { gl.deleteBuffer(this._dynamicIndexBuf); this._dynamicIndexBuf = null; }
    this._dynamicIndexBufSize = 0;
  }

  /**
   * Upload a single octree node's geometry into the batch buffer system.
   * A region is allocated from the batch pool; missing attributes get default
   * fallback data. The node is tracked so that `removeNode` can free its space.
   * @param {object} node - Octree node with `.geometryData` and `.onDispose` support.
   */
  uploadNode(node) {
    const gl = this.gl;
    const gd = node.geometryData;
    if (!gd || !gd.position) return;
    const numPoints = gd.numPoints;

    if (!this._batchVao) this._initBatchBuffers();

    const offset = this._allocateBatchRegion(numPoints);
    if (offset < 0) {
      console.warn('Batch capacity exceeded, skipping node');
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, offset * 3 * 4, gd.position);

    // Default colour fallback: grey.
    let colData = gd.color;
    if (!colData) {
      colData = new Uint8Array(numPoints * 3);
      for (let i = 0; i < numPoints * 3; i++) colData[i] = 180;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboCol);
    gl.bufferSubData(gl.ARRAY_BUFFER, offset * 3, colData);

    let intData = gd.intensity;
    if (!intData) {
      intData = new Float32Array(numPoints);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboInt);
    gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, intData);

    let classData = gd.classification;
    if (!classData) {
      classData = new Uint8Array(numPoints);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboClass);
    gl.bufferSubData(gl.ARRAY_BUFFER, offset * 1, classData);

    let opacityData = gd.opacity;
    if (!opacityData) {
      opacityData = new Float32Array(numPoints);
      opacityData.fill(1.0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._batchVboOpacity);
    gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, opacityData);

    // Register a one-shot dispose handler so the batch region is freed when
    // the octree node is evicted.
    if (!node._rendererDisposeHandlerRegistered) {
      node._rendererDisposeHandlerRegistered = true;
      node.onDispose((n) => {
        n._rendererDisposeHandlerRegistered = false;
        this.removeNode(n);
      });
    }

    node._batchOffset = offset;
    node._batchCount = numPoints;
    node.numPoints = numPoints;

    const gpuBytes = numPoints * BYTES_PER_POINT_GPU;
    node._gpuBytes = gpuBytes;
    this._gpuBytes += gpuBytes;

    this._batchIndexDirty = true;
  }

  /**
   * Try to allocate a contiguous region in the batch buffer for N points.
   * Returns the start offset or -1 if no space is available.
   * @param {number} numPoints
   * @returns {number} Offset into the batch buffer or -1.
   */
  _allocateBatchRegion(numPoints) {
    // First, try to satisfy from the free-region pool.
    for (let i = 0; i < this._batchFreeRegions.length; i++) {
      const fr = this._batchFreeRegions[i];
      if (fr.count >= numPoints) {
        const offset = fr.offset;
        if (fr.count === numPoints) {
          this._batchFreeRegions.splice(i, 1);
        } else {
          fr.offset += numPoints;
          fr.count -= numPoints;
        }
        return offset;
      }
    }

    // Otherwise, append to the end if enough capacity remains.
    if (this._batchNextOffset + numPoints > this._batchCapacity) return -1;
    const offset = this._batchNextOffset;
    this._batchNextOffset += numPoints;
    return offset;
  }

  /**
   * Return a used region back to the free-region pool.
   * @param {number} offset
   * @param {number} count
   */
  _freeBatchRegion(offset, count) {
    this._batchFreeRegions.push({ offset, count });
    this._mergeFreeRegions();
  }

  /**
   * Coalesce adjacent free regions in the pool to reduce fragmentation.
   */
  _mergeFreeRegions() {
    const fr = this._batchFreeRegions;
    fr.sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < fr.length - 1; i++) {
      if (fr[i].offset + fr[i].count >= fr[i + 1].offset) {
        fr[i].count = Math.max(fr[i].count, fr[i + 1].offset + fr[i + 1].count - fr[i].offset);
        fr.splice(i + 1, 1);
        i--;
      }
    }
  }

  /**
   * Release a node's batch region so it can be reused.
   * @param {object} node - Octree node previously uploaded via `uploadNode`.
   */
  removeNode(node) {
    if (node._batchOffset != null && node._batchCount > 0) {
      this._freeBatchRegion(node._batchOffset, node._batchCount);
      node._batchOffset = null;
      node._batchCount = 0;
      this._batchIndexDirty = true;
    }
    const gpuBytes = node._gpuBytes || 0;
    this._gpuBytes -= gpuBytes;
    node._gpuBytes = 0;
    if (this._gpuBytes < 0) this._gpuBytes = 0;
  }

  /**
   * Destroy all batch-mode GPU resources.
   */
  _disposeBatchBuffers() {
    const gl = this.gl;
    if (this._batchVao) { gl.deleteVertexArray(this._batchVao); this._batchVao = null; }
    if (this._batchVboPos) { gl.deleteBuffer(this._batchVboPos); this._batchVboPos = null; }
    if (this._batchVboCol) { gl.deleteBuffer(this._batchVboCol); this._batchVboCol = null; }
    if (this._batchVboInt) { gl.deleteBuffer(this._batchVboInt); this._batchVboInt = null; }
    if (this._batchVboClass) { gl.deleteBuffer(this._batchVboClass); this._batchVboClass = null; }
    if (this._batchVboOpacity) { gl.deleteBuffer(this._batchVboOpacity); this._batchVboOpacity = null; }
    this._batchIndexBuf = null;
    this._batchTotalPoints = 0;
    this._batchDrawStart = 0;
    this._batchContiguous = true;
    this._batchNextOffset = 0;
    this._batchFreeRegions = [];
    this._batchIndexDirty = true;
    this._batchVisibleNodeIds.length = 0;
    this._batchVisibleOffsets.length = 0;
    this._batchVisibleCounts.length = 0;
    this._batchRuns.length = 0;
  }

  /**
   * Check whether the cached batch index is still valid for the given set of
   * visible nodes (same ids in same order with same offsets/counts).
   * @param {object[]} visibleNodes
   * @returns {boolean}
   */
  _isBatchIndexCurrent(visibleNodes) {
    if (this._batchIndexDirty) return false;
    if (visibleNodes.length !== this._batchVisibleNodeIds.length) return false;

    for (let i = 0; i < visibleNodes.length; i++) {
      const node = visibleNodes[i];
      if (node.id !== this._batchVisibleNodeIds[i] ||
          node._batchOffset !== this._batchVisibleOffsets[i] ||
          node._batchCount !== this._batchVisibleCounts[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Rebuild the batch draw order for a list of visible nodes. Nodes are
   * depth-sorted (back to front) to help with semi-transparent points.
   * Computes contiguous/non-contiguous draw ranges stored in `_batchRuns`.
   * @param {object[]} visibleNodes
   * @param {object|null} cameraPosition - {x,y,z} world position for depth sort.
   */
  _rebuildBatchIndex(visibleNodes, cameraPosition) {
    const sortedNodes = this._sortNodesByDepth(visibleNodes, cameraPosition);

    let total = 0;
    let contiguous = true;
    let expected = -1;
    let drawStart = 0;
    const runs = this._batchRuns;
    runs.length = 0;
    let runStart = -1;
    let runEnd = 0;

    for (let i = 0; i < sortedNodes.length; i++) {
      const n = sortedNodes[i];
      if (n._batchOffset == null || n._batchCount <= 0) continue;
      if (expected < 0) {
        expected = n._batchOffset;
        drawStart = n._batchOffset;
      }
      if (n._batchOffset !== expected) contiguous = false;

      if (runStart < 0 || n._batchOffset !== runEnd) {
        if (runStart >= 0) runs.push(runStart, runEnd - runStart);
        runStart = n._batchOffset;
      }
      runEnd = n._batchOffset + n._batchCount;
      expected = n._batchOffset + n._batchCount;
      total += n._batchCount;
    }
    if (runStart >= 0) runs.push(runStart, runEnd - runStart);

    this._batchTotalPoints = total;
    this._batchDrawStart = drawStart;
    this._batchContiguous = contiguous;

    this._batchVisibleNodeIds.length = sortedNodes.length;
    this._batchVisibleOffsets.length = sortedNodes.length;
    this._batchVisibleCounts.length = sortedNodes.length;
    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];
      this._batchVisibleNodeIds[i] = node.id;
      this._batchVisibleOffsets[i] = node._batchOffset;
      this._batchVisibleCounts[i] = node._batchCount;
    }

    this._batchIndexDirty = false;
  }

  /**
   * Sort nodes by squared distance to the camera (back-to-front).
   * @param {object[]} nodes
   * @param {object|null} cameraPosition - {x,y,z} world position.
   * @returns {object[]} Sorted copy of nodes.
   */
  _sortNodesByDepth(nodes, cameraPosition) {
    if (!cameraPosition || nodes.length < 2) return nodes;

    const sorted = nodes.slice();
    sorted.sort((a, b) => {
      const aCenter = a.boundingSphere?.center;
      const bCenter = b.boundingSphere?.center;
      if (!aCenter || !bCenter) return 0;

      const aDist = (aCenter.x - cameraPosition.x) ** 2 +
                    (aCenter.y - cameraPosition.y) ** 2 +
                    (aCenter.z - cameraPosition.z) ** 2;
      const bDist = (bCenter.x - cameraPosition.x) ** 2 +
                    (bCenter.y - cameraPosition.y) ** 2 +
                    (bCenter.z - cameraPosition.z) ** 2;
      return aDist - bDist;
    });
    return sorted;
  }

  /**
   * Release all WebGL resources (VAOs, VBOs, textures, renderbuffers, programs).
   * Also removes context-lost/restored event listeners.
   */
  dispose() {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._disposeCloudVAOs();
    this._disposeBatchBuffers();

    if (this.vboPos)  { gl.deleteBuffer(this.vboPos);  this.vboPos = null; }
    if (this.vboCol)  { gl.deleteBuffer(this.vboCol);  this.vboCol = null; }
    if (this.vboInt)  { gl.deleteBuffer(this.vboInt);  this.vboInt = null; }
    if (this.vboClass) { gl.deleteBuffer(this.vboClass); this.vboClass = null; }
    if (this.vboOpacity) { gl.deleteBuffer(this.vboOpacity); this.vboOpacity = null; }
    if (this._quadVao) { gl.deleteVertexArray(this._quadVao); this._quadVao = null; }

    if (this.fbo)      { gl.deleteFramebuffer(this.fbo);    this.fbo = null; }
    if (this.colorTex) { gl.deleteTexture(this.colorTex);   this.colorTex = null; }
    if (this.depthTex) { gl.deleteTexture(this.depthTex);   this.depthTex = null; }
    if (this._depthRB) { gl.deleteRenderbuffer(this._depthRB); this._depthRB = null; }

    if (this.progPoint) { gl.deleteProgram(this.progPoint); this.progPoint = null; }
    if (this.progDepth) { gl.deleteProgram(this.progDepth); this.progDepth = null; }
    if (this.progLight) { gl.deleteProgram(this.progLight); this.progLight = null; }

    this._cloud = null;
    this._gpuBytes = 0;
    this._lastDrawCount = 0;
    this._pointUniforms = null;
    this._lightUniforms = null;
    this._fboValid = false;
  }

  /**
   * Estimate total GPU memory used by the renderer in MB.
   * @returns {string} Formatted MB string (one decimal place).
   */
  getMemoryMB() {
    let total = this._gpuBytes;
    if (this._dynamicIndexBuf) total += this._dynamicIndexBufSize;
    const fboTex = this.width * this.height * 4;
    total += fboTex * 2;
    total += this.width * this.height * 3;
    return (total / (1024 * 1024)).toFixed(1);
  }

  /** @returns {number} Maximum number of points per batch buffer. */
  get batchCapacity() {
    return this._batchCapacity;
  }

  /** @returns {number} Detected VRAM in megabytes. */
  get detectedVRAM_MB() {
    return this._detectedVRAM_MB;
  }

  /** @returns {number} Suggested LRU cache byte budget (60 % of detected VRAM). */
  get suggestedLRUBudget() {
    return this._suggestedLRUBudget;
  }

  /**
   * Return a simple benchmark object with the last frame's total milliseconds.
   * @returns {{frameMs: number}}
   */
  getBench() {
    return { frameMs: this._benchFrameMs };
  }

  /**
   * Return the detailed per-frame profiling breakdown.
   * @returns {{selectMs:number, rebuildMs:number, cpuMs:number, pointMs:number, lightMs:number, totalMs:number}}
   */
  getProfile() {
    return this._profile || { selectMs: 0, rebuildMs: 0, cpuMs: 0, pointMs: 0, lightMs: 0, totalMs: 0 };
  }

  /**
   * Create a VAO that binds the per-cloud VBOs to the point-shader attributes.
   * If intensity, classification, or opacity buffers are not present on the
   * cloud, the corresponding attribute is disabled and a constant value is used.
   * @param {object} cloud - Point cloud object.
   * @param {WebGLBuffer|null} [indexBuffer=null] - Optional element array buffer.
   * @returns {WebGLVertexArrayObject}
   */
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

    if (cloud.classification && this.attrClass >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboClass);
      gl.enableVertexAttribArray(this.attrClass);
      gl.vertexAttribPointer(this.attrClass, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    } else if (this.attrClass >= 0) {
      gl.disableVertexAttribArray(this.attrClass);
      gl.vertexAttrib1f(this.attrClass, 0.0);
    }

    if (cloud.opacity && this.attrOpacity >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vboOpacity);
      gl.enableVertexAttribArray(this.attrOpacity);
      gl.vertexAttribPointer(this.attrOpacity, 1, gl.FLOAT, false, 0, 0);
    } else if (this.attrOpacity >= 0) {
      gl.disableVertexAttribArray(this.attrOpacity);
      gl.vertexAttrib1f(this.attrOpacity, 1.0);
    }

    if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    return vao;
  }

  /**
   * Upload index data into the dynamic element array buffer, growing it if necessary.
   * @param {Uint32Array} buf - Index array.
   * @param {number} count - Number of indices.
   */
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

  /**
   * Transmit camera-related uniforms to the point vertex shader.
   * @param {object} camera - Camera object with `.getUniforms()` method.
   * @param {object} cloud  - Point cloud object (used for range uniforms).
   */
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

    apply.uniform1f(up.screenWidth, 'point.screenWidth', this.width);
    apply.uniform1f(up.screenHeight, 'point.screenHeight', this.height);

    const fov = camera.activeMode === 'fps'
      ? (camera.perspectiveCamera.fov * Math.PI / 180) : 1.0;
    apply.uniform1f(up.fov, 'point.fov', fov);

    const spacing = u.u_spacing != null ? u.u_spacing : 1.0;
    apply.uniform1f(up.spacing, 'point.spacing', spacing);

    if (cameraMode === 1 && u.u_viewMatrix && u.u_projMatrix) {
      apply.uniformMatrix4fv(up.viewMatrix, 'point.viewMatrix', u.u_viewMatrix);
      apply.uniformMatrix4fv(up.projMatrix, 'point.projMatrix', u.u_projMatrix);
    }
  }

  /**
   * Transmit camera-related uniforms to the depth shader.
   * @param {object} camera
   * @param {object} cloud
   */
  _applyDepthUniforms(camera, cloud) {
    const u = camera.getUniforms(this.width, this.height, cloud);
    const apply = this._depthUniforms;
    const ud = this.uDepth;
    const cameraMode = u.u_cameraMode || 0;

    apply.uniform2fv(ud.resolution, 'depth.resolution', u.u_resolution);
    apply.uniform2fv(ud.pan, 'depth.pan', u.u_pan);
    apply.uniform1f(ud.zoom, 'depth.zoom', u.u_zoom);
    apply.uniform1f(ud.rot, 'depth.rot', u.u_rot);
    apply.uniform1f(ud.rotX, 'depth.rotX', u.u_rotX);
    apply.uniform1f(ud.rotY, 'depth.rotY', u.u_rotY);
    apply.uniform3fv(ud.center, 'depth.center', u.u_center);
    apply.uniform1i(ud.cameraMode, 'depth.cameraMode', cameraMode);

    if (cameraMode === 1 && u.u_viewMatrix && u.u_projMatrix) {
      apply.uniformMatrix4fv(ud.viewMatrix, 'depth.viewMatrix', u.u_viewMatrix);
      apply.uniformMatrix4fv(ud.projMatrix, 'depth.projMatrix', u.u_projMatrix);
    }
  }

  /**
   * Main render entry point. Executes:
   *   1. Point splatting pass into the G-buffer (FBO).
   *   2. Full-screen lighting pass (default framebuffer).
   *
   * Supports three draw paths:
   *   - Batch-mode (multiple octree nodes sharing one big buffer).
   *   - Indexed dynamic draw (single cloud with octree LOD selection).
   *   - Full-cloud drawArrays (no octree, single VAO).
   *
   * @param {object} camera - Camera object providing uniforms and draw call.
   * @param {object} cloud  - Point cloud object (may have octree geometry).
   * @param {object} [opts={}] - Render options.
   * @param {string} [opts.colorMode='rgb'] - Colour mapping mode.
   * @param {number[]} [opts.lightDir] - Light direction in eye space.
   * @param {number} [opts.ambient] - Ambient light contribution.
   * @param {boolean} [opts.shading=true] - Enable diffuse shading.
   * @param {number} [opts.pointSize] - Point size in pixels.
   * @param {number} [opts.pointSizeType] - 0 = fixed, 1 = density-aware.
   * @param {number} [opts.sketchfabOpacity] - Sketchfab-style opacity.
   * @param {number} [opts.dreamy] - Dreamy glow intensity.
   * @param {boolean} [opts.useCloudTransform] - Apply cloud rotation/scale.
   * @param {number[]} [opts.cloudRot] - Cloud rotation [rx, ry, rz].
   * @param {number[]} [opts.cloudScale] - Cloud scale [sx, sy, sz].
   * @param {boolean} [opts.skyEnabled] - Enable sky colour background.
   * @param {number[]} [opts.skyColorTop] - Top sky colour.
   * @param {number[]} [opts.skyColorBottom] - Bottom sky colour.
   * @returns {number} Number of points drawn (0 if context lost).
   */
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
    const t1 = performance.now();
    const drawCount = drawCall.count;
    const hasIndices = !!drawCall.indices;
    const nodes = drawCall.nodes;

    const hasPoints = drawCount > 0 || (nodes && nodes.length > 0);

    const modeVal = COLOR_MODE_VALUE[colorMode] != null ? COLOR_MODE_VALUE[colorMode] : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const pointSize = opts.pointSize != null ? opts.pointSize : DEFAULT_POINT_SIZE;
    const pointSizeType = opts.pointSizeType != null ? opts.pointSizeType : 1;
    const sketchfabOpacity = opts.sketchfabOpacity != null ? opts.sketchfabOpacity : 0;
    const dreamy = opts.dreamy != null ? opts.dreamy : 0;

    let rebuildMs = 0;

    // ---- Pass 1: Point splatting ----
    if (hasPoints) {
      gl.useProgram(this.progPoint);

      this._applyCameraUniforms(camera, cloud);
      this._pointUniforms.uniform1i(this.uPoint.colorMode, 'point.colorMode', modeVal);
      this._pointUniforms.uniform1f(this.uPoint.pointSize, 'point.pointSize', pointSize);
      this._pointUniforms.uniform1i(this.uPoint.pointSizeType, 'point.pointSizeType', pointSizeType);
      this._pointUniforms.uniform1f(this.uPoint.sketchfabOpacity, 'point.sketchfabOpacity', sketchfabOpacity);
      this._pointUniforms.uniform1f(this.uPoint.dreamy, 'point.dreamy', dreamy);

      const useCloudTransform = opts.useCloudTransform ? 1 : 0;
      this._pointUniforms.uniform1i(this.uPoint.useCloudTransform, 'point.useCloudTransform', useCloudTransform);
      if (useCloudTransform) {
        const rot = opts.cloudRot || [0, 0, 0];
        const scale = opts.cloudScale || [1, 1, 1];
        this._cloudRotBuf[0] = rot[0]; this._cloudRotBuf[1] = rot[1]; this._cloudRotBuf[2] = rot[2];
        this._cloudScaleBuf[0] = scale[0]; this._cloudScaleBuf[1] = scale[1]; this._cloudScaleBuf[2] = scale[2];
        this._pointUniforms.uniform3fv(this.uPoint.cloudRot, 'point.cloudRot', this._cloudRotBuf);
        this._pointUniforms.uniform3fv(this.uPoint.cloudScale, 'point.cloudScale', this._cloudScaleBuf);
      }

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.colorMask(true, true, true, true);

      if (sketchfabOpacity > 0 || dreamy > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.disable(gl.BLEND);
      }

      // Branch 1: Octree-node batch draw.
      if (nodes && this._batchVao) {
        const camPos = camera.getWorldPosition ? camera.getWorldPosition() : null;
        if (!this._isBatchIndexCurrent(nodes)) {
          const rt0 = performance.now();
          this._rebuildBatchIndex(nodes, camPos);
          rebuildMs = performance.now() - rt0;
        }
        if (this._batchTotalPoints > 0) {
          gl.bindVertexArray(this._batchVao);
          if (this._batchContiguous) {
            gl.drawArrays(gl.POINTS, this._batchDrawStart, this._batchTotalPoints);
          } else {
            const runs = this._batchRuns;
            for (let r = 0; r < runs.length; r += 2) {
              gl.drawArrays(gl.POINTS, runs[r], runs[r + 1]);
            }
          }
        }
      // Branch 2: Indexed per-cloud LOD draw.
      } else if (hasIndices) {
        if (!this._dynamicIndexVao) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return 0;
        }
        gl.bindVertexArray(this._dynamicIndexVao);
        this._uploadDynamicIndices(drawCall.indices, drawCount);
        gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
      // Branch 3: Full-cloud unfiltered draw.
      } else {
        if (!this._cloudVao) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return 0;
        }
        gl.bindVertexArray(this._cloudVao);
        gl.drawArrays(gl.POINTS, 0, drawCount);
      }
    }
    const t2 = performance.now();

    // ---- Pass 2: Full-screen lighting ----
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

    const skyEnabled = opts.skyEnabled ? 1 : 0;
    const skyColorTop = opts.skyColorTop || [0.4, 0.6, 0.9];
    const skyColorBottom = opts.skyColorBottom || [0.7, 0.85, 1.0];
    this._lightUniforms.uniform1f(this.uLight.skyEnabled, 'light.skyEnabled', skyEnabled);
    this._lightUniforms.uniform3fv(this.uLight.skyColorTop, 'light.skyColorTop', skyColorTop);
    this._lightUniforms.uniform3fv(this.uLight.skyColorBottom, 'light.skyColorBottom', skyColorBottom);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const t3 = performance.now();

    this._profile = {
      selectMs: drawCall.profiling?.selectNodesMs || 0,
      rebuildMs: rebuildMs,
      cpuMs: t1 - t0,
      pointMs: t2 - t1,
      lightMs: t3 - t2,
      totalMs: t3 - t0,
    };

    this._lastDrawCount = drawCount;
    this._benchFrameMs = t3 - t0;

    return drawCount;
  }

}
