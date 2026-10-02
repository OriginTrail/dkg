import type { UpdateHoldoffFs } from '../../src/daemon/auto-update-holdoff-store.js';

export function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

/** In-memory fs seam for the file-backed hold-off store. It outlives any single
 *  gate, like the DKG home outlives a daemon process. */
export function memoryFs() {
  const files = new Map<string, string>();
  const fs: UpdateHoldoffFs = {
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw enoent(path);
      return data;
    },
    writeFile: async (path, data) => { files.set(path, data); },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, data);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw enoent(path);
    },
  };
  return { files, fs };
}
