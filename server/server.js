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

let connectedClients = new Map();
let host = null;
let viewers = new Set();
let currentController = null;

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
        <p>Porta: <code>${PORT}</code></p>
        <p>Client connessi: <code>${connectedClients.size}</code></p>
      </div>
      <div class="info">
        <h2>Streaming WebSocket 60fps</h2>
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

// Gestisci connessioni WebSocket
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substr(2, 9);
  console.log('🔗 Client connesso:', clientId);
  connectedClients.set(clientId, ws);
  
  ws.on('close', () => {
    console.log('🔌 Client disconnesso:', clientId);
    
    // Cleanup host
    if (host === ws) {
      host = null;
      console.log('Host disconnesso');
    }
    
    // Cleanup viewer
    if (viewers.has(ws)) {
      viewers.delete(ws);
    }
    
    // Rilascia controllo se il controller si disconnette
    if (currentController === clientId) {
      currentController = null;
      broadcastControlMessage({ type: 'control-released' });
      console.log('Controllo rilasciato (controller disconnesso)');
    }
    
    connectedClients.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error('Errore WebSocket:', error);
    connectedClients.delete(clientId);
    if (host === ws) host = null;
    if (viewers.has(ws)) viewers.delete(ws);
    if (currentController === clientId) {
      currentController = null;
      broadcastControlMessage({ type: 'control-released' });
    }
  });
  
  ws.on('message', (message, isBinary) => {
    // Se è un messaggio binario (frame video), inoltra a tutti i viewer
    if (isBinary) {
      viewers.forEach(viewer => {
        if (viewer.readyState === 1 && viewer !== ws) {
          viewer.send(message, { binary: true });
        }
      });
      return;
    }
    
    try {
      const messageStr = message.toString();
      const data = JSON.parse(messageStr);
      
      // Registrazione ruolo
      if (data.type === 'register') {
        if (data.role === 'host') {
          host = ws;
          console.log('✓ Host registrato:', clientId);
        } else if (data.role === 'viewer') {
          viewers.add(ws);
          console.log('✓ Viewer registrato:', clientId);
          
          // Notifica host che un nuovo viewer si è connesso
          if (host && host.readyState === 1) {
            host.send(JSON.stringify({
              type: 'viewer-joined',
              viewerId: clientId
            }));
          }
        }
        return;
      }
      
      // Signaling WebRTC
      if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
        if (data.target === 'host' && host && host.readyState === 1) {
          host.send(JSON.stringify({ ...data, senderId: clientId }));
        } else if (data.target === 'viewer' && data.viewerId) {
          // Trova il viewer specifico
          for (const [id, client] of connectedClients) {
            if (id === data.viewerId && client.readyState === 1) {
              client.send(JSON.stringify({ ...data, senderId: clientId }));
              break;
            }
          }
        }
        return;
      }
      
      // Gestione controllo
      if (data.type === 'request-control') {
        if (currentController === null) {
          currentController = clientId;
          broadcastControlMessage({ 
            type: 'control-granted', 
            controllerId: clientId 
          });
          console.log('✓ Controllo concesso a:', clientId);
        } else {
          ws.send(JSON.stringify({ type: 'control-denied' }));
          console.log('✗ Controllo negato a:', clientId, '(già in uso)');
        }
        return;
      }
      
      if (data.type === 'release-control') {
        if (currentController === clientId) {
          currentController = null;
          broadcastControlMessage({ type: 'control-released' });
          console.log('✓ Controllo rilasciato da:', clientId);
        }
        return;
      }
      
      // Inoltra segnali di controllo solo dal controller autorizzato
      if (data.type === 'signal' && currentController === clientId && host && host.readyState === 1) {
        host.send(JSON.stringify({ ...data, senderId: clientId }));
        return;
      }
      
      // Altri messaggi (backward compatibility)
      connectedClients.forEach((client, id) => {
        if (id !== clientId && client.readyState === 1) {
          client.send(messageStr);
        }
      });
    } catch (error) {
      console.error('Errore parsing messaggio:', error);
    }
  });
});

function broadcastControlMessage(msg) {
  const message = JSON.stringify(msg);
  connectedClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Avvia il server
server.listen(PORT, () => {
  console.log(`\n  Nuvola Stream Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Server attivo su http://localhost:${PORT}`);
  console.log(`  Info: http://localhost:${PORT}/info`);
  console.log(`\n  Streaming WebSocket 60fps:`);
  console.log(`  1. Avvia streaming dal viewer (Start Streaming)`);
  console.log(`  2. Su qualsiasi dispositivo: http://<IP-PC>:${PORT}/stream-client.html`);
  console.log(`  3. Premi "Take Control" per interagire`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

// Gestione chiusura graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Chiusura server...');
  process.exit(0);
});
