#!/usr/bin/env node

/**
 * @file Nuvola Dataset Server
 * @description A zero-dependency HTTP static file server for serving Potree
 * point cloud datasets and static frontend files. Supports CORS, byte-range
 * requests (essential for Potree streaming), and automatic local IP detection
 * for mobile device access over WiFi.
 *
 * Usage: node tools/serve-datasets.js
 */

import { createServer } from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import { join, extname, resolve } from 'path';
import { networkInterfaces } from 'os';

/** @constant {number} PORT - HTTP server port, read from PORT env var or defaults to 8080. */
const PORT = parseInt(process.env.PORT || '8080', 10);
const PROJECT_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');
const ROOT = PROJECT_ROOT;
const DATASETS_DIR = join(PROJECT_ROOT, 'datasets');

/**
 * MIME type mapping for common file extensions used by Potree and web content.
 * @constant {Object<string, string>}
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Determines the MIME type for a given file path based on its extension.
 * Falls back to application/octet-stream for unknown types.
 * @param {string} filePath - Absolute path to the file.
 * @returns {string} The corresponding MIME type string.
 */
function getMimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Scans the system's network interfaces and returns the first non-internal IPv4 address.
 * Used to display the URL accessible from other devices on the same network.
 * @returns {string} The local IPv4 address, or 'localhost' if none found.
 */
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

/**
 * Serves a file over HTTP with CORS headers and byte-range support.
 * If the path is a directory, attempts to serve index.html inside it.
 * Supports HTTP 206 Partial Content for efficient Potree data streaming.
 *
 * @param {string} filePath - Absolute path to the file or directory to serve.
 * @param {import('http').IncomingMessage} req - The HTTP request.
 * @param {import('http').ServerResponse} res - The HTTP response.
 */
function serveFile(filePath, req, res) {
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const stat = statSync(filePath);
  // If the path is a directory, look for an index.html inside it.
  if (stat.isDirectory()) {
    filePath = join(filePath, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
  }

  const mime = getMimeType(filePath);
  const range = req.headers.range;

  // Set CORS and range-request headers for Potree compatibility.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    // Parse the byte range header (e.g., "bytes=0-1023").
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

    // Validate range bounds.
    if (start >= stat.size || end >= stat.size) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
      });
      res.end();
      return;
    }

    // Respond with 206 Partial Content.
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    // Respond with the full file.
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mime,
    });
    createReadStream(filePath).pipe(res);
  }
}

/**
 * Creates and starts the HTTP server.
 * Routes starting with /datasets/ serve files from the datasets directory;
 * all other routes serve static files from the project root.
 */
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/datasets/')) {
    const datasetPath = join(DATASETS_DIR, pathname.replace('/datasets/', ''));
    serveFile(datasetPath, req, res);
  } else {
    const filePath = join(ROOT, pathname);
    serveFile(filePath, req, res);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n=== Nuvola Server ===\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(`  Datasets: ${DATASETS_DIR}`);
  console.log(`\n  Access from phone: http://${ip}:${PORT}`);
  console.log(`  Load Potree: paste http://${ip}:${PORT}/datasets/<name>/ in the Potree URL field\n`);
});
