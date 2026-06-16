const LAS_WORKER_SOURCE = `
'use strict';
let state = null;

self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'init') {
    const vc = msg.vertexCount;
    const mp = msg.maxPoints > 0 ? Math.min(msg.maxPoints, vc) : vc;
    const useRS = vc > mp;
    state = {
      vc, stride: msg.pointRecordLength, pf: msg.pointFormat,
      scaleX: msg.scaleX, scaleY: msg.scaleY, scaleZ: msg.scaleZ,
      offsetX: msg.offsetX, offsetY: msg.offsetY, offsetZ: msg.offsetZ,
      hasCol: msg.hasColor,
      useRS, rsMax: mp, rsCount: 0, rsSeen: 0,
      pos: new Float32Array(useRS ? mp * 3 : vc * 3),
      col: new Uint8Array(useRS ? mp * 3 : vc * 3),
      inten: new Float32Array(useRS ? mp : vc),
      minI: Infinity, maxI: -Infinity,
    };
  } else if (msg.type === 'chunk') {
    const s = state; if (!s) return;
    const dv = new DataView(msg.data);
    const n = msg.data.byteLength / s.stride;
    const base = msg.startVertex;

    for (let i = 0; i < n; i++) {
      const bo = i * s.stride;

      const x = dv.getInt32(bo, true)     * s.scaleX + s.offsetX;
      const y = dv.getInt32(bo + 4, true)  * s.scaleY + s.offsetY;
      const z = dv.getInt32(bo + 8, true)  * s.scaleZ + s.offsetZ;

      const iVal = dv.getUint16(bo, true);

      if (s.useRS) {
        s.rsSeen++;
        if (s.rsCount < s.rsMax) {
          const ri = s.rsCount++;
          s.pos[ri*3] = x; s.pos[ri*3+1] = y; s.pos[ri*3+2] = z;
          s.inten[ri] = iVal;
          if (iVal < s.minI) s.minI = iVal;
          if (iVal > s.maxI) s.maxI = iVal;
          if (s.hasCol) {
            let r = 128, g = 128, b = 128;
            let rgbOff = -1;
            if (s.pf === 2) rgbOff = 20;
            else if (s.pf === 3) rgbOff = 28;
            else if (s.pf === 7) rgbOff = 26;
            else if (s.pf === 8) rgbOff = 34;
            if (rgbOff >= 0) {
              r = dv.getUint16(bo + rgbOff, true) / 256;
              g = dv.getUint16(bo + rgbOff + 2, true) / 256;
              b = dv.getUint16(bo + rgbOff + 4, true) / 256;
            }
            s.col[ri*3] = Math.min(255, r);
            s.col[ri*3+1] = Math.min(255, g);
            s.col[ri*3+2] = Math.min(255, b);
          } else {
            s.col[ri*3] = s.col[ri*3+1] = s.col[ri*3+2] = 0;
          }
        } else {
          const j = Math.random() * s.rsSeen | 0;
          if (j < s.rsMax) {
            s.pos[j*3] = x; s.pos[j*3+1] = y; s.pos[j*3+2] = z;
            s.inten[j] = iVal;
            if (iVal < s.minI) s.minI = iVal;
            if (iVal > s.maxI) s.maxI = iVal;
            if (s.hasCol) {
              let r = 128, g = 128, b = 128;
              let rgbOff = -1;
              if (s.pf === 2) rgbOff = 20;
              else if (s.pf === 3) rgbOff = 28;
              else if (s.pf === 7) rgbOff = 26;
              else if (s.pf === 8) rgbOff = 34;
              if (rgbOff >= 0) {
                r = dv.getUint16(bo + rgbOff, true) / 256;
                g = dv.getUint16(bo + rgbOff + 2, true) / 256;
                b = dv.getUint16(bo + rgbOff + 4, true) / 256;
              }
              s.col[j*3] = Math.min(255, r);
              s.col[j*3+1] = Math.min(255, g);
              s.col[j*3+2] = Math.min(255, b);
            } else {
              s.col[j*3] = s.col[j*3+1] = s.col[j*3+2] = 0;
            }
          }
        }
      } else {
        const vi = base + i;
        s.pos[vi*3] = x; s.pos[vi*3+1] = y; s.pos[vi*3+2] = z;
        s.inten[vi] = iVal;
        if (iVal < s.minI) s.minI = iVal;
        if (iVal > s.maxI) s.maxI = iVal;
        if (s.hasCol) {
          let r = 128, g = 128, b = 128;
          let rgbOff = -1;
          if (s.pf === 2) rgbOff = 20;
          else if (s.pf === 3) rgbOff = 28;
          else if (s.pf === 7) rgbOff = 26;
          else if (s.pf === 8) rgbOff = 34;
          if (rgbOff >= 0) {
            r = dv.getUint16(bo + rgbOff, true) / 256;
            g = dv.getUint16(bo + rgbOff + 2, true) / 256;
            b = dv.getUint16(bo + rgbOff + 4, true) / 256;
          }
          s.col[vi*3] = Math.min(255, r);
          s.col[vi*3+1] = Math.min(255, g);
          s.col[vi*3+2] = Math.min(255, b);
        } else {
          s.col[vi*3] = s.col[vi*3+1] = s.col[vi*3+2] = 0;
        }
      }
    }
  } else if (msg.type === 'done') {
    const s = state; if (!s) return;
    const actualCount = s.useRS ? s.rsCount : s.vc;
    // Normalize intensity
    const iRange = s.maxI - s.minI;
    for (let i = 0; i < actualCount; i++) {
      s.inten[i] = iRange > 0 ? (s.inten[i] - s.minI) / iRange : 0.5;
    }
    // Fill missing colors with grayscale from intensity
    if (!s.hasCol) {
      for (let i = 0; i < actualCount; i++) {
        const val = Math.floor(s.inten[i] * 255);
        s.col[i*3] = val; s.col[i*3+1] = val; s.col[i*3+2] = val;
      }
    }
    const tr = [s.pos.buffer, s.col.buffer, s.inten.buffer];
    self.postMessage({
      ok: true, positions: s.pos, colors: s.col, intensity: s.inten,
      count: actualCount, hasColor: s.hasCol, hasIntensity: true,
    }, tr);
    state = null;
  }
};
`;

function parseLASHeader(chunk) {
  const dv = new DataView(chunk);
  const fileSignature = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (fileSignature !== 'LASF') throw new Error('Not a valid LAS file');

  const headerSize = dv.getUint16(94, true);
  const majorVersion = dv.getUint8(24);
  const minorVersion = dv.getUint8(25);
  const pointOffset = dv.getUint32(96, true);
  let pointCount = dv.getUint32(107, true);
  const pointFormat = dv.getUint8(104, true);
  const pointRecordLength = dv.getUint16(105, true);

  // LAS 1.4 64-bit point count
  if ((majorVersion >= 1 && minorVersion >= 4) && headerSize >= 375) {
    const countLow = dv.getUint32(247, true);
    const countHigh = dv.getUint32(251, true);
    const count64 = countLow + countHigh * 0x100000000;
    if (count64 > 0 && count64 <= 1000000000) pointCount = Number(count64);
  }

  if (!pointCount || pointCount > 1000000000) throw new Error('Invalid point count in LAS header');

  const hasColor = [2, 3, 7, 8].includes(pointFormat);

  return {
    pointCount,
    pointOffset,
    pointRecordLength,
    pointFormat,
    hasColor,
    scaleX: dv.getFloat64(131, true),
    scaleY: dv.getFloat64(139, true),
    scaleZ: dv.getFloat64(147, true),
    offsetX: dv.getFloat64(155, true),
    offsetY: dv.getFloat64(163, true),
    offsetZ: dv.getFloat64(171, true),
  };
}

export class LASLoader {
  constructor(options = {}) {
    this.maxPoints = options.maxPoints || 50000000;
    const blob = new Blob([LAS_WORKER_SOURCE], { type: 'application/javascript' });
    this._workerUrl = URL.createObjectURL(blob);
  }

  dispose() {
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }

  static isLASFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.las') || n.endsWith('.laz');
  }

  _streamToWorker(worker, file, info, reject) {
    const CHUNK = 64 * 1024 * 1024;
    let offset = info.pointOffset;
    let vOffset = 0;
    const total = file.size;

    (async () => {
      try {
        while (offset < total) {
          const end = Math.min(offset + CHUNK, total);
          const chunk = await file.slice(offset, end).arrayBuffer();
          const alignedLen = Math.floor(chunk.byteLength / info.pointRecordLength) * info.pointRecordLength;
          const alignedChunk = alignedLen === chunk.byteLength ? chunk : chunk.slice(0, alignedLen);
          const vCount = alignedLen / info.pointRecordLength;
          worker.postMessage({ type: 'chunk', data: alignedChunk, startVertex: vOffset }, [alignedChunk]);
          vOffset += vCount;
          offset += alignedLen;
        }
        worker.postMessage({ type: 'done' });
      } catch (err) {
        reject(err);
      }
    })();
  }

  _sendInit(worker, info) {
    worker.postMessage({
      type: 'init',
      vertexCount: info.pointCount,
      pointRecordLength: info.pointRecordLength,
      pointFormat: info.pointFormat,
      scaleX: info.scaleX, scaleY: info.scaleY, scaleZ: info.scaleZ,
      offsetX: info.offsetX, offsetY: info.offsetY, offsetZ: info.offsetZ,
      hasColor: info.hasColor,
      maxPoints: this.maxPoints,
    });
  }

  load(input) {
    const CHUNK = 64 * 1024 * 1024;

    // Handle pre-decompressed buffer (LAZ path) or File (LAS path)
    if (input instanceof File) {
      return new Promise((resolve, reject) => {
        input.slice(0, Math.min(1024 * 1024, input.size)).arrayBuffer().then(headBuf => {
          const info = parseLASHeader(headBuf);
          const worker = new Worker(this._workerUrl);
          worker.onmessage = (e) => { worker.terminate(); if (e.data.ok) resolve(e.data); else reject(new Error(e.data.error)); };
          worker.onerror = (err) => { worker.terminate(); reject(err); };
          this._sendInit(worker, info);
          this._streamToWorker(worker, input, info, reject);
        }).catch(reject);
      });
    }

    // ArrayBuffer from LAZ decompression
    return new Promise((resolve, reject) => {
      const buf = input;
      const headBuf = buf.slice(0, Math.min(1024 * 1024, buf.byteLength));
      const info = parseLASHeader(headBuf);
      const worker = new Worker(this._workerUrl);
      worker.onmessage = (e) => { worker.terminate(); if (e.data.ok) resolve(e.data); else reject(new Error(e.data.error)); };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      this._sendInit(worker, info);

      let offset = info.pointOffset;
      let vOffset = 0;
      (async () => {
        while (offset < buf.byteLength) {
          const end = Math.min(offset + CHUNK, buf.byteLength);
          const chunk = buf.slice(offset, end);
          const alignedLen = Math.floor(chunk.byteLength / info.pointRecordLength) * info.pointRecordLength;
          const alignedChunk = alignedLen === chunk.byteLength ? chunk : chunk.slice(0, alignedLen);
          const vCount = alignedLen / info.pointRecordLength;
          worker.postMessage({ type: 'chunk', data: alignedChunk, startVertex: vOffset }, [alignedChunk]);
          vOffset += vCount;
          offset += alignedLen;
        }
        worker.postMessage({ type: 'done' });
      })().catch(reject);
    });
  }
}
