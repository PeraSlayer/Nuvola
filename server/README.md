# Nuvola Stream Server

Sistema di stream rendering per visualizzare nuvole di punti su Meta Quest (o altri dispositivi) con il rendering fatto dal PC.

## Architettura

```
┌─────────────────────────────────────────┐
│  PC (Server)                             │
│  ├── Node.js + Express + WebSocket      │
│  ├── Browser con viewer WebGL           │
│  └── Cattura frame → invia al Quest     │
└──────────────┬──────────────────────────┘
               │ WebSocket
               │
┌──────────────▼──────────────────────────┐
│  Meta Quest (Client)                     │
│  ├── Riceve frame JPEG via WebSocket    │
│  ├── Tracking testa → invia al PC       │
│  └── Visualizzazione immersiva          │
└─────────────────────────────────────────┘
```

## Installazione

```bash
cd server
npm install
```

## Avvio Server

```bash
npm start
```

Il server si avvia su `http://localhost:3000`

## Utilizzo

### 1. Trova l'IP del tuo PC

**macOS:**
```bash
ipconfig getifaddr en0
```

**Windows:**
```bash
ipconfig
```

**Linux:**
```bash
ip addr show
```

### 2. Avvia il Viewer sul PC

Apri nel browser del PC:
```
http://localhost:3000/viewer.html
```

Carica il file PLY e clicca **"Avvia Streaming"**

### 3. Connetti il Meta Quest

Dal browser del Meta Quest, vai a:
```
http://<IP-DEL-TUO-PC>:3000/quest.html
```

Clicca **"Avvia VR"** per iniziare lo streaming.

## Funzionalità

### Viewer Desktop (`viewer.html`)
- Carica il viewer originale
- Cattura i frame dal canvas WebGL
- Invia i frame al Quest via WebSocket
- Riceve il tracking della testa dal Quest
- Aggiorna la camera in tempo reale

### Client Quest (`quest.html`)
- Riceve i frame JPEG via WebSocket
- Visualizza a schermo intero
- Tracking della testa tramite DeviceOrientation API
- Controlli touch per movimento
- Pulsanti per avanti/indietro/reset

### Server (`server.js`)
- Server Express per file statici
- WebSocket server per comunicazione bidirezionale
- Bridge tra viewer e Quest
- Gestione multiple connessioni

## Requisiti

- **PC**: Node.js 18+, browser moderno con WebGL2
- **Meta Quest**: Browser con supporto WebSocket
- **Rete**: PC e Quest sulla stessa rete locale

## Prestazioni

- **FPS Target**: 30 FPS
- **Qualità JPEG**: 75%
- **Latenza**: ~50-100ms (dipende dalla rete)

## Troubleshooting

### Il Quest non si connette
- Verifica che PC e Quest siano sulla stessa rete
- Controlla che il firewall non blocchi la porta 3000
- Prova a pingare il PC dal Quest

### FPS bassi
- Riduci la qualità JPEG in `viewer.html` (riga `canvas.toDataURL('image/jpeg', 0.7)`)
- Riduci il target FPS in `viewer.html` (riga `setInterval(sendFrame, 33)`)
- Chiudi altre applicazioni che usano la GPU

### Il viewer non carica il file
- Verifica che `points.ply` esista nella root del progetto
- Controlla la console del browser per errori
- Prova a caricare manualmente il file dal viewer originale

## Sviluppo

### Modalità sviluppo
```bash
npm run dev
```

### Struttura file
```
server/
├── server.js          # Server principale
├── viewer.html        # Viewer con streaming
├── quest.html         # Client per Meta Quest
├── package.json       # Dipendenze
└── README.md          # Questa guida
```

## Limitazioni

- Richiede browser aperto sul PC
- Latenza di rete può influire sull'esperienza
- WebXR non supportato (usa DeviceOrientation)
- Qualità video dipende dalla banda disponibile

## Futuri miglioramenti

- [ ] Supporto WebXR per tracking migliore
- [ ] Compressione video (WebRTC)
- [ ] Rendering headless con Puppeteer
- [ ] Supporto multi-utente
- [ ] Ottimizzazione prestazioni rendering

## Licenza

Stesso licenza del progetto Nuvola principale.
