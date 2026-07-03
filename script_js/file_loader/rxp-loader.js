/**
 * RXP (Riegl binary) point cloud loader with Web Worker-based heuristic parsing.
 *
 * RXP files do not have a well-documented header format, so the parser uses
 * multiple heuristic strategies to detect the point count, record stride, and
 * data layout. It probes various byte offsets for plausible uint32 counts,
 * estimates stride by comparing total file size with expected point sizes, and
 * determines whether RGB color data is embedded based on record stride length.
 * All parsing runs in a Web Worker to avoid blocking the UI.
 *
 * @module rxp-loader
 */

/*
===============================================================================
File: rxp-loader.js

Questo modulo implementa un loader sperimentale per file RXP/Riegl binari. Il
worker inline tenta di dedurre numero di punti, stride e offset dei dati
analizzando varie posizioni plausibili nell'header e confrontando le dimensioni
del file con layout noti o stimati.

Una volta individuata una struttura coerente, il parser estrae coordinate,
colori o intensita quando possibile e restituisce typed array nello stesso
formato usato dagli altri loader. La logica include fallback e stime per
gestire varianti RXP non perfettamente documentate o non uniformi.

RXPLoader incapsula worker, riconoscimento estensione e API asincrona, ma il
formato resta piu euristico rispetto a PLY/LAS/XYZ.
===============================================================================
*/

// =============================================================================
// RXP Loader (Riegl binary point cloud) - Versione migliorata
// =============================================================================

const RXP_WORKER_SOURCE = `
'use strict';

/**
 * Parses a Riegl RXP binary point cloud buffer using heuristic detection.
 *
 * Because RXP files lack a standardized header, this function iterates
 * through plausible byte offsets to find a consistent point count, then
 * determines the record stride (number of bytes per point) and whether
 * RGB color channels are present. Points are read as XYZ double-precision
 * coordinates with unsigned short intensity. Missing colors are filled
 * with grayscale derived from normalized intensity.
 *
 * @param {ArrayBuffer} buffer - The raw RXP file buffer.
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array, count: number, hasColor: boolean, hasIntensity: boolean}} Parsed point data.
 */
function parseRXP(buffer) {
  const dv = new DataView(buffer);
  const fileSize = buffer.byteLength;
  
  // Funzione di debug per inviare messaggi (opzionale)
  function debug(msg) {
    // Invia messaggio al main (per ora commentato per non intasare)
    // self.postMessage({ debug: true, message: msg });
  }
  
  debug("File size: " + fileSize);
  
  // ---- 1. Ricerca numero punti ----
  let pointCount = 0;
  // Legge uint32 a vari offset
  const possibleOffsets = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128];
  for (let off of possibleOffsets) {
    if (off + 4 <= fileSize) {
      const val = dv.getUint32(off, true);
      // Verosimilmente il numero punti è compreso tra 1 e 100 milioni e la dimensione totale coerenza
      if (val > 0 && val < 200000000) {
        // stima dimensione minima per punto (26 byte) e massima (50 byte)
        const minSize = val * 26;
        const maxSize = val * 50;
        if (fileSize >= minSize && fileSize <= maxSize + 1024) {
          pointCount = val;
          debug("Punti trovati a offset " + off + ": " + pointCount);
          break;
        }
      }
    }
  }
  
  // Se non trovato, prova a leggere come int32 a 4 byte in little endian a offset 0-256
  if (pointCount === 0) {
    for (let off = 0; off < 512; off += 4) {
      if (off + 4 <= fileSize) {
        const val = dv.getUint32(off, true);
        if (val > 0 && val < 100000000) {
          const estSize = val * 26;
          if (Math.abs(fileSize - estSize) < 1024) {
            pointCount = val;
            debug("Punti stimati offset " + off + ": " + pointCount);
            break;
          }
        }
      }
    }
  }
  
  if (pointCount === 0) {
    // Stima basata sulla dimensione del file
    const possibleStride = [26, 28, 30, 32, 36, 40];
    for (let stride of possibleStride) {
      const est = Math.floor(fileSize / stride);
      if (est > 0 && est < 100000000 && Math.abs(fileSize - est * stride) < 4096) {
        pointCount = est;
        debug("Stima da stride " + stride + ": " + pointCount);
        break;
      }
    }
  }
  
  if (pointCount === 0 || pointCount > 100000000) {
    throw new Error('Impossibile determinare il numero di punti nel file RXP');
  }
  
  debug("Numero punti finale: " + pointCount);
  
  // ---- 2. Determinare lo stride (bytes per punto) ----
  // Cerchiamo di capire se i punti iniziano a 1024 (header fisso) o altrove
  let dataStart = 1024; // default tipico RXP
  // Se il file è troppo piccolo per avere header 1024, potrebbe iniziare prima
  if (fileSize < 1024) dataStart = 0;
  
  // Se la dimensione residua non è multipla di un numero ragionevole, proviamo a spostare dataStart
  let stride = 0;
  let hasRGB = false;
  let rgbOffset = -1;
  
  const possibleStrides = [26, 27, 28, 29, 30, 32, 34, 36, 38, 40];
  for (let s of possibleStrides) {
    const bytesForPoints = fileSize - dataStart;
    if (bytesForPoints % s === 0 && (bytesForPoints / s) === pointCount) {
      stride = s;
      break;
    }
  }
  
  if (stride === 0) {
    // Se nessuno stride si adatta esattamente, prova a stimare basato sulla presenza di RGB
    // RXP tipico: 26 byte (xyz double + intensity ushort) oppure 29 byte (rgb aggiuntivo)
    const bytesForPoints = fileSize - dataStart;
    const stride26 = bytesForPoints / pointCount;
    if (Math.abs(stride26 - 26) < 2) stride = 26;
    else if (Math.abs(stride26 - 29) < 2) { stride = 29; hasRGB = true; rgbOffset = 26; }
    else if (Math.abs(stride26 - 28) < 2) stride = 28; // forse con padding
    else stride = 26; // default
  }
  
  // Se stride determinato e non abbiamo ancora deciso RGB, controlliamo se haRGB in base allo stride
  if (stride === 29) {
    hasRGB = true;
    rgbOffset = 26;
  } else if (stride === 28) {
    // Potrebbe essere RGB con un byte di padding? proviamo a vedere se i valori RGB sono plausibili
    // Per ora lo assumiamo senza RGB
    hasRGB = false;
  } else {
    hasRGB = false;
  }
  
  debug("Stride: " + stride + ", hasRGB: " + hasRGB + ", dataStart: " + dataStart);
  
  // ---- 3. Allocazione array ----
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);
  const intensity = new Float32Array(pointCount);
  
  let minI = Infinity, maxI = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  
  // ---- 4. Lettura punti ----
  for (let i = 0; i < pointCount; i++) {
    const offset = dataStart + i * stride;
    if (offset + 26 > fileSize) break;
    
    // Legge XYZ come double (8 byte ciascuno) little-endian
    const x = dv.getFloat64(offset, true);
    const y = dv.getFloat64(offset + 8, true);
    const z = dv.getFloat64(offset + 16, true);
  
    
    positions[i*3] = x;
    positions[i*3+1] = y;
    positions[i*3+2] = z;
    
    // Aggiorna bounds per debug
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    
    // Intensità: unsigned short a offset 24 (nei formati senza RGB) o a offset 24 se stride >=26
    let iVal = 0;
    if (offset + 24 + 2 <= fileSize) {
      iVal = dv.getUint16(offset + 24, true);
    } else {
      iVal = 0;
    }
    intensity[i] = iVal;
    if (iVal < minI) minI = iVal;
    if (iVal > maxI) maxI = iVal;
    
    // Colori RGB se presenti
    if (hasRGB && rgbOffset >= 0 && offset + rgbOffset + 3 <= fileSize) {
      const r = dv.getUint8(offset + rgbOffset);
      const g = dv.getUint8(offset + rgbOffset + 1);
      const b = dv.getUint8(offset + rgbOffset + 2);
      colors[i*3] = r;
      colors[i*3+1] = g;
      colors[i*3+2] = b;
    } else {
      // temporaneo, verrà riempito dopo normalizzazione intensità
      colors[i*3] = colors[i*3+1] = colors[i*3+2] = 0;
    }
  }
  
  debug("Min X: " + minX + " Max X: " + maxX);
  debug("Min Y: " + minY + " Max Y: " + maxY);
  debug("Min Z: " + minZ + " Max Z: " + maxZ);
  debug("Min Intensity: " + minI + " Max Intensity: " + maxI);
  
  // Normalizza intensità to 0..1
  const iRange = maxI - minI;
  if (iRange > 0) {
    for (let i = 0; i < pointCount; i++) {
      intensity[i] = (intensity[i] - minI) / iRange;
    }
  } else {
    for (let i = 0; i < pointCount; i++) intensity[i] = 0.5;
  }
  
  // Se non abbiamo colori veri, impostiamo in base all'intensità normalizzata
  if (!hasRGB) {
    for (let i = 0; i < pointCount; i++) {
      const val = Math.floor(intensity[i] * 255);
      colors[i*3] = val;
      colors[i*3+1] = val;
      colors[i*3+2] = val;
    }
  }
  
  // Se le coordinate sono enormi o troppo piccole, potrebbero essere in metri (normale)
  // Non facciamo ulteriori trasformazioni
  
  return {
    positions,
    colors,
    intensity,
    count: pointCount,
    hasColor: hasRGB,
    hasIntensity: true
  };
}

/**
 * Web Worker message handler for RXP parsing.
 *
 * Receives the raw ArrayBuffer, delegates to parseRXP, and posts the
 * typed arrays back to the main thread using transferable objects
 * for zero-copy transfer.
 *
 * @listens MessageEvent
 */
self.onmessage = function(e) {
  try {
    const buffer = e.data;
    const result = parseRXP(buffer);
    self.postMessage({ ok: true, ...result }, 
      [result.positions.buffer, result.colors.buffer, result.intensity.buffer]);
  } catch(err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads Riegl RXP binary point clouds via a Web Worker. */
export class RXPLoader {
  /**
   * Creates a Blob URL for the inline RXP worker source.
   */
  constructor() {
    const blob = new Blob([RXP_WORKER_SOURCE], { type: 'application/javascript' });
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
   * Checks whether a file has an .rxp extension.
   *
   * @param {File} file - The file to check.
   * @returns {boolean} True if the file is an RXP file.
   */
  static isRXPFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.rxp');
  }
  
  /**
   * Reads an RXP file into an ArrayBuffer.
   *
   * @param {File} file - The DOM File object.
   * @returns {Promise<ArrayBuffer>} The raw file buffer.
   */
  static async readFile(file) {
    return await file.arrayBuffer();
  }
  
  /**
   * Parses an RXP buffer in a Web Worker and returns structured point
   * cloud data.
   *
   * @param {ArrayBuffer} arrayBuffer - The raw RXP file buffer.
   * @returns {Promise<{ok: boolean, positions: Float32Array, colors: Uint8Array, intensity: Float32Array, count: number, hasColor: boolean, hasIntensity: boolean}>} Parsed point data.
   */
  load(arrayBuffer) {
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
