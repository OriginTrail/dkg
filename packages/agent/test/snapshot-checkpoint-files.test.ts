import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPinnedCheckpointFile, checkpointSha256, nativeCheckpointShaFile } from '../src/snapshot-checkpoint-files.js';
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const p of folders.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pinned-checkpoint-')); folders.push(dir);
  const file = join(dir, 'body'), bytes = Buffer.from('safe'); await fs.writeFile(file, bytes);
  return { dir, file, bytes, digest: checkpointSha256(bytes) };
}
it('reads exactly bounded bytes and uses the same digest for bounded and streaming reads', async () => {
  const f = await fixture();
  expect(await readPinnedCheckpointFile(f.file, f.digest, 4)).toEqual(f.bytes);
  expect(await nativeCheckpointShaFile(f.file)).toBe(f.digest);
});
it.each(['oversize', 'digest', 'symlink', 'directory'] as const)('refuses %s pinned input', async failure => {
  const f = await fixture();
  if (failure === 'symlink') await fs.symlink(f.file, join(f.dir, 'link'));
  const path = failure === 'symlink' ? join(f.dir, 'link') : failure === 'directory' ? f.dir : f.file;
  await expect(readPinnedCheckpointFile(path, failure === 'digest' ? '0'.repeat(64) : f.digest,
    failure === 'oversize' ? 3 : 4)).rejects.toThrow();
});
it.each([2, 5])('bounds a read and closes its descriptor if the file changes after stat (reported size %s)', async size => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handle = await actual.open(f.file, 'r'); const info = await handle.stat();
  vi.spyOn(handle, 'stat').mockResolvedValue({ ...info, size, isFile: () => true } as never);
  const read = vi.spyOn(handle, 'read'), close = vi.spyOn(handle, 'close');
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  await expect(readPinnedCheckpointFile(f.file, f.digest, 8)).rejects.toThrow('Unsafe checkpoint');
  expect(close).toHaveBeenCalledOnce();
  expect(read.mock.calls.every(args => (args[0] as Buffer).length === size + 1)).toBe(true);
});
