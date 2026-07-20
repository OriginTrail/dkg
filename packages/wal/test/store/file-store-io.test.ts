import { expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = String(args[0]);
      if (path.includes('/virtual/lstat-root/') && path.endsWith('.wal')) {
        const error = new Error('simulated lookup failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      if (path.includes('/virtual/special-root/') && path.endsWith('.wal')) {
        return {
          isSymbolicLink: () => false,
          isFile: () => false,
          isDirectory: () => false,
        };
      }
      return original.lstat(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      if (String(args[0]).includes('/virtual/open-root/')) {
        const error = new Error('simulated open failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return original.open(...args);
    },
  };
});

import { walObjectId } from '../../src/reconciliation/ids.js';
import { FileWalObjectStore } from '../../src/store/file-store.js';

const id = walObjectId(new Uint8Array(32));

it('propagates unexpected lstat failures from validated object paths', async () => {
  const store = new FileWalObjectStore({ root: '/virtual/lstat-root' });
  await expect(store.has(id)).rejects.toThrow('simulated lookup failure');
});

it('classifies unexpected open failures with the stable store IO code', async () => {
  const store = new FileWalObjectStore({ root: '/virtual/open-root' });
  await expect(async () => {
    for await (const _chunk of store.read(id)) void _chunk;
  }).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
});

it('classifies unsupported filesystem entry kinds as unsafe', async () => {
  const store = new FileWalObjectStore({ root: '/virtual/special-root' });
  await expect(store.has(id)).rejects.toMatchObject({ code: 'WAL_STORE_PATH_UNSAFE' });
});
