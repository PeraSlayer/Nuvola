/**
 * PLY point cloud loader with Web Worker-based parsing.
 *
 * Reads PLY files (ASCII or Binary Little-Endian), transparently decompresses
 * .ply.gz archives via DecompressionStream, and parses header/vertex data in a
 * dedicated Web Worker to keep the main thread responsive. Extracts positions,
 * RGB colors, and intensity into typed arrays ready for PointCloud rendering.
 *
 * @module ply-loader
 */

/*
===============================================================================
File: ply-loader.js

Questo modulo carica file PLY contenenti nuvole di punti, sia ASCII sia binary
little-endian, con supporto opzionale alla decompressione gzip per .ply.gz. Il
worker inline legge l'header PLY, individua proprieta come x/y/z, RGB e
intensita, poi converte i vertici in typed array pronti per PointCloud.

Il parser gestisce tipi numerici diversi, colori float o interi, valori di
intensita e fallback cromatici quando il file non contiene RGB. Spostando il
lavoro nel Web Worker, il modulo evita blocchi dell'interfaccia durante il
caricamento di dataset pesanti.

PLYLoader espone metodi statici per riconoscere e leggere il formato e un
metodo load() che restituisce una Promise con i dati gia strutturati.
===============================================================================
*/

// =============================================================================
// PLYLoader
//
//   - Reads a PLY file (ASCII or Binary LE), transparently decompressing .gz
//   - Parsing runs in a Web Worker (see PLY_WORKER_SOURCE below) so the main
//     thread never blocks on large files
//   - Returns positions/colors/intensity typed arrays
// ============================================================================

const PLY_WORKER_SOURCE = `
'use strict';

/**
 * Parses the textual header of a PLY file and extracts format, element, and
 * property metadata.
 *
 * @param {string|string[]} lines - The header text, either as a string with
 *   newlines or a pre-split array of lines.
 * @returns {{format: string, vertexCount: number, properties: Array<{name: string, type: string}>, headerEnd: number, headerText: string}} Parsed header information.
 */
function parseHeader(lines) {
  if (!Array.isArray(lines)) lines = lines.split(String.fromCharCode(10));
  if (lines[0].trim() !== 'ply') throw new Error('Not a PLY file');
  let format = null, vertexCount = 0, headerEnd = 0;
  const properties = [];
  let inVertex = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === 'end_header') { headerEnd = i; break; }
    const parts = line.split(/ +/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') { inVertex = parts[1] === 'vertex'; if (inVertex) vertexCount = parseInt(parts[2], 10); else inVertex = false; }
    else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') properties.push({ name: parts[parts.length-1], type: 'list' });
      else properties.push({ name: parts[parts.length-1], type: parts[1] });
    }
  }
  if (!format || !vertexCount) throw new Error('Invalid PLY header');
  return { format, vertexCount, properties, headerEnd, headerText: lines.slice(0, headerEnd+1).join(String.fromCharCode(10)) };
}

const TYPE_SIZES = { char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, int32:4, uint:4, uint32:4, float:4, float32:4, double:8, float64:8 };

/**
 * Finds the index of a property within the properties array by trying a list
 * of candidate names (case-insensitive). Returns -1 if no match is found.
 *
 * @param {Array<{name: string}>} props - The property list from the header.
 * @param {string[]} names - Candidate property names to search for.
 * @returns {number} The index of the first matching property, or -1.
 */
function propIndex(props, names) {
  for (const n of names) { const i = props.findIndex(p => p.name.toLowerCase() === n); if (i >= 0) return i; }
  return -1;
}

/**
 * Parses the ASCII body of a PLY file into typed arrays.
 *
 * Reads the text line by line (without allocating a global array), splits on
 * whitespace, and converts each field to a numeric value. If colors are absent,
 * fills with a default lavender (180, 180, 200).
 *
 * @param {string} body - The ASCII content after the header.
 * @param {number} vertexCount - Expected number of vertex lines.
 * @param {Array<{name: string, type: string}>} props - Property metadata from the header.
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array|null, count: number, hasColor: boolean, hasIntensity: boolean}} Parsed point data.
 */
function parseAscii(body, vertexCount, props) {
  const ix = propIndex(props, ['x']), iy = propIndex(props, ['y']), iz = propIndex(props, ['z']);
  const ir = propIndex(props, ['red','r']), ig = propIndex(props, ['green','g']), ib = propIndex(props, ['blue','b']);
  const ii = propIndex(props, ['intensity','scalar_intensity','i','reflectance']);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const intensity = new Float32Array(vertexCount);
  let hasColor = ir >= 0, hasIntensity = ii >= 0;

  // MODIFICA: Leggiamo la stringa riga per riga al volo usando indexOf, senza allocare array globali
  let pos = 0;
  let v = 0;
  const len = body.length;
  const newlineChar = String.fromCharCode(10);

  while (v < vertexCount && pos < len) {
    let nextNewline = body.indexOf(newlineChar, pos);
    if (nextNewline === -1) nextNewline = len;
    
    const line = body.substring(pos, nextNewline).trim();
    pos = nextNewline + 1;
    
    if (line === '') continue;
    
    const vals = line.split(/ +/);
    if (vals.length <= Math.max(ix, iy, iz)) continue;

    positions[v*3]   = parseFloat(vals[ix]); 
    positions[v*3+1] = parseFloat(vals[iy]); 
    positions[v*3+2] = parseFloat(vals[iz]);
    
    if (hasColor) { 
      colors[v*3]   = +vals[ir]; 
      colors[v*3+1] = +vals[ig]; 
      colors[v*3+2] = +vals[ib]; 
    }
    if (hasIntensity) intensity[v] = parseFloat(vals[ii]);
    v++;
  }

  if (!hasColor) { for (let i = 0; i < v; i++) { colors[i*3]=180; colors[i*3+1]=180; colors[i*3+2]=200; } }
  return { positions: positions.subarray(0, v*3), colors: colors.subarray(0, v*3), intensity: hasIntensity ? intensity.subarray(0, v) : null, count: v, hasColor, hasIntensity };
}

/**
 * Parses the binary body of a PLY file into typed arrays.
 *
 * Iterates over each vertex record using the DataView API, respecting the
 * format byte order (little-endian). Converts float color values to 0..255
 * range. If no color properties exist, fills with a default lavender.
 *
 * @param {ArrayBuffer} buffer - The raw file buffer.
 * @param {number} byteOffset - Offset into the buffer where vertex data starts.
 * @param {number} vertexCount - Number of vertices to read.
 * @param {Array<{name: string, type: string}>} props - Property metadata.
 * @param {boolean} littleEndian - Whether the data is little-endian.
 * @returns {{positions: Float32Array, colors: Uint8Array, intensity: Float32Array|null, count: number, hasColor: boolean, hasIntensity: boolean}} Parsed point data.
 */
function parseBinary(buffer, byteOffset, vertexCount, props, littleEndian) {
  const ix = propIndex(props, ['x']), iy = propIndex(props, ['y']), iz = propIndex(props, ['z']);
  const ir = propIndex(props, ['red','r']), ig = propIndex(props, ['green','g']), ib = propIndex(props, ['blue','b']);
  const ii = propIndex(props, ['intensity','scalar_intensity','i','reflectance']);
  let stride = 0;
  const offsets = props.map(p => { const o = stride; if (p.type !== 'list') stride += TYPE_SIZES[p.type] || 4; return o; });
  const dv = new DataView(buffer);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const intensity = new Float32Array(vertexCount);
  const hasColor = ir >= 0, hasIntensity = ii >= 0;
  const le = littleEndian;
  /**
   * Reads a single numeric value from the DataView at the specified offset,
   * selecting the correct DataView getter based on the PLY type name.
   *
   * @param {number} off - Byte offset within the DataView.
   * @param {string} type - PLY property type string (e.g. 'float', 'uint8').
   * @returns {number} The numeric value.
   */
  function readVal(off, type) {
    switch(type) {
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
  const hasPos = ix >= 0 && iy >= 0 && iz >= 0;
  if (!hasPos) throw new Error('PLY vertex element missing x/y/z properties');
  for (let v = 0; v < vertexCount; v++) {
    const base = byteOffset + v * stride;
    positions[v*3] = readVal(base + offsets[ix], props[ix].type);
    positions[v*3+1] = readVal(base + offsets[iy], props[iy].type);
    positions[v*3+2] = readVal(base + offsets[iz], props[iz].type);
    if (hasColor) {
      let r = readVal(base + offsets[ir], props[ir].type);
      let g = readVal(base + offsets[ig], props[ig].type);
      let b = readVal(base + offsets[ib], props[ib].type);
      if (props[ir].type === 'float' || props[ir].type === 'float32' || props[ir].type === 'double') { r*=255; g*=255; b*=255; }
      colors[v*3]=r; colors[v*3+1]=g; colors[v*3+2]=b;
    }
    if (hasIntensity) intensity[v] = readVal(base + offsets[ii], props[ii].type);
  }
  if (!hasColor) { for (let v = 0; v < vertexCount; v++) { colors[v*3]=180; colors[v*3+1]=180; colors[v*3+2]=200; } }
  return { positions, colors, intensity: hasIntensity ? intensity : null, count: vertexCount, hasColor, hasIntensity };
}

/**
 * Web Worker message handler for PLY parsing.
 *
 * Receives the raw ArrayBuffer, scans for the ASCII header up to
 * "end_header", delegates to parseHeader, then routes to either
 * parseAscii or parseBinary based on the format field. Posts the
 * resulting typed arrays back to the main thread using transferable
 * objects for zero-copy transfer.
 *
 * @listens MessageEvent
 */
self.onmessage = function(e) {
  try {
    const buffer = e.data;
    const arr = new Uint8Array(buffer);
    let lineEnd = 0, headerEndByte = 0;
    const headerLines = [];
    while (lineEnd < arr.length) {
      let start = lineEnd;
      while (lineEnd < arr.length && arr[lineEnd] !== 10 && arr[lineEnd] !== 13) lineEnd++;
      const line = new TextDecoder('ascii').decode(arr.subarray(start, lineEnd));
      headerLines.push(line);
      if (line.trim() === 'end_header') { headerEndByte = lineEnd; break; }
      while (lineEnd < arr.length && (arr[lineEnd] === 10 || arr[lineEnd] === 13)) lineEnd++;
    }
    if (!headerEndByte) throw new Error('PLY header not found');
    const header = parseHeader(headerLines);
    let byteOffset = headerEndByte;
    while (byteOffset < arr.length && (arr[byteOffset] === 10 || arr[byteOffset] === 13)) byteOffset++;
    let result;
    if (header.format === 'ascii') {
      const body = new TextDecoder('utf-8').decode(new Uint8Array(buffer, byteOffset));
      result = parseAscii(body, header.vertexCount, header.properties);
    } else if (header.format === 'binary_little_endian') {
      result = parseBinary(buffer, byteOffset, header.vertexCount, header.properties, true);
    } else throw new Error('Unsupported format: ' + header.format);
    self.postMessage({ ok: true, ...result }, [result.positions.buffer, result.colors.buffer, ...(result.intensity ? [result.intensity.buffer] : [])]);
  } catch(err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads PLY point clouds (ASCII or Binary LE) via a Web Worker. */
export class PLYLoader {
  /**
   * Creates a Blob URL for the inline PLY worker source.
   */
  constructor() {
    const blob = new Blob([PLY_WORKER_SOURCE], { type: 'application/javascript' });
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
   * Reads a PLY (or .ply.gz) file from a File object, transparently
   * decompressing gzip if the filename indicates compression.
   *
   * @param {File} file - The DOM File object to read.
   * @returns {Promise<ArrayBuffer>} The uncompressed file buffer.
   */
  static async readFile(file) {
    let buf = await file.arrayBuffer();
    if (file.name.toLowerCase().endsWith('.gz')) {
      if (typeof DecompressionStream === 'undefined')
        throw new Error('Gzip requires DecompressionStream (use a modern browser)');
      const ds = new DecompressionStream('gzip');
      buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    }
    return buf;
  }

  /**
   * Checks whether a file has a PLY extension (including .ply.gz variants).
   *
   * @param {File} file - The file to check.
   * @returns {boolean} True if the file is a PLY file.
   */
  static isPLYFile(file) {
    const n = file.name.toLowerCase();
    return n.endsWith('.ply') || n.endsWith('.ply.gz') || (n.endsWith('.gz') && n.includes('.ply'));
  }

  /**
   * Parses a PLY ArrayBuffer in a Web Worker and returns structured point
   * cloud data.
   *
   * @param {ArrayBuffer} arrayBuffer - The raw PLY file buffer (already
   *   decompressed if gzip).
   * @returns {Promise<{ok: boolean, positions: Float32Array, colors: Uint8Array, intensity: Float32Array|null, count: number, hasColor: boolean, hasIntensity: boolean}>} Parsed point data.
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
