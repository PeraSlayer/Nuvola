const E57_WORKER_SOURCE = `
'use strict';

function bzip2Decompress(input) {
  var out = [];
  var bytePos = 0, bitPos = 0;

  function readBit() {
    var bit = (input[bytePos] >> (7 - bitPos)) & 1;
    if (++bitPos === 8) { bytePos++; bitPos = 0; }
    return bit;
  }

  function readBits(n) {
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  }

  function alignByte() {
    if (bitPos) { bytePos++; bitPos = 0; }
  }

  if (input[0] !== 0x42 || input[1] !== 0x5A || input[2] !== 0x68) {
    throw new Error('Invalid bzip2 header');
  }
  var blockSize = input[3] - 0x30;
  if (blockSize < 1 || blockSize > 9) throw new Error('Invalid bzip2 block size');
  bytePos = 4; bitPos = 0;

  var BLOCK_MAGIC = [0x31,0x41,0x59,0x26,0x53,0x59];
  var END_MAGIC   = [0x17,0x72,0x45,0x38,0x50,0x90];

  function checkMagic(magic) {
    for (var i = 0; i < 6; i++) {
      if (readBits(8) !== magic[i]) return false;
    }
    return true;
  }

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

function parseNode(dv, pos, fileData) {
  var type = dv.getUint8(pos); pos++;
  var nameResult = readUString(dv, pos);
  var name = nameResult.value;
  pos = nameResult.nextPos;

  switch (type) {
    case 1: {
      var blobLen = Number(dv.getBigUint64(pos, true)); pos += 8;
      var data = fileData.slice(pos, pos + blobLen);
      pos += blobLen;
      return { type: 'blob', name: name, data: data, nextPos: pos };
    }
    case 2: {
      var childCount = dv.getUint32(pos, true); pos += 4;
      var children = [];
      for (var i = 0; i < childCount; i++) {
        var child = parseNode(dv, pos, fileData);
        children.push(child);
        pos = child.nextPos;
      }
      return { type: 'structure', name: name, children: children, nextPos: pos };
    }
    case 3: {
      var childCount = dv.getUint32(pos, true); pos += 4;
      var children = [];
      for (var i = 0; i < childCount; i++) {
        var child = parseNode(dv, pos, fileData);
        children.push(child);
        pos = child.nextPos;
      }
      return { type: 'vector', name: name, children: children, nextPos: pos };
    }
    case 4: {
      var value = Number(dv.getBigInt64(pos, true)); pos += 8;
      return { type: 'integer', name: name, value: value, nextPos: pos };
    }
    case 5: {
      var value = dv.getFloat64(pos, true); pos += 8;
      return { type: 'float', name: name, value: value, nextPos: pos };
    }
    case 6: {
      var raw = Number(dv.getBigInt64(pos, true)); pos += 8;
      var scale = dv.getFloat64(pos, true); pos += 8;
      var offset = dv.getFloat64(pos, true); pos += 8;
      return { type: 'scaledInteger', name: name, raw: raw, scale: scale, offset: offset, nextPos: pos };
    }
    case 7: {
      var valResult = readUString(dv, pos);
      return { type: 'string', name: name, value: valResult.value, nextPos: valResult.nextPos };
    }
    case 8: {
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

function findChild(node, name) {
  if (!node || !node.children) return null;
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].name === name) return node.children[i];
  }
  return null;
}

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

  return records;
}

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

export class E57Loader {
  constructor() {
    const blob = new Blob([E57_WORKER_SOURCE], { type: 'application/javascript' });
    this._workerUrl = URL.createObjectURL(blob);
  }

  dispose() {
    if (this._workerUrl) {
      URL.revokeObjectURL(this._workerUrl);
      this._workerUrl = null;
    }
  }

  static isE57File(file) {
    return file.name.toLowerCase().endsWith('.e57');
  }

  static async readFile(file) {
    return await file.arrayBuffer();
  }

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
