export class GaussianCloud {
  constructor(data) {
    this.count = data.count;
    this.positions = data.positions;
    this.colors = data.colors;
    this._gpuBytes = this.count * 15;
  }

  static fromPointCloud(cloud) {
    return new GaussianCloud({
      count: cloud.count,
      positions: cloud.positions,
      colors: cloud.colors,
    });
  }

  getGPUByteSize() {
    return this._gpuBytes;
  }
}
