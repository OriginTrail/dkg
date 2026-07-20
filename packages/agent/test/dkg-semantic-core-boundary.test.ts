import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DkgSemanticCore,
  type DkgSemanticCoreDelegates,
  type DkgSemanticCoreTraceEvent,
} from '../src/semantic/dkg-semantic-core.js';
import type { VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const asset: VerifiedGraphScopedAsset = {
  contextGraphId: 'cg-1',
  ual: 'did:dkg:knowledge-asset:hardhat1:31337/0x0000000000000000000000000000000000000001/1',
  assertionVersion: 1n,
  assertionGraph: 'did:dkg:context-graph:cg-1/_shared_memory/ka/1',
  metaGraph: 'did:dkg:context-graph:cg-1/_shared_memory_meta',
  dataQuads: [],
  metadataQuads: [],
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('one shared DKG semantic-core boundary', () => {
  it('routes legacy-sync and wal-sync graph materialization through the same delegates', async () => {
    const trace: DkgSemanticCoreTraceEvent[] = [];
    const authenticate = vi.fn(async (_chain: ChainAdapter, value: VerifiedGraphScopedAsset) => value);
    const materialize = vi.fn(async () => 'applied' as const);
    const core = new DkgSemanticCore({
      observer: event => trace.push(event),
      delegates: {
        authenticateVerifiedGraphScopedAsset:
          authenticate as DkgSemanticCoreDelegates['authenticateVerifiedGraphScopedAsset'],
        materializeVerifiedGraphScopedAsset:
          materialize as DkgSemanticCoreDelegates['materializeVerifiedGraphScopedAsset'],
      },
    });
    const params = {
      chain: {} as ChainAdapter,
      store: {} as TripleStore,
      asset,
    };

    const legacyResult = await core.applyVerifiedGraphScopedAsset('legacy-sync', params);
    const walResult = await core.applyVerifiedGraphScopedAsset('wal-sync', params);

    expect(legacyResult).toEqual(walResult);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize.mock.calls[0]?.[0]).toEqual(materialize.mock.calls[1]?.[0]);
    expect(trace).toEqual([
      { driver: 'legacy-sync', entryPoint: 'verified-graph-scoped-materialization', phase: 'enter' },
      { driver: 'legacy-sync', entryPoint: 'verified-graph-scoped-materialization', phase: 'return' },
      { driver: 'wal-sync', entryPoint: 'verified-graph-scoped-materialization', phase: 'enter' },
      { driver: 'wal-sync', entryPoint: 'verified-graph-scoped-materialization', phase: 'return' },
    ]);
  });

  it('routes legacy-sync and wal-sync verified SWM recovery through one implementation', async () => {
    const apply = vi.fn(async () => ({ replacedRoots: 1, insertedQuads: 1 }));
    const core = new DkgSemanticCore({
      delegates: {
        applySwmRecovery: apply as DkgSemanticCoreDelegates['applySwmRecovery'],
      },
    });
    const params = {
      store: {} as Parameters<DkgSemanticCoreDelegates['applySwmRecovery']>[0]['store'],
      verifiedData: [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }],
      roots: [{ dataGraph: 'urn:g', entity: 'urn:s' }],
    };

    await expect(core.applyVerifiedSwmRecovery('legacy-sync', params))
      .resolves.toEqual({ replacedRoots: 1, insertedQuads: 1 });
    await expect(core.applyVerifiedSwmRecovery('wal-sync', params))
      .resolves.toEqual({ replacedRoots: 1, insertedQuads: 1 });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]?.[0]).toBe(params);
    expect(apply.mock.calls[1]?.[0]).toBe(params);
  });

  it('feeds chain events and WAL replay into the same VM reconciliation implementation', async () => {
    const reconcile = vi.fn(async () => ({ head: 1, watermark: 1, reconciled: 1, pending: 0 }));
    const core = new DkgSemanticCore({
      delegates: {
        reconcileContextGraph: reconcile as DkgSemanticCoreDelegates['reconcileContextGraph'],
      },
    });
    const params = {
      deps: {} as Parameters<DkgSemanticCoreDelegates['reconcileContextGraph']>[0],
      state: { watermark: 0, ahead: new Map() } as Parameters<DkgSemanticCoreDelegates['reconcileContextGraph']>[1],
      localContextGraphId: 'cg-1',
      onChainContextGraphId: 1n,
    };

    const chainResult = await core.reconcileVm('chain-event', params);
    const walResult = await core.reconcileVm('wal-sync', params);

    expect(chainResult).toEqual(walResult);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[0]).toEqual(reconcile.mock.calls[1]);
  });

  it('keeps failures identical and records no driver-specific fallback', async () => {
    const failure = Object.assign(new Error('semantic rejection'), { code: 'DKG_SEMANTIC_REJECTED' });
    const apply = vi.fn(async () => { throw failure; });
    const trace: DkgSemanticCoreTraceEvent[] = [];
    const core = new DkgSemanticCore({
      observer: event => trace.push(event),
      delegates: {
        applySwmRecovery: apply as DkgSemanticCoreDelegates['applySwmRecovery'],
      },
    });
    const params = {
      store: {} as Parameters<DkgSemanticCoreDelegates['applySwmRecovery']>[0]['store'],
      verifiedData: [],
      roots: [],
    };

    await expect(core.applyVerifiedSwmRecovery('legacy-sync', params)).rejects.toBe(failure);
    await expect(core.applyVerifiedSwmRecovery('wal-sync', params)).rejects.toBe(failure);
    expect(trace.filter(event => event.phase === 'throw')).toEqual([
      { driver: 'legacy-sync', entryPoint: 'verified-swm-recovery', phase: 'throw' },
      { driver: 'wal-sync', entryPoint: 'verified-swm-recovery', phase: 'throw' },
    ]);
  });

  it('prevents production sync code from bypassing the shared adapter', () => {
    const allowed = new Set([
      resolve(packageRoot, 'src/semantic/dkg-semantic-core.ts'),
      resolve(packageRoot, 'src/sync/requester/graph-scoped-materialization.ts'),
      resolve(packageRoot, 'src/sync/requester/swm-recovery-apply.ts'),
      resolve(packageRoot, 'src/chain-reconciler.ts'),
    ]);
    const directSemanticCall = /\b(?:authenticateVerifiedGraphScopedAsset|materializeVerifiedGraphScopedAsset|applySwmRecovery|reconcileContextGraph)\s*\(/;
    const bypasses = sourceFiles(resolve(packageRoot, 'src'))
      .filter(path => !allowed.has(path))
      .filter(path => directSemanticCall.test(readFileSync(path, 'utf8')))
      .map(path => relative(packageRoot, path));

    expect(bypasses).toEqual([]);
  });
});
