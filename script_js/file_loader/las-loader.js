/**
 * LAS point cloud loader with Web Worker-based parsing and chunked reading.
 *
 * Parses uncompressed LAS files (versions 1.2-1.4) entirely in JavaScript.
 * Supports both full in-memory parsing for small files and chunked reading
 * (~256MB blocks) for files larger than 2GB to avoid memory pressure. A
 * dedicated Web Worker extracts header metadata, scale/offset, coordinates,
 * intensity, and optional RGB color data, delivering typed arrays ready for
 * PointCloud rendering.
 *
 * For LAZ (compressed LAS) files, decompress first with laz-decompressor.js
 * and then pass the resulting LAS buffer to this loader.
 *
 * @module las-loader
 */

/*
===============================================================================
File: las-loader.js

Questo modulo carica file LAS non compressi direttamente in JavaScript. Il
parser inline, eseguito in un Web Worker, legge header LAS, versione, formato
record, scale, offset, conteggio punti, coordinate, intensita e colori quando
presenti.

Per file grandi (>2GB) usa chunked reading: legge il file a blocchi di ~256MB
per evitare di caricare l'intero file in memoria.

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
// Supports chunked reading for files > 2GB.
// =============================================================================

const LAS_WORKER_SOURCE = `
'use strict';

/**
 * Parses the LAS file header and extracts structural metadata.
 *
 * Validates the "LASF" signature, reads version, point format, record
 * length, scale/offset factors, and determines whether color (RGB) data
 * is embedded. For LAS 1.4, reads the 64-bit point count at offset 247.
 *
 * @param {DataView} dv - DataView over the header bytes (at least 375 bytes).
 * @returns {{pointOffset: number, pointCount: number, pointFormat: number, pointRecordLength: number, scaleX: number, scaleY: number, scaleZ: number, offsetX: number, offsetY: number, offsetZ: number, hasColor: boolean, rgbOffset: number}} Parsed header information.
 */
function parseHeader(dv) {
  const fileSignature = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  console.log('[LAS Worker] parseHeader called, buffer size:', dv.byteLength);
  console.log('[LAS Worker] File signature:', fileSignature);
  if (fileSignature !== 'LASF') {
    console.error('[LAS Worker] Signature mismatch! Expected "LASF", got:', fileSignature);
    console.error('[LAS Worker] First 4 bytes:', dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    throw new Error('Not a valid LAS file (signature mismatch)');
  }
  
  const headerSize = dv.getUint16(94, true);
  const majorVersion = dv.getUint8(24);
  const minorVersion = dv.getUint8(25);
  const pointOffset = dv.getUint32(96, true);
  let pointCount = dv.getUint32(107, true);
  const pointFormat = dv.getUint8(104, true);
  const pointRecordLength = dv.getUint16(105, true);
  
  // LAS 1.4 uses a 64-bit point count at offset 247
  if ((majorVersion === 1 && minorVersion >= 4) && headerSize >= 375) {
    // Leggi sempre il conteggio 64-bit per LAS 1.4 (è il valore authoritative)
    const countLow = dv.getUint32(247, true);
    const countHigh = dv.getUint32(251, true);
    const count64 = countLow + (countHigh * 0x100000000);
    if (count64 > 0 && count64 <= 1000000000) {
      pointCount = Number(count64);
    }
  }
  
  if (pointCount === 0 || pointCount > 1000000000) {
    throw new Error('Invalid point count in LAS header');
  }
  
  const scaleX = dv.getFloat64(131, true);
  const scaleY = dv.getFloat64(139, true);
  const scaleZ = dv.getFloat64(147, true);
  const offsetX = dv.getFloat64(155, true);
  const offsetY = dv.getFloat64(163, true);
  const offsetZ = dv.getFloat64(171, true);
  
  const hasColor = (pointFormat === 2 || pointFormat === 3 || pointFormat === 7 || pointFormat === 8);
  
  // Determine byte offset of RGB fields within each point record
  let rgbOffset = -1;
  if (pointFormat === 2) rgbOffset = 20;
  else if (pointFormat === 3) rgbOffset = 28;
  else if (pointFormat === 7) rgbOffset = 26;
  else if (pointFormat === 8) rgbOffset = 34;
  
  return {
    pointOffset, pointCount, pointFormat, pointRecordLength,
    scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ,
    hasColor, rgbOffset
  };
}

/**
 * Parses a raw chunk of LAS point data without validating the header.
 *
 * Iterates over point records applying scale/offset transforms to produce
 * world-space coordinates. Tracks per-chunk intensity min/max for later
 * global normalization.
 *
 * @param {ArrayBuffer} buffer - Raw point data chunk.
 * @param {object} header - Parsed header object from parseHeader().
 * @param {number} numPoints - Number of point records expected in this chunk.
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array, minI: number, maxI: number, numPoints: number}} Parsed point data for this chunk.
 */
function parseRawChunk(buffer, header, numPoints) {
  // Parse raw point data chunk (no header validation)
  const dv = new DataView(buffer);
  const positions = new Float32Array(numPoints * 3);
  const colors = new Uint8Array(numPoints * 3);
  const intensity = new Float32Array(numPoints);
  
  const { scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ, pointRecordLength, hasColor, rgbOffset } = header;
  
  let minI = Infinity, maxI = -Infinity;
  let actualPoints = 0;
  
  for (let i = 0; i < numPoints; i++) {
    const pointStart = i * pointRecordLength;
    if (pointStart + pointRecordLength > buffer.byteLength) break;
    
    const x = dv.getInt32(pointStart, true) * scaleX + offsetX;
    const y = dv.getInt32(pointStart + 4, true) * scaleY + offsetY;
    const z = dv.getInt32(pointStart + 8, true) * scaleZ + offsetZ;
    
    positions[actualPoints*3] = x;
    positions[actualPoints*3+1] = y;
    positions[actualPoints*3+2] = z;
    
    const iVal = dv.getUint16(pointStart, true);
    intensity[actualPoints] = iVal;
    if (iVal < minI) minI = iVal;
    if (iVal > maxI) maxI = iVal;
    
    // Parse RGB if the point format supports it; LAS stores 16-bit channels
    if (hasColor && rgbOffset !== -1 && pointStart + rgbOffset + 6 <= buffer.byteLength) {
      let r = dv.getUint16(pointStart + rgbOffset, true);
      let g = dv.getUint16(pointStart + rgbOffset + 2, true);
      let b = dv.getUint16(pointStart + rgbOffset + 4, true);
      colors[actualPoints*3] = Math.min(255, r / 256);
      colors[actualPoints*3+1] = Math.min(255, g / 256);
      colors[actualPoints*3+2] = Math.min(255, b / 256);
    } else {
      colors[actualPoints*3] = colors[actualPoints*3+1] = colors[actualPoints*3+2] = 0;
    }
    
    actualPoints++;
  }
  
  return { 
    positions: positions.subarray(0, actualPoints * 3),
    colors: colors.subarray(0, actualPoints * 3),
    intensity: intensity.subarray(0, actualPoints),
    minI, maxI, numPoints: actualPoints 
  };
}

/**
 * Parses an entire LAS buffer in one pass (for small files that fit in memory).
 *
 * Reads the header, iterates over all point records, normalizes intensity
 * to 0..1, and fills missing colors with grayscale based on normalized
 * intensity.
 *
 * @param {ArrayBuffer} buffer - Complete LAS file buffer.
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array, count: number, hasColor: boolean, hasIntensity: boolean}} Parsed point data.
 */
function parseFull(buffer) {
  const dv = new DataView(buffer);
  const header = parseHeader(dv);
  const { pointOffset, pointCount, pointRecordLength, scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ, hasColor, rgbOffset } = header;
  const fileSize = buffer.byteLength;
  
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);
  const intensity = new Float32Array(pointCount);
  
  let minI = Infinity, maxI = -Infinity;
  
  for (let i = 0; i < pointCount; i++) {
    const pointStart = pointOffset + i * pointRecordLength;
    if (pointStart + pointRecordLength > fileSize) break;
    
    const x = dv.getInt32(pointStart, true) * scaleX + offsetX;
    const y = dv.getInt32(pointStart + 4, true) * scaleY + offsetY;
    const z = dv.getInt32(pointStart + 8, true) * scaleZ + offsetZ;
    
    positions[i*3] = x;
    positions[i*3+1] = y;
    positions[i*3+2] = z;
    
    const iVal = dv.getUint16(pointStart, true);
    intensity[i] = iVal;
    if (iVal < minI) minI = iVal;
    if (iVal > maxI) maxI = iVal;
    
    if (hasColor && rgbOffset !== -1 && pointStart + rgbOffset + 6 <= fileSize) {
      let r = dv.getUint16(pointStart + rgbOffset, true);
      let g = dv.getUint16(pointStart + rgbOffset + 2, true);
      let b = dv.getUint16(pointStart + rgbOffset + 4, true);
      colors[i*3] = Math.min(255, r / 256);
      colors[i*3+1] = Math.min(255, g / 256);
      colors[i*3+2] = Math.min(255, b / 256);
    } else {
      colors[i*3] = colors[i*3+1] = colors[i*3+2] = 0;
    }
  }
  
  // Normalize intensity to 0..1 range
  const iRange = maxI - minI;
  for (let i = 0; i < pointCount; i++) {
    if (iRange > 0) intensity[i] = (intensity[i] - minI) / iRange;
    else intensity[i] = 0.5;
  }
  
  // If no RGB data, derive grayscale colors from normalized intensity
  if (!hasColor) {
    for (let i = 0; i < pointCount; i++) {
      const val = Math.floor(intensity[i] * 255);
      colors[i*3] = val;
      colors[i*3+1] = val;
      colors[i*3+2] = val;
    }
  }
  
  return { positions, colors, intensity, count: pointCount, hasColor, hasIntensity: true };
}

/**
 * Web Worker message handler for LAS parsing.
 *
 * Supports three message types:
 * - 'parseHeader': returns header metadata only.
 * - 'parseRawChunk': parses a subset of point records and returns them.
 * - 'parseFull': parses the entire buffer at once.
 *
 * Results are posted back with transferable buffers for zero-copy.
 *
 * @listens MessageEvent
 */
self.onmessage = function(e) {
  try {
    const msg = e.data;
    if (msg.type === 'parseHeader') {
      const header = parseHeader(new DataView(msg.buffer));
      self.postMessage({ type: 'header', header });
    } else if (msg.type === 'parseRawChunk') {
      const result = parseRawChunk(msg.buffer, msg.header, msg.numPoints);
      self.postMessage(
        { type: 'chunk', ...result },
        [result.positions.buffer, result.colors.buffer, result.intensity.buffer]
      );
    } else if (msg.type === 'parseFull') {
      const result = parseFull(msg.buffer);
      self.postMessage(
        { type: 'full', ...result },
        [result.positions.buffer, result.colors.buffer, result.intensity.buffer]
      );
    }
  } catch(err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};
`;

/** Loads LAS / LAZ point clouds via a Web Worker. */
export class LASLoader {
  /**
   * Creates a Blob URL for the inline LAS worker source.
   */
  constructor() {
    const blob = new Blob([LAS_WORKER_SOURCE], { type: 'application/javascript' });
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
   * Checks whether a file has a .las or .laz extension.
   *
   * @param {File} file - The file to check.
   * @returns {boolean} True if the file is a LAS or LAZ file.
   */
  static isLASFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.las') || n.endsWith('.laz');
  }
  
  /**
   * Reads a LAS file for processing. For standard LAS, returns the File
   * object so chunked reading can be used. LAZ files are handled at a
   * higher level via decompression before reaching this method.
   *
   * @param {File} file - The DOM File object.
   * @returns {Promise<{file: File, type: string}>} File reference for further processing.
   */
  static async readFile(file) {
    // For LAS files, return the File object for chunked reading
    // For LAZ files, this will be overridden in main.js
    return { file, type: 'las-file' };
  }
  
  /**
   * Sends a message to the worker and returns a Promise that resolves with
   * the response. Handles worker errors by terminating the worker.
   *
   * @param {Worker} worker - The Web Worker instance.
   * @param {object} msg - The message to send.
   * @param {ArrayBuffer[]} [transferables=[]] - Transferable objects for zero-copy.
   * @returns {Promise<object>} The worker's response message.
   * @private
   */
  _sendToWorker(worker, msg, transferables = []) {
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'error') reject(new Error(e.data.error));
        else resolve(e.data);
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage(msg, transferables);
    });
  }
  
  /**
   * Loads and parses a LAS file or buffer. Chooses chunked reading for
   * large files ({file, type} objects) or full parsing for in-memory
   * ArrayBuffers.
   *
   * @param {File|ArrayBuffer|object} fileRef - Either a raw ArrayBuffer or a
   *   file reference object {file, type: 'las-file'}.
   * @param {boolean} [isCompressed=false] - Whether the source is compressed
   *   (deprecated; LAZ decompression now happens externally).
   * @returns {Promise<object>} Parsed point cloud data with positions,
   *   colors, intensity, and metadata.
   */
  async load(fileRef, isCompressed = false) {
    // isCompressed è sempre false ora perché la decompressione LAZ
    // avviene in _readLASFile() prima di arrivare qui
    
    if (fileRef && fileRef.type === 'las-file') {
      // File LAS grande (>2GB): chunked reading
      return this._loadChunked(fileRef.file);
    }
    
    if (fileRef instanceof ArrayBuffer || ArrayBuffer.isView(fileRef)) {
      // Buffer in memoria: parsing completo
      return this._loadLegacy(fileRef);
    }
    
    throw new Error('Invalid input: expected ArrayBuffer or {file, type} object');
  }
  
  /**
   * Parses an entire in-memory ArrayBuffer in a single pass via the worker.
   *
   * @param {ArrayBuffer} arrayBuffer - The complete LAS file buffer.
   * @returns {Promise<object>} Parsed point data from the 'parseFull' message.
   * @private
   */
  async _loadLegacy(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this._workerUrl);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.type === 'error') reject(new Error(e.data.error));
        else if (e.data.type === 'full') resolve(e.data);
        else reject(new Error('Unexpected response type'));
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage({ type: 'parseFull', buffer: arrayBuffer }, [arrayBuffer]);
    });
  }
  
  /**
   * Loads a large LAS file using chunked reading (~256MB blocks) to avoid
   * loading the entire file into memory. Reads the header first, then
   * processes point data in sequential chunks, normalizes intensity
   * globally, and fills missing colors with grayscale.
   *
   * @param {File} file - The DOM File object to load.
   * @returns {Promise<object>} Parsed point cloud data with positions,
   *   colors, intensity, count, and metadata.
   * @private
   */
  async _loadChunked(file) {
    const worker = new Worker(this._workerUrl);
    
    try {
      // 1. Read header (first 400 bytes)
      console.log('[LAS] Loading file:', file.name, 'Size:', file.size, 'bytes');
      const headerBlob = file.slice(0, 400);
      const headerBuf = await headerBlob.arrayBuffer();
      console.log('[LAS] Header buffer size:', headerBuf.byteLength, 'bytes');
      
      // Debug: mostra i primi 4 byte per verificare la signature
      const headerView = new Uint8Array(headerBuf);
      const sigBytes = Array.from(headerView.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const sigText = String.fromCharCode(...headerView.slice(0, 4));
      console.log('[LAS] First 4 bytes (hex):', sigBytes);
      console.log('[LAS] First 4 bytes (text):', sigText);
      
      const headerMsg = await this._sendToWorker(worker, { type: 'parseHeader', buffer: headerBuf }, [headerBuf]);
      const header = headerMsg.header;
      console.log('[LAS] Header parsed successfully:', header);
      
      const { pointOffset, pointCount, pointRecordLength, hasColor, scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ } = header;
      
      console.log('[LAS] Point offset:', pointOffset, 'Point count:', pointCount, 'Record length:', pointRecordLength);
      
      // Verifica overflow per file molto grandi
      const totalDataSize = pointCount * pointRecordLength;
      console.log('[LAS] Total data size:', totalDataSize, 'bytes (', (totalDataSize / 1024 / 1024 / 1024).toFixed(2), 'GB)');
      
      if (totalDataSize > Number.MAX_SAFE_INTEGER) {
        throw new Error('File too large: point count * record length exceeds JavaScript safe integer limit');
      }
      
      // 2. Pre-allocate output arrays
      const positions = new Float32Array(pointCount * 3);
      const colors = new Uint8Array(pointCount * 3);
      const intensity = new Float32Array(pointCount);
      
      // 3. Read and parse chunks (~256MB per chunk)
      const CHUNK_POINTS = Math.max(1, Math.floor((256 * 1024 * 1024) / pointRecordLength));
      let globalMinI = Infinity, globalMaxI = -Infinity;
      let actualPoints = 0;
      
      for (let startIdx = 0; startIdx < pointCount; startIdx += CHUNK_POINTS) {
        const numPoints = Math.min(CHUNK_POINTS, pointCount - startIdx);
        const chunkStart = pointOffset + startIdx * pointRecordLength;
        const chunkEnd = Math.min(chunkStart + numPoints * pointRecordLength, file.size);
        
        console.log('[LAS] Processing chunk: startIdx=', startIdx, 'numPoints=', numPoints, 
                    'chunkStart=', chunkStart, 'chunkEnd=', chunkEnd);
        
        if (chunkStart >= file.size) break;
        
        const chunkBlob = file.slice(chunkStart, chunkEnd);
        const chunkBuf = await chunkBlob.arrayBuffer();
        
        const chunkMsg = await this._sendToWorker(worker, {
          type: 'parseRawChunk',
          buffer: chunkBuf,
          header: header,
          numPoints: numPoints
        }, [chunkBuf]);
        
        // Copy results to output arrays
        const outOffset = startIdx * 3;
        positions.set(chunkMsg.positions, outOffset);
        colors.set(chunkMsg.colors, outOffset);
        intensity.set(chunkMsg.intensity, startIdx);
        
        if (chunkMsg.minI < globalMinI) globalMinI = chunkMsg.minI;
        if (chunkMsg.maxI > globalMaxI) globalMaxI = chunkMsg.maxI;
        
        actualPoints += chunkMsg.numPoints;
        
        // Yield to UI every chunk to keep the browser responsive
        await new Promise(r => setTimeout(r, 0));
      }
      
      // 4. Normalize intensity globally to 0..1 range
      const iRange = globalMaxI - globalMinI;
      for (let i = 0; i < actualPoints; i++) {
        if (iRange > 0) intensity[i] = (intensity[i] - globalMinI) / iRange;
        else intensity[i] = 0.5;
      }
      
      // 5. Fill missing colors with grayscale based on intensity
      if (!hasColor) {
        for (let i = 0; i < actualPoints; i++) {
          const val = Math.floor(intensity[i] * 255);
          colors[i*3] = val;
          colors[i*3+1] = val;
          colors[i*3+2] = val;
        }
      }
      
      worker.terminate();
      
      return {
        positions: positions.subarray(0, actualPoints * 3),
        colors: colors.subarray(0, actualPoints * 3),
        intensity: intensity.subarray(0, actualPoints),
        count: actualPoints,
        hasColor,
        hasIntensity: true
      };
    } catch (err) {
      worker.terminate();
      throw err;
    }
  }
}
