import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore } from '../src/adapters/oxigraph.js';

const io = vi.hoisted(() => ({ directory: '', snapshot: '', fileError: false, directoryError: false, calls: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]), mode = args[1];
    io.calls.push(`${path}:${mode}`);
    // Model the Windows API refusal; all snapshot writes/rename/reopen stay real.
    if (process.platform === 'win32' && path === io.directory && mode === 'r') {
      throw Object.assign(new Error('read-only Windows directory handle'), { code: 'EACCES' });
    }
    const handle = await fs.open(...args);
    if ((path === io.snapshot && io.fileError) || (path === io.directory && io.directoryError)) {
      handle.sync = async () => { throw Object.assign(new Error('injected persistence EIO'), { code: 'EIO' }); };
    }
    return handle;
  } };
});
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform);
  io.fileError = false; io.directoryError = false; io.calls = [];
  if (io.directory) await rm(io.directory, { recursive: true, force: true });
  io.directory = ''; io.snapshot = '';
});
async function fixture(platform: NodeJS.Platform) {
  io.directory = await mkdtemp(join(tmpdir(), 'dkg-platform-snapshot-'));
  io.snapshot = join(io.directory, 'store.nq');
  // Oxigraph's native engine was loaded before changing the JS platform policy.
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  const store = new OxigraphStore(io.snapshot);
  await store.insert([{ subject: 'urn:platform:s', predicate: 'urn:platform:p', object: '"persisted"', graph: 'urn:platform:g' }]);
  return store;
}
it.each(['flush', 'close', 'commit'] as const)('Windows %s flushes the renamed file with write access and reopens without a directory handle', async method => {
  const store = await fixture('win32');
  try {
    await (method === 'commit' ? store.commitment.commit() : store[method]());
    expect(io.calls).toContain(`${io.snapshot}.tmp:w`);
    expect(io.calls).toContain(`${io.snapshot}:r+`);
    expect(io.calls).not.toContain(`${io.directory}:r`);
    const reopened = new OxigraphStore(io.snapshot);
    try { expect(await reopened.countQuads()).toBe(1); } finally { await reopened.close(); }
  } finally { await store.close(); }
});
it('Windows writable-file sync errors reject certified commitment and can be retried', async () => {
  const store = await fixture('win32');
  try {
    io.fileError = true;
    await expect(store.commitment.commit()).rejects.toMatchObject({ code: 'EIO' });
    io.fileError = false;
    await store.commitment.commit();
    const reopened = new OxigraphStore(io.snapshot);
    try { expect(await reopened.countQuads()).toBe(1); } finally { await reopened.close(); }
  } finally { io.fileError = false; await store.close(); }
});
it('POSIX directory sync errors still reject certified commitment and can be retried', async () => {
  const store = await fixture('linux');
  try {
    io.directoryError = true;
    await expect(store.commitment.commit()).rejects.toMatchObject({ code: 'EIO' });
    io.directoryError = false;
    await store.commitment.commit();
    expect(io.calls).toContain(`${io.directory}:r`);
  } finally { io.directoryError = false; await store.close(); }
});
