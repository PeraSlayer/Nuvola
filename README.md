# Nuvola

**Multi-format point cloud viewer for the browser — 2.5D rendering powered by WebGL2 and Three.js.**

---

## Overview

Nuvola is a high-performance, browser-based point cloud visualization tool. Drag and drop a file or paste a Potree dataset URL and instantly explore millions to billions of points with custom WebGL shaders, adaptive level-of-detail, and a rich set of interactive controls. No installation, no backend — everything runs client-side in the GPU.

### Features

- **Multi-format support** — PLY, LAS, LAZ, XYZ, TXT, PTS, E57, RXP, and Potree streaming datasets
- **Custom WebGL2 deferred shading pipeline** — depth-based lighting, edge enhancement, sky gradient
- **Five color modes** — RGB, Height, Intensity, Depth, Classification
- **Priority-queue LOD** — GPU VRAM-aware point budget with automatic scaling
- **Octree streaming (Potree v2.0)** — progressive loading via HTTP range requests, LRU cache
- **Distance measurement tool** — pick two points on any surface, get horizontal / vertical / Euclidean distances
- **Orientation gizmo** — real-time XYZ axes indicator
- **Minimap** — top-down overview with camera frustum overlay
- **Visual effects** — sketch effect (outline rendering), dreamy glow, depth-based fog
- **WebRTC streaming** — broadcast the viewport at 60fps to any device with remote camera control (PeerJS)
- **VR mode** — immersive WebXR headset support
- **FPS / drone camera** — toggle between isometric inspection and first-person fly-through
- **Responsive sidebar** — collapsible panels optimized for desktop and mobile
- **Zero dependencies at runtime** — Three.js and PeerJS loaded from CDN

---

## Supported Formats

| Format | Extension | Notes |
|---|---|---|
| PLY | `.ply`, `.ply.gz` | Binary and ASCII, gzip-compressed |
| LAS | `.las` | Uncompressed; files >2 GB load via chunked tiling |
| LAZ | `.laz` | Decompressed client-side via laz-perf WASM |
| XYZ / TXT / PTS | `.xyz`, `.txt`, `.pts` | Whitespace-separated `x y z [r g b]` |
| E57 | `.e57` | ASTM E57 format, large-file streaming support |
| RXP | `.rxp` | Riegl RXP scanner format |
| Potree | `metadata.json` URL | Potree v2.0 octree datasets, progressive streaming |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  index.html (Single Page App)                            │
│  ┌─────────────┐  ┌──────────────────────────────────┐   │
│  │ Sidebar UI  │  │ Main Canvas (WebGL2)              │   │
│  │             │  │  ┌─────────┐ ┌────────────────┐   │   │
│  │ Load / View │  │  │ WebGL2  │ │ Three.js       │   │   │
│  │ Color Mode  │  │  │ Renderer│ │ Overlay (meas.)│   │   │
│  │ Lighting    │  │  └─────────┘ └────────────────┘   │   │
│  │ Effects     │  │  ┌─────────┐ ┌────────────────┐   │   │
│  │ Streaming   │  │  │ Gizmo   │ │ Minimap Canvas │   │   │
│  └─────────────┘  │  └─────────┘ └────────────────┘   │   │
│                   └──────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────┐  ┌────────────────────────────┐    │
│  │ File Loaders     │  │ Potree Loader              │    │
│  │ (PLY,LAS,XYZ,...)│  │ (streaming octree + LRU)   │    │
│  └────────┬─────────┘  └─────────────┬──────────────┘    │
│           │                          │                   │
│  ┌────────▼──────────────────────────▼──────────────┐    │
│  │ PointCloud Model (octree, LOD, pick-grid)        │    │
│  │ Inline Web Worker — bounds, octree, pick-grid    │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Camera Controller (isometric + FPS dual mode)    │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘

  ┌─────────────────┐        ┌─────────────────┐
  │ Stream Host     │◄──────►│ Stream Client   │
  │ (PeerJS +       │ WebRTC │ (any device)    │
  │  canvas stream) │        │                 │
  └────────┬────────┘        └─────────────────┘
           │ Signaling
  ┌────────▼────────┐
  │ PeerJS Server   │
  │ (server/server) │
  └─────────────────┘
```

**Rendering pipeline:**  The renderer uses a two-pass deferred shading approach: points are first drawn into a G-buffer (color + depth + normal), then a full-screen quad composites the result with per-pixel lighting, edge enhancement, and optional post-processing effects.

---

## Quick Start

### Option A — Open directly (static files)

```bash
# Python 3
python3 -m http.server 8000
```
Then visit `http://localhost:8000`.

### Option B — Development server with streaming

```bash
cd server
npm install
npm start
```
Then visit `http://localhost:3000`.  
Server info page at `http://localhost:3000/info`.

---

## Opening Files

### Drag & Drop

Drag any supported file (`.ply`, `.las`, `.laz`, `.xyz`, `.txt`, `.pts`, `.rxp`, `.e57`) directly onto the browser window. A drop overlay confirms the action.

### File Picker

Click **Load Point Cloud** in the sidebar or use the keyboard shortcut to open the native file dialog.

### Potree URL

Paste a URL to a Potree dataset's `metadata.json` (e.g., `http://localhost:8080/datasets/myscan/metadata.json`) and click **Load Potree Dataset**, or press Enter. The dataset streams progressively from the server via HTTP range requests.

---

## Controls

### Mouse

| Action | Control |
|---|---|
| Orbit / Rotate | Left drag |
| Pan | Right drag (or Ctrl + Left drag) |
| Zoom | Scroll wheel |
| Reset view | Double-click |

### Touch

| Action | Control |
|---|---|
| Orbit | One-finger drag |
| Pinch zoom | Two-finger pinch |
| Pan | Two-finger drag |

### Keyboard

| Key | Action |
|---|---|
| `W` / `↑` | Pan up |
| `S` / `↓` | Pan down |
| `A` / `←` | Pan left |
| `D` / `→` | Pan right |
| `Q` | Rotate view counter-clockwise |
| `E` | Rotate view clockwise |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `R` | Reset view |

### UI Buttons

- **View grid (N / E / S / W)** — snap to 4 or 8 cardinal directions
- **Snap buttons (Top / Front / Right / Back)** — instant orthographic presets
- **Rotate Left / Right** — 90° view rotation
- **Reset View** — restore default camera

---

## Color Modes

Available via the **Color Mode** panel in the sidebar:

| Mode | Description |
|---|---|
| **RGB** | Natural color from point attributes (default) |
| **Height** | Color-mapped by Z elevation (blue → green → red) |
| **Intensity** | Color-mapped by LiDAR intensity values |
| **Depth** | Color-mapped by distance from the camera |
| **Classification** | Color-mapped by LAS classification codes |

The Classification mode is automatically disabled when the loaded dataset lacks classification data.

---

## Visual Effects

### Lighting

- **Light Azimuth** (0°–360°) — direction of the directional light in the horizontal plane
- **Light Elevation** (5°–85°) — angle above the horizon
- **Ambient** (0–1) — base scene brightness
- **Depth-based shading** — toggle realistic hill-shading derived from point depth

### Background

- **Sky gradient** — customizable top and bottom colors
- The gradient blends smoothly behind the point cloud using CSS-like color interpolation

### Point Style

- **Auto point size** — adapts dynamically to the camera zoom level
- **Fixed point size** — constant pixel size regardless of zoom
- **Sketch effect** — outlines and edge-darkening for a hand-drawn look
- **Dreamy effect** — soft bloom / glow around bright points

---

## WebRTC Streaming

Nuvola can stream its viewport to any device (phone, tablet, laptop) at 60fps using WebRTC with peer-to-peer connectivity.

### How it works

1. The **host** (desktop with the point cloud loaded) starts streaming via the **Start Streaming** button
2. A PeerJS connection is established to the signaling server (`server/server.js`)
3. The host's WebGL canvas is captured at 60fps via `canvas.captureStream(60)`
4. A **client** (any device on the same network) opens `stream-client.html`, connects to the host, and receives the video stream
5. The client can **Take Control** to orbit, pan, and zoom the model remotely — camera commands are sent via a WebRTC DataChannel
6. Toggle between **Isometric** and **FPS** camera modes remotely
7. Only one client at a time can hold control; others watch passively

### Setup

```bash
cd server
npm install
npm start
```

- Host: `http://localhost:3000/stream-host.html`
- Client: `http://<host-ip>:3000/stream-client.html`

### Architecture

```
Host (canvas capture) ──WebRTC P2P──► Client (<video> element)
         │                                  │
         └── DataChannel (control signals) ─┘
         │                                  │
    PeerJS Server (signaling only, no video relay)
```

### Advantages over WebSocket streaming

- Zero server load for video frames (P2P direct)
- Automatic NAT traversal
- Hardware-accelerated codecs (VP8 / H264 / VP9)
- Sub-50ms latency
- Native 60fps capture

For detailed troubleshooting and comparison, see [server/STREAMING_PEERJS.md](server/STREAMING_PEERJS.md).

---

## LAS to Potree Conversion

Convert LAS/LAZ point cloud files to Potree streaming octrees for efficient progressive loading:

```bash
cd tools/las2potree
npm install
node src/index.js <input.las|input.laz> <output-dir> [options]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--max-depth <n>` | `12` | Maximum octree depth |
| `--leaf-size <n>` | `5000` | Points per leaf node |
| `--streaming` | `false` | Enable streaming mode for very large files |
| `--memory-limit <MB>` | `4096` | Memory threshold before switching to streaming |

### Example

```bash
node src/index.js ~/data/scan.las ./datasets/scan/
node src/index.js ~/data/huge.laz ./datasets/huge/ --streaming --memory-limit 8192
```

Then serve the dataset:

```bash
node tools/serve-datasets.js
```

And load it in Nuvola by pasting `http://localhost:8080/datasets/scan/metadata.json`.

### Streaming mode

For datasets with over 1 billion points, the converter operates in two passes:
1. **First pass** — builds the octree structure (point counts per node) without storing geometry
2. **Second pass** — writes binary data file by file, streaming points to disk

This keeps memory usage bounded regardless of input size.

---

## Development Server

The `tools/serve-datasets.js` script is a zero-dependency static file server optimized for Potree datasets:

```bash
node tools/serve-datasets.js
```

**Features:**
- Serves the Nuvola viewer and datasets from a single origin
- CORS headers enabled
- HTTP 206 Partial Content support for Potree byte-range requests
- Automatic local IP detection for mobile access
- Routes: `/datasets/` → `./datasets/` directory; everything else → project root

The `server/server.js` Express server additionally runs a PeerJS signaling service for WebRTC streaming.

---

## Project Structure

```
Nuvola/
├── index.html                          # Main entry point (SPA)
├── styles.css                          # Stylesheet
├── test.html                           # Automated test suite (Phases 1—5)
├── .gitignore
│
├── script_js/
│   ├── main/
│   │   ├── main.js                     # App class — orchestration, render loop, workers
│   │   └── input.js                    # Mouse / touch / keyboard event wiring
│   │
│   ├── file_loader/
│   │   ├── ply-loader.js               # PLY binary & ASCII parser
│   │   ├── las-loader.js               # LAS 1.2—1.4 parser
│   │   ├── las-tiling-loader.js        # Large LAS chunked loading (>2 GB)
│   │   ├── laz-decompressor.js         # LAZ → LAS decompression (laz-perf WASM)
│   │   ├── xyz-loader.js               # XYZ / TXT / PTS parser
│   │   ├── rxp-loader.js               # Riegl RXP scanner parser
│   │   └── e57-loader.js               # ASTM E57 parser with large-file streaming
│   │
│   ├── model/
│   │   ├── PointCloud.js               # Point cloud data model, GPU upload, LOD interface
│   │   ├── Octree.js                   # Octree spatial index
│   │   ├── transform.js                # Cloud rotation / scale transforms
│   │   └── camera.js                   # Camera matrix & projection helpers
│   │
│   ├── rendering-app/
│   │   ├── renderer.js                 # WebGL2 renderer — deferred shading, batching, VAO/VBO
│   │   ├── shader.js                   # GLSL vertex & fragment shaders (inline strings)
│   │   ├── ThreeOverlayRenderer.js     # Three.js overlay for measurement markers
│   │   └── OverlayScene.js             # Canvas overlay scene management
│   │
│   ├── potree/
│   │   ├── PotreeLoader.js             # Potree v2.0 metadata parser & octree loader
│   │   ├── PotreeOctree.js             # Potree octree geometry class
│   │   ├── CameraController.js         # Dual-mode camera (isometric + FPS)
│   │   ├── VisibilitySystem.js         # Priority-queue LOD node selection
│   │   ├── LRUCache.js                 # GPU resource cache with eviction
│   │   ├── PriorityQueue.js            # Binary heap for LOD traversal
│   │   ├── NodeLoader.js               # Async node fetch + decode pipeline
│   │   ├── WorkerPool.js               # Web Worker thread pool
│   │   └── DecoderWorker.js            # Worker script for binary node decoding
│   │
│   └── view/
│       ├── ui-controller.js            # Sidebar control bindings & drag-and-drop
│       ├── measurements.js             # Point-to-point distance measurement tool
│       ├── minimap.js                  # Top-down minimap with frustum indicator
│       ├── gizmo.js                    # XYZ orientation gizmo overlay
│       ├── fps-controls.js             # First-person camera input handler
│       └── vr-mode.js                  # WebXR immersive VR session manager
│
├── server/
│   ├── server.js                       # Express + PeerJS signaling server
│   ├── stream-host.html                # Lightweight streaming host page
│   ├── stream-client.html              # Mobile-optimized streaming client
│   ├── STREAMING_PEERJS.md             # WebRTC streaming documentation
│   ├── package.json
│   └── .gitignore
│
└── tools/
    ├── serve-datasets.js               # Zero-dependency dataset HTTP server
    ├── laz-perf/
    │   ├── laz-perf.js                 # laz-perf JavaScript bindings
    │   └── laz-perf.wasm               # laz-perf WebAssembly binary
    └── las2potree/
        ├── package.json
        └── src/
            ├── index.js                # CLI entry point
            ├── las-reader.js           # LAS header & point record reader
            ├── octree-builder.js       # In-memory octree construction
            ├── octree-builder-streaming.js  # Streaming octree for massive datasets
            └── binary-writer.js        # Potree binary format writer
```

---

## Technologies

| Technology | Role |
|---|---|
| [Three.js](https://threejs.org/) v0.160.0 | 3D math, overlay scene, VR camera rig |
| **WebGL2** | Low-level GPU rendering, custom shader pipeline |
| **GLSL ES 3.0** | Custom deferred shading, lighting, and color-mapping shaders |
| [PeerJS](https://peerjs.com/) v1.5.4 | WebRTC peer-to-peer streaming & signaling |
| [laz-perf](https://github.com/hobu/laz-perf) | LAZ decompression via WebAssembly |
| **Node.js** | CLI tools (las2potree, serve-datasets) and streaming server |
| **Express** | HTTP server with static file serving and PeerJS integration |
| **Web Workers** | Off-main-thread octree construction and node decoding |
| **WebXR** | Immersive VR headset support |

---

## Browser Compatibility

Nuvola requires a browser with **WebGL2** support:

| Browser | Desktop | Mobile |
|---|---|---|
| Chrome | 56+ | 56+ |
| Firefox | 51+ | 51+ |
| Safari | 15+ | 15+ |
| Edge | 79+ | 79+ |

VR mode additionally requires **WebXR** support (Chrome 79+, Edge 79+, Oculus Browser).

Large LAZ files (>500 MB compressed) require sufficient memory for in-browser decompression. Consider converting to Potree format for datasets exceeding this limit.

---

## License

*[License placeholder — insert appropriate license text here]*

---

## Acknowledgments

Nuvola builds on concepts from the [Potree](https://github.com/potree/potree) and [PotreeConverter](https://github.com/potree/PotreeConverter) projects for streaming octree rendering. 3D math primitives are provided by [Three.js](https://threejs.org/). LAZ decompression uses the [laz-perf](https://github.com/hobu/laz-perf) library compiled to WebAssembly.
