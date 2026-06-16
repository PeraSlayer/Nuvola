/*
===============================================================================
File: xyz-loader.js

Questo modulo carica nuvole di punti testuali nei formati XYZ, TXT e PTS. Il
parser accetta righe separate da spazi, tab o virgole, ignora commenti e righe
vuote, legge almeno coordinate x/y/z e tenta di riconoscere automaticamente
colori RGB o intensita quando sono presenti colonne aggiuntive.

Il parsing viene eseguito in un Web Worker creato da una stringa inline, cosi
anche file ASCII grandi non bloccano l'interfaccia. Il risultato viene
normalizzato in typed array: Float32Array per posizioni e intensita, Uint8Array
per colori, piu metadati su conteggio e disponibilita dei canali.

La classe XYZLoader fornisce riconoscimento estensione, gestione del worker e
API asincrona usata dall'app principale.
===============================================================================
*/

// =============================================================================
// XYZ/TXT/PTS Loader (ASCII point clouds)
//
//   - Supports space/tab/comma separated values
//   - Format: x y z [r g b] [intensity]
//   - Auto‑detects presence of RGB and intensity
//   - Runs in a Web Worker
// ============================================================================

const XYZ_WORKER_SOURCE = `
'use strict';

function parseXYZ(text) {
  const lines = text.split(/\\r?\\n/);
  const points = [];
  const colorsList = [];
  const intensityList = [];
  
  // Auto‑detect format from first data line
  let colorPresent = false;
  let intensityPresent = false;
  let firstDataLine = null;
  
  // Find first non‑comment line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/[\\s,]+/).filter(p => p.length > 0);
    if (parts.length >= 3) {
      firstDataLine = parts;
      if (parts.length >= 6) colorPresent = true;
      if (parts.length >= 4 && !colorPresent) {
        const val = parseFloat(parts[3]);
        if (!isNaN(val) && val <= 255) intensityPresent = true;
      }
      break;
    }
  }
  
  if (!firstDataLine) throw new Error('No valid data found');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    
    const parts = line.split(/[\\s,]+/).filter(p => p.length > 0);
    if (parts.length < 3) continue;
    
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    const z = parseFloat(parts[2]);
    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;
    
    points.push(x, y, z);
    
    // Colors
    if (colorPresent && parts.length >= 6) {
      let r = parseFloat(parts[3]);
      let g = parseFloat(parts[4]);
      let b = parseFloat(parts[5]);
      if (isNaN(r) || isNaN(g) || isNaN(b)) { r = g = b = 128; }
      if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
      colorsList.push(Math.min(255, Math.max(0, r)),
                      Math.min(255, Math.max(0, g)),
                      Math.min(255, Math.max(0, b)));
    } else if (!colorPresent && intensityPresent && parts.length >= 4) {
      // Grayscale based on intensity
      const inten = parseFloat(parts[3]);
      const val = isNaN(inten) ? 128 : Math.min(255, Math.max(0, inten));
      colorsList.push(val, val, val);
    } else {
      colorsList.push(180, 180, 200);
    }
    
    // Intensity
    if (intensityPresent && parts.length >= 4) {
      let inten = parseFloat(parts[3]);
      if (isNaN(inten)) inten = 0.5;
      intensityList.push(inten);
    } else {
      intensityList.push(0.5);
    }
  }
  
  const pointCount = points.length / 3;
  
  // Normalize intensity
  let iMin = Infinity, iMax = -Infinity;
  for (let i = 0; i < pointCount; i++) {
    const v = intensityList[i];
    if (v < iMin) iMin = v;
    if (v > iMax) iMax = v;
  }
  const iRange = iMax - iMin;
  for (let i = 0; i < pointCount; i++) {
    if (iRange > 0) intensityList[i] = (intensityList[i] - iMin) / iRange;
    else intensityList[i] = 0.5;
  }
  
  return {
    positions: new Float32Array(points),
    colors: new Uint8Array(colorsList),
    intensity: new Float32Array(intensityList),
    count: pointCount,
    hasColor: colorPresent || !intensityPresent, // if no intensity, we made gray
    hasIntensity: true
  };
}

self.onmessage = function(e) {
  try {
    const text = e.data;
    const result = parseXYZ(text);
    self.postMessage({ ok: true, ...result }, 
      [result.positions.buffer, result.colors.buffer, result.intensity.buffer]);
  } catch(err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads ASCII point clouds (XYZ/TXT/PTS) via a Web Worker. */
export class XYZLoader {
  constructor() {
    const blob = new Blob([XYZ_WORKER_SOURCE], { type: 'application/javascript' });
    this._workerUrl = URL.createObjectURL(blob);
  }

  dispose() {
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }
  
  static isXYZFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.xyz') || n.endsWith('.txt') || n.endsWith('.pts');
  }
  
  load(input) {
    if (typeof input === 'string') {
      return this._loadText(input);
    }
    // input is File — read text with size check
    if (input.size > 500 * 1024 * 1024) {
      return Promise.reject(new Error('XYZ/TXT files over 500MB not supported. Use binary PLY or LAS.'));
    }
    return input.text().then(text => this._loadText(text));
  }

  _loadText(text) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this._workerUrl);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.ok) resolve(e.data);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage(text);
    });
  }
}
