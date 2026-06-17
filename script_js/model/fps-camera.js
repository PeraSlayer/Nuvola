export class FPSCamera {
  constructor() {
    this.position = [0, 0, 0];
    this.pitch = 0;
    this.yaw = 0;
    this._velocity = [0, 0, 0];
    this._dirty = true;
  }

  getMVP(w, h) {
    const fov = Math.PI / 3;
    const aspect = w / h;
    const near = 0.1;
    const far = 100000;
    const f = 1.0 / Math.tan(fov * 0.5);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = (2 * far * near) / (near - far);
    out[15] = 0;

    const x = this.position[0], y = this.position[1], z = this.position[2];
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);

    const fx = cp * cy;
    const fy = cp * sy;
    const fz = sp;
    const upx = -sp * cy, upy = -sp * sy, upz = cp;
    const rx = fy * upz - fz * upy;
    const ry = fz * upx - fx * upz;
    const rz = fx * upy - fy * upx;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const tx = -(rx * x + ry * y + rz * z);
    const ty = -(ux * x + uy * y + uz * z);
    const tz = -(fx * x + fy * y + fz * z);

    const v = new Float32Array(16);
    v[0] = rx; v[1] = ux; v[2] = -fx; v[3] = 0;
    v[4] = ry; v[5] = uy; v[6] = -fy; v[7] = 0;
    v[8] = rz; v[9] = uz; v[10] = -fz; v[11] = 0;
    v[12] = tx; v[13] = ty; v[14] = tz; v[15] = 1;

    const result = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        result[j * 4 + i] = out[i] * v[j] + out[4 + i] * v[4 + j] + out[8 + i] * v[8 + j] + out[12 + i] * v[12 + j];
      }
    }
    return result;
  }

  markDirty() { this._dirty = true; }

  consumeDirty() { const d = this._dirty; this._dirty = false; return d; }

  update() {}

  reset() {
    this.position = [0, 0, 0];
    this.pitch = 0;
    this.yaw = 0;
    this._velocity = [0, 0, 0];
    this._dirty = true;
  }
}
