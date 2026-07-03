/**
 * XYZ/TXT/PTS ASCII point cloud loader with Web Worker-based parsing.
 *
 * Parses space-, tab-, or comma-separated text point cloud files.
 * Automatically detects the presence of RGB color columns (6+ fields per
 * line) and intensity data (4+ fields). Supports comment lines starting
 * with '#' or '//'. All parsing runs in a dedicated Web Worker to keep
 * the main thread responsive even with large text files.
 *
 * @module xyz-loader
 */

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

/**
 * Counts the number of valid data lines in the buffer.
 *
 * Skips empty lines and comment lines (starting with '#' or '//') while
 * counting only lines that contain potential point data. Returns the
 * total count for pre-allocation of typed arrays.
 *
 * @param {ArrayBuffer} buf - The raw file buffer.
 * @returns {number} Number of data lines.
 */
function countDataLines(buf) {
  var b = new Uint8Array(buf), n = b.length, c = 0, i = 0;
  while (i < n) {
    var s = i;
    while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    var e = i;
    if (i < n && b[i] === 13) i++;
    if (i < n && b[i] === 10) i++;
    if (e === s) continue;
    var f = b[s];
    if (f === 35) continue;
    if (f === 47 && s + 1 < e && b[s + 1] === 47) continue;
    c++;
  }
  return c;
}

/**
 * Parses the XYZ body text into typed arrays.
 *
 * Performs two passes over the raw bytes. The first pass detects whether
 * colors are present by examining the first valid data line. The second
 * pass parses all lines into pre-allocated Float32Array (positions,
 * intensity) and Uint8Array (colors) with intensity normalization to
 * 0..1. Defaults to a lavender color (180, 180, 200) when no color data
 * is present.
 *
 * @param {ArrayBuffer} buf - The raw file buffer.
 * @param {number} count - Expected number of data lines (from countDataLines).
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array, count: number, hasColor: boolean, hasIntensity: boolean}} Parsed point data.
 */
function parseXYZ(buf, count) {
  var decoder = new TextDecoder('utf-8');
  var b = new Uint8Array(buf), n = b.length;
  var pos = 0, idx = 0;

  // Detect format on first data line
  var colorPresent = false, intensityPresent = true;
  while (pos < n) {
    var s = pos;
    while (pos < n && b[pos] !== 10 && b[pos] !== 13) pos++;
    var e = pos;
    if (pos < n && b[pos] === 13) pos++;
    if (pos < n && b[pos] === 10) pos++;
    if (e === s) continue;
    var f = b[s];
    if (f === 35 || (f === 47 && s + 1 < e && b[s + 1] === 47)) continue;
    var line = decoder.decode(b.subarray(s, e)).trim();
    var p = line.split(/[\\s,]+/);
    if (p.length >= 3) {
      if (p.length >= 6) colorPresent = true;
      break;
    }
  }

  // Pre-allocate typed arrays directly (no JS arrays)
  var positions = new Float32Array(count * 3);
  var colors = new Uint8Array(count * 3);
  var intensity = new Float32Array(count);
  var hasColor = !!colorPresent;

  // Second pass: parse lines into typed arrays
  pos = 0;
  while (pos < n && idx < count) {
    var s = pos;
    while (pos < n && b[pos] !== 10 && b[pos] !== 13) pos++;
    var e = pos;
    if (pos < n && b[pos] === 13) pos++;
    if (pos < n && b[pos] === 10) pos++;
    if (e === s) continue;
    var f = b[s];
    if (f === 35 || (f === 47 && s + 1 < e && b[s + 1] === 47)) continue;
    var line = decoder.decode(b.subarray(s, e)).trim();
    var p = line.split(/[\\s,]+/);
    if (p.length < 3) continue;

    var x = parseFloat(p[0]), y = parseFloat(p[1]), z = parseFloat(p[2]);
    if (isNaN(x) || isNaN(y) || isNaN(z)) continue;

    var i3 = idx * 3;
    positions[i3] = x; positions[i3 + 1] = y; positions[i3 + 2] = z;

    if (colorPresent && p.length >= 6) {
      var r = parseFloat(p[3]), g = parseFloat(p[4]), bv = parseFloat(p[5]);
      if (isNaN(r) || isNaN(g) || isNaN(bv)) { r = g = bv = 128; }
      // Scale float 0..1 to 0..255 byte range
      if (r <= 1 && g <= 1 && bv <= 1) { r *= 255; g *= 255; bv *= 255; }
      colors[i3] = Math.min(255, Math.max(0, r));
      colors[i3 + 1] = Math.min(255, Math.max(0, g));
      colors[i3 + 2] = Math.min(255, Math.max(0, bv));
    } else if (p.length >= 4) {
      var iv = parseFloat(p[3]);
      var cv = isNaN(iv) ? 128 : Math.min(255, Math.max(0, iv));
      colors[i3] = colors[i3 + 1] = colors[i3 + 2] = cv;
    } else {
      colors[i3] = 180; colors[i3 + 1] = 180; colors[i3 + 2] = 200;
    }

    if (p.length >= 4) {
      var inten = parseFloat(p[3]);
      intensity[idx] = isNaN(inten) ? 0.5 : inten;
    } else {
      intensity[idx] = 0.5;
    }

    idx++;
  }

  // Normalize intensity to 0..1 range
  var iMin = Infinity, iMax = -Infinity;
  for (var i = 0; i < idx; i++) {
    var v = intensity[i];
    if (v < iMin) iMin = v;
    if (v > iMax) iMax = v;
  }
  var iRange = iMax - iMin;
  if (iRange > 0) {
    for (var i = 0; i < idx; i++) intensity[i] = (intensity[i] - iMin) / iRange;
  } else {
    for (var i = 0; i < idx; i++) intensity[i] = 0.5;
  }

  return {
    positions: positions,
    colors: colors,
    intensity: intensity,
    count: idx,
    hasColor: hasColor,
    hasIntensity: true
  };
}

/**
 * Web Worker message handler for XYZ parsing.
 *
 * Receives the raw ArrayBuffer, counts data lines, delegates to parseXYZ,
 * and posts the typed arrays back to the main thread using transferable
 * objects for zero-copy transfer.
 *
 * @listens MessageEvent
 */
self.onmessage = function(e) {
  try {
    var buf = e.data;
    var count = countDataLines(buf);
    if (count === 0) throw new Error('No valid data found');
    var result = parseXYZ(buf, count);
    self.postMessage({ ok: true, positions: result.positions, colors: result.colors, intensity: result.intensity, count: result.count, hasColor: result.hasColor, hasIntensity: result.hasIntensity }, 
      [result.positions.buffer, result.colors.buffer, result.intensity.buffer]);
  } catch(err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads ASCII point clouds (XYZ/TXT/PTS) via a Web Worker. */
export class XYZLoader {
  /**
   * Creates a Blob URL for the inline XYZ worker source.
   */
  constructor() {
    const blob = new Blob([XYZ_WORKER_SOURCE], { type: 'application/javascript' });
    this._workerUrl = URL.createObjectURL(blob);
  }

  /**
   * Revokes the worker Blob URL and cleans up resources.
   */
  dispose() {
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }
  
  /**
   * Checks whether a file has an XYZ/TXT/PTS extension.
   *
   * @param {File} file - The file to check.
   * @returns {boolean} True if the file is an XYZ/TXT/PTS file.
   */
  static isXYZFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.xyz') || n.endsWith('.txt') || n.endsWith('.pts');
  }
  
  /**
   * Reads an XYZ/TXT/PTS file into an ArrayBuffer.
   *
   * @param {File} file - The DOM File object.
   * @returns {Promise<ArrayBuffer>} The raw file buffer.
   */
  static async readFile(file) {
    return await file.arrayBuffer();
  }
  
  /**
   * Parses an XYZ/TXT/PTS buffer in a Web Worker and returns structured
   * point cloud data.
   *
   * @param {ArrayBuffer} buf - The raw file buffer.
   * @returns {Promise<{ok: boolean, positions: Float32Array, colors: Uint8Array, intensity: Float32Array, count: number, hasColor: boolean, hasIntensity: boolean}>} Parsed point data.
   */
  load(buf) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this._workerUrl);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.ok) resolve(e.data);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage(buf, [buf]);
    });
  }
}
