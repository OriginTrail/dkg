import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleIntegrityError, isNamedKaVmLifecycleIntegrityError } from '../src/named-ka-vm-lifecycle-integrity-error.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { isConfirmedNamedKaVmLifecycleCurrent } from '../src/named-ka-vm-lifecycle-current.js';
import { normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { confirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

const input = { contextGraphId: 'integrity-contract', agentAddress: '0x' + '11'.repeat(20), name: 'asset',
  publishedUal: 'did:dkg:mock/1', merkleRoot: 'ab'.repeat(32), assertionVersion: '1', packedKaId: 1n,
  publicationDeployment: { chainId: '31337', lifecycleAddress: '0x' + '22'.repeat(20) } };
const dirs: string[] = [], stores: OxigraphStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('named KA lifecycle integrity contract', () => {
  it('has a shared code/message and refuses arbitrary code-shaped values', () => {
    const error = new NamedKaVmLifecycleIntegrityError('permanent evidence conflict');
    expect(error).toMatchObject({ name: 'NamedKaVmLifecycleIntegrityError', code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY', message: 'permanent evidence conflict' });
    expect(isNamedKaVmLifecycleIntegrityError(error)).toBe(true);
    for (const value of [null, undefined, {}, new Error('temporary outage'), { code: error.code }]) {
      expect(isNamedKaVmLifecycleIntegrityError(value)).toBe(false);
    }
  });
  it('uses the same producer contract for journal and confirmed publication evidence', () => {
    expect(() => normalizeLifecycleRepairInput({ ...input, assertionVersion: '0' }, true)).toThrow(NamedKaVmLifecycleIntegrityError);
    const { publication } = confirmedLifecycleRecoveryFixture();
    expect(() => confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, kaUal: undefined } }, input))
      .toThrow(NamedKaVmLifecycleIntegrityError);
  });
  it.each(['chain-root', 'ambiguous-workspace'] as const)('retains %s evidence as rejected through a real journal restart without retries', async scenario => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-integrity-owner-')); dirs.push(dir);
    const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
    if (scenario === 'ambiguous-workspace') await store.insert(['ab', 'cd'].map(root => ({
      graph: contextGraphMetaUri(input.contextGraphId), subject: assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name),
      predicate: 'http://dkg.io/ontology/wmCurrentAssertion', object: JSON.stringify(root.repeat(32)),
    })));
    const current = vi.fn(async () => isConfirmedNamedKaVmLifecycleCurrent({
      getEvmChainId: async () => 31337n, getKnowledgeAssetsLifecycleAddress: async () => input.publicationDeployment.lifecycleAddress,
      readKnowledgeAssetVersionSnapshot: async () => ({ latestRoot: '0x' + 'cd'.repeat(32), rootCount: 1n }),
    } as Parameters<typeof isConfirmedNamedKaVmLifecycleCurrent>[0], input, 1000, false));
    const apply = vi.fn(async () => applyPublishedNamedKaVmLifecycle(store, input));
    let now = 1000;
    const options = { dataDir: dir, writeLocks: new Map<string, Promise<void>>(), now: () => now,
      isCurrent: scenario === 'chain-root' ? current : async () => true, apply, warn: () => {} };
    const owner = new NamedKaVmLifecycleRepair(options); owners.push(owner);
    expect(await owner.submit(input)).toBe('rejected');
    const journal = () => readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8').then(JSON.parse);
    expect((await journal()).entries[0][1]).toMatchObject({ rejected: true, attempts: 1,
      lastError: scenario === 'chain-root' ? 'Confirmed named KA lifecycle repair root differs from the chain' : 'Invalid workspace pointers during confirmed lifecycle repair' });
    const before = { current: current.mock.calls.length, apply: apply.mock.calls.length };
    now = 1_000_000; await owner.runDue(); await owner.stop();
    const restarted = new NamedKaVmLifecycleRepair(options); owners.push(restarted); await restarted.runDue();
    expect(current).toHaveBeenCalledTimes(before.current); expect(apply).toHaveBeenCalledTimes(before.apply);
    expect((await journal()).entries[0][1]).toMatchObject({ rejected: true, attempts: 1 });
  });
  it('keeps transient failures pending and retries only after the persisted backoff deadline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-transient-owner-')); dirs.push(dir);
    const failure = new Error('temporary storage outage'), apply = vi.fn(async () => { throw failure; });
    let now = 1000;
    const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), now: () => now,
      apply, isCurrent: async () => true, warn: () => {} }); owners.push(owner);
    expect(await owner.submit(input)).toBe('pending'); expect(apply).toHaveBeenCalledOnce();
    now = 5999; await owner.runDue(); expect(apply).toHaveBeenCalledOnce();
    now = 6000; await owner.runDue(); expect(apply).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
    expect(journal.entries[0][1]).toMatchObject({ rejected: false, attempts: 2, nextAttemptAt: 16000, lastError: failure.message });
  });
});
