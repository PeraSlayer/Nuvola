/*
===============================================================================
File: las-loader.js

Questo modulo carica file LAS non compressi direttamente in JavaScript. Il
parser inline, eseguito in un Web Worker, legge header LAS, versione, formato
record, scale, offset, conteggio punti, coordinate, intensita e colori quando
presenti.

I valori grezzi del file vengono convertiti in coordinate mondo tramite scale e
offset, poi raccolti in Float32Array e Uint8Array compatibili con PointCloud.
Il modulo include controlli di validita su firma, conteggio punti e dimensioni
dei record per intercettare file non coerenti.

Per i file LAZ compressi il flusso previsto e decomprimere prima con
laz-decompressor.js e poi passare il buffer LAS risultante a questo loader.
===============================================================================
*/

// =============================================================================
// LAS Loader (pure JavaScript, no external dependencies)
// Supports LAS 1.2 - 1.4 (uncompressed). For LAZ use an external tool.
// =============================================================================

const LAS_WORKER_SOURCE = `
'use strict';

function parseLAS(buffer) {
  const dv = new DataView(buffer);
  const fileSize = buffer.byteLength;
  
  // Read header (offset 0)
  const fileSignature = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (fileSignature !== 'LASF') {
    throw new Error('Not a valid LAS file (signature mismatch)');
  }
  
  const headerSize = dv.getUint16(94, true);
  const majorVersion = dv.getUint8(24);
  const minorVersion = dv.getUint8(25);
  const pointOffset = dv.getUint32(96, true);
  let pointCount = dv.getUint32(107, true);  // offset 107 = legacy 32-bit count
  const pointFormat = dv.getUint8(104, true);
  const pointRecordLength = dv.getUint16(105, true);
  
  // LAS 1.4 uses a 64-bit point count at offset 247
  if ((majorVersion === 1 && minorVersion >= 4) && headerSize >= 375) {
    if (pointOffset + pointCount * pointRecordLength > buffer.byteLength) {
      // Legacy count seems wrong; try 64-bit count at offset 247
      const countLow = dv.getUint32(247, true);
      const countHigh = dv.getUint32(251, true);
      const count64 = countLow + (countHigh * 0x100000000);
      if (count64 > 0 && count64 <= 1000000000) {
        pointCount = Number(count64);
      }
    }
  }
  
  if (pointCount === 0 || pointCount > 100000000) {
    throw new Error('Invalid point count in LAS header');
  }
  
  const hasColor = (pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8);
  const hasIntensity = true;
  
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);
  const intensity = new Float32Array(pointCount);
  
  // Read scale and offset
  const scaleX = dv.getFloat64(131, true);
  const scaleY = dv.getFloat64(139, true);
  const scaleZ = dv.getFloat64(147, true);
  const offsetX = dv.getFloat64(155, true);
  const offsetY = dv.getFloat64(163, true);
  const offsetZ = dv.getFloat64(171, true);
  
  // Helper to read XYZ
  const getX = (view, offset) => view.getInt32(offset, true) * scaleX + offsetX;
  const getY = (view, offset) => view.getInt32(offset + 4, true) * scaleY + offsetY;
  const getZ = (view, offset) => view.getInt32(offset + 8, true) * scaleZ + offsetZ;
  
  let minI = Infinity, maxI = -Infinity;
  
  for (let i = 0; i < pointCount; i++) {
    const pointStart = pointOffset + i * pointRecordLength;
    if (pointStart + pointRecordLength > fileSize) break;
    
    const x = getX(dv, pointStart);
    const y = getY(dv, pointStart);
    const z = getZ(dv, pointStart);
    
    positions[i*3] = x;
    positions[i*3+1] = y;
    positions[i*3+2] = z;
    
    // Intensity (unsigned short at offset 0 within point record)
    const iVal = dv.getUint16(pointStart + 0, true);
    intensity[i] = iVal;
    if (iVal < minI) minI = iVal;
    if (iVal > maxI) maxI = iVal;
    
    // Color (depends on point format)
    if (hasColor) {
      let r = 128, g = 128, b = 128;
      // RGB offset depends on point format
      let rgbOffset = -1;
      if (pointFormat === 2) rgbOffset = 20;
      else if (pointFormat === 3) rgbOffset = 28;
      else if (pointFormat === 7) rgbOffset = 26;
      else if (pointFormat === 8) rgbOffset = 34;
      
      if (rgbOffset !== -1 && pointStart + rgbOffset + 6 <= fileSize) {
        r = dv.getUint16(pointStart + rgbOffset, true);
        g = dv.getUint16(pointStart + rgbOffset + 2, true);
        b = dv.getUint16(pointStart + rgbOffset + 4, true);
        // Normalize 16-bit to 8-bit
        r = Math.min(255, r / 256);
        g = Math.min(255, g / 256);
        b = Math.min(255, b / 256);
      }
      colors[i*3] = r;
      colors[i*3+1] = g;
      colors[i*3+2] = b;
    } else {
      // Gray based on normalized intensity (will be set later)
      colors[i*3] = colors[i*3+1] = colors[i*3+2] = 0;
    }
  }
  
  // Normalize intensity
  const iRange = maxI - minI;
  for (let i = 0; i < pointCount; i++) {
    if (iRange > 0) intensity[i] = (intensity[i] - minI) / iRange;
    else intensity[i] = 0.5;
  }
  
  // Fill missing colors with grayscale from intensity
  if (!hasColor) {
    for (let i = 0; i < pointCount; i++) {
      const val = Math.floor(intensity[i] * 255);
      colors[i*3] = val;
      colors[i*3+1] = val;
      colors[i*3+2] = val;
    }
  }
  
  return {
    positions,
    colors,
    intensity,
    count: pointCount,
    hasColor,
    hasIntensity: true
  };
}

self.onmessage = function(e) {
  try {
    const buffer = e.data;
    const result = parseLAS(buffer);
    self.postMessage({ ok: true, ...result }, 
      [result.positions.buffer, result.colors.buffer, result.intensity.buffer]);
  } catch(err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads LAS / LAZ point clouds via a Web Worker. */
export class LASLoader {
  constructor() {
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
  
  static async readFile(file) {
    return await file.arrayBuffer();
  }
  
  load(arrayBuffer, isCompressed = false) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this._workerUrl);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.ok) resolve(e.data);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage(arrayBuffer, [arrayBuffer]);
    });
  }
}
