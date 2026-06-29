/*
===============================================================================
File: laz-decompressor.js

Decompressore LAZ basato su laz-perf (WASM). Carica il modulo laz-perf
dalla cartella tools/laz-perf/ e usa la classe LASZip per decomprimere
i punti compressi.

Espone decompressLAZ(lazBuffer), una funzione asincrona che riceve un
ArrayBuffer LAZ e restituisce un ArrayBuffer LAS pronto per il parsing.
===============================================================================
*/

const _moduleDir = new URL('./', import.meta.url).pathname;
const _projectRoot = _moduleDir.replace(/script_js\/file_loader\/$/, '');
const LAZ_PERF_JS = _projectRoot + 'tools/laz-perf/laz-perf.js';
const LAZ_PERF_WASM_DIR = _projectRoot + 'tools/laz-perf/';

let _lazPerfModule = null;
let _loading = null;

async function _loadLazPerf() {
  if (_lazPerfModule) return _lazPerfModule;
  if (_loading) return _loading;

  _loading = (async () => {
    if (typeof globalThis.createLazPerf === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LAZ_PERF_JS;
        script.onload = resolve;
        script.onerror = () => reject(new Error(
          'Failed to load laz-perf.js from ' + LAZ_PERF_JS + '\n' +
          'Make sure the file exists in tools/laz-perf/'
        ));
        document.head.appendChild(script);
      });
    }

    if (typeof globalThis.createLazPerf === 'undefined') {
      throw new Error('laz-perf.js loaded but createLazPerf not found globally');
    }

    const module = await globalThis.createLazPerf({
      locateFile: (path) => LAZ_PERF_WASM_DIR + path
    });

    if (!module.LASZip) {
      throw new Error('laz-perf module loaded but LASZip class not found');
    }

    _lazPerfModule = module;
    return module;
  })();

  return _loading;
}

/**
 * Decomprime un buffer LAZ in un buffer LAS.
 * 
 * @param {ArrayBuffer} lazBuffer - Buffer LAZ compresso
 * @returns {Promise<ArrayBuffer>} Buffer LAS decompresso
 */
export async function decompressLAZ(lazBuffer) {
  const module = await _loadLazPerf();

  const size = lazBuffer.byteLength;
  const srcView = new Uint8Array(lazBuffer);

  console.log('[LAZ] Decompressing buffer, size:', size, 'bytes');

  // Verifica firma LAS/LAZ
  if (size < 4 || srcView[0] !== 0x4C || srcView[1] !== 0x41 || 
      srcView[2] !== 0x53 || srcView[3] !== 0x46) {
    console.error('[LAZ] Invalid signature. First 4 bytes:', 
      Array.from(srcView.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    throw new Error('Not a valid LAZ file (signature mismatch)');
  }

  // Leggi header LAS per estrarre info necessarie
  const dv = new DataView(lazBuffer);
  const headerSize = dv.getUint16(94, true);
  const pointDataOffset = dv.getUint32(96, true);
  const pointFormat = dv.getUint8(104, true);
  const pointRecordLength = dv.getUint16(105, true);
  let pointCount = dv.getUint32(107, true);

  // LAS 1.4 64-bit point count
  const majorVersion = dv.getUint8(24);
  const minorVersion = dv.getUint8(25);
  if (majorVersion === 1 && minorVersion >= 4 && headerSize >= 375) {
    const countLow = dv.getUint32(247, true);
    const countHigh = dv.getUint32(251, true);
    const count64 = countLow + (countHigh * 0x100000000);
    if (count64 > 0) pointCount = Number(count64);
  }

  console.log('[LAZ] Point count:', pointCount, 'Point format:', pointFormat, 
              'Record length:', pointRecordLength);

  // Alloca memoria WASM per il buffer LAZ
  const inputPtr = module._malloc(size);
  if (!inputPtr) throw new Error('WASM memory allocation failed for LAZ buffer');

  try {
    module.HEAPU8.set(srcView, inputPtr);

    // Crea decoder LASZip
    const laszip = new module.LASZip();
    
    try {
      laszip.open(inputPtr, size);

      const actualCount = laszip.getCount();
      const actualPointLength = laszip.getPointLength();

      console.log('[LAZ] Decompressor reports:', actualCount, 'points,', 
                  actualPointLength, 'bytes per point');

      if (actualCount !== pointCount) {
        console.warn('[LAZ] Point count mismatch: header says', pointCount, 
                     'but decompressor says', actualCount);
        pointCount = actualCount;
      }

      // Alloca buffer per i punti decompressi
      const totalPointSize = pointCount * actualPointLength;
      console.log('[LAZ] Total decompressed size:', totalPointSize, 'bytes');
      
      const outputBuffer = new Uint8Array(totalPointSize);
      const pointPtr = module._malloc(actualPointLength);
      
      if (!pointPtr) {
        throw new Error('WASM memory allocation failed for point buffer');
      }

      try {
        // Decomprimi punto per punto
        for (let i = 0; i < pointCount; i++) {
          laszip.getPoint(pointPtr);
          outputBuffer.set(
            module.HEAPU8.subarray(pointPtr, pointPtr + actualPointLength),
            i * actualPointLength
          );
          
          // Progress reporting ogni 100k punti
          if (i % 100000 === 0) {
            console.log('[LAZ] Decompressed', i, '/', pointCount, 'points');
          }
        }
      } finally {
        module._free(pointPtr);
      }

      // Costruisci buffer LAS finale
      // Mantieni header + VLR originali, sostituisci solo i dati dei punti
      const result = new Uint8Array(pointDataOffset + totalPointSize);
      result.set(srcView.subarray(0, pointDataOffset), 0);
      result.set(outputBuffer, pointDataOffset);

      console.log('[LAZ] Decompression complete. Final buffer size:', result.buffer.byteLength);
      return result.buffer;

    } finally {
      laszip.delete();
    }
  } finally {
    module._free(inputPtr);
  }
}
