# Nuvola Stream - PeerJS WebRTC

Sistema di streaming ottimizzato con PeerJS per WebRTC P2P diretto.

## Architettura

```
Host (MacBook)                    PeerJS Cloud              Client (remoto)
┌────────────────────┐           ┌──────────────┐          ┌────────────────────┐
│ Canvas WebGL       │           │ Signaling    │          │ <video> element    │
│ (nascosto)         │──────────▶│ Server       │◀─────────│ WebRTC receive     │
│ captureStream(60)  │           │ (gratuito)   │          │ MediaStream        │
│                    │           │              │          │                    │
│ PointCloud render  │           │              │          │ Touch/mouse input  │
│                    │           │              │          │ ↓                  │
│                    │◀──────────┤              ├──────────┤ DataChannel        │
│                    │  segnali  │              │  segnali │                    │
└────────────────────┘           └──────────────┘          └────────────────────┘
         ▲                                                        │
         └────────────────────────────────────────────────────────┘
                    WebRTC P2P diretto (video stream)
```

## Vantaggi rispetto a WebSocket

- **Zero carico sul server** per i frame video (P2P diretto)
- **NAT traversal automatico** (funziona attraverso router/firewall)
- **Latenza minima** (WebRTC ottimizzato per real-time)
- **Qualità superiore** (codec hardware VP8/H264/VP9)
- **60fps nativi** (MediaStream senza conversioni)

## Uso

### 1. Avvia il server

```bash
cd server
npm start
```

### 2. Host (MacBook)

Apri nel browser del Mac:
```
http://localhost:3000/stream-host.html
```

Vedrai un messaggio con il **Peer ID** (es: `nuvola-abc123xyz`).

### 3. Client (remoto)

Apri nel browser del dispositivo remoto:
```
http://<IP-Mac>:3000/stream-client.html
```

Inserisci il Peer ID dell'host e clicca "Connetti".

### 4. Controllo

- Clicca "Take Control" per ottenere il controllo esclusivo
- Usa touch/mouse per ruotare, zoommare, spostare il modello
- Clicca "Release Control" per rilasciare il controllo
- Solo un client alla volta può controllare il modello

## Ottimizzazioni

### Host (stream-host.html)

- Canvas WebGL nascosto (`opacity: 0`, `position: fixed`)
- Nessun UI overlay (sidebar, pannelli, minimap disabilitati)
- Solo rendering essenziale del point cloud
- `canvas.captureStream(60)` per cattura a 60fps
- PeerJS gestisce automaticamente signaling e NAT traversal

### Client (stream-client.html)

- Riceve MediaStream via WebRTC
- Decodifica hardware (VP8/H264/VP9)
- Input touch/mouse inviati via DataChannel
- Segnali a 30Hz (sufficiente per interazione fluida)

## Troubleshooting

### Connessione fallisce

- Verifica che entrambi i dispositivi abbiano accesso a Internet (PeerJS usa server cloud gratuito per signaling)
- Controlla la console del browser per errori dettagliati
- Assicurati che il Peer ID sia corretto (copialo esattamente)

### Video non parte

- Alcuni browser richiedono interazione utente prima di avviare il video
- Clicca/tocca lo schermo se vedi "Tocca per avviare lo stream"

### Performance scarse

- Riduci la risoluzione del canvas nell'host (modifica `width` e `height` in stream-host.html)
- Verifica che il Mac non sia in modalità risparmio energetico
- Chiudi altre applicazioni che usano la GPU

## Differenze rispetto a WebSocket

| Aspetto | WebSocket | PeerJS WebRTC |
|---------|-----------|---------------|
| Carico server | Alto (tutti i frame passano dal server) | Zero (P2P diretto) |
| Latenza | ~50-100ms | ~20-50ms |
| Qualità video | WebP compresso (perdita qualità) | Codec hardware (VP8/H264/VP9) |
| NAT traversal | No (richiede stessa rete) | Sì (funziona attraverso router) |
| Complessità | Bassa | Media (PeerJS semplifica) |
| Affidabilità | Alta (WebSocket stabile) | Media (WebRTC può fallire in reti restrittive) |

## File modificati

- `server/stream-host.html` - Host minimalista con PeerJS
- `server/stream-client.html` - Client con PeerJS
- `server/server.js` - Server WebSocket (solo per fallback, non più necessario per streaming)

## Note

- PeerJS usa un server cloud gratuito per signaling (0peers.com)
- Per uso production, considera di hostare il tuo PeerJS server
- Il traffico video è P2P, non passa dal server PeerJS
- Funziona su Chrome, Firefox, Safari, Edge (desktop e mobile)
