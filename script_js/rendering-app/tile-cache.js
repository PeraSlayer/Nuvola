export class TileCache {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.maxPoints = options.maxPoints || 50_000_000;
    this._cache = new Map();
    this._loadingTiles = new Set();
    this._opfs = null;
    this._totalPoints = 0;
    this._attrPos = options.attrPos != null ? options.attrPos : 0;
    this._attrCol = options.attrCol != null ? options.attrCol : 1;
    this._attrInt = options.attrInt != null ? options.attrInt : 2;
    this._hasIntensity = true;
    this._onTileLoaded = null;
    this._loadDebounceTimer = null;
  }

  setOPFSManager(opfs) {
    this._opfs = opfs;
  }

  setHasIntensity(v) {
    this._hasIntensity = v;
  }

  setOnTileLoaded(fn) {
    this._onTileLoaded = fn;
  }

  has(key) {
    return this._cache.has(key);
  }

  isLoading(key) {
    return this._loadingTiles.has(key);
  }

  get(key) {
    return this._cache.get(key) || null;
  }

  async loadTileAsync(key, tile) {
    if (this._cache.has(key) || this._loadingTiles.has(key) || !this._opfs) return;
    this._loadingTiles.add(key);

    try {
      const data = await this._opfs.readTile(key);
      const dv = new DataView(data);
      const count = dv.getUint32(0, true);
      if (!count) return;

      this._evictIfNeeded(count);

      const gl = this.gl;
      const posOff = 4;
      const colOff = posOff + count * 12;
      const intOff = colOff + count * 3;

      const vboPos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data, posOff, count * 3), gl.STATIC_DRAW);

      const vboCol = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(data, colOff, count * 3), gl.STATIC_DRAW);

      let vboInt = null;
      if (this._hasIntensity) {
        vboInt = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboInt);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data, intOff, count), gl.STATIC_DRAW);
      }

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
      gl.enableVertexAttribArray(this._attrPos);
      gl.vertexAttribPointer(this._attrPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, vboCol);
      gl.enableVertexAttribArray(this._attrCol);
      gl.vertexAttribPointer(this._attrCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

      if (vboInt) {
        gl.bindBuffer(gl.ARRAY_BUFFER, vboInt);
        gl.enableVertexAttribArray(this._attrInt);
        gl.vertexAttribPointer(this._attrInt, 1, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(this._attrInt);
        gl.vertexAttrib1f(this._attrInt, 0.5);
      }

      gl.bindVertexArray(null);

      const entry = { vao, vboPos, vboCol, vboInt, count, lastUsed: performance.now() };
      this._cache.set(key, entry);
      this._totalPoints += count;

      this._debounceNotify();
    } finally {
      this._loadingTiles.delete(key);
    }
  }

  _debounceNotify() {
    if (this._loadDebounceTimer) return;
    this._loadDebounceTimer = setTimeout(() => {
      this._loadDebounceTimer = null;
      if (this._onTileLoaded) this._onTileLoaded();
    }, 50);
  }

  _evictIfNeeded(newCount) {
    const gl = this.gl;
    while (this._totalPoints + newCount > this.maxPoints && this._cache.size > 0) {
      let lruKey = null;
      let lruTime = Infinity;
      for (const [key, entry] of this._cache) {
        if (entry.lastUsed < lruTime) { lruKey = key; lruTime = entry.lastUsed; }
      }
      if (!lruKey) break;
      this._removeTile(lruKey);
    }
  }

  _removeTile(key) {
    const entry = this._cache.get(key);
    if (!entry) return;
    const gl = this.gl;
    gl.deleteVertexArray(entry.vao);
    gl.deleteBuffer(entry.vboPos);
    gl.deleteBuffer(entry.vboCol);
    if (entry.vboInt) gl.deleteBuffer(entry.vboInt);
    this._totalPoints -= entry.count;
    this._cache.delete(key);
  }

  touch(key) {
    const entry = this._cache.get(key);
    if (entry) entry.lastUsed = performance.now();
  }

  dispose() {
    if (this._loadDebounceTimer) {
      clearTimeout(this._loadDebounceTimer);
      this._loadDebounceTimer = null;
    }
    this._loadingTiles.clear();
    for (const key of [...this._cache.keys()]) this._removeTile(key);
    this._cache.clear();
    this._totalPoints = 0;
  }
}
