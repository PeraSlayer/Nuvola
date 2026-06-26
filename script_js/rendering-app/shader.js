export const POINT_VERTEX_SHADER = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 a_position;
  layout(location = 1) in vec3 a_color;
  layout(location = 2) in float a_intensity;
  layout(location = 3) in float a_classification;
  layout(location = 4) in float a_opacity;
  uniform vec2 u_resolution;
  uniform vec2 u_pan;
  uniform float u_zoom;
  uniform float u_rot;
  uniform float u_rotX, u_rotY, u_rotZ;
  uniform vec3 u_center;
  uniform float u_zMin, u_zMax;
  uniform float u_depthMin, u_depthMax;
  uniform float u_iMin, u_iMax;
  uniform int u_colorMode;
  uniform bool u_useCloudTransform;
  uniform vec3 u_cloudRot;
  uniform vec3 u_cloudScale;
  uniform float u_pointSize;
  uniform int u_pointSizeType;
  uniform float u_spacing;
  uniform int u_cameraMode;
  uniform mat4 u_viewMatrix;
  uniform mat4 u_projMatrix;
  uniform float u_screenWidth;
  uniform float u_screenHeight;
  uniform float u_fov;
  out vec3 v_color;
  out float v_depth;
  out float v_height;
  out float v_pointSize;
  out float v_opacity;

  const vec3 CLASS_COLORS[16] = vec3[16](
    vec3(0.5, 0.5, 0.5),
    vec3(0.7, 0.7, 0.7),
    vec3(0.55, 0.27, 0.07),
    vec3(0.0, 1.0, 0.0),
    vec3(0.0, 0.8, 0.0),
    vec3(0.0, 0.5, 0.0),
    vec3(1.0, 0.0, 0.0),
    vec3(0.4, 0.4, 0.4),
    vec3(0.9, 0.9, 0.0),
    vec3(0.0, 0.5, 1.0),
    vec3(0.9, 0.8, 0.7),
    vec3(0.8, 0.8, 0.8),
    vec3(0.6, 0.6, 0.6),
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5)
  );

  void main() {
      vec3 local = a_position - u_center;
      if (u_useCloudTransform) {
        local *= u_cloudScale;
        float cx = cos(u_cloudRot.x), sx = sin(u_cloudRot.x);
        float y1 = local.y * cx - local.z * sx;
        float z1 = local.y * sx + local.z * cx;
        local.y = y1; local.z = z1;
        float cy = cos(u_cloudRot.y), sy = sin(u_cloudRot.y);
        float x1 = local.x * cy + local.z * sy;
        float z2 = -local.x * sy + local.z * cy;
        local.x = x1; local.z = z2;
        float cz = cos(u_cloudRot.z), sz = sin(u_cloudRot.z);
        float x2 = local.x * cz - local.y * sz;
        float y2 = local.x * sz + local.y * cz;
        local.x = x2; local.y = y2;
      }

      float dNorm;
      if (u_cameraMode == 1) {
         vec4 worldPos = vec4(a_position, 1.0);
         vec4 viewPos = u_viewMatrix * worldPos;
         vec4 clipPos = u_projMatrix * viewPos;
         gl_Position = clipPos;
         float viewDist = -viewPos.z;
         dNorm = clamp((viewDist - 0.1) / 9999.9, 0.0, 1.0);

          if (u_pointSizeType == 0) {
            gl_PointSize = clamp(u_pointSize, 1.0, 50.0);
          } else {
            float slope = tan(u_fov * 0.5);
            float projFactor = 0.5 * u_screenHeight / (slope * max(viewDist, 0.1));
            float spacing = u_spacing > 0.0 ? u_spacing : 1.0;
            float fillSize = spacing * projFactor;
            float ps = u_pointSize * 0.5 * fillSize;
            gl_PointSize = clamp(ps, 1.0, 12.0);
          }
       } else {
        float cosX = cos(u_rotX), sinX = sin(u_rotX);
        float y1 = local.y * cosX - local.z * sinX;
        float z1 = local.y * sinX + local.z * cosX;
        local.y = y1;
        local.z = z1;
        float cosY = cos(u_rotY), sinY = sin(u_rotY);
        float x1 = local.x * cosY + local.z * sinY;
        float z2 = -local.x * sinY + local.z * cosY;
        local.x = x1;
        local.z = z2;
        float c = cos(u_rot), s = sin(u_rot);
        float rx = local.x * c - local.y * s;
        float ry = local.x * s + local.y * c;
        float sx = (rx - ry) * u_zoom + u_pan.x;
        float sy = ((rx + ry) * 0.5 - local.z) * u_zoom + u_pan.y;
        float invW = 2.0 / u_resolution.x;
        float invH = 2.0 / u_resolution.y;
        float dKey = rx + ry - local.z;
        dNorm = (dKey - u_depthMin) / max(u_depthMax - u_depthMin, 1e-6);
        gl_Position = vec4(sx * invW - 1.0, 1.0 - sy * invH, dNorm * 2.0 - 1.0, 1.0);

         if (u_pointSizeType == 0) {
           gl_PointSize = clamp(u_pointSize, 1.0, 50.0);
         } else {
           float spacing = u_spacing > 0.0 ? u_spacing : 1.0;
           float ps = spacing * u_zoom * u_pointSize * 0.5;
           gl_PointSize = clamp(ps, 1.0, 12.0);
         }
       }

      v_pointSize = gl_PointSize;

      v_opacity = a_opacity;

      v_depth = dNorm;
      v_height = (a_position.z - u_center.z - u_zMin) / max(u_zMax - u_zMin, 1e-6);
      if (u_colorMode == 0) v_color = a_color;
      else if (u_colorMode == 1) {
        float t = clamp(v_height, 0.0, 1.0);
        v_color = vec3(mix(0.1,0.2,t), mix(0.3,0.7,t), mix(0.6,1.0,t));
      } else if (u_colorMode == 2) {
        float t = (a_intensity - u_iMin) / max(u_iMax - u_iMin, 1e-6);
        v_color = vec3(clamp(t, 0.0, 1.0));
      } else if (u_colorMode == 4) {
        int ci = min(int(a_classification), 15);
        v_color = CLASS_COLORS[ci];
      } else v_color = vec3(v_depth);
  }`;

export const POINT_FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  in vec3 v_color;
  in float v_depth;
  in float v_height;
  in float v_pointSize;
  in float v_opacity;
  layout(location = 0) out vec4 outColor;
  layout(location = 1) out vec4 outDepth;
  void main() {
    float dist = length(gl_PointCoord - 0.5) * 2.0;
    if (dist > 1.0) discard;
    outColor = vec4(v_color * v_opacity, 1.0);
    outDepth = vec4(v_depth, v_height, 0.0, 1.0);
  }`;

export const DEPTH_VERTEX_SHADER = `#version 300 es
  precision highp float;
  layout(location = 0) in vec3 a_position;
  uniform vec2 u_resolution;
  uniform vec2 u_pan;
  uniform float u_zoom, u_rot;
  uniform float u_rotX, u_rotY;
  uniform vec3 u_center;
  uniform int u_cameraMode;
  uniform mat4 u_viewMatrix;
  uniform mat4 u_projMatrix;
  out float v_depth;
  void main() {
    vec3 local = a_position - u_center;
    if (u_cameraMode == 1) {
      vec4 worldPos = vec4(a_position, 1.0);
      vec4 viewPos = u_viewMatrix * worldPos;
      gl_Position = u_projMatrix * viewPos;
      float viewDist = -viewPos.z;
      v_depth = clamp((viewDist - 0.1) / 9999.9, 0.0, 1.0);
    } else {
      float cosX = cos(u_rotX), sinX = sin(u_rotX);
      float y1 = local.y * cosX - local.z * sinX;
      float z1 = local.y * sinX + local.z * cosX;
      local.y = y1; local.z = z1;
      float cosY = cos(u_rotY), sinY = sin(u_rotY);
      float x1 = local.x * cosY + local.z * sinY;
      float z2 = -local.x * sinY + local.z * cosY;
      local.x = x1; local.z = z2;
      float c = cos(u_rot), s = sin(u_rot);
      float rx = local.x * c - local.y * s;
      float ry = local.x * s + local.y * c;
      float sx = (rx - ry) * u_zoom + u_pan.x;
      float sy = ((rx + ry) * 0.5 - local.z) * u_zoom + u_pan.y;
      float invW = 2.0 / u_resolution.x;
      float invH = 2.0 / u_resolution.y;
      gl_Position = vec4(sx * invW - 1.0, 1.0 - sy * invH, 0.5 * 2.0 - 1.0, 1.0);
      v_depth = 0.5;
    }
  }`;

export const DEPTH_FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  in float v_depth;
  layout(location = 0) out vec4 outColor;
  layout(location = 1) out vec4 outDepth;
  void main() {
    outColor = vec4(0.0);
    outDepth = vec4(v_depth, 0.0, 0.0, 1.0);
  }`;

export const QUAD_VERTEX_SHADER = `#version 300 es
  precision highp float;
  const vec2 pos[4] = vec2[4](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(1,1));
  const vec2 uv[4] = vec2[4](vec2(0,0),vec2(1,0),vec2(0,1),vec2(1,1));
  out vec2 v_uv;
  void main() {
    v_uv = uv[gl_VertexID];
    gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
  }`;

export const LIGHT_FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_colorTex;
  uniform sampler2D u_depthTex;
  uniform vec2 u_texel;
  uniform vec3 u_lightDir;
  uniform float u_ambient;
  uniform bool u_shading;
  out vec4 fragColor;
  void main() {
    vec4 colorSample = texture(u_colorTex, v_uv);
    if (colorSample.a < 0.5) {
      fragColor = vec4(0.13, 0.15, 0.18, 1.0);
      return;
    }
    vec3 finalColor = colorSample.rgb;
    if (!u_shading) {
      fragColor = vec4(finalColor, 1.0);
      return;
    }
    float d = texture(u_depthTex, v_uv).r;
    float d_r = texture(u_depthTex, v_uv + vec2(u_texel.x, 0.0)).r;
    float d_l = texture(u_depthTex, v_uv - vec2(u_texel.x, 0.0)).r;
    float d_t = texture(u_depthTex, v_uv + vec2(0.0, u_texel.y)).r;
    float d_b = texture(u_depthTex, v_uv - vec2(0.0, u_texel.y)).r;
    float dx = (d_r - d_l) * 2.0;
    float dy = (d_t - d_b) * 2.0;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));
    float diff = max(dot(normal, normalize(u_lightDir)), 0.0);
    fragColor = vec4(finalColor * (u_ambient + diff * (1.0 - u_ambient)), 1.0);
  }`;
