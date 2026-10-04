import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { assertionLifecycleWriteLockKey, withKeyedLocks, WM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair, type ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
import { decodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { applyPublishedNamedKaVmLifecycle, applyTentativeNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
const fields = { contextGraphId: 'command-contract', agentAddress: '0x1111111111111111111111111111111111111111', name: 'asset',
  publishedUal: 'did:dkg:mock/1', merkleRoot: 'ab'.repeat(32), assertionVersion: '1' };
const dirs: string[] = [], stores: OxigraphStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('confirmed lifecycle command contract', () => {
  it('refuses an owner without an explicit shared lock domain', () => {
    expect(() => new NamedKaVmLifecycleRepair({ apply: async () => {}, isCurrent: async () => true, warn: () => {} } as unknown as ConstructorParameters<typeof NamedKaVmLifecycleRepair>[0]))
      .toThrowError(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_LOCKS_REQUIRED' }));
  });
  it.each([true, false])('refuses a supplied tentative flag rather than stripping it, flag=%s', tentative => {
    expect(() => normalizeLifecycleRepairInput({ ...fields, tentative }, true)).toThrowError(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }));
    const valid = normalizeLifecycleRepairInput(fields, true);
    expect(() => decodeLifecycleRepairJournal({ version: 2, entries: [[lifecycleRepairKey(valid), {
      input: { ...valid, tentative }, attempts: 0, nextAttemptAt: 0,
    }]] })).toThrowError(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }));
  });
  it('rejects a confirmed projection carrying tentative mode before any graph read or write', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const read = vi.spyOn(store, 'query'), write = vi.spyOn(store, 'atomicUpdate');
    await expect(applyPublishedNamedKaVmLifecycle(store, { ...fields, tentative: true } as unknown as Parameters<typeof applyPublishedNamedKaVmLifecycle>[1]))
      .rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('refuses an unmarked tentative entry-point call before graph I/O', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const read = vi.spyOn(store, 'query');
    await expect(applyTentativeNamedKaVmLifecycle(store, fields as unknown as Parameters<typeof applyTentativeNamedKaVmLifecycle>[1]))
      .rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    expect(read).not.toHaveBeenCalled();
  });
  it('consumes the sealed prior WM pointer through the tentative entry point without certifying memory persistence', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const graph = contextGraphMetaUri(fields.contextGraphId), lifecycle = assertionLifecycleUri(fields.contextGraphId, fields.agentAddress, fields.name);
    const prior = 'cd'.repeat(32);
    await store.insert([{ graph, subject: lifecycle, predicate: WM_CURRENT_ASSERTION_PRED, object: JSON.stringify(prior) }]);
    await applyTentativeNamedKaVmLifecycle(store, { ...fields, tentative: true, priorMerkleRoot: prior });
    expect(await store.query(`ASK { GRAPH <${graph}> { <${lifecycle}> <${WM_CURRENT_ASSERTION_PRED}> ?root } }`)).toMatchObject({ value: false });
    expect(await store.query(`ASK { GRAPH <${graph}> { <${lifecycle}> <http://dkg.io/ontology/vmCurrentAssertion> "${fields.merkleRoot}" } }`)).toMatchObject({ value: true });
  });
  it('requires certified persistence for a genuine confirmed command before graph I/O', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const read = vi.spyOn(store, 'query'), write = vi.spyOn(store, 'atomicUpdate');
    await expect(applyPublishedNamedKaVmLifecycle(store, fields)).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE' });
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('keeps admitted confirmed evidence pending until a shared draft mutation physically retires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-command-contract-')); dirs.push(dir);
    const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
    const writeLocks = new Map<string, Promise<void>>(), key = assertionLifecycleWriteLockKey(fields.contextGraphId, fields.name, fields.agentAddress);
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const lifecycle = assertionLifecycleUri(fields.contextGraphId, fields.agentAddress, fields.name), graph = contextGraphMetaUri(fields.contextGraphId);
    const mutation = withKeyedLocks(writeLocks, [key], async () => {
      started(); await held;
      await store.insert([{ graph, subject: lifecycle, predicate: WM_CURRENT_ASSERTION_PRED, object: JSON.stringify('cd'.repeat(32)) }]);
    });
    await entered;
    const current = vi.fn(async () => true), apply = vi.fn(async (input: ConfirmedNamedKaVmLifecycleInput) => applyPublishedNamedKaVmLifecycle(store, input));
    const repair = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks, apply, isCurrent: current, warn: () => {} }); owners.push(repair);
    const attempt = repair.submit(fields);
    try {
      await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries).toHaveLength(1));
      expect(apply).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    } finally { release(); }
    await mutation; expect(await attempt).toBe('repaired');
    expect(await store.query(`ASK { GRAPH <${graph}> { <${lifecycle}> <${WM_CURRENT_ASSERTION_PRED}> "${'cd'.repeat(32)}" } }`)).toMatchObject({ value: true });
  });
});
