import { expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const path = String(args[0]);
      if (path === '/virtual/error.wal' || path === '/virtual/string-error.wal') {
        return {
          stat: async () => {
            if (path === '/virtual/error.wal') throw new Error('simulated read failure');
            throw 'simulated string failure';
          },
          close: async () => undefined,
        };
      }
      return original.open(...args);
    },
  };
});

import { verifyWalObjectFile } from '../../src/store/streaming-verifier.js';

it.each(['/virtual/error.wal', '/virtual/string-error.wal'])(
  'classifies unexpected streaming filesystem failures at %s as stable IO errors',
  async (path) => {
    await expect(verifyWalObjectFile(path, new Uint8Array(32), {
      maximumObjectBytes: 1_024n,
      readBufferBytes: 32,
    })).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
  },
);
