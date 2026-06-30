import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { PeerServer } from 'peer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const PORT = 3000;
const PEER_PORT = 3001;

// Servo i file statici dalla root del progetto
app.use(express.static(path.join(__dirname, '..')));

// Servo anche i file dalla directory server/ direttamente
app.use(express.static(__dirname));

// Pagina principale - redirect al viewer
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// Pagina info server
app.get('/info', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Nuvola Stream Server</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; background: #1a1a1a; color: #fff; }
        h1 { color: #00d4ff; }
        .info { background: #2a2a2a; padding: 20px; border-radius: 8px; margin: 20px 0; }
        code { background: #333; padding: 2px 8px; border-radius: 4px; }
        a { color: #00d4ff; }
        .badge { display: inline-block; background: #34c759; color: #000; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>Nuvola Stream Server</h1>
      <div class="info">
        <h2>Server Status: Running <span class="badge">OK</span></h2>
        <p>Porta HTTP: <code>${PORT}</code></p>
        <p>Porta PeerJS: <code>${PEER_PORT}</code></p>
      </div>
      <div class="info">
        <h2>Streaming WebRTC (Peer-to-Peer)</h2>
        <p>Da qualsiasi dispositivo sulla stessa rete WiFi:</p>
        <p><code>http://&lt;IP-DEL-TUO-PC&gt;:${PORT}/stream-client.html</code></p>
        <p>Sostituisci <code>&lt;IP-DEL-TUO-PC&gt;</code> con l'indirizzo IP del tuo computer.</p>
        <p style="color: #888; font-size: 14px; margin-top: 10px;">
          1. Avvia lo streaming dal viewer desktop (Start Streaming)<br>
          2. Apri il link sopra su qualsiasi dispositivo<br>
          3. Premi "Take Control" per interagire con il modello
        </p>
      </div>
      <div class="info">
        <h2>Viewer Desktop (Host)</h2>
        <p>Apri il viewer: <a href="/index.html">index.html</a></p>
      </div>
    </body>
    </html>
  `);
});

// Avvia il server PeerJS standalone
const peerServer = PeerServer({
  port: PEER_PORT,
  path: '/peerjs',
  allow_discovery: false,
  concurrent_limit: 10000
});

peerServer.on('connection', (client) => {
  console.log('🔗 Peer connesso:', client.getId());
});

peerServer.on('disconnect', (client) => {
  console.log('🔌 Peer disconnesso:', client.getId());
});

peerServer.on('error', (error) => {
  console.error('❌ Errore PeerJS:', error);
});

// Avvia il server HTTP
server.listen(PORT, () => {
  console.log(`\n  Nuvola Stream Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Server HTTP: http://localhost:${PORT}`);
  console.log(`  Server PeerJS: ws://localhost:${PEER_PORT}/peerjs`);
  console.log(`  Info: http://localhost:${PORT}/info`);
  console.log(`\n  Streaming WebRTC (Peer-to-Peer):`);
  console.log(`  1. Avvia streaming dal viewer (Start Streaming)`);
  console.log(`  2. Su qualsiasi dispositivo: http://<IP-PC>:${PORT}/stream-client.html`);
  console.log(`  3. Premi "Take Control" per interagire`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

// Gestione chiusura graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Chiusura server...');
  peerServer.close();
  server.close();
  process.exit(0);
});
