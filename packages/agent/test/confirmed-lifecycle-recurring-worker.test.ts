import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';
const dirs: string[] = [], stores: OxigraphStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('confirmed lifecycle recurring worker ownership', () => {
  it('refuses restart and new submissions until a held direct write physically retires, then permits a fresh worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-retirement-')); dirs.push(dir);
    const path = join(dir, 'store.nq'), store = new OxigraphStore(path); stores.push(store);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const { input } = confirmedLifecycleRecoveryFixture();
    const apply = vi.fn(async (current: typeof input) => {
      if (current.name === input.name) { entered(); await held; }
      await store.insert([{ graph: 'urn:worker', subject: `urn:${current.name}`, predicate: 'urn:value', object: '"committed"' }]);
      await store.commitment!.commit();
    });
    const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), warn: vi.fn(), apply, isCurrent: async () => true }); owners.push(owner);
    owner.start(); const submission = owner.submit(input); await started;
    let drained = false; const stop = owner.stop().then(() => { drained = true; }); owner.start();
    try {
      await expect(owner.submit({ ...input, name: 'after-stop' })).rejects.toThrow('stopped');
      await new Promise(resolve => setTimeout(resolve, 20)); expect(drained).toBe(false); expect(apply).toHaveBeenCalledOnce();
      const journal = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
      expect(journal.entries).toHaveLength(1);
    } finally { release(); await submission; await stop; }
    const reopened = new OxigraphStore(path); stores.push(reopened);
    expect(await reopened.query(`ASK { GRAPH <urn:worker> { <urn:${input.name}> <urn:value> "committed" } }`)).toMatchObject({ value: true });
    owner.start(); expect(await owner.submit({ ...input, name: 'after-retirement' })).toBe('repaired');
    expect(apply).toHaveBeenCalledTimes(2); await owner.stop();
  });
  it('owns delayed periodic errors and cancels future deadlines before restart', async () => {
    vi.useFakeTimers(); const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-error-')); dirs.push(dir);
    const journal = join(dir, 'named-ka-vm-lifecycle-repairs.json'); await writeFile(journal, '{broken');
    const warn = vi.fn(), owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), warn, apply: async () => {}, isCurrent: async () => true }); owners.push(owner);
    owner.start(); await vi.advanceTimersByTimeAsync(4999); expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    await owner.stop(); await vi.advanceTimersByTimeAsync(20_000); expect(warn).toHaveBeenCalledOnce();
    await writeFile(journal, JSON.stringify({ version: 2, entries: [] })); owner.start();
    await vi.advanceTimersByTimeAsync(5000); await owner.stop(); expect(warn).toHaveBeenCalledOnce();
  });
});
