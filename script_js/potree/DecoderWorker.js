const DECODER_WORKER_SOURCE = `
function decodeAttributes(buffer, attributes, scale, offset) {
  const view = new DataView(buffer);
  const numPoints = Math.floor(buffer.byteLength / attributes.reduce((s, a) => s + a.size, 0));
  if (numPoints === 0) return null;

  const result = {};
  let byteOffset = 0;

  for (const attr of attributes) {
    switch (attr.name) {
      case 'POSITION_CARTESIAN': {
        const arr = new Float32Array(numPoints * 3);
        if (attr.type === 'int32') {
          for (let i = 0; i < numPoints * 3; i++) {
            arr[i] = view.getInt32(byteOffset + i * 4, true) * scale + offset;
          }
        } else {
          for (let i = 0; i < numPoints * 3; i++) {
            arr[i] = view.getFloat32(byteOffset + i * 4, true);
          }
        }
        result.position = arr;
        break;
      }
      case 'RGBA': {
        const len = numPoints * 4;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          arr[i] = view.getUint8(byteOffset + i);
        }
        result.color = new Uint8Array(numPoints * 3);
        for (let i = 0; i < numPoints; i++) {
          result.color[i * 3] = arr[i * 4];
          result.color[i * 3 + 1] = arr[i * 4 + 1];
          result.color[i * 3 + 2] = arr[i * 4 + 2];
        }
        break;
      }
      case 'RGB': {
        const arr = new Uint8Array(numPoints * 3);
        for (let i = 0; i < numPoints * 3; i++) {
          arr[i] = view.getUint8(byteOffset + i);
        }
        result.color = arr;
        break;
      }
      case 'INTENSITY': {
        const arr = new Float32Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          arr[i] = view.getUint16(byteOffset + i * 2, true) / 65535;
        }
        result.intensity = arr;
        break;
      }
      case 'CLASSIFICATION': {
        const arr = new Uint8Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          arr[i] = view.getUint8(byteOffset + i);
        }
        result.classification = arr;
        break;
      }
      case 'RETURN_NUMBER': {
        const arr = new Uint8Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          const packed = view.getUint8(byteOffset + i);
          arr[i] = (packed >> 4) & 0x0F;
        }
        result.returnNumber = arr;
        break;
      }
      case 'NUMBER_OF_RETURNS': {
        const arr = new Uint8Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          const packed = view.getUint8(byteOffset + i);
          arr[i] = packed & 0x0F;
        }
        result.numReturns = arr;
        break;
      }
      case 'SOURCE_ID': {
        const arr = new Uint16Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          arr[i] = view.getUint16(byteOffset + i * 2, true);
        }
        result.sourceId = arr;
        break;
      }
      case 'GPS_TIME': {
        const arr = new Float32Array(numPoints);
        for (let i = 0; i < numPoints; i++) {
          arr[i] = view.getFloat64(byteOffset + i * 8, true);
        }
        result.gpsTime = arr;
        break;
      }
    }
    byteOffset += attr.size * numPoints;
  }

  result.numPoints = numPoints;
  return result;
}

self.onmessage = function(e) {
  try {
    const data = e.data;
    const result = decodeAttributes(data.buffer, data.attributes, data.scale || 1, data.offset || 0);
    if (!result) {
      self.postMessage({ error: 'No points decoded' });
      return;
    }
    const transferables = [];
    for (const key of ['position', 'color', 'intensity', 'classification', 'returnNumber', 'numReturns', 'sourceId', 'gpsTime']) {
      if (result[key] && result[key].buffer) {
        transferables.push(result[key].buffer);
      }
    }
    self.postMessage(result, transferables);
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
`;

export function createDecoderWorker() {
  const blob = new Blob([DECODER_WORKER_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
