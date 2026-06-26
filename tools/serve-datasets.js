#!/usr/bin/env node
import { createServer } from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import { join, extname, resolve } from 'path';
import { networkInterfaces } from 'os';

const PORT = parseInt(process.env.PORT || '8080', 10);
const PROJECT_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');
const ROOT = PROJECT_ROOT;
const DATASETS_DIR = join(PROJECT_ROOT, 'datasets');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getMimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function serveFile(filePath, req, res) {
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const stat = statSync(filePath);
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

    if (start >= stat.size || end >= stat.size) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
      });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': mime,
    });
    createReadStream(filePath).pipe(res);
  }
}

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
