import { LASLoader } from './las-loader.js';

const CHUNK_SIZE = 5_000_000;
const MAX_MEMORY_POINTS = 50_000_000;

export class LASStreamingLoader {
  constructor() {
    this._loader = new LASLoader();
  }

  static isLargeFile(file) {
    return file.size > 2 * 1024 * 1024 * 1024;
  }

  static estimatePointCount(file) {
    const sizeGB = file.size / (1024 * 1024 * 1024);
    const avgBytesPerPoint = 30;
    return Math.floor((file.size / avgBytesPerPoint));
  }

  async load(file, onProgress) {
    if (LASStreamingLoader.estimatePointCount(file) > MAX_MEMORY_POINTS) {
      throw new Error(
        `File too large for direct loading (~${(LASStreamingLoader.estimatePointCount(file) / 1e6).toFixed(0)}M points). ` +
        `Use las2potree to convert to streaming format:\n` +
        `node tools/las2potree/src/index.js ${file.name} ./datasets/${file.name.replace(/\.\w+$/, '')}/`
      );
    }

    const buf = await file.arrayBuffer();
    const isLaz = file.name.toLowerCase().endsWith('.laz');
    return await this._loader.load(buf, isLaz);
  }

  dispose() {
    if (this._loader) {
      this._loader.dispose();
    }
  }
}
