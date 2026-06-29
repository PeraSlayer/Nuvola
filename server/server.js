import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3000;

let connectedClients = new Set();

// Servo i file statici dalla root del progetto
app.use(express.static(path.join(__dirname, '..')));

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
        body { font-family: Arial, sans-serif; margin: 40px; background: #1a1a1a; color: #fff; }
        h1 { color: #00d4ff; }
        .info { background: #2a2a2a; padding: 20px; border-radius: 8px; margin: 20px 0; }
        code { background: #333; padding: 2px 8px; border-radius: 4px; }
        a { color: #00d4ff; }
      </style>
    </head>
    <body>
      <h1>🌩️ Nuvola Stream Server</h1>
      <div class="info">
        <h2>Server Status: Running ✓</h2>
        <p>Porta: <code>${PORT}</code></p>
        <p>Client connessi: <code>${connectedClients.size}</code></p>
      </div>
      <div class="info">
        <h2>Connessione Meta Quest</h2>
        <p>Dal Meta Quest, apri il browser e vai a:</p>
        <p><code>http://&lt;IP-DEL-TUO-PC&gt;:${PORT}/quest.html</code></p>
        <p>Sostituisci <code>&lt;IP-DEL-TUO-PC&gt;</code> con l'indirizzo IP del tuo computer.</p>
      </div>
      <div class="info">
        <h2>Viewer Desktop</h2>
        <p>Apri il viewer: <a href="/viewer.html">Viewer con streaming</a></p>
        <p>O usa il viewer originale: <a href="/index.html">Viewer originale</a></p>
      </div>
    </body>
    </html>
  `);
});

// Gestisci connessioni WebSocket
wss.on('connection', (ws) => {
  console.log('🔗 Client connesso');
  connectedClients.add(ws);
  
  ws.on('close', () => {
    console.log('🔌 Client disconnesso');
    connectedClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('Errore WebSocket:', error);
    connectedClients.delete(ws);
  });
  
  // Inoltra messaggi a tutti i client connessi
  ws.on('message', (message) => {
    // Log messaggi di input per debug
    try {
      const data = JSON.parse(message);
      if (data.type === 'tracking' || data.type === 'click') {
        console.log('📥 Input ricevuto:', data.type);
      }
    } catch (e) {
      // Messaggio binario (frame video)
    }
    
    connectedClients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(message);
      }
    });
  });
});

// Avvia il server
server.listen(PORT, () => {
  console.log(`\n🌩️  Nuvola Stream Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ Server attivo su http://localhost:${PORT}`);
  console.log(`✓ Info: http://localhost:${PORT}/info`);
  console.log(`\n📱 Per connettere il Meta Quest:`);
  console.log(`   1. Trova l'IP del tuo PC`);
  console.log(`   2. Sul Quest, apri il browser`);
  console.log(`   3. Vai a: http://<IP-PC>:${PORT}/quest.html`);
  console.log(`\n💻 Per il viewer desktop:`);
  console.log(`   Apri: http://localhost:${PORT}/viewer.html`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

// Gestione chiusura graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Chiusura server...');
  process.exit(0);
});
