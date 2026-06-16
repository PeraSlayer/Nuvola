/*
===============================================================================
File: laz-decompressor.js

Questo modulo prova a convertire dati LAZ compressi in dati LAS leggibili dal
loader LAS. Carica una build WebAssembly di laszip al primo utilizzo, mantiene
in cache l'istanza WASM e copia i buffer di input/output tra JavaScript e la
memoria del modulo WebAssembly.

Espone decompressLAZ(lazBuffer), una funzione asincrona che riceve un
ArrayBuffer LAZ e restituisce un ArrayBuffer LAS. Se il decoder non e
disponibile o la build WASM non espone le funzioni attese, genera errori
esplicativi con alternative operative.

Il file e quindi un adattatore: consente al flusso principale di trattare i file
LAZ come LAS dopo una fase preliminare di decompressione.
===============================================================================
*/

/**
 * LAZ decompressor using WASM laszip.
 *
 * Loads laszip.wasm from CDN on first use. Falls back to a descriptive
 * error if the WASM module is unavailable.
 *
 * CDN source: https://unpkg.com/laszip-wasm@1.0.0/dist/laszip.wasm
 */

const LASZIP_WASM_URL = 'https://unpkg.com/laszip-wasm@1.0.0/dist/laszip.wasm';

let _wasmInstance = null;
let _wasmLoading = null;

async function _loadWasm() {
  if (_wasmInstance) return _wasmInstance;
  if (_wasmLoading) return _wasmLoading;

  _wasmLoading = (async () => {
    try {
      const response = await fetch(LASZIP_WASM_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const wasmBytes = await response.arrayBuffer();
      const result = await WebAssembly.instantiate(wasmBytes, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
          emscripten_memcpy: () => {},
        },
      });

      _wasmInstance = result.instance;
      return _wasmInstance;
    } catch (err) {
      _wasmInstance = null;
      throw new Error(
        `Could not load laszip WASM from CDN.\n` +
        `Install it via: npm install laszip-wasm\n` +
        `Or decompress manually using: laszip -i file.laz -o file.las\n` +
        `Or use the online converter at: https://laszip.org/\n` +
        `Falling back to error.`
      );
    }
  })();

  return _wasmLoading;
}

/**
 * Decompress a LAZ ArrayBuffer to LAS ArrayBuffer.
 * Returns the raw LAS data ready for parsing.
 *
 * @param {ArrayBuffer} lazBuffer
 * @returns {Promise<ArrayBuffer>}
 */
export async function decompressLAZ(lazBuffer) {
  const wasm = await _loadWasm();
  const decoder = wasm.exports.laszip_decoder_create
    ? wasm
    : _throwNoDecoder();

  const size = lazBuffer.byteLength;
  const inputPtr = wasm.exports.malloc(size);
  const inputBuf = new Uint8Array(wasm.exports.memory.buffer, inputPtr, size);
  inputBuf.set(new Uint8Array(lazBuffer));

  const outputSizePtr = wasm.exports.malloc(4);
  const outputPtr = wasm.exports.laszip_decode(inputPtr, size, outputSizePtr);

  if (!outputPtr) {
    wasm.exports.free(inputPtr);
    wasm.exports.free(outputSizePtr);
    throw new Error('WASM laszip decompression failed');
  }

  const outSize = new Uint32Array(wasm.exports.memory.buffer, outputSizePtr, 1)[0];
  const output = new Uint8Array(wasm.exports.memory.buffer, outputPtr, outSize);
  const result = output.slice().buffer;

  wasm.exports.free(inputPtr);
  wasm.exports.free(outputPtr);
  wasm.exports.free(outputSizePtr);

  return result;
}

function _throwNoDecoder() {
  throw new Error(
    'LAZ decompression requires the laszip-wasm package.\n\n' +
    'Install: npm install laszip-wasm\n' +
    'Or decompress your file manually:\n' +
    '  laszip -i file.laz -o file.las\n' +
    'Or use the online converter at https://laszip.org/'
  );
}
