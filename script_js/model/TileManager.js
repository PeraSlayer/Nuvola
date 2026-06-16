export class TileManager {
  constructor(options = {}) {
    this.tileSize = options.tileSize || 4096;
    this.gridSize = options.gridSize || 16;
    this.tiles = [];
    this.tileMap = new Map();
  }

  getTile(tileId) {
    return this.tileMap.get(tileId);
  }

  addTile(tile) {
    tile.id = tile.tx + '_' + tile.ty;
    tile.loaded = false;
    tile.gpuVao = null;
    this.tiles.push(tile);
    this.tileMap.set(tile.id, tile);
  }

  registerTileMetadata(tiles) {
    this.tiles = [];
    this.tileMap.clear();
    for (const t of tiles) {
      t.id = t.tx + '_' + t.ty;
      t.loaded = false;
      t.gpuVao = null;
      this.tiles.push(t);
      this.tileMap.set(t.id, t);
    }
  }

  dispose() {
    this.tiles = [];
    this.tileMap.clear();
  }
}
