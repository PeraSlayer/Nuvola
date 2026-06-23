# Nuvola → Potree Integration Plan

## Dependency

Add **Three.js** via CDN importmap in `index.html`:
```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"
  }
}
</script>
```

## Phase Summary

| # | Phase | New Files | Key Change | Complexity |
|---|-------|-----------|------------|------------|
| 1 | Potree Format Support | 7 | Parse metadata.json + hierarchy.bin + octree.bin | Medium |
| 2 | Priority Queue + LOD | 2 | Potree's greedy LOD selection replaces stride | High |
| 3 | Streaming Loader + Cache | 2 | On-demand Range requests replace eager load | High |
| 4 | GPU Rendering | 0 (modify renderer/shader) | Per-node VAOs, point size modes, classification | High |
| 5 | Camera System | 4 | FPS perspective + isometric dual camera | Medium |
| 6 | Visibility Texture | 0 (modify shader) | Adaptive point size via texture-walk LOD | Medium |
| 7 | Cache + Memory | 0 (refine LRU) | GPU memory tracking, prefetch | Low |
| 8 | Picking | 2 | Offscreen render + readback replaces 2D grid | Medium |
| 9 | Eye-Dome Lighting | 2 | EDL post-processing pass | Medium |
| 10 | Optimizations | 0 (refine) | VBO pool, indirect draw, visibility cache | Low |

## File count (new + modified)

- **`script_js/potree/`** — ~12 new files
- **`script_js/rendering-app/`** — 2 new files (edl-shader.js, BufferPool.js), 2 modified
- **`script_js/model/`** — 3 modified
- **`script_js/view/`** — 2 new (fps-camera.js, fps-controls.js), 1 modified
- **`script_js/main/`** — 1 modified
- **`index.html`** — 1 modified

## Execution order

Phases 1→2→3 are strictly sequential. Phases 4–9 can partially overlap with 3 once the streaming foundation is in place:

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6
                                          │            │
                                          └──→ Phase 8 ─┘
                                          │
                                          └──→ Phase 9
                                                    │
                                                    └──→ Phase 10
                                          Phase 7 (refines Phase 3)
```

## Key architectural constraints

- **Nuvola's WebGL2 renderer is preserved.** Potree modules produce data that feeds into Nuvola's existing draw pipeline via per-node VAOs.
- **Streaming is built from Phase 1.** No interim "load all to memory" step — even Phase 1 supports eager full-load as fallback, but the architecture is streaming-ready.
- **Three.js is used for math/camera/scene types only** — not for rendering. Three.js replaces manual Vector3/Box3/Matrix4/Frustum implementations.
- **Potree format v2.0 only** — metadata.json + hierarchy.bin + octree.bin. No cloud.js/.bin legacy support.
- **All new JS is ES modules** — no bundler, no build step.

## Dependencies between microtasks

Each phase file lists per-microtask dependencies. Key dependency graph:

```
1.1 (Three.js importmap)
 ├─ 1.5 (PotreeOctree.js)
 ├─ 2.2 (VisibilitySystem.js)
 ├─ 5.1 (fps-camera.js)
 └─ all other Three.js consumers

1.4 (DecoderWorker) ← 1.6 (NodeLoader) ← 1.7 (PotreeLoader)
1.2 (PriorityQueue) ← 2.2 (VisibilitySystem)
3.1 (LRUCache) ← 3.2 (NodeLoader streaming) ← 3.3 (Visibility streaming)
```

## Verification dataset

Test with publicly available Potree datasets:
- `https://potree.org/pointclouds/riegl/` (metadata.json at this URL)
- `https://s3.amazonaws.com/potree/demo/pointclouds/V_Lion_tile/` (smaller dataset)
