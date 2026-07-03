/**
 * Tiled LAS loader with IndexedDB caching and view-dependent loading.
 *
 * Divides large LAS files (>2GB) into spatial grid chunks, stores parsed
 * results in IndexedDB for persistence across sessions, and loads only
 * the chunks visible in the current viewport. Implements LRU cache
 * eviction and supports LOD (Level of Detail) for multi-resolution
 * rendering.
 *
 * @module las-tiling-loader
 */

/*
===============================================================================
File: las-tiling-loader.js

Sistema di tiling per file LAS grandi (>2GB). Divide il file in chunk più
piccoli gestibili e li carica on-demand in base alla vista.

Funzionalità:
- Divide il file LAS in chunk spaziali (grid 2D o 3D)
- Salva i chunk in IndexedDB per persistenza
- Carica solo i chunk visibili nella viewport corrente
- Implementa caching LRU per ottimizzare le prestazioni
- Supporta LOD (Level of Detail) per chunk a diverse risoluzioni

===============================================================================
*/

import { LASLoader } from './las-loader.js';

const CHUNK_SIZE_MB = 100; // Dimensione target per chunk
const MAX_CACHED_CHUNKS = 10; // Numero massimo di chunk in cache
const DB_NAME = 'NuvolaTilingDB';
const DB_VERSION = 1;

/**
 * IndexedDB-backed storage for tiled LAS chunks.
 *
 * Provides persistent storage of pre-parsed chunk data so that expensive
 * parsing does not need to be repeated across page loads. Chunks are
 * keyed by a composite ID (file hash + grid coordinates) and support
 * LRU-based eviction via a lastAccess timestamp.
 */
class ChunkDatabase {
  /**
   * Creates the database wrapper. Initialization is deferred to {@link ChunkDatabase#init}.
   */
  constructor() {
    this.db = null;
  }

  /**
   * Opens (or creates) the IndexedDB database and ensures the 'chunks'
   * object store and its indexes exist.
   *
   * @returns {Promise<void>} Resolves when the database is ready.
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('chunks')) {
          const store = db.createObjectStore('chunks', { keyPath: 'id' });
          store.createIndex('fileHash', 'fileHash', { unique: false });
          store.createIndex('lastAccess', 'lastAccess', { unique: false });
        }
      };
    });
  }

  /**
   * Persists a chunk object into IndexedDB. Updates the lastAccess
   * timestamp before writing.
   *
   * @param {object} chunk - The chunk data object to save.
   * @returns {Promise<void>} Resolves when the write completes.
   */
  async saveChunk(chunk) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const store = transaction.objectStore('chunks');
      chunk.lastAccess = Date.now();
      const request = store.put(chunk);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Retrieves a chunk by its composite ID. If found, updates its
   * lastAccess timestamp to reflect usage.
   *
   * @param {string} chunkId - The chunk identifier.
   * @returns {Promise<object|undefined>} The chunk data, or undefined if not found.
   */
  async getChunk(chunkId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readonly');
      const store = transaction.objectStore('chunks');
      const request = store.get(chunkId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (request.result) {
          request.result.lastAccess = Date.now();
          // Aggiorna lastAccess
          const updateTx = this.db.transaction(['chunks'], 'readwrite');
          const updateStore = updateTx.objectStore('chunks');
          updateStore.put(request.result);
        }
        resolve(request.result);
      };
    });
  }

  /**
   * Evicts the oldest chunks from IndexedDB when the total count exceeds
   * the specified limit. Sorts by lastAccess (ascending) and deletes the
   * least recently used entries.
   *
   * @param {number} maxChunks - Maximum number of chunks to retain.
   * @returns {Promise<number>} Number of chunks deleted.
   */
  async cleanupOldChunks(maxChunks) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const store = transaction.objectStore('chunks');
      const index = store.index('lastAccess');
      const request = index.openCursor();
      
      const chunks = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          chunks.push({ key: cursor.key, lastAccess: cursor.value.lastAccess });
          cursor.continue();
        } else {
          // Ordina per lastAccess (più vecchio prima)
          chunks.sort((a, b) => a.lastAccess - b.lastAccess);
          
          // Elimina i chunk più vecchi se superano il limite
          const toDelete = chunks.slice(0, Math.max(0, chunks.length - maxChunks));
          const deleteTx = this.db.transaction(['chunks'], 'readwrite');
          const deleteStore = deleteTx.objectStore('chunks');
          
          toDelete.forEach(chunk => {
            deleteStore.delete(chunk.key);
          });
          
          deleteTx.oncomplete = () => resolve(toDelete.length);
          deleteTx.onerror = () => reject(deleteTx.error);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * Loader with spatial tiling for large LAS files.
 *
 * Splits a LAS file into a regular grid of chunks, reads the file header
 * to determine point count and record structure, and loads individual
 * chunks on demand. Chunks are cached in memory and optionally persisted
 * in IndexedDB.
 */
export class LASTilingLoader {
  /**
   * Creates the tiling loader, initializing the chunk database wrapper
   * and the underlying LASLoader.
   */
  constructor() {
    this.db = new ChunkDatabase();
    this.dbInitialized = false;
    this.currentFile = null;
    this.fileHash = null;
    this.header = null;
    this.gridSize = { x: 0, y: 0 };
    this.chunks = new Map(); // chunkId -> chunk metadata
    this.loadedChunks = new Map(); // chunkId -> loaded data
    this.lasLoader = new LASLoader();
  }

  /**
   * Computes a simple hash for the file to uniquely identify chunks
   * belonging to this file. Uses the first 1024 bytes and the file size.
   *
   * @param {File} file - The file to hash.
   * @returns {Promise<string>} A string hash identifier.
   * @private
   */
  async _computeFileHash(file) {
    const buffer = await file.slice(0, 1024).arrayBuffer();
    const view = new Uint8Array(buffer);
    let hash = 0;
    for (let i = 0; i < view.length; i++) {
      hash = ((hash << 5) - hash) + view[i];
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36) + '_' + file.size.toString(36);
  }

  /**
   * Initializes the database and loads file metadata (header parsing via
   * the LAS worker). Creates a grid of chunk metadata entries.
   *
   * @param {File} file - The LAS file to tile.
   * @param {Function} [onProgress] - Callback receiving a 0..1 progress value.
   * @returns {Promise<void>} Resolves when initialization is complete.
   */
  async init(file, onProgress) {
    if (!this.dbInitialized) {
      await this.db.init();
      this.dbInitialized = true;
    }

    this.currentFile = file;
    this.fileHash = await this._computeFileHash(file);

    // Leggi l'header del file
    const headerBlob = file.slice(0, 400);
    const headerBuf = await headerBlob.arrayBuffer();
    const worker = new Worker(this.lasLoader._workerUrl);
    
    const headerMsg = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.type === 'error') reject(new Error(e.data.error));
        else resolve(e.data);
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage({ type: 'parseHeader', buffer: headerBuf }, [headerBuf]);
    });

    this.header = headerMsg.header;
    console.log('[Tiling] File header:', this.header);

    // Calcola la griglia di chunk
    const bounds = {
      minX: this.header.offsetX,
      minY: this.header.offsetY,
      minZ: this.header.offsetZ,
      maxX: this.header.offsetX + (this.header.pointCount * this.header.pointRecordLength),
      maxY: this.header.offsetY + (this.header.pointCount * this.header.pointRecordLength),
      maxZ: this.header.offsetZ + (this.header.pointCount * this.header.pointRecordLength)
    };

    // Per ora usa una griglia semplice basata sul numero di punti
    // In futuro si può fare una partizione spaziale più intelligente
    const totalPoints = this.header.pointCount;
    const pointsPerChunk = Math.ceil(totalPoints / 100); // Target: 100 chunk
    const gridSize = Math.ceil(Math.sqrt(100)); // Griglia 10x10

    this.gridSize = { x: gridSize, y: gridSize };
    console.log('[Tiling] Grid size:', this.gridSize);

    // Crea i metadati dei chunk
    for (let gy = 0; gy < this.gridSize.y; gy++) {
      for (let gx = 0; gx < this.gridSize.x; gx++) {
        const chunkId = `${this.fileHash}_${gx}_${gy}`;
        this.chunks.set(chunkId, {
          id: chunkId,
          gridX: gx,
          gridY: gy,
          fileHash: this.fileHash,
          loaded: false,
          visible: false
        });
      }
    }

    if (onProgress) onProgress(1.0);
  }

  /**
   * Determines which chunks are visible in the current viewport.
   *
   * Currently returns all chunks; future implementations may use
   * frustum culling based on camera position and viewport dimensions.
   *
   * @param {object} camera - The camera object (unused, reserved for future culling).
   * @param {number} viewportWidth - Viewport width in pixels (unused).
   * @param {number} viewportHeight - Viewport height in pixels (unused).
   * @returns {string[]} Array of visible chunk IDs.
   */
  getVisibleChunks(camera, viewportWidth, viewportHeight) {
    // Per ora restituisce tutti i chunk
    // In futuro si può fare un frustum culling più preciso
    const visibleChunks = [];
    for (const [chunkId, chunk] of this.chunks) {
      visibleChunks.push(chunkId);
    }
    return visibleChunks;
  }

  /**
   * Reads and parses a single chunk of point data directly from the
   * original LAS file. Delegates point parsing to the LAS worker via
   * parseRawChunk.
   *
   * @param {string} chunkId - The chunk identifier.
   * @param {object} chunk - Chunk metadata (gridX, gridY, etc.).
   * @returns {Promise<object|null>} Parsed chunk data, or null if the
   *   chunk has no points.
   * @private
   */
  async _loadChunkFromFile(chunkId, chunk) {
    const { gridX, gridY } = chunk;
    
    // Calcola l'offset e il numero di punti per questo chunk
    const totalPoints = this.header.pointCount;
    const pointsPerChunk = Math.ceil(totalPoints / (this.gridSize.x * this.gridSize.y));
    const chunkIndex = gridY * this.gridSize.x + gridX;
    const startIdx = chunkIndex * pointsPerChunk;
    const numPoints = Math.min(pointsPerChunk, totalPoints - startIdx);

    if (numPoints <= 0) return null;

    const chunkStart = this.header.pointOffset + startIdx * this.header.pointRecordLength;
    const chunkEnd = Math.min(chunkStart + numPoints * this.header.pointRecordLength, this.currentFile.size);

    const chunkBlob = this.currentFile.slice(chunkStart, chunkEnd);
    const chunkBuf = await chunkBlob.arrayBuffer();

    // Usa il worker del LASLoader per parsare il chunk
    const worker = new Worker(this.lasLoader._workerUrl);
    
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.type === 'error') reject(new Error(e.data.error));
        else if (e.data.type === 'chunk') resolve(e.data);
        else reject(new Error('Unexpected response type'));
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      
      worker.postMessage({
        type: 'parseRawChunk',
        buffer: chunkBuf,
        header: this.header,
        numPoints: numPoints
      }, [chunkBuf]);
    });

    return {
      id: chunkId,
      fileHash: this.fileHash,
      gridX: gridX,
      gridY: gridY,
      positions: result.positions,
      colors: result.colors,
      intensity: result.intensity,
      count: result.numPoints,
      minI: result.minI,
      maxI: result.maxI,
      lastAccess: Date.now()
    };
  }

  /**
   * Loads a chunk, trying in-memory cache first, then IndexedDB, then
   * falling back to reading from the original file. When loaded from
   * file, the result is saved to both memory and IndexedDB.
   *
   * @param {string} chunkId - The chunk identifier.
   * @param {Function} [onProgress] - Optional progress callback.
   * @returns {Promise<object|null>} The loaded chunk data, or null if not found.
   */
  async loadChunk(chunkId, onProgress) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) throw new Error(`Chunk ${chunkId} not found`);

    // Controlla se è già in memoria
    if (this.loadedChunks.has(chunkId)) {
      const loaded = this.loadedChunks.get(chunkId);
      loaded.lastAccess = Date.now();
      return loaded;
    }

    // Controlla se è in IndexedDB
    try {
      const dbChunk = await this.db.getChunk(chunkId);
      if (dbChunk) {
        console.log('[Tiling] Loaded chunk from DB:', chunkId);
        this.loadedChunks.set(chunkId, dbChunk);
        await this.db.cleanupOldChunks(MAX_CACHED_CHUNKS);
        return dbChunk;
      }
    } catch (err) {
      console.warn('[Tiling] Failed to load from DB:', err);
    }

    // Carica dal file
    console.log('[Tiling] Loading chunk from file:', chunkId);
    const chunkData = await this._loadChunkFromFile(chunkId, chunk);
    
    if (chunkData) {
      // Salva in IndexedDB
      try {
        await this.db.saveChunk(chunkData);
        await this.db.cleanupOldChunks(MAX_CACHED_CHUNKS);
      } catch (err) {
        console.warn('[Tiling] Failed to save to DB:', err);
      }

      // Salva in memoria
      this.loadedChunks.set(chunkId, chunkData);
    }

    return chunkData;
  }

  /**
   * Loads all currently visible chunks, reporting progress as each chunk
   * completes.
   *
   * @param {string[]} visibleChunkIds - Array of chunk IDs to load.
   * @param {Function} [onProgress] - Callback receiving 0..1 progress.
   * @returns {Promise<void>} Resolves when all visible chunks are loaded.
   */
  async loadVisibleChunks(visibleChunkIds, onProgress) {
    const total = visibleChunkIds.length;
    let loaded = 0;

    for (const chunkId of visibleChunkIds) {
      await this.loadChunk(chunkId);
      loaded++;
      if (onProgress) onProgress(loaded / total);
    }
  }

  /**
   * Returns all currently loaded chunks as an array.
   *
   * @returns {object[]} Array of loaded chunk data objects.
   */
  getLoadedChunks() {
    return Array.from(this.loadedChunks.values());
  }

  /**
   * Resets the loader state, clearing file reference, metadata, and
   * all chunk caches. Does not delete IndexedDB entries.
   */
  dispose() {
    this.currentFile = null;
    this.fileHash = null;
    this.header = null;
    this.chunks.clear();
    this.loadedChunks.clear();
  }
}
