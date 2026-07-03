/**
 * E57 (ASTM-E57) point cloud loader with built-in bzip2 decompression and
 * chunked reading for large files.
 *
 * Parses the binary E57 format including its XML-based metadata section
 * and compressedVector point data packets. Implements a full bzip2
 * decompressor in JavaScript for handling compressed point payloads.
 * Supports both single-pass loading for small files and chunked streaming
 * for large datasets, with dynamic array resizing.
 *
 * All parsing runs in a Web Worker; the main thread only manages file
 * slicing and Worker message routing.
 *
 * @module e57-loader
 */

const E57_WORKER_SOURCE = `
'use strict';

/**
 * Decompresses a bzip2-compressed byte array into an uncompressed
 * Uint8Array. Implements the full bzip2 block format: header validation,
 * Huffman tree decoding (with MTF), Burrows-Wheeler inverse transform,
 * and RLE decompression.
 *
 * @param {Uint8Array} input - The bzip2-compressed input data.
 * @returns {Uint8Array} The decompressed output.
 */
function bzip2Decompress(input) {
  var out = [];
  var bytePos = 0, bitPos = 0;

  /**
   * Reads a single bit from the input stream.
   * @returns {number} The bit value (0 or 1).
   */
  function readBit() {
    var bit = (input[bytePos] >> (7 - bitPos)) & 1;
    if (++bitPos === 8) { bytePos++; bitPos = 0; }
    return bit;
  }

  /**
   * Reads n bits from the input stream, constructing a numerical value.
   * @param {number} n - Number of bits to read.
   * @returns {number} The combined bit value.
   */
  function readBits(n) {
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  }

  /**
   * Aligns the bit cursor to the next byte boundary.
   */
  function alignByte() {
    if (bitPos) { bytePos++; bitPos = 0; }
  }

  // Validate bzip2 magic bytes: 'BZh'
  if (input[0] !== 0x42 || input[1] !== 0x5A || input[2] !== 0x68) {
    throw new Error('Invalid bzip2 header');
  }
  var blockSize = input[3] - 0x30;
  if (blockSize < 1 || blockSize > 9) throw new Error('Invalid bzip2 block size');
  bytePos = 4; bitPos = 0;

  var BLOCK_MAGIC = [0x31,0x41,0x59,0x26,0x53,0x59];
  var END_MAGIC   = [0x17,0x72,0x45,0x38,0x50,0x90];

  /**
   * Reads 48 bits and compares them against a magic byte sequence.
   * @param {number[]} magic - The expected 6-byte magic sequence.
   * @returns {boolean} True if the magic matches.
   */
  function checkMagic(magic) {
    for (var i = 0; i < 6; i++) {
      if (readBits(8) !== magic[i]) return false;
    }
    return true;
  }

  /**
   * Builds a canonical Huffman tree from an array of code lengths.
   * @param {Int32Array|Uint8Array} lengths - Code lengths for each symbol.
   * @param {number} n - Number of symbols.
   * @returns {{table: Int32Array, n: number, maxLen: number}} The
   *   Huffman tree: table stores [code, len] pairs sequentially.
   */
  function buildHuffmanTree(lengths, n) {
    var maxLen = 0;
    for (var i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    if (maxLen === 0) return { table: [], maxLen: 0 };

    var blCount = new Int32Array(maxLen + 1);
    for (var i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;

    var code = 0;
    var nextCode = new Int32Array(maxLen + 1);
    for (var len = 1; len <= maxLen; len++) {
      code = (code + blCount[len - 1]) << 1;
      nextCode[len] = code;
    }

    var table = new Int32Array(n * 2);
    for (var sym = 0; sym < n; sym++) {
      var len = lengths[sym];
      if (len === 0) continue;
      var c = nextCode[len]++;
      table[sym * 2] = c;
      table[sym * 2 + 1] = len;
    }
    return { table: table, n: n, maxLen: maxLen };
  }

  /**
   * Decodes a single symbol from the Huffman tree by reading bits
   * until a valid code matches.
   * @param {object} tree - A Huffman tree object from buildHuffmanTree.
   * @returns {number} The decoded symbol index.
   */
  function decodeHuffman(tree) {
    var code = 0;
    for (var len = 1; len <= tree.maxLen; len++) {
      code = (code << 1) | readBit();
      var t = tree.table;
      for (var sym = 0; sym < tree.n; sym++) {
        if (t[sym * 2 + 1] === len && t[sym * 2] === code) return sym;
      }
    }
    throw new Error('Huffman decode error');
  }

  // Process bzip2 blocks until the end-of-stream magic is found
  while (true) {
    var savedBP = bytePos, savedBPt = bitPos;
    if (checkMagic(END_MAGIC)) {
      readBits(32);
      break;
    }
    bytePos = savedBP; bitPos = savedBPt;

    if (!checkMagic(BLOCK_MAGIC)) throw new Error('Invalid block magic');

    readBits(32);
    var randomized = readBit();
    if (randomized) throw new Error('Randomized bzip2 not supported');
    var origPtr = readBits(24);

    // Read which characters are used in this block (bitmap)
    var usedChars = new Uint8Array(256);
    var nUsed = 0;
    var rangeMap = readBits(16);
    for (var i = 0; i < 16; i++) {
      if (rangeMap & (1 << (15 - i))) {
        var charMap = readBits(16);
        for (var j = 0; j < 16; j++) {
          if (charMap & (1 << (15 - j))) {
            usedChars[i * 16 + j] = 1;
            nUsed++;
          }
        }
      }
    }

    var usedSyms = [];
    for (var i = 0; i < 256; i++) {
      if (usedChars[i]) usedSyms.push(i);
    }

    var alphaSize = nUsed + 2;
    var nTrees = readBits(3);
    var nSelectors = readBits(15);

    // Read Huffman tree selectors with MTF (Move-To-Front) decoding
    var selectorList = new Uint8Array(nSelectors);
    var mtfTable = [];
    for (var i = 0; i < nTrees; i++) mtfTable.push(i);

    for (var i = 0; i < nSelectors; i++) {
      var j = 0;
      while (readBit()) j++;
      var tmp = mtfTable[j];
      for (var k = j; k > 0; k--) mtfTable[k] = mtfTable[k - 1];
      mtfTable[0] = tmp;
      selectorList[i] = tmp;
    }

    // Build Huffman trees for this block
    var huffmanTrees = [];
    for (var t = 0; t < nTrees; t++) {
      var currLen = readBits(5);
      var lengths = new Uint8Array(alphaSize);
      for (var i = 0; i < alphaSize; i++) {
        while (readBit()) {
          currLen += readBit() ? -1 : 1;
        }
        lengths[i] = currLen;
      }
      huffmanTrees.push(buildHuffmanTree(lengths, alphaSize));
    }

    var GROUP_SIZE = 50;
    var mtfValues = [];
    var selIdx = 0;
    var symbolsInGroup = 0;

    // Decode Huffman symbols for this block
    while (selIdx < nSelectors) {
      if (symbolsInGroup === 0) {
        symbolsInGroup = GROUP_SIZE;
      }
      symbolsInGroup--;

      var treeIdx = selectorList[selIdx];
      var val = decodeHuffman(huffmanTrees[treeIdx]);
      mtfValues.push(val);

      if (symbolsInGroup === 0) {
        selIdx++;
      }
    }

    // Inverse MTF (Move-To-Front) transformation and RLE run-length decoding
    var RUNA = nUsed;
    var RUNB = nUsed + 1;
    var mtfState = usedSyms.slice();
    var bwtOutput = [];
    var runAccum = 0, runShift = 0;

    for (var i = 0; i < mtfValues.length; i++) {
      var val = mtfValues[i];
      if (val === RUNA) {
        runAccum += (1 << runShift);
        runShift++;
      } else if (val === RUNB) {
        runAccum += (2 << runShift);
        runShift++;
      } else {
        if (runShift > 0) {
          for (var j = 0; j < runAccum; j++) bwtOutput.push(mtfState[0]);
          runAccum = 0;
          runShift = 0;
        }
        bwtOutput.push(mtfState[val]);
        var sym = mtfState[val];
        for (var j = val; j > 0; j--) mtfState[j] = mtfState[j - 1];
        mtfState[0] = sym;
      }
    }
    if (runShift > 0) {
      for (var j = 0; j < runAccum; j++) bwtOutput.push(mtfState[0]);
    }

    var nblock = bwtOutput.length;

    // Inverse Burrows-Wheeler Transform using the original pointer
    var count = new Int32Array(256);
    for (var i = 0; i < nblock; i++) count[bwtOutput[i]]++;

    var cumulative = new Int32Array(256);
    cumulative[0] = 0;
    for (var i = 1; i < 256; i++) cumulative[i] = cumulative[i - 1] + count[i - 1];

    var charRank = new Int32Array(256);
    var lf = new Int32Array(nblock);
    for (var i = 0; i < nblock; i++) {
      lf[i] = cumulative[bwtOutput[i]] + charRank[bwtOutput[i]]++;
    }

    var blockOutput = new Uint8Array(nblock);
    var pos = origPtr;
    for (var i = nblock - 1; i >= 0; i--) {
      blockOutput[i] = bwtOutput[pos];
      pos = lf[pos];
    }

    // RLE (Run-Length Encoding) decompression of the block output
    var oi = 0;
    while (oi < nblock) {
      var c = blockOutput[oi++];
      out.push(c);

      var runLen = 1;
      while (oi < nblock && blockOutput[oi] === c && runLen < 4) {
        out.push(c);
        oi++;
        runLen++;
      }

      if (runLen === 4 && oi < nblock) {
        var cnt = blockOutput[oi++];
        for (var j = 0; j < cnt; j++) out.push(c);
      }
    }
  }

  return new Uint8Array(out);
}

/**
 * Reads a UTF-8 encoded string from the E57 binary XML section.
 * The first byte is the length (unless 0xFF, then the next 2 bytes
 * form a 16-bit length).
 *
 * @param {DataView} dv - DataView over the file buffer.
 * @param {number} pos - Current byte position.
 * @param {boolean} le - Whether to use little-endian (unused, always true).
 * @returns {{value: string, nextPos: number}} The decoded string and
 *   the next read position.
 */
function readUString(dv, pos, le) {
  var len = dv.getUint8(pos); pos++;
  if (len === 0xFF) {
    len = dv.getUint16(pos, true); pos += 2;
  }
  var s = '';
  for (var i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(pos + i));
  pos += len;
  return { value: s, nextPos: pos };
}

/**
 * Recursively parses an E57 XML binary node from the file buffer.
 *
 * E57 nodes can be of types: blob (1), structure (2), vector (3),
 * integer (4), float (5), scaledInteger (6), string (7), and
 * compressedVector (8). Each node type is decoded appropriately.
 *
 * @param {DataView} dv - DataView over the file buffer.
 * @param {number} pos - Current byte position.
 * @param {Uint8Array} fileData - The raw file bytes (for blob data).
 * @returns {{type: string, name: string, nextPos: number, [children]: Array, [value]: number, [data]: Uint8Array, ...}} The parsed node.
 */
function parseNode(dv, pos, fileData) {
  var type = dv.getUint8(pos); pos++;
  var nameResult = readUString(dv, pos);
  var name = nameResult.value;
  pos = nameResult.nextPos;

  switch (type) {
    case 1: { // blob: raw binary data
      var blobLen = Number(dv.getBigUint64(pos, true)); pos += 8;
      var data = fileData.slice(pos, pos + blobLen);
      pos += blobLen;
      return { type: 'blob', name: name, data: data, nextPos: pos };
    }
    case 2: { // structure: ordered children
      var childCount = dv.getUint32(pos, true); pos += 4;
      var children = [];
      for (var i = 0; i < childCount; i++) {
        var child = parseNode(dv, pos, fileData);
        children.push(child);
        pos = child.nextPos;
      }
      return { type: 'structure', name: name, children: children, nextPos: pos };
    }
    case 3: { // vector: homogeneous array of children
      var childCount = dv.getUint32(pos, true); pos += 4;
      var children = [];
      for (var i = 0; i < childCount; i++) {
        var child = parseNode(dv, pos, fileData);
        children.push(child);
        pos = child.nextPos;
      }
      return { type: 'vector', name: name, children: children, nextPos: pos };
    }
    case 4: { // integer: signed 64-bit
      var value = Number(dv.getBigInt64(pos, true)); pos += 8;
      return { type: 'integer', name: name, value: value, nextPos: pos };
    }
    case 5: { // float: IEEE 754 64-bit
      var value = dv.getFloat64(pos, true); pos += 8;
      return { type: 'float', name: name, value: value, nextPos: pos };
    }
    case 6: { // scaledInteger: raw + scale + offset
      var raw = Number(dv.getBigInt64(pos, true)); pos += 8;
      var scale = dv.getFloat64(pos, true); pos += 8;
      var offset = dv.getFloat64(pos, true); pos += 8;
      return { type: 'scaledInteger', name: name, raw: raw, scale: scale, offset: offset, nextPos: pos };
    }
    case 7: { // string: UTF-8 encoded
      var valResult = readUString(dv, pos);
      return { type: 'string', name: name, value: valResult.value, nextPos: valResult.nextPos };
    }
    case 8: { // compressedVector: bzip2-compressed point data
      var binaryOffset = Number(dv.getBigUint64(pos, true)); pos += 8;
      var binaryLength = Number(dv.getBigUint64(pos, true)); pos += 8;
      var prototype = parseNode(dv, pos, fileData);
      pos = prototype.nextPos;
      return { type: 'compressedVector', name: name, binaryOffset: binaryOffset, binaryLength: binaryLength, prototype: prototype, nextPos: pos };
    }
    default:
      throw new Error('Unknown E57 node type: ' + type + ' at pos ' + (pos - 1));
  }
}

/**
 * Finds a child node by name within a structure or vector node.
 *
 * @param {object} node - The parent node (must have a children array).
 * @param {string} name - The name to search for.
 * @returns {object|null} The matching child node, or null if not found.
 */
function findChild(node, name) {
  if (!node || !node.children) return null;
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].name === name) return node.children[i];
  }
  return null;
}

/**
 * Extracts field metadata from a prototype structure node.
 *
 * Each field includes its name, type, precision (for floats), scale/offset
 * (for scaledIntegers), and min/max bounds where available.
 *
 * @param {object} prototype - The prototype node (type 'structure').
 * @returns {Array<{name: string, type: string, precision?: string, scale?: number, offset?: number, minimum?: object, maximum?: object}>} Array of field descriptors.
 */
function getFieldInfo(prototype) {
  if (!prototype || prototype.type !== 'structure') return [];
  var fields = [];
  for (var i = 0; i < prototype.children.length; i++) {
    var child = prototype.children[i];
    var info = { name: child.name, type: child.type };
    if (child.type === 'float') {
      var prec = findChild(child, 'precision');
      info.precision = prec ? prec.value : 'double';
      info.minimum = findChild(child, 'minimum');
      info.maximum = findChild(child, 'maximum');
    } else if (child.type === 'integer') {
      info.minimum = findChild(child, 'minimum');
      info.maximum = findChild(child, 'maximum');
    } else if (child.type === 'scaledInteger') {
      info.scale = child.scale;
      info.offset = child.offset;
      info.minimum = findChild(child, 'minimum');
      info.maximum = findChild(child, 'maximum');
    }
    fields.push(info);
  }
  return fields;
}

/**
 * Computes the number of bits needed to represent a field's value range.
 *
 * For float fields, returns 32 or 64 based on precision. For integer and
 * scaledInteger fields, uses the min/max range to determine bit width.
 *
 * @param {object} field - A field info object from getFieldInfo.
 * @returns {number} Number of bits required.
 */
function computeBits(field) {
  if (field.type === 'float') {
    return field.precision === 'float' ? 32 : 64;
  }
  var minNode = field.minimum;
  var maxNode = field.maximum;
  if (!minNode || !maxNode) return field.type === 'float' ? 64 : 32;
  var min = minNode.value;
  var max = maxNode.value;
  if (field.type === 'scaledInteger') {
    var rawMin = Math.ceil((min - field.offset) / field.scale);
    var rawMax = Math.floor((max - field.offset) / field.scale);
    var range = rawMax - rawMin;
    if (range <= 0) return 0;
    return Math.ceil(Math.log2(range + 1));
  }
  var range = max - min;
  if (range <= 0) return 0;
  return Math.ceil(Math.log2(range + 1));
}

/**
 * Reads and decompresses the point data from a compressedVector node.
 *
 * Processes packet headers, decompresses bzip2 payloads when present, and
 * decodes bit-packed fields into an array of record objects. Each record
 * is a plain object with field names as keys and numeric values.
 *
 * @param {Uint8Array} fileData - The raw file bytes.
 * @param {object} cvNode - The compressedVector node from the XML tree.
 * @returns {Array<object>} Array of point records.
 */
function readCompressedVector(fileData, cvNode) {
  var offset = cvNode.binaryOffset;
  var length = cvNode.binaryLength;
  if (length === 0) return [];

  var fields = getFieldInfo(cvNode.prototype);
  var bitsPerField = [];
  var fieldMin = [];
  for (var i = 0; i < fields.length; i++) {
    bitsPerField.push(computeBits(fields[i]));
    if (fields[i].type === 'integer') {
      fieldMin.push(fields[i].minimum ? fields[i].minimum.value : 0);
    } else if (fields[i].type === 'scaledInteger') {
      var rawMin = Math.ceil((fields[i].minimum.value - fields[i].offset) / fields[i].scale);
      fieldMin.push(rawMin);
    } else {
      fieldMin.push(0);
    }
  }

  var totalBitsPerRecord = 0;
  for (var i = 0; i < bitsPerField.length; i++) totalBitsPerRecord += bitsPerField[i];

  var records = [];
  var pos = offset;
  var end = offset + length;

  while (pos + 4 <= end) {
    var headerByte0 = fileData[pos];
    var headerByte1 = fileData[pos + 1];
    var headerByte2 = fileData[pos + 2];
    var headerByte3 = fileData[pos + 3];

    var packetType = (headerByte0 >> 4) & 0x0F;
    var packetVersion = headerByte0 & 0x0F;
    var packetLength = (headerByte1 << 16) | (headerByte2 << 8) | headerByte3;
    var packetBytes = packetLength * 4;

    if (packetBytes === 0 || pos + packetBytes > end) break;

    if (packetType === 0) {
      var recordCount = (fileData[pos + 4] << 24) | (fileData[pos + 5] << 16) | (fileData[pos + 6] << 8) | fileData[pos + 7];
      var dataStart = pos + 8;
      var dataEnd = pos + packetBytes;
      var payload = fileData.slice(dataStart, dataEnd);

      // Check for bzip2 magic bytes
      if (payload.length >= 3 && payload[0] === 0x42 && payload[1] === 0x5A && payload[2] === 0x68) {
        try {
          var decompressed = bzip2Decompress(payload);
          var bitPos = 0;
          /**
           * Reads n bits from a decompressed Uint8Array buffer.
           * @param {Uint8Array} buf - The byte buffer.
           * @param {number} n - Number of bits to read.
           * @returns {number} The combined bit value.
           */
          function readBitsFromBuf(buf, n) {
            var v = 0;
            for (var b = 0; b < n; b++) {
              var byteIdx = bitPos >> 3;
              var bitIdx = 7 - (bitPos & 7);
              if (byteIdx < buf.length) {
                v = (v << 1) | ((buf[byteIdx] >> bitIdx) & 1);
              }
              bitPos++;
            }
            return v;
          }

          for (var r = 0; r < recordCount; r++) {
            var record = {};
            for (var f = 0; f < fields.length; f++) {
              var bits = bitsPerField[f];
              if (bits === 0) {
                if (fields[f].type === 'integer') {
                  record[fields[f].name] = fieldMin[f];
                } else if (fields[f].type === 'scaledInteger') {
                  record[fields[f].name] = fieldMin[f] * fields[f].scale + fields[f].offset;
                } else {
                  record[fields[f].name] = 0;
                }
                continue;
              }
              if (fields[f].type === 'float') {
                if (bits === 32) {
                  var raw32 = readBitsFromBuf(decompressed, 32);
                  var tmpBuf32 = new ArrayBuffer(4);
                  var tmpView32 = new DataView(tmpBuf32);
                  tmpView32.setUint32(0, raw32, false);
                  record[fields[f].name] = tmpView32.getFloat32(0, false);
                } else {
                  var hi32 = readBitsFromBuf(decompressed, 32);
                  var lo32 = readBitsFromBuf(decompressed, 32);
                  var tmpBuf64 = new ArrayBuffer(8);
                  var tmpView64 = new DataView(tmpBuf64);
                  tmpView64.setUint32(0, hi32, false);
                  tmpView64.setUint32(4, lo32, false);
                  record[fields[f].name] = tmpView64.getFloat64(0, false);
                }
              } else {
                var raw = readBitsFromBuf(decompressed, bits);
                if (fields[f].type === 'integer') {
                  record[fields[f].name] = raw + fieldMin[f];
                } else if (fields[f].type === 'scaledInteger') {
                  record[fields[f].name] = (raw + fieldMin[f]) * fields[f].scale + fields[f].offset;
                }
              }
            }
            records.push(record);
          }
        } catch (e) {
          // skip packet on decompression error
        }
      } else {
        // Non-bzip2 payload: read directly from raw bytes
        var bitPos = 0;
        /**
         * Reads n bits from a raw (non-compressed) Uint8Array buffer.
         * @param {Uint8Array} buf - The byte buffer.
         * @param {number} n - Number of bits to read.
         * @returns {number} The combined bit value.
         */
        function readBitsFromRaw(buf, n) {
          var v = 0;
          for (var b = 0; b < n; b++) {
            var byteIdx = bitPos >> 3;
            var bitIdx = 7 - (bitPos & 7);
            if (byteIdx < buf.length) {
              v = (v << 1) | ((buf[byteIdx] >> bitIdx) & 1);
            }
            bitPos++;
          }
          return v;
        }

        for (var r = 0; r < recordCount; r++) {
          var record = {};
          for (var f = 0; f < fields.length; f++) {
            var bits = bitsPerField[f];
            if (bits === 0) {
              if (fields[f].type === 'integer') {
                record[fields[f].name] = fieldMin[f];
              } else if (fields[f].type === 'scaledInteger') {
                record[fields[f].name] = fieldMin[f] * fields[f].scale + fields[f].offset;
              } else {
                record[fields[f].name] = 0;
              }
              continue;
            }
            if (fields[f].type === 'float') {
              if (bits === 32) {
                var raw32 = readBitsFromRaw(payload, 32);
                var tmpBuf32 = new ArrayBuffer(4);
                var tmpView32 = new DataView(tmpBuf32);
                tmpView32.setUint32(0, raw32, false);
                record[fields[f].name] = tmpView32.getFloat32(0, false);
              } else {
                var hi32 = readBitsFromRaw(payload, 32);
                var lo32 = readBitsFromRaw(payload, 32);
                var tmpBuf64 = new ArrayBuffer(8);
                var tmpView64 = new DataView(tmpBuf64);
                tmpView64.setUint32(0, hi32, false);
                tmpView64.setUint32(4, lo32, false);
                record[fields[f].name] = tmpView64.getFloat64(0, false);
              }
            } else {
              var raw = readBitsFromRaw(payload, bits);
              if (fields[f].type === 'integer') {
                record[fields[f].name] = raw + fieldMin[f];
              } else if (fields[f].type === 'scaledInteger') {
                record[fields[f].name] = (raw + fieldMin[f]) * fields[f].scale + fields[f].offset;
              }
            }
          }
          records.push(record);
        }
      }
    }

    pos += packetBytes;
  }

  return records;
}

/**
 * Web Worker message handler for E57 parsing.
 *
 * Supports multiple message types for chunked loading:
 *   - 'parseHeader': validates the E57 signature and returns XML offset/length.
 *   - 'parseXml': parses the XML binary section to find point data metadata.
 *   - 'processChunk': decompresses and parses a chunk of binary point data.
 *   - 'finalize': converts accumulated records into typed point arrays.
 * Falls back to a single-pass (legacy) mode if the message is a raw ArrayBuffer.
 *
 * @listens MessageEvent
 */
self.onmessage = function(e) {
  try {
    var msg = e.data;
    
    if (msg.type === 'parseHeader') {
      var headerBuf = msg.headerData;
      var dv = new DataView(headerBuf);
      var arr = new Uint8Array(headerBuf);

      var sig = '';
      for (var i = 0; i < 8; i++) sig += String.fromCharCode(arr[i]);
      if (sig.indexOf('ASTM-E57') !== 0) throw new Error('Not an E57 file');

      var xmlOffset = Number(dv.getBigUint64(18, true));
      var xmlLength = Number(dv.getBigUint64(26, true));

      self.postMessage({
        type: 'headerParsed',
        xmlOffset: xmlOffset,
        xmlLength: xmlLength
      });
    }
    else if (msg.type === 'parseXml') {
      var xmlBuf = msg.xmlData;
      var dv = new DataView(xmlBuf);
      var arr = new Uint8Array(xmlBuf);

      var root = parseNode(dv, 0, arr);

      var data3D = findChild(root, 'data3D');
      if (!data3D || data3D.type !== 'vector' || data3D.children.length === 0) {
        throw new Error('No 3D data found in E57 file');
      }

      var scan = data3D.children[0];
      var pointsNode = findChild(scan, 'points');
      if (!pointsNode || pointsNode.type !== 'compressedVector') {
        throw new Error('No points data found in E57 file');
      }

      var fields = getFieldInfo(pointsNode.prototype);
      var bitsPerField = [];
      var fieldMin = [];
      for (var i = 0; i < fields.length; i++) {
        bitsPerField.push(computeBits(fields[i]));
        if (fields[i].type === 'integer') {
          fieldMin.push(fields[i].minimum ? fields[i].minimum.value : 0);
        } else if (fields[i].type === 'scaledInteger') {
          var rawMin = Math.ceil((fields[i].minimum.value - fields[i].offset) / fields[i].scale);
          fieldMin.push(rawMin);
        } else {
          fieldMin.push(0);
        }
      }

      self.postMessage({
        type: 'xmlParsed',
        binaryOffset: pointsNode.binaryOffset,
        binaryLength: pointsNode.binaryLength,
        fields: fields,
        bitsPerField: bitsPerField,
        fieldMin: fieldMin
      });
    }
    else if (msg.type === 'processChunk') {
      var chunkData = msg.chunkData;
      var fields = msg.fields;
      var bitsPerField = msg.bitsPerField;
      var fieldMin = msg.fieldMin;
      var chunkOffset = msg.chunkOffset;

      var arr = new Uint8Array(chunkData);
      var pos = 0;
      var records = [];

      // Process E57 data packets within this chunk
      while (pos + 4 <= arr.length) {
        var headerByte0 = arr[pos];
        var headerByte1 = arr[pos + 1];
        var headerByte2 = arr[pos + 2];
        var headerByte3 = arr[pos + 3];

        var packetType = (headerByte0 >> 4) & 0x0F;
        var packetLength = (headerByte1 << 16) | (headerByte2 << 8) | headerByte3;
        var packetBytes = packetLength * 4;

        if (packetBytes === 0 || pos + packetBytes > arr.length) break;

        if (packetType === 0) {
          var recordCount = (arr[pos + 4] << 24) | (arr[pos + 5] << 16) | (arr[pos + 6] << 8) | arr[pos + 7];
          var dataStart = pos + 8;
          var dataEnd = pos + packetBytes;
          var payload = arr.slice(dataStart, dataEnd);

          // Check for bzip2 compression
          if (payload.length >= 3 && payload[0] === 0x42 && payload[1] === 0x5A && payload[2] === 0x68) {
            try {
              var decompressed = bzip2Decompress(payload);
              var bitPos = 0;
              function readBitsFromBuf(buf, n) {
                var v = 0;
                for (var b = 0; b < n; b++) {
                  var byteIdx = bitPos >> 3;
                  var bitIdx = 7 - (bitPos & 7);
                  if (byteIdx < buf.length) {
                    v = (v << 1) | ((buf[byteIdx] >> bitIdx) & 1);
                  }
                  bitPos++;
                }
                return v;
              }

              for (var r = 0; r < recordCount; r++) {
                var record = {};
                for (var f = 0; f < fields.length; f++) {
                  var bits = bitsPerField[f];
                  if (bits === 0) {
                    if (fields[f].type === 'integer') {
                      record[fields[f].name] = fieldMin[f];
                    } else if (fields[f].type === 'scaledInteger') {
                      record[fields[f].name] = fieldMin[f] * fields[f].scale + fields[f].offset;
                    } else {
                      record[fields[f].name] = 0;
                    }
                    continue;
                  }
                  if (fields[f].type === 'float') {
                    if (bits === 32) {
                      var raw32 = readBitsFromBuf(decompressed, 32);
                      var tmpBuf32 = new ArrayBuffer(4);
                      var tmpView32 = new DataView(tmpBuf32);
                      tmpView32.setUint32(0, raw32, false);
                      record[fields[f].name] = tmpView32.getFloat32(0, false);
                    } else {
                      var hi32 = readBitsFromBuf(decompressed, 32);
                      var lo32 = readBitsFromBuf(decompressed, 32);
                      var tmpBuf64 = new ArrayBuffer(8);
                      var tmpView64 = new DataView(tmpBuf64);
                      tmpView64.setUint32(0, hi32, false);
                      tmpView64.setUint32(4, lo32, false);
                      record[fields[f].name] = tmpView64.getFloat64(0, false);
                    }
                  } else {
                    var raw = readBitsFromBuf(decompressed, bits);
                    if (fields[f].type === 'integer') {
                      record[fields[f].name] = raw + fieldMin[f];
                    } else if (fields[f].type === 'scaledInteger') {
                      record[fields[f].name] = (raw + fieldMin[f]) * fields[f].scale + fields[f].offset;
                    }
                  }
                }
                records.push(record);
              }
            } catch (e) {
              // skip packet on decompression error
            }
          } else {
            // Raw (non-bzip2) payload processing
            var bitPos = 0;
            function readBitsFromRaw(buf, n) {
              var v = 0;
              for (var b = 0; b < n; b++) {
                var byteIdx = bitPos >> 3;
                var bitIdx = 7 - (bitPos & 7);
                if (byteIdx < buf.length) {
                  v = (v << 1) | ((buf[byteIdx] >> bitIdx) & 1);
                }
                bitPos++;
              }
              return v;
            }

            for (var r = 0; r < recordCount; r++) {
              var record = {};
              for (var f = 0; f < fields.length; f++) {
                var bits = bitsPerField[f];
                if (bits === 0) {
                  if (fields[f].type === 'integer') {
                    record[fields[f].name] = fieldMin[f];
                  } else if (fields[f].type === 'scaledInteger') {
                    record[fields[f].name] = fieldMin[f] * fields[f].scale + fields[f].offset;
                  } else {
                    record[fields[f].name] = 0;
                  }
                  continue;
                }
                if (fields[f].type === 'float') {
                  if (bits === 32) {
                    var raw32 = readBitsFromRaw(payload, 32);
                    var tmpBuf32 = new ArrayBuffer(4);
                    var tmpView32 = new DataView(tmpBuf32);
                    tmpView32.setUint32(0, raw32, false);
                    record[fields[f].name] = tmpView32.getFloat32(0, false);
                  } else {
                    var hi32 = readBitsFromRaw(payload, 32);
                    var lo32 = readBitsFromRaw(payload, 32);
                    var tmpBuf64 = new ArrayBuffer(8);
                    var tmpView64 = new DataView(tmpBuf64);
                    tmpView64.setUint32(0, hi32, false);
                    tmpView64.setUint32(4, lo32, false);
                    record[fields[f].name] = tmpView64.getFloat64(0, false);
                  }
                } else {
                  var raw = readBitsFromRaw(payload, bits);
                  if (fields[f].type === 'integer') {
                    record[fields[f].name] = raw + fieldMin[f];
                  } else if (fields[f].type === 'scaledInteger') {
                    record[fields[f].name] = (raw + fieldMin[f]) * fields[f].scale + fields[f].offset;
                  }
                }
              }
              records.push(record);
            }
          }
        }

        pos += packetBytes;
      }

      self.postMessage({
        type: 'chunkProcessed',
        records: records,
        chunkOffset: chunkOffset
      });
    }
    else if (msg.type === 'finalize') {
      // Convert all accumulated records into typed arrays
      var allRecords = msg.allRecords;
      var count = allRecords.length;

      var positions = new Float32Array(count * 3);
      var colors = new Uint8Array(count * 3);
      var intensity = new Float32Array(count);
      var hasColor = false;
      var hasIntensity = false;

      var minX = Infinity, minY = Infinity, minZ = Infinity;
      var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      var minI = Infinity, maxI = -Infinity;

      for (var i = 0; i < count; i++) {
        var rec = allRecords[i];
        var x = rec.cartesianX || 0;
        var y = rec.cartesianY || 0;
        var z = rec.cartesianZ || 0;

        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

        if (rec.colorRed !== undefined && rec.colorGreen !== undefined && rec.colorBlue !== undefined) {
          hasColor = true;
          var r = rec.colorRed, g = rec.colorGreen, b = rec.colorBlue;
          if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
          colors[i * 3] = Math.min(255, Math.max(0, r));
          colors[i * 3 + 1] = Math.min(255, Math.max(0, g));
          colors[i * 3 + 2] = Math.min(255, Math.max(0, b));
        } else {
          colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 200;
        }

        if (rec.intensity !== undefined) {
          hasIntensity = true;
          intensity[i] = rec.intensity;
          if (rec.intensity < minI) minI = rec.intensity;
          if (rec.intensity > maxI) maxI = rec.intensity;
        }
      }

      if (!hasColor) {
        for (var i = 0; i < count; i++) {
          colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 200;
        }
      }

      var bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
      var center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];

      self.postMessage({
        ok: true,
        positions: positions,
        colors: colors,
        intensity: hasIntensity ? intensity : null,
        count: count,
        hasColor: hasColor,
        hasIntensity: hasIntensity,
        bounds: bounds,
        center: center,
        zMin: minZ,
        zMax: maxZ,
        intensityMin: hasIntensity ? minI : 0,
        intensityMax: hasIntensity ? maxI : 1
      }, [positions.buffer, colors.buffer].concat(hasIntensity ? [intensity.buffer] : []));
    }
    else {
      // Legacy mode: single-pass processing with raw ArrayBuffer
      var buffer = msg;
      var dv = new DataView(buffer);
      var arr = new Uint8Array(buffer);

      var sig = '';
      for (var i = 0; i < 8; i++) sig += String.fromCharCode(arr[i]);
      if (sig.indexOf('ASTM-E57') !== 0) throw new Error('Not an E57 file');

      var xmlOffset = Number(dv.getBigUint64(18, true));
      var xmlLength = Number(dv.getBigUint64(26, true));

      var root = parseNode(dv, xmlOffset, arr);

      var data3D = findChild(root, 'data3D');
      if (!data3D || data3D.type !== 'vector' || data3D.children.length === 0) {
        throw new Error('No 3D data found in E57 file');
      }

      var scan = data3D.children[0];
      var pointsNode = findChild(scan, 'points');
      if (!pointsNode || pointsNode.type !== 'compressedVector') {
        throw new Error('No points data found in E57 file');
      }

      var records = readCompressedVector(arr, pointsNode);

      var count = records.length;
      if (count === 0) throw new Error('No points found in E57 file');

      var positions = new Float32Array(count * 3);
      var colors = new Uint8Array(count * 3);
      var intensity = new Float32Array(count);
      var hasColor = false;
      var hasIntensity = false;

      var minX = Infinity, minY = Infinity, minZ = Infinity;
      var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      var minI = Infinity, maxI = -Infinity;

      for (var i = 0; i < count; i++) {
        var rec = records[i];
        var x = rec.cartesianX || 0;
        var y = rec.cartesianY || 0;
        var z = rec.cartesianZ || 0;

        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

        if (rec.colorRed !== undefined && rec.colorGreen !== undefined && rec.colorBlue !== undefined) {
          hasColor = true;
          var r = rec.colorRed, g = rec.colorGreen, b = rec.colorBlue;
          if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
          colors[i * 3] = Math.min(255, Math.max(0, r));
          colors[i * 3 + 1] = Math.min(255, Math.max(0, g));
          colors[i * 3 + 2] = Math.min(255, Math.max(0, b));
        } else {
          colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 200;
        }

        if (rec.intensity !== undefined) {
          hasIntensity = true;
          intensity[i] = rec.intensity;
          if (rec.intensity < minI) minI = rec.intensity;
          if (rec.intensity > maxI) maxI = rec.intensity;
        }
      }

      if (!hasColor) {
        for (var i = 0; i < count; i++) {
          colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 200;
        }
      }

      var bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
      var center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];

      self.postMessage({
        ok: true,
        positions: positions,
        colors: colors,
        intensity: hasIntensity ? intensity : null,
        count: count,
        hasColor: hasColor,
        hasIntensity: hasIntensity,
        bounds: bounds,
        center: center,
        zMin: minZ,
        zMax: maxZ,
        intensityMin: hasIntensity ? minI : 0,
        intensityMax: hasIntensity ? maxI : 1
      }, [positions.buffer, colors.buffer].concat(hasIntensity ? [intensity.buffer] : []));
    }
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
`;

/** Loads ASTM E57 point clouds with built-in bzip2 decompression. */
export class E57Loader {
  /**
   * Creates a Blob URL for the inline E57 worker source.
   */
  constructor() {
    const blob = new Blob([E57_WORKER_SOURCE], { type: 'application/javascript' });
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
   * Checks whether a file has an .e57 extension.
   *
   * @param {File} file - The file to check.
   * @returns {boolean} True if the file is an E57 file.
   */
  static isE57File(file) {
    return file.name.toLowerCase().endsWith('.e57');
  }

  /**
   * Reads an E57 file into an ArrayBuffer.
   *
   * @param {File} file - The DOM File object.
   * @returns {Promise<ArrayBuffer>} The raw file buffer.
   */
  static async readFile(file) {
    return await file.arrayBuffer();
  }

  /**
   * Parses an E57 buffer in a Web Worker (legacy single-pass mode) and
   * returns structured point cloud data.
   *
   * @param {ArrayBuffer} buf - The raw E57 file buffer.
   * @returns {Promise<{ok: boolean, positions: Float32Array, colors: Uint8Array, intensity: Float32Array|null, count: number, hasColor: boolean, hasIntensity: boolean, bounds: object, center: number[], zMin: number, zMax: number, intensityMin: number, intensityMax: number}>} Parsed point data.
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

  /**
   * Loads a large E57 file using chunked reading (64MB chunks). The
   * header is read first to extract the XML section, then binary point
   * data is processed in chunks to avoid memory pressure. Dynamically
   * reallocates typed arrays as more points are discovered.
   *
   * @param {File} file - The DOM File object to load.
   * @param {Function} [onProgress] - Callback receiving 0..1 progress.
   * @returns {Promise<object>} Parsed point cloud data with positions,
   *   colors, intensity, bounds, center, and metadata.
   */
  async loadLargeFile(file, onProgress) {
    const CHUNK_SIZE = 64 * 1024 * 1024;
    const worker = new Worker(this._workerUrl);
    
    return new Promise(async (resolve, reject) => {
      let fields, bitsPerField, fieldMin, binaryOffset, binaryLength;
      let positions, colors, intensity;
      let hasColor = false, hasIntensity = false;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let minI = Infinity, maxI = -Infinity;
      let actualPoints = 0;
      let estimatedPoints = 0;
      
      worker.onmessage = async (e) => {
        try {
          if (e.data.type === 'headerParsed') {
            const xmlOffset = e.data.xmlOffset;
            const xmlLength = e.data.xmlLength;
            
            const xmlSlice = file.slice(xmlOffset, xmlOffset + xmlLength);
            const xmlBuf = await xmlSlice.arrayBuffer();
            
            worker.postMessage({
              type: 'parseXml',
              xmlData: xmlBuf
            });
          }
          else if (e.data.type === 'xmlParsed') {
            binaryOffset = e.data.binaryOffset;
            binaryLength = e.data.binaryLength;
            fields = e.data.fields;
            bitsPerField = e.data.bitsPerField;
            fieldMin = e.data.fieldMin;
            
            // Stima il numero di punti basato sulla dimensione dei dati
            // Assumendo ~30 bytes per punto (valore tipico per E57)
            estimatedPoints = Math.ceil(binaryLength / 30);
            console.log('[E57] Estimated points:', estimatedPoints);
            
            // Pre-alloca array con stima (potrà essere ridimensionato se necessario)
            positions = new Float32Array(estimatedPoints * 3);
            colors = new Uint8Array(estimatedPoints * 3);
            intensity = new Float32Array(estimatedPoints);
            
            // Inizia a processare i chunk
            await processNextChunk(binaryOffset);
          }
          else if (e.data.type === 'chunkProcessed') {
            const records = e.data.records;
            const chunkOffset = e.data.chunkOffset;
            
            // Processa i record e accumula nei TypedArray
            for (let i = 0; i < records.length; i++) {
              const rec = records[i];
              const x = rec.cartesianX || 0;
              const y = rec.cartesianY || 0;
              const z = rec.cartesianZ || 0;

              if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

              // Verifica se dobbiamo ridimensionare gli array
              if (actualPoints >= positions.length / 3) {
                const newSize = Math.ceil(positions.length * 1.5);
                console.log('[E57] Resizing arrays from', positions.length / 3, 'to', newSize / 3);
                const newPositions = new Float32Array(newSize * 3);
                const newColors = new Uint8Array(newSize * 3);
                const newIntensity = new Float32Array(newSize);
                newPositions.set(positions);
                newColors.set(colors);
                newIntensity.set(intensity);
                positions = newPositions;
                colors = newColors;
                intensity = newIntensity;
              }

              positions[actualPoints * 3] = x;
              positions[actualPoints * 3 + 1] = y;
              positions[actualPoints * 3 + 2] = z;

              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

              if (rec.colorRed !== undefined && rec.colorGreen !== undefined && rec.colorBlue !== undefined) {
                hasColor = true;
                let r = rec.colorRed, g = rec.colorGreen, b = rec.colorBlue;
                if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
                colors[actualPoints * 3] = Math.min(255, Math.max(0, r));
                colors[actualPoints * 3 + 1] = Math.min(255, Math.max(0, g));
                colors[actualPoints * 3 + 2] = Math.min(255, Math.max(0, b));
              } else {
                colors[actualPoints * 3] = 180;
                colors[actualPoints * 3 + 1] = 180;
                colors[actualPoints * 3 + 2] = 200;
              }

              if (rec.intensity !== undefined) {
                hasIntensity = true;
                intensity[actualPoints] = rec.intensity;
                if (rec.intensity < minI) minI = rec.intensity;
                if (rec.intensity > maxI) maxI = rec.intensity;
              }

              actualPoints++;
            }
            
            // Processa il prossimo chunk
            const nextOffset = chunkOffset + CHUNK_SIZE;
            if (nextOffset < binaryOffset + binaryLength) {
              await processNextChunk(nextOffset);
            } else {
              // Tutti i chunk processati, finalizza
              finalize();
            }
          }
          else if (e.data.ok) {
            worker.terminate();
            resolve(e.data);
          }
          else if (e.data.error) {
            worker.terminate();
            reject(new Error(e.data.error));
          }
        } catch (err) {
          worker.terminate();
          reject(err);
        }
      };
      
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      
      /**
       * Slices and sends the next chunk of binary point data to the worker.
       * @param {number} offset - Byte offset into the file's binary section.
       * @returns {Promise<void>} Resolves when the chunk is posted.
       */
      async function processNextChunk(offset) {
        const end = Math.min(offset + CHUNK_SIZE, binaryOffset + binaryLength);
        const chunkSlice = file.slice(offset, end);
        const chunkBuf = await chunkSlice.arrayBuffer();
        
        worker.postMessage({
          type: 'processChunk',
          chunkData: chunkBuf,
          fields: fields,
          bitsPerField: bitsPerField,
          fieldMin: fieldMin,
          chunkOffset: offset
        }, [chunkBuf]);
        
        if (onProgress) {
          const progress = (offset - binaryOffset) / binaryLength;
          onProgress(progress);
        }
      }
      
      /**
       * Finalizes parsing: fills missing colors, computes bounds and
       * center, and resolves the promise with the final point data.
       */
      function finalize() {
        if (!hasColor) {
          for (let i = 0; i < actualPoints; i++) {
            colors[i * 3] = 180;
            colors[i * 3 + 1] = 180;
            colors[i * 3 + 2] = 200;
          }
        }

        const bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
        const center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];

        worker.terminate();
        
        resolve({
          ok: true,
          positions: positions.subarray(0, actualPoints * 3),
          colors: colors.subarray(0, actualPoints * 3),
          intensity: hasIntensity ? intensity.subarray(0, actualPoints) : null,
          count: actualPoints,
          hasColor: hasColor,
          hasIntensity: hasIntensity,
          bounds: bounds,
          center: center,
          zMin: minZ,
          zMax: maxZ,
          intensityMin: hasIntensity ? minI : 0,
          intensityMax: hasIntensity ? maxI : 1
        });
      }
      
      const headerSlice = file.slice(0, Math.min(file.size, 64));
      const headerBuf = await headerSlice.arrayBuffer();
      
      worker.postMessage({
        type: 'parseHeader',
        headerData: headerBuf
      });
    });
  }
}
