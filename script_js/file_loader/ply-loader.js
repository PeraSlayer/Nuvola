const PLY_WORKER_SOURCE = `
'use strict';
const TS = { char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, int32:4, uint:4, uint32:4, float:4, float32:4, double:8, float64:8 };
function rv(dv, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    default: return dv.getFloat32(off, le);
  }
}
self.onmessage = function(e) {
  const d = e.data;
  try {
    const stride = d.stride, count = d.vertexCount, le = d.littleEndian;
    const dv = new DataView(d.data);
    const off = d.offsets, typ = d.types;
    const hasColor = d.hasColor, hasInt = d.hasIntensity;
    const positions = new Float32Array(count * 3);
    const colors = new Uint8Array(count * 3);
    const intensity = hasInt ? new Float32Array(count) : null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minI = Infinity, maxI = -Infinity;
    for (let i = 0; i < count; i++) {
      const bo = i * stride;
      const x = rv(dv, bo + off.x, typ.x, le);
      const y = rv(dv, bo + off.y, typ.y, le);
      const z = rv(dv, bo + off.z, typ.z, le);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (hasColor) {
        let r = rv(dv, bo + off.r, typ.r, le);
        let g = rv(dv, bo + off.g, typ.g, le);
        let b = rv(dv, bo + off.b, typ.b, le);
        if (typ.r === 'float' || typ.r === 'float32' || typ.r === 'double') {
          r = Math.round(r * 255);
          g = Math.round(g * 255);
          b = Math.round(b * 255);
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      } else {
        colors[i * 3] = 180;
        colors[i * 3 + 1] = 180;
        colors[i * 3 + 2] = 200;
      }
      if (hasInt) {
        const iv = rv(dv, bo + off.intensity, typ.intensity, le);
        intensity[i] = iv;
        if (iv < minI) minI = iv;
        if (iv > maxI) maxI = iv;
      }
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    const iMin = hasInt ? minI : 0;
    const iMax = hasInt ? (maxI === minI ? maxI + 1 : maxI) : 1;
    self.postMessage({
      ok: true,
      positions: positions.buffer,
      colors: colors.buffer,
      intensity: intensity ? intensity.buffer : null,
      count,
      hasColor,
      hasIntensity: hasInt,
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      center: [cx, cy, cz],
      zMin: minZ, zMax: maxZ,
      intensityMin: iMin, intensityMax: iMax,
    }, (() => { const x = [positions.buffer, colors.buffer]; if (intensity) x.push(intensity.buffer); return x; })());
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

function parsePLYHeader(chunk) {
  const arr = new Uint8Array(chunk);
  let lineEnd = 0, headerEndByte = 0;
  const headerLines = [];
  while (lineEnd < arr.length) {
    const start = lineEnd;
    while (lineEnd < arr.length && arr[lineEnd] !== 10 && arr[lineEnd] !== 13) lineEnd++;
    const line = new TextDecoder('ascii').decode(arr.subarray(start, lineEnd));
    headerLines.push(line);
    if (line.trim() === 'end_header') { headerEndByte = lineEnd; break; }
    while (lineEnd < arr.length && (arr[lineEnd] === 10 || arr[lineEnd] === 13)) lineEnd++;
  }
  if (!headerEndByte) throw new Error('PLY header not found');
  if (headerLines[0].trim() !== 'ply') throw new Error('Not a PLY file');
  let format = null, vertexCount = 0;
  const properties = [];
  let inVertex = false;
  for (let i = 1; i < headerLines.length; i++) {
    const line = headerLines[i].trim();
    if (!line) continue;
    if (line === 'end_header') break;
    const parts = line.split(/ +/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') { inVertex = parts[1] === 'vertex'; if (inVertex) vertexCount = parseInt(parts[2], 10); else inVertex = false; }
    else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') properties.push({ name: parts[parts.length-1], type: 'list' });
      else properties.push({ name: parts[parts.length-1], type: parts[1] });
    }
  }
  if (!format || !vertexCount) throw new Error('Invalid PLY header');
  while (headerEndByte < arr.length && (arr[headerEndByte] === 10 || arr[headerEndByte] === 13)) headerEndByte++;
  const TYPE_SIZES = { char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, int32:4, uint:4, uint32:4, float:4, float32:4, double:8, float64:8 };
  let stride = 0;
  const offsets = {}, types = {};
  for (const p of properties) {
    if (p.type !== 'list') {
      const lower = p.name.toLowerCase();
      const key = lower === 'red' || lower === 'r' ? 'r' :
                  lower === 'green' || lower === 'g' ? 'g' :
                  lower === 'blue' || lower === 'b' ? 'b' :
                  lower === 'scalar_intensity' || lower === 'reflectance' || lower === 'i' || lower === 'intensity' ? 'intensity' : lower;
      if (key === 'x' || key === 'y' || key === 'z' || key === 'r' || key === 'g' || key === 'b' || key === 'intensity') {
        offsets[key] = stride;
        types[key] = p.type;
      }
      stride += TYPE_SIZES[p.type] || 4;
    }
  }
  const hasColor = 'r' in offsets && 'g' in offsets && 'b' in offsets;
  const hasIntensity = 'intensity' in offsets;
  return {
    format, vertexCount, stride,
    dataOffset: headerEndByte,
    offsets, types, hasColor, hasIntensity,
    littleEndian: format === 'binary_little_endian',
    properties,
  };
}

export class PLYLoader {
  constructor(options = {}) {
    this.maxPoints = options.maxPoints || 50000000;
    this._workerUrl = null;
  }

  static _createWorkerUrl() {
    const blob = new Blob([PLY_WORKER_SOURCE], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  _getWorkerUrl() {
    if (!this._workerUrl) this._workerUrl = PLYLoader._createWorkerUrl();
    return this._workerUrl;
  }

  dispose() {
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }

  static isPLYFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.ply') || n.endsWith('.ply.gz') || (n.endsWith('.gz') && n.includes('.ply'));
  }

  load(file) {
    return new Promise((resolve, reject) => {
      file.slice(0, Math.min(1024 * 1024, file.size)).arrayBuffer().then(headBuf => {
        const info = parsePLYHeader(headBuf);

        if (file.name.toLowerCase().endsWith('.gz')) {
          if (typeof DecompressionStream === 'undefined')
            throw new Error('Gzip requires DecompressionStream (use a modern browser)');
          return file.arrayBuffer().then(buf => {
            const ds = new DecompressionStream('gzip');
            return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
          }).then(decompressed => {
            const info2 = parsePLYHeader(new Uint8Array(decompressed, 0, Math.min(1024 * 1024, decompressed.byteLength)).buffer);
            const body = decompressed.slice(info2.dataOffset);
            this._runWorker(body, info2, resolve, reject);
          });
        }

        if (info.format === 'ascii') {
          if (file.size > 500 * 1024 * 1024)
            return reject(new Error('ASCII PLY over 500MB. Use binary PLY for large files.'));
          return file.text().then(text => {
            this._parseAscii(text, info, resolve, reject);
          });
        }

        file.slice(info.dataOffset).arrayBuffer().then(body => {
          this._runWorker(body, info, resolve, reject);
        });
      }).catch(reject);
    });
  }

  _runWorker(body, info, resolve, reject) {
    const url = this._getWorkerUrl();
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) {
        const result = {
          positions: new Float32Array(e.data.positions),
          colors: new Uint8Array(e.data.colors),
          intensity: e.data.intensity ? new Float32Array(e.data.intensity) : null,
          count: e.data.count,
          hasColor: e.data.hasColor,
          hasIntensity: e.data.hasIntensity,
          bounds: e.data.bounds,
          center: e.data.center,
          zMin: e.data.zMin,
          zMax: e.data.zMax,
          intensityMin: e.data.intensityMin,
          intensityMax: e.data.intensityMax,
        };
        resolve(result);
      } else {
        reject(new Error(e.data.error || 'Worker parse error'));
      }
    };
    worker.onerror = (err) => { worker.terminate(); reject(err); };
    worker.postMessage({
      data: body, vertexCount: info.vertexCount, stride: info.stride,
      offsets: info.offsets, types: info.types,
      hasColor: info.hasColor, hasIntensity: info.hasIntensity,
      littleEndian: info.littleEndian,
    }, [body]);
  }

  _parseAscii(text, info, resolve, reject) {
    const props = info.properties;
    const ix = props.findIndex(p => p.name.toLowerCase() === 'x');
    const iy = props.findIndex(p => p.name.toLowerCase() === 'y');
    const iz = props.findIndex(p => p.name.toLowerCase() === 'z');
    const ir = props.findIndex(p => ['red', 'r'].includes(p.name.toLowerCase()));
    const ig = props.findIndex(p => ['green', 'g'].includes(p.name.toLowerCase()));
    const ib = props.findIndex(p => ['blue', 'b'].includes(p.name.toLowerCase()));
    const ii = props.findIndex(p => ['intensity', 'scalar_intensity', 'i', 'reflectance'].includes(p.name.toLowerCase()));
    const hasColor = ir >= 0, hasInt = ii >= 0;
    const vc = info.vertexCount;
    const positions = new Float32Array(vc * 3);
    const colors = new Uint8Array(vc * 3);
    const intensity = hasInt ? new Float32Array(vc) : null;
    const lines = text.split('\n');
    let v = 0, p2 = 0;
    while (p2 < lines.length && v < vc) {
      const line = lines[p2++].trim();
      if (!line) continue;
      const vals = line.split(/ +/);
      if (vals.length <= Math.max(ix, iy, iz)) continue;
      const x = parseFloat(vals[ix]), y = parseFloat(vals[iy]), z = parseFloat(vals[iz]);
      positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
      if (hasColor) { colors[v * 3] = +vals[ir]; colors[v * 3 + 1] = +vals[ig]; colors[v * 3 + 2] = +vals[ib]; }
      else { colors[v * 3] = 180; colors[v * 3 + 1] = 180; colors[v * 3 + 2] = 200; }
      if (hasInt) intensity[v] = parseFloat(vals[ii]);
      v++;
    }
    const actualCount = v;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minI = Infinity, maxI = -Infinity;
    for (let i = 0; i < actualCount; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (hasInt) { const iv = intensity[i]; if (iv < minI) minI = iv; if (iv > maxI) maxI = iv; }
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    resolve({
      positions: positions.slice(0, actualCount * 3),
      colors: colors.slice(0, actualCount * 3),
      intensity: hasInt ? intensity.slice(0, actualCount) : null,
      count: actualCount,
      hasColor, hasIntensity: hasInt,
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      center: [cx, cy, cz],
      zMin: minZ, zMax: maxZ,
      intensityMin: hasInt ? minI : 0,
      intensityMax: hasInt ? (maxI === minI ? maxI + 1 : maxI) : 1,
    });
  }
}
