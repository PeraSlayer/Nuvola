# Nuvola

Visualizzatore di nuvole di punti 2.5D multi-formato, basato su WebGL e Three.js.

## Formati supportati

- **PLY** (inclusi `.ply.gz`)
- **LAS / LAZ**
- **XYZ / TXT / PTS**
- **Potree** (tramite URL `metadata.json`)

## Funzionalità

- Rendering WebGL con shader personalizzati
- Modalità colore: RGB, Altezza, Intensità, Profondità, Classificazione
- LOD (Level of Detail) con budget automatico basato su VRAM GPU
- Decimazione dei punti per distanza
- Navigazione orbitale con viste predefinite (N, E, S, W, Top, Front, Right, Back)
- Rotazione fluida e modalità 8 direzioni
- Illuminazione regolabile (azimut, elevazione, ambiente)
- Strumento di misurazione distanza
- Minimappa
- Supporto drag & drop dei file
- Responsive (sidebar collassabile su mobile)

## Utilizzo

Apri `index.html` in un browser moderno, oppure avvia un server locale:

```bash
python3 -m http.server 8000
```

Poi visita `http://localhost:8000`.

## Controlli

| Azione | Controllo |
|---|---|
| Orbita / ruota | Trascinamento sinistro |
| Pan | Trascinamento destro |
| Zoom | Rotella |
| Reset vista | Doppio clic |
| Pan su/giù | W / S oppure frecce su/giù |
| Pan sinistra/destra | A / D oppure frecce sinistra/destra |
| Zoom +/- | Tasti `+` / `-` |
| Ruota vista | Q / E |
| Reset vista | R |

## Struttura progetto

```
Nuvola/
├── index.html
├── styles.css
└── script_js/
    ├── main/          # Entry point e logica principale
    ├── file_loader/   # Parsing file (PLY, LAS, LAZ, XYZ)
    ├── model/         # Modello dati nuvola di punti
    ├── rendering-app/ # Rendering WebGL e shader
    ├── view/          # Controlli vista e camera
    └── potree/        # Supporto dataset Potree
```

## Dipendenze

- [Three.js](https://threejs.org/) v0.160.0 (caricato via CDN)

Nessuna installazione richiesta: tutto funziona nel browser.
