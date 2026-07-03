/**
 * @file LAS File Reader
 * @description Low-level reader for LAS (LASer) point cloud files.
 * Parses the binary LAS header to extract metadata (version, bounds, scale,
 * offset, point format capabilities) and decodes individual point records
 * into JavaScript objects. Supports streaming via async generators for
 * memory-efficient processing of large files.
 */

import { createReadStream } from 'fs';
import { open } from 'fs/promises';

/**
 * LAS point format definitions.
 * Each format specifies the record size and what optional attributes (GPS time,
 * RGB color, NIR) are available.
 * @constant {Object<number, {size: number, hasGps: boolean, hasColor: boolean, hasNir: boolean}>}
 */
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

/**
 * Reads and parses the header of a LAS/LAZ file.
 * Opens the file, reads the first 375 bytes, and extracts metadata including
 * version, point format, bounds, scale factors, offsets, and total point count.
 * Supports LAS 1.4 64-bit point counts when available.
 *
 * @async
 * @param {string} filePath - Path to the LAS/LAZ file.
 * @returns {Promise<Object>} Parsed header object with metadata fields.
 * @throws {Error} If the file signature is invalid or the point format is unsupported.
 */
export async function readLASHeader(filePath) {
  const fh = await open(filePath, 'r');
  const headerBuf = Buffer.alloc(375);
  await fh.read(headerBuf, 0, 375, 0);

  // Verify the LAS file signature ("LASF") at the start of the file.
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

  // LAS 1.4+ uses a 64-bit point count stored at offset 247.
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

/**
 * Reads point records from a LAS file in chunks, yielding batches of parsed
 * point objects. Uses an async generator for memory-efficient streaming.
 * Each point is decoded from the binary record, applying scale/offset to
 * convert integer coordinates to world-space doubles, normalizing 16-bit
 * color values to 8-bit, and extracting classification/return data.
 *
 * @async
 * @generator
 * @param {string} filePath - Path to the LAS/LAZ file.
 * @param {Object} header - Parsed LAS header object from {@link readLASHeader}.
 * @param {number} [chunkSize=100000] - Number of points to read per chunk.
 * @yields {Object[]} Array of parsed point objects, each with x, y, z, intensity,
 *   classification, returnNumber, numberOfReturns, pointSourceId, gpsTime, r, g, b, nir.
 */
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
      // Core coordinates: int32 LE * scale + offset = world-space doubles.
      const x = buf.readInt32LE(off) * scaleX + offsetX;
      const y = buf.readInt32LE(off + 4) * scaleY + offsetY;
      const z = buf.readInt32LE(off + 8) * scaleZ + offsetZ;
      const intensity = buf.readUInt16LE(off + 12);

      // Flags byte: bits 0-2 = return number, bits 3-5 = number of returns.
      const flags = buf[off + 14];
      const returnNumber = flags & 0x07;
      const numberOfReturns = (flags >> 3) & 0x07;

      // Point format 6+ reshuffles the fields after intensity.
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

      // Calculate offset to optional fields (GPS time, RGB, NIR).
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
        // 16-bit color values are normalized to 8-bit (0-255).
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

/**
 * Convenience function that reads all points from a LAS file into a single
 * array in memory. Suitable for smaller files; for large datasets, use
 * {@link readPoints} directly as an async iterator.
 *
 * @async
 * @param {string} filePath - Path to the LAS/LAZ file.
 * @param {Object} header - Parsed LAS header from {@link readLASHeader}.
 * @returns {Promise<Object[]>} Array of all parsed point objects.
 */
export async function readAllPoints(filePath, header) {
  const allPoints = [];
  for await (const chunk of readPoints(filePath, header)) {
    allPoints.push(...chunk);
  }
  return allPoints;
}
