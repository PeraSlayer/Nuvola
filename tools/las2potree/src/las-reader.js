import { createReadStream } from 'fs';
import { open } from 'fs/promises';

const POINT_FORMATS = {
  0: { size: 20, hasGps: false, hasColor: false, hasNir: false },
  1: { size: 28, hasGps: true,  hasColor: false, hasNir: false },
  2: { size: 26, hasGps: false, hasColor: true,  hasNir: false },
  3: { size: 34, hasGps: true,  hasColor: true,  hasNir: false },
  4: { size: 57, hasGps: true,  hasColor: false, hasNir: false },
  5: { size: 63, hasGps: true,  hasColor: true,  hasNir: false },
  6: { size: 30, hasGps: true,  hasColor: false, hasNir: false },
  7: { size: 36, hasGps: true,  hasColor: true,  hasNir: false },
  8: { size: 42, hasGps: true,  hasColor: true,  hasNir: true  },
  9: { size: 59, hasGps: true,  hasColor: false, hasNir: false },
  10: { size: 67, hasGps: true, hasColor: true,  hasNir: true  },
};

export async function readLASHeader(filePath) {
  const fh = await open(filePath, 'r');
  const headerBuf = Buffer.alloc(375);
  await fh.read(headerBuf, 0, 375, 0);

  const sig = headerBuf.toString('ascii', 0, 4);
  if (sig !== 'LASF') throw new Error('Not a valid LAS file (bad signature)');

  const versionMajor = headerBuf[24];
  const versionMinor = headerBuf[25];
  const headerSize = headerBuf.readUInt16LE(94);
  const pointOffset = headerBuf.readUInt32LE(96);
  const pointFormat = headerBuf[104];
  const pointRecordLength = headerBuf.readUInt16LE(105);
  let pointCount = headerBuf.readUInt32LE(107);

  const scaleX = headerBuf.readDoubleLE(131);
  const scaleY = headerBuf.readDoubleLE(139);
  const scaleZ = headerBuf.readDoubleLE(147);
  const offsetX = headerBuf.readDoubleLE(155);
  const offsetY = headerBuf.readDoubleLE(163);
  const offsetZ = headerBuf.readDoubleLE(171);
  const maxX = headerBuf.readDoubleLE(179);
  const minX = headerBuf.readDoubleLE(187);
  const maxY = headerBuf.readDoubleLE(195);
  const minY = headerBuf.readDoubleLE(203);
  const maxZ = headerBuf.readDoubleLE(211);
  const minZ = headerBuf.readDoubleLE(219);

  if (versionMajor === 1 && versionMinor >= 4 && headerSize >= 375) {
    const count64Low = headerBuf.readUInt32LE(247);
    const count64High = headerBuf.readUInt32LE(251);
    const count64 = count64Low + count64High * 0x100000000;
    if (count64 > 0 && (pointCount === 0 || count64 > pointCount)) {
      pointCount = Number(count64);
    }
  }

  const fmt = POINT_FORMATS[pointFormat];
  if (!fmt) throw new Error(`Unsupported point format: ${pointFormat}`);

  const header = {
    versionMajor, versionMinor, headerSize,
    pointOffset, pointFormat, pointRecordLength, pointCount,
    scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ,
    minX, maxX, minY, maxY, minZ, maxZ,
    hasGpsTime: fmt.hasGps,
    hasColor: fmt.hasColor,
    hasNir: fmt.hasNir,
  };

  await fh.close();
  return header;
}

export async function* readPoints(filePath, header, chunkSize = 100000) {
  const fh = await open(filePath, 'r');
  const { pointOffset, pointCount, pointRecordLength, pointFormat,
          scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ } = header;

  const fmt = POINT_FORMATS[pointFormat];
  const buf = Buffer.alloc(pointRecordLength * chunkSize);

  for (let start = 0; start < pointCount; start += chunkSize) {
    const count = Math.min(chunkSize, pointCount - start);
    const fileOffset = pointOffset + start * pointRecordLength;
    await fh.read(buf, 0, count * pointRecordLength, fileOffset);

    const points = [];
    for (let i = 0; i < count; i++) {
      const off = i * pointRecordLength;
      const x = buf.readInt32LE(off) * scaleX + offsetX;
      const y = buf.readInt32LE(off + 4) * scaleY + offsetY;
      const z = buf.readInt32LE(off + 8) * scaleZ + offsetZ;
      const intensity = buf.readUInt16LE(off + 12);

      const flags = buf[off + 14];
      const returnNumber = flags & 0x07;
      const numberOfReturns = (flags >> 3) & 0x07;

      let classification, scanAngle, userData, pointSourceId;
      if (pointFormat >= 6) {
        classification = buf[off + 16];
        scanAngle = buf.readInt16LE(off + 18);
        userData = buf[off + 20];
        pointSourceId = buf.readUInt16LE(off + 22);
      } else {
        classification = buf[off + 15];
        scanAngle = buf.readInt8(off + 16);
        userData = buf[off + 17];
        pointSourceId = buf.readUInt16LE(off + 18);
      }

      let gpsTime = null;
      let r = 0, g = 0, b = 0;
      let nir = 0;

      let extraOff;
      if (pointFormat >= 6) {
        extraOff = 24;
      } else {
        extraOff = 20;
      }

      if (fmt.hasGps) {
        gpsTime = buf.readDoubleLE(off + extraOff);
        extraOff += 8;
      }

      if (fmt.hasColor) {
        r = buf.readUInt16LE(off + extraOff);
        g = buf.readUInt16LE(off + extraOff + 2);
        b = buf.readUInt16LE(off + extraOff + 4);
        extraOff += 6;
      }

      if (fmt.hasNir) {
        nir = buf.readUInt16LE(off + extraOff);
      }

      points.push({
        x, y, z, intensity, classification,
        returnNumber, numberOfReturns,
        pointSourceId, gpsTime,
        r: Math.min(255, Math.floor(r / 256)),
        g: Math.min(255, Math.floor(g / 256)),
        b: Math.min(255, Math.floor(b / 256)),
        nir,
      });
    }

    yield points;
  }

  await fh.close();
}

export async function readAllPoints(filePath, header) {
  const allPoints = [];
  for await (const chunk of readPoints(filePath, header)) {
    allPoints.push(...chunk);
  }
  return allPoints;
}
