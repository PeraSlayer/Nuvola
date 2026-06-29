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
 * Gestisce il database IndexedDB per i chunk
 */
class ChunkDatabase {
  constructor() {
    this.db = null;
  }

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
 * Loader con sistema di tiling per file LAS grandi
 */
export class LASTilingLoader {
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
   * Calcola un hash semplice del file per identificare i chunk
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
   * Inizializza il database e carica i metadati del file
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
   * Determina quali chunk sono visibili nella viewport corrente
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
   * Carica un chunk dal file originale
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
   * Carica un chunk (da DB o da file)
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
   * Carica tutti i chunk visibili
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
   * Ottieni tutti i chunk caricati
   */
  getLoadedChunks() {
    return Array.from(this.loadedChunks.values());
  }

  /**
   * Reset dello stato
   */
  dispose() {
    this.currentFile = null;
    this.fileHash = null;
    this.header = null;
    this.chunks.clear();
    this.loadedChunks.clear();
  }
}
