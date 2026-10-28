import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';
import { startSnapshotNativeProcess } from '../src/snapshot-native-process.js';
import { auditSnapshotCheckpoint } from '../src/snapshot-checkpoint-audit.js';
import { nativeFixture } from './helpers/native-checkpoint-fixture.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), statfs: vi.fn() }));
vi.mock('../src/snapshot-native-process.js', () => ({ startSnapshotNativeProcess: vi.fn() }));
vi.mock('../src/snapshot-checkpoint-audit.js', () => ({ auditSnapshotCheckpoint: vi.fn() }));
const closeStore = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@origintrail-official/dkg-storage', () => ({ BlazegraphStore: class { async close() { await closeStore(); } } }));
const processes: { stop: ReturnType<typeof vi.fn>; assertRunning: ReturnType<typeof vi.fn>; closed: Promise<number> }[] = [];
beforeEach(() => {
  vi.clearAllMocks(); processes.length = 0;
  // Simulated capacity for byte-sized orchestration fixtures; production gate is exercised below.
  vi.mocked(statfs).mockResolvedValue({ bavail: 20 * 2 ** 30, bsize: 1 } as never);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  vi.mocked(auditSnapshotCheckpoint).mockResolvedValue({ assets: 1, publicQuads: 1, fullReadback: true });
  vi.mocked(startSnapshotNativeProcess).mockImplementation(async (_java, args, cwd) => {
    if (args[0]?.endsWith('loader.args')) {
      const text = await readFile(join(cwd, 'loader.args'), 'utf8');
      expect(text.split('\n').slice(0, 2)).toEqual(['"-Xms256m"', '"-Xmx3g"']);
      expect(text).toContain('com.bigdata.rdf.store.DataLoader');
      expect(text).toContain('000000.verified.nq.gz');
      expect(text).toContain('000000.verified.meta.nq');
      expect(text).toContain('trust.nq');
      expect(text.split('\n')).not.toContain(JSON.stringify(join(cwd, 'input')));
      // Unlisted files in the private input directory cannot become loader inputs.
      await writeFile(join(cwd, 'input/._000000.verified.meta.nq'), Buffer.from([0, 5, 16]));
      expect(text).not.toContain('._000000');
      await writeFile(join(cwd, 'store.jnl'), 'journal');
    }
    const process = { stop: vi.fn(async () => {}), assertRunning: vi.fn(), closed: Promise.resolve(0) };
    processes.push(process); return process;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('native checkpoint build lifecycle', () => {
  it('seals only after full readback, physical store closure and a second authority check', async () => {
    const f = await nativeFixture();
    const authority = vi.fn(async () => {
      if (processes.length) {
        expect(await readdir(join(f.prepared.directory, 'native'))).not.toContain('READY.json');
        expect(processes[1]!.stop).toHaveBeenCalledOnce();
      }
    });
    const result = await buildNativeSnapshotCheckpoint(f.prepared, { ...f.runtime, signal: f.signal, assertInventoryCurrent: authority });
    const folder = join(f.prepared.directory, 'native');
    expect(result).toMatchObject({ fullReadback: true, assets: 1, current: false, activeStoreChanged: false });
    expect(JSON.parse(await readFile(join(folder, 'READY.json'), 'utf8'))).toEqual(result);
    expect(await readFile(join(folder, 'input/000000.verified.nq.gz'), 'utf8')).toBe('data');
    expect(await readFile(join(folder, 'audit.properties'), 'utf8')).toContain('readOnly=true');
    expect(authority).toHaveBeenCalledTimes(2);
    expect(auditSnapshotCheckpoint).toHaveBeenCalledWith(expect.anything(), f.prepared.manifest, expect.any(AbortSignal));
    expect(processes.every(p => p.stop.mock.calls.length === 1)).toBe(true);
    expect(closeStore).toHaveBeenCalledOnce();
  });
  it.each(['input', 'audit', 'journal', 'authority'] as const)('keeps a failed %s unpublished and closes owned resources', async failure => {
    const f = await nativeFixture();
    if (failure === 'input') await writeFile(join(f.prepared.directory, 'load/000000.verified.nq.gz'), 'tampered');
    if (failure === 'audit') vi.mocked(auditSnapshotCheckpoint).mockRejectedValue(new Error('invalid root'));
    if (failure === 'journal') vi.mocked(auditSnapshotCheckpoint).mockImplementation(async () => {
      await writeFile(join(f.prepared.directory, 'native/store.jnl'), 'changed during readback');
      return { assets: 1, publicQuads: 1, fullReadback: true };
    });
    const authority = vi.fn(async () => {});
    if (failure === 'authority') authority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('inventory changed'));
    await expect(buildNativeSnapshotCheckpoint(f.prepared, { ...f.runtime, signal: f.signal, assertInventoryCurrent: authority })).rejects.toThrow();
    expect(await readdir(join(f.prepared.directory, 'native'))).not.toContain('READY.json');
    expect(processes.every(p => p.stop.mock.calls.length > 0)).toBe(true);
    if (failure === 'input') expect(startSnapshotNativeProcess).not.toHaveBeenCalled();
  });
  it.each([7 * 2 ** 30, 7 * 2 ** 30 + 200])('refuses insufficient disk space (%s bytes) before spawning or loading', async free => {
    const f = await nativeFixture();
    vi.mocked(statfs).mockResolvedValue({ bavail: free, bsize: 1 } as never);
    await expect(buildNativeSnapshotCheckpoint(f.prepared, { ...f.runtime, signal: f.signal, assertInventoryCurrent: async () => {} })).rejects.toThrow(/space|reserve/);
    expect(startSnapshotNativeProcess).not.toHaveBeenCalled();
    expect(await readdir(f.prepared.directory)).toEqual(['load']);
  });
});
