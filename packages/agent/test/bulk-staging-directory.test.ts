import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveBulkStagingDirectory } from '../src/sync/requester/bulk-staging-directory.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))); });
it('bounds concurrent and retained failed chunks without removing active or failed evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bulk-staging-quota-')); roots.push(root);
  const results = await Promise.allSettled(Array.from({length: 32}, () => reserveBulkStagingDirectory(root)));
  const directories = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  expect(directories).toHaveLength(8);
  for (const directory of directories) await writeFile(join(directory, '0.part'), 'retained payload');
  for (let failure = 0; failure < 20; failure++)
    await expect(reserveBulkStagingDirectory(root)).rejects.toMatchObject({code:'RESOURCE_LIMIT'});
  expect(await readdir(root)).toHaveLength(8);
  for (const directory of directories) expect(await readFile(join(directory, '0.part'), 'utf8')).toBe('retained payload');
  // Only the successful chunk owner releases its own slot; failed owners stay reserved.
  await rm(directories[0]!, {recursive:true});
  expect(await reserveBulkStagingDirectory(root)).toBe(directories[0]);
});
it('charges historical failed directories before admitting new chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bulk-staging-legacy-')); roots.push(root);
  for (let i=0;i<7;i++) await mkdir(join(root, `chunk-old-${i}`));
  await reserveBulkStagingDirectory(root);
  await expect(reserveBulkStagingDirectory(root)).rejects.toThrow('retention capacity');
  expect(await readdir(root)).toHaveLength(8);
});
it.each([
  { legacy: 7, retained: [7], expectedNew: 0 },
  { legacy: 4, retained: [3, 4], expectedNew: 2 },
  { legacy: 2, retained: [5, 6, 7], expectedNew: 3 },
])('charges mixed legacy and high numbered reservations: $legacy/$retained', async ({ legacy, retained, expectedNew }) => {
  const root = await mkdtemp(join(tmpdir(), 'bulk-staging-mixed-')); roots.push(root);
  for (let i = 0; i < legacy; i++) await mkdir(join(root, `chunk-old-${i}`));
  for (const slot of retained) {
    const dir = join(root, `chunk-slot-${slot}`);
    await mkdir(dir); await writeFile(join(dir, 'diagnostic.txt'), 'retained evidence');
  }
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => reserveBulkStagingDirectory(root)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(expectedNew);
  for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'RESOURCE_LIMIT' });
  expect(await readdir(root)).toHaveLength(8);
  for (const slot of retained) expect(await readFile(join(root, `chunk-slot-${slot}`, 'diagnostic.txt'), 'utf8')).toBe('retained evidence');
});
