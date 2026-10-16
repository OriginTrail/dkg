import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { RecoveryMaterializationOwner, type RecoveryMaterializationPorts } from '../src/durable-recovery-materialization.js';
import type { DurableRecoveryAuthority } from '../src/durable-recovery-authority.js';
import * as materialization from '../src/sync/requester/graph-scoped-materialization.js';
import * as cleanup from '../src/sync/requester/post-materialization.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const physicalRuns = new Set<Promise<unknown>>();
  let generation = 0;
  const subscription = { onChainId: '1' } as ReturnType<RecoveryMaterializationPorts['subscription']>;
  const asset = { contextGraphId: 'graph', ual: 'asset' } as materialization.VerifiedGraphScopedAsset;
  const ports: RecoveryMaterializationPorts = {
    chain: () => { throw new Error('not a chain-authentication test'); },
    store: () => ({} as ReturnType<RecoveryMaterializationPorts['store']>),
    isClosed: () => false,
    subscription: () => subscription,
    bindingGeneration: () => generation,
    isBindingGenerationCurrent: (_id, captured) => captured === generation,
    track: run => { physicalRuns.add(run); },
    untrack: run => { physicalRuns.delete(run); },
    verifyBinding: async () => true,
    persistSubscription: async () => { throw new Error('already bound'); },
    bindSubscription: () => { throw new Error('already bound'); },
    recordDrops: () => {},
    cleanup: () => ({} as ReturnType<RecoveryMaterializationPorts['cleanup']>),
  };
  const authority: DurableRecoveryAuthority = {
    coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
    authenticate: async () => ({ asset, onChainContextGraphId: '1' }),
  };
  const scope = new RecoveryMaterializationOwner(ports).forOperation({
    ctx: createOperationContext('sync'), contextGraphId: 'graph', authority,
  });
  return { scope, authority, asset, physicalRuns, rebind: () => { generation += 1; } };
}

it('rejects rebinding during authentication before dispatching a physical write', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const write = vi.spyOn(materialization, 'materializeVerifiedGraphScopedAsset');
  f.authority.authenticate = async () => {
    entered.resolve(); await release.promise;
    return { asset: f.asset, onChainContextGraphId: '1' };
  };
  const run = f.scope.storeGraphScopedAsset({ asset: f.asset, authenticationDeadline: Date.now() + 2_000 });
  await entered.promise;
  expect(f.physicalRuns.size).toBe(1);
  f.rebind(); release.resolve();
  await expect(run).rejects.toThrow('changed during graph-scoped store');
  expect(write).not.toHaveBeenCalled();
  expect(f.physicalRuns.size).toBe(0);
});

it('retains physical ownership through atomic settlement and cleanup after caller cancellation', async () => {
  const f = fixture();
  const entered = deferred(); const releaseWrite = deferred();
  const cleanupEntered = deferred(); const releaseCleanup = deferred();
  const controller = new AbortController();
  vi.spyOn(materialization, 'materializeVerifiedGraphScopedAsset').mockImplementation(async () => {
    entered.resolve(); await releaseWrite.promise; return 'applied';
  });
  vi.spyOn(cleanup, 'reconcileAfterMaterialization').mockImplementation(async () => {
    cleanupEntered.resolve(); await releaseCleanup.promise;
  });
  const run = f.scope.storeGraphScopedAsset({ asset: f.asset, authenticationDeadline: Date.now() + 2_000, signal: controller.signal });
  await entered.promise;
  controller.abort();
  expect(f.physicalRuns.size).toBe(1);
  releaseWrite.resolve(); await cleanupEntered.promise;
  expect(f.physicalRuns.size).toBe(1);
  releaseCleanup.resolve(); await expect(run).resolves.toBe('applied');
  expect(f.physicalRuns.size).toBe(0);
});
