export class OPFSManager {
  constructor(fileKey) {
    this.fileKey = fileKey;
    this._root = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function';
  }

  async _ensureRoot() {
    if (!this._root) this._root = await navigator.storage.getDirectory();
    return this._root;
  }

  async writeTile(tileKey, data) {
    const root = await this._ensureRoot();
    const fileDir = await root.getDirectoryHandle('nuvola_' + this.fileKey, { create: true });
    const fh = await fileDir.getFileHandle(tileKey + '.bin', { create: true });
    const ws = await fh.createWritable();
    await ws.write(data);
    await ws.close();
  }

  async readTile(tileKey) {
    const root = await this._ensureRoot();
    const fileDir = await root.getDirectoryHandle('nuvola_' + this.fileKey);
    const fh = await fileDir.getFileHandle(tileKey + '.bin');
    const file = await fh.getFile();
    return file.arrayBuffer();
  }

  async deleteAll() {
    const root = await this._ensureRoot();
    try {
      await root.removeEntry('nuvola_' + this.fileKey, { recursive: true });
    } catch (e) {
      // ignore if not exists
    }
  }
}
