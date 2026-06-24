import * as THREE from 'three';

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 color;
in float intensity;
in float classification;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform float u_pointSize;
uniform int u_pointSizeType;
uniform float u_spacing;
uniform int u_colorMode;
uniform float u_screenWidth;
uniform float u_screenHeight;
uniform float u_fov;
uniform vec3 u_center;
uniform float u_zMin;
uniform float u_zMax;
uniform float u_iMin;
uniform float u_iMax;

out vec3 v_color;
out float v_depth;
out float v_height;
out float v_pointSize;

const vec3 CLASS_COLORS[16] = vec3[16](
  vec3(0.5, 0.5, 0.5), vec3(0.7, 0.7, 0.7), vec3(0.55, 0.27, 0.07), vec3(0.0, 1.0, 0.0),
  vec3(0.0, 0.8, 0.0), vec3(0.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0), vec3(0.4, 0.4, 0.4),
  vec3(0.9, 0.9, 0.0), vec3(0.0, 0.5, 1.0), vec3(0.9, 0.8, 0.7), vec3(0.8, 0.8, 0.8),
  vec3(0.6, 0.6, 0.6), vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5)
);

void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;

  float viewDist = -mvPos.z;

  if (u_pointSizeType == 0) {
    gl_PointSize = clamp(u_pointSize, 1.0, 50.0);
  } else {
    float slope = tan(u_fov * 0.5);
    float projFactor = 0.5 * u_screenHeight / (slope * max(viewDist, 0.1));
    float spacing = u_spacing > 0.0 ? u_spacing : 1.0;
    float fillSize = spacing * projFactor;
    float ps = u_pointSize * 0.25 * fillSize;
    gl_PointSize = clamp(ps, 1.0, 50.0);
  }

  v_pointSize = gl_PointSize;
  v_depth = clamp((viewDist - 0.1) / 9999.0, 0.0, 1.0);
  v_height = (position.z - u_center.z - u_zMin) / max(u_zMax - u_zMin, 1e-6);

       if (u_colorMode == 0) { v_color = color; }
  else if (u_colorMode == 1) {
    float t = clamp(v_height, 0.0, 1.0);
    v_color = vec3(mix(0.1, 0.2, t), mix(0.3, 0.7, t), mix(0.6, 1.0, t));
  } else if (u_colorMode == 2) {
    float t = (intensity - u_iMin) / max(u_iMax - u_iMin, 1e-6);
    v_color = vec3(clamp(t, 0.0, 1.0));
  } else if (u_colorMode == 4) {
    int ci = min(int(classification), 15);
    v_color = CLASS_COLORS[ci];
  } else {
    v_color = vec3(v_depth);
  }
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_depth;
in float v_height;
in float v_pointSize;

out vec4 fragColor;

void main() {
  float dist = length(gl_PointCoord - 0.5) * 2.0;
  float edge = max(fwidth(dist), 1.0 / v_pointSize);
  float alpha = 1.0 - smoothstep(1.0 - edge * 2.0, 1.0, dist);
  if (alpha < 0.01) discard;
  fragColor = vec4(v_color, alpha);
}`;

export class ThreeRenderer {
  constructor() {
    this._scene = new THREE.Scene();
    this._pointsMap = new Map();
    this._nodeCount = 0;
    this._pointCount = 0;

    this._uniforms = {
      u_pointSize: { value: 3.0 },
      u_pointSizeType: { value: 1 },
      u_spacing: { value: 1.0 },
      u_colorMode: { value: 0 },
      u_screenWidth: { value: 1 },
      u_screenHeight: { value: 1 },
      u_fov: { value: 60.0 },
      u_center: { value: new THREE.Vector3() },
      u_zMin: { value: 0 },
      u_zMax: { value: 1 },
      u_iMin: { value: 0 },
      u_iMax: { value: 1 },
    };

    this._material = new THREE.RawShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
  }

  getScene() {
    return this._scene;
  }

  addNode(node, geometryData) {
    if (!geometryData || !geometryData.position) return;
    const numPoints = geometryData.numPoints;
    if (!numPoints || numPoints === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(geometryData.position, 3));

    if (geometryData.color && geometryData.color.length >= numPoints * 3) {
      geo.setAttribute('color', new THREE.BufferAttribute(geometryData.color, 3, true));
    } else {
      const fallback = new Uint8Array(numPoints * 3);
      fallback.fill(180);
      geo.setAttribute('color', new THREE.BufferAttribute(fallback, 3, true));
    }

    if (geometryData.intensity && geometryData.intensity.length >= numPoints) {
      geo.setAttribute('intensity', new THREE.BufferAttribute(geometryData.intensity, 1));
    } else {
      const fallback = new Float32Array(numPoints);
      fallback.fill(0);
      geo.setAttribute('intensity', new THREE.BufferAttribute(fallback, 1));
    }

    if (geometryData.classification && geometryData.classification.length >= numPoints) {
      geo.setAttribute('classification', new THREE.BufferAttribute(geometryData.classification, 1));
    } else {
      const fallback = new Uint8Array(numPoints);
      fallback.fill(0);
      geo.setAttribute('classification', new THREE.BufferAttribute(fallback, 1));
    }

    const points = new THREE.Points(geo, this._material);
    points.frustumCulled = false;

    const spacing = node.spacing != null ? node.spacing : 1.0;
    points.onBeforeRender = function (_renderer, _scene, _camera, _geometry, material, _group) {
      material.uniforms.u_spacing.value = spacing;
    };

    points.userData.nodeId = node.id;
    points.userData.numPoints = numPoints;

    this._pointsMap.set(node.id, points);
    this._scene.add(points);
    this._nodeCount = this._pointsMap.size;
    this._pointCount += numPoints;
  }

  removeNode(node) {
    const points = this._pointsMap.get(node.id);
    if (!points) return;
    this._pointCount -= points.userData.numPoints || 0;
    points.onBeforeRender = null;
    this._scene.remove(points);
    points.geometry.dispose();
    this._pointsMap.delete(node.id);
    this._nodeCount = this._pointsMap.size;
  }

  removeAll() {
    for (const [id, points] of this._pointsMap) {
      points.onBeforeRender = null;
      this._scene.remove(points);
      points.geometry.dispose();
    }
    this._pointsMap.clear();
    this._nodeCount = 0;
    this._pointCount = 0;
  }

  getNodeCount() {
    return this._nodeCount;
  }

  getTotalPoints() {
    return this._pointCount;
  }

  dispose() {
    this.removeAll();
    if (this._material) { this._material.dispose(); this._material = null; }
  }
}
