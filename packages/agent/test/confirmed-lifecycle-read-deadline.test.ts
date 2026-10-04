import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeRpcRequestAbortSignal, EVMChainAdapter, withRpcRequestContext, type ChainReadOptions } from '@origintrail-official/dkg-chain';
import { startLoopbackRpc } from '../../chain/test/loopback-rpc-harness.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { isConfirmedNamedKaVmLifecycleCurrent } from '../src/named-ka-vm-lifecycle-current.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

afterEach(() => vi.restoreAllMocks());
it.each(['chainId', 'lifecycleAddress'] as const)('retires a non-cooperative deployment %s read, preserves evidence and releases the shared lock', async stalledRead => {
  const { input: fields, publication } = confirmedLifecycleRecoveryFixture();
  const input = { ...fields, packedKaId: 1n, publicationDeployment: {
    chainId: publication.seal.chainId.toString(), lifecycleAddress: publication.seal.kav10Address,
  } };
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-read-deadline-'));
  const store = new OxigraphStore(join(dir, 'store.nq'));
  const writeLocks = new Map<string, Promise<void>>();
  let release!: () => void, stalled = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  const observedSignals: Array<AbortSignal | undefined> = [];
  const deploymentRead = async (kind: typeof stalledRead) => {
    observedSignals.push(activeRpcRequestAbortSignal());
    if (stalled && kind === stalledRead) await held;
  };
  const snapshot = vi.fn(async (_id: bigint, options?: { signal?: AbortSignal }) => {
    observedSignals.push(options?.signal);
    return { rootCount: 1n, latestRoot: fields.merkleRoot };
  });
  const chain = {
    getEvmChainId: async () => { await deploymentRead('chainId'); return publication.seal.chainId; },
    getKnowledgeAssetsLifecycleAddress: async () => { await deploymentRead('lifecycleAddress'); return publication.seal.kav10Address; },
    readKnowledgeAssetVersionSnapshot: snapshot,
  };
  const apply = vi.fn(candidate => applyPublishedNamedKaVmLifecycle(store, candidate));
  const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks, warn: () => {}, apply,
    isCurrent: candidate => isConfirmedNamedKaVmLifecycleCurrent(chain, candidate, 5, true) });
  const attempt = owner.submit(input);
  try {
    const outcome = await Promise.race([attempt, new Promise(resolve => setTimeout(() => resolve('still-held'), 1_000))]);
    expect(outcome).toBe('pending');
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(snapshot).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    const journal = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0][1].input.publicationDeployment).toEqual(input.publicationDeployment);
    expect(journal.entries[0][1].lastError).toMatch(/timed out/);
    const acquired = vi.fn();
    await withKeyedLocks(writeLocks, [assertionLifecycleWriteLockKey(input.contextGraphId, input.name, input.agentAddress)], async () => { acquired(); });
    expect(acquired).toHaveBeenCalledOnce();
    stalled = false;
    expect(await owner.submit({ ...input, name: 'later-repair' })).toBe('repaired');
    expect(apply).toHaveBeenCalledOnce();
    expect(observedSignals.at(-1)).toBe(observedSignals.at(-2));
    expect(observedSignals.at(-1)?.aborted).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries).toHaveLength(1);
    await owner.stop();
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(snapshot).toHaveBeenCalledOnce(); // The abandoned deployment waiter cannot start a late snapshot.
  } finally {
    release(); await attempt; await owner.stop(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

it.each(['chainId', 'lifecycleAddress'] as const)('retires the real EVM deployment %s getter while preserving its physical request ownership', async read => {
  const method = read === 'chainId' ? 'eth_chainId' : 'eth_call';
  const rpc = await startLoopbackRpc({ hang: [method] });
  const adapter = new EVMChainAdapter({ rpcUrl: rpc.url, chainId: 'evm:31337',
    staticNetwork: read !== 'chainId', allowNoAdminSigner: true,
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001' });
  const { input: fields, publication } = confirmedLifecycleRecoveryFixture();
  const snapshot = vi.fn();
  let getterRetirement: Promise<unknown> | undefined;
  let getterRetired = false;
  const observeGetter = <T>(work: Promise<T>): Promise<T> => {
    getterRetirement = work.then(value => value, error => error).finally(() => { getterRetired = true; });
    return work;
  };
  const chain = {
    getEvmChainId: read === 'chainId' ? (options?: ChainReadOptions) => observeGetter(adapter.getEvmChainId(options)) : async () => publication.seal.chainId,
    getKnowledgeAssetsLifecycleAddress: read === 'lifecycleAddress'
      ? (options?: ChainReadOptions) => observeGetter(adapter.getKnowledgeAssetsLifecycleAddress(options)) : async () => publication.seal.kav10Address,
    readKnowledgeAssetVersionSnapshot: snapshot,
  };
  try {
    const outcome = isConfirmedNamedKaVmLifecycleCurrent(chain, { ...fields, packedKaId: 1n,
      publicationDeployment: { chainId: publication.seal.chainId.toString(), lifecycleAddress: publication.seal.kav10Address } }, 1_000, true);
    void outcome.catch(() => {});
    await expect.poll(() => rpc.hits(method)).toBeGreaterThan(0);
    await expect(outcome).rejects.toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT' });
    await expect.poll(() => getterRetired).toBe(true);
    await expect(getterRetirement).resolves.toBeInstanceOf(Error);
    if (read === 'chainId') {
      // Shared network discovery belongs to the provider lifecycle, not this
      // repair waiter. Caller cancellation must not destroy another user's provider.
      expect(rpc.aborted(method)).toBe(0);
      adapter.destroy();
    }
    await expect.poll(() => rpc.aborted(method)).toBe(rpc.hits(method));
    expect(snapshot).not.toHaveBeenCalled();
  } finally { adapter.destroy(); await rpc.close(); await getterRetirement; }
});

it('composes inherited caller cancellation and refuses late non-cooperative reads before the snapshot', async () => {
  const { input: fields, publication } = confirmedLifecycleRecoveryFixture();
  const input = { ...fields, packedKaId: 1n, publicationDeployment: {
    chainId: publication.seal.chainId.toString(), lifecycleAddress: publication.seal.kav10Address,
  } };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const caller = new AbortController(), signals: Array<AbortSignal | undefined> = [];
  const snapshot = vi.fn();
  const chain = { getEvmChainId: async () => { signals.push(activeRpcRequestAbortSignal()); await held; return publication.seal.chainId; },
    getKnowledgeAssetsLifecycleAddress: async () => { signals.push(activeRpcRequestAbortSignal()); await held; return publication.seal.kav10Address; },
    readKnowledgeAssetVersionSnapshot: snapshot };
  try {
    const work = withRpcRequestContext({ signal: caller.signal }, () => isConfirmedNamedKaVmLifecycleCurrent(chain, input, 10_000, true));
    caller.abort(new Error('caller retired'));
    await expect(work).rejects.toMatchObject({ name: 'AbortError', message: 'caller retired' });
    expect(signals).toHaveLength(2); expect(signals[0]).toBe(signals[1]); expect(signals[0]?.aborted).toBe(true);
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(snapshot).not.toHaveBeenCalled();
    const first = vi.spyOn(chain, 'getEvmChainId'); first.mockClear();
    await expect(withRpcRequestContext({ signal: caller.signal }, () => isConfirmedNamedKaVmLifecycleCurrent(chain, input, 10_000, true)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(first).not.toHaveBeenCalled();
  } finally { release(); }
});
