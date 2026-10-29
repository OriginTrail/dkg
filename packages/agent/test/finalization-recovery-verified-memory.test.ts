import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFinalizationMessage,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import type { CanonicalFinalizationReceipt, ChainAdapter } from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { parseGraphScopedFinalization } from '../src/finalization-graph-envelope.js';
import { FinalizationRecovery } from '../src/finalization-recovery.js';
import {
  openSqliteFinalizationRecoveryStore,
  type SqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryFailureCode,
} from '../src/finalization-recovery-store.js';
import {
  VERIFIED_MEMORY_SUPERSESSION_REASON,
  supersedeEntryHeldInVerifiedMemory,
  type ExactVerifiedMemoryCopyQuery,
} from '../src/finalization-recovery-verified-memory.js';

const CONTEXT_GRAPH = 'finalization-verified-memory';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:base:84532/${AUTHOR}/7`;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const SOURCE = '12D3KooWPublisher';
const ROOT = new Uint8Array(32).fill(5);
const ROOT_HEX = `0x${'05'.repeat(32)}`;

function message(): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: ROOT,
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 123,
    batchId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
    publisherAddress: PUBLISHER,
    rootEntities: [],
    // Fixed, so a duplicate delivery carries the same envelope bytes.
    timestampMs: 1_700_000_000_000,
    operationId: 'verified-memory-test',
    targetContextGraphId: '42',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
  };
}

function liveInput() {
  const parsed = parseGraphScopedFinalization(message(), CONTEXT_GRAPH);
  if (!parsed.ok) throw new Error(`unexpected admission failure: ${parsed.reason}`);
  return {
    rawMessage: encodeFinalizationMessage(message()),
    contextGraphId: CONTEXT_GRAPH,
    sourcePeerId: SOURCE,
    candidate: parsed.value,
  };
}

function receipt(): CanonicalFinalizationReceipt {
  return {
    txHash: message().txHash,
    blockNumber: 123,
    blockHash: `0x${'cd'.repeat(32)}`,
    txIndex: 4,
    merkleRoot: ROOT,
    publisherAddress: PUBLISHER,
    authorAddress: AUTHOR,
    batchId: PACKED_KA_ID,
    kaId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
  };
}

function chain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    chainId: 'base:84532',
    getLatestMerkleRoot: async () => ROOT,
    getMerkleRootCount: async () => 1n,
    getKAContextGraphId: async () => 42n,
    resolveCanonicalFinalizationReceipt: async () => ({ status: 'confirmed', receipt: receipt() }),
    ...overrides,
  } as ChainAdapter;
}

interface Prepared {
  onChainContextGraphId: string;
  localTopicOnChainContextGraphId: string;
  publisherPeerId: string;
  access: { accessPolicy: 'public'; allowedPeers: string[] };
}

const PREPARED: Prepared = {
  onChainContextGraphId: '42',
  localTopicOnChainContextGraphId: '42',
  publisherPeerId: SOURCE,
  access: { accessPolicy: 'public', allowedPeers: [] },
};

/**
 * By default a node that never held the SWM copy: preparation is unavailable.
 * `prepared` stands for a node that holds it.
 */
function materializer(
  held: (query: ExactVerifiedMemoryCopyQuery) => Promise<boolean>,
  options: { prepared?: Prepared; apply?: 'applied' | 'deferred' } = {},
) {
  return {
    prepare: vi.fn(async (): Promise<Prepared | undefined> => options.prepared),
    apply: async () => options.apply ?? 'applied',
    recoverVerifiedEvidence: async () => undefined,
    replayVerified: async () => 'promoted' as const,
    invalidateVerified: async () => 'invalidated' as const,
    hasExactVerifiedMemoryCopy: vi.fn(held),
    isRetryableError: (error: unknown) => error instanceof StoreSchedulerBusyError,
  };
}

function capturingLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: {
      info: (text: string) => { info.push(text); },
      warn: (text: string) => { warn.push(text); },
    },
  };
}

const replayInput = {
  chainId: 'base:84532',
  contextGraphId: CONTEXT_GRAPH,
  onChainCgId: '42',
  ual: UAL,
  merkleRoot: ROOT_HEX,
  kaId: PACKED_KA_ID.toString(),
};

async function withInbox(
  run: (open: () => Promise<SqliteFinalizationRecoveryStore>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-verified-memory-'));
  const opened: SqliteFinalizationRecoveryStore[] = [];
  try {
    await run(async () => {
      const store = await openSqliteFinalizationRecoveryStore(directory, { maxPerPeer: 1 });
      opened.push(store);
      return store;
    });
  } finally {
    for (const store of opened) await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

describe('finalization recovery of an assertion already in Verified Memory', () => {
  it('closes a due entry at once and frees its source quota, across a restart', async () => {
    await withInbox(async (open) => {
      const store = await open();
      const { info, log } = capturingLog();
      const fake = materializer(async () => true);
      const recovery = new FinalizationRecovery(store, chain(), log, fake);
      await recovery.receive(liveInput());
      expect(await store.health()).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
      });

      await expect(recovery.processDueBatch(16)).resolves.toBe(1);

      expect(await store.list()).toMatchObject([{
        state: 'SUPERSEDED',
        lastError: VERIFIED_MEMORY_SUPERSESSION_REASON,
        failureStreak: 0,
      }]);
      expect(fake.hasExactVerifiedMemoryCopy).toHaveBeenCalledOnce();
      const [query] = fake.hasExactVerifiedMemoryCopy.mock.calls[0]!;
      expect(query.contextGraphId).toBe(CONTEXT_GRAPH);
      expect(query.candidate.scope.ual).toBe(UAL);
      expect(query.merkleRoot).toEqual(ROOT);
      expect(info).toContain(
        `Finalization recovery closed the entry for ${UAL}: Verified Memory already holds this exact assertion`,
      );
      // The closed entry is not then recorded as a failed background match.
      expect(info.filter((text) => text.includes('stale attempt update'))).toEqual([]);
      expect(await store.health()).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 0, contextGraphs: 0 },
        stateCounts: { SUPERSEDED: 1 },
      });
      await store.close();

      // The closed state is durable, and a duplicate delivery does not reopen it.
      const reopened = await open();
      const restarted = new FinalizationRecovery(reopened, chain(), log, fake);
      await expect(restarted.processLiveOutcome(liveInput())).resolves.toEqual({ status: 'handled' });
      await expect(restarted.processDueBatch(16)).resolves.toBe(0);
      expect(await reopened.list()).toMatchObject([{ state: 'SUPERSEDED' }]);
      expect(fake.hasExactVerifiedMemoryCopy).toHaveBeenCalledOnce();
      expect(fake.prepare).toHaveBeenCalledOnce();
    });
  });

  it('closes the entry from chain reconciliation and lets the reconciliation continue', async () => {
    await withInbox(async (open) => {
      const store = await open();
      const recovery = new FinalizationRecovery(
        store,
        chain(),
        capturingLog().log,
        materializer(async () => true),
      );
      await recovery.receive(liveInput());

      await expect(recovery.replayMatching(replayInput)).resolves.toBe('none');
      expect(await store.list()).toMatchObject([{ state: 'SUPERSEDED' }]);
    });
  });

  it('keeps the entry owed when Verified Memory does not hold the assertion', async () => {
    await withInbox(async (open) => {
      const store = await open();
      const fake = materializer(async () => false);
      const recovery = new FinalizationRecovery(store, chain(), capturingLog().log, fake);
      await recovery.receive(liveInput());

      await expect(recovery.processDueBatch(16)).resolves.toBe(1);
      const [entry] = await store.list();
      expect(entry).toMatchObject({
        state: 'RECEIVED',
        attemptCount: 1,
        failureSignature: 'workspace-unavailable',
        failureStreak: 1,
        lastError: 'workspace preparation is unavailable',
      });
      expect(entry!.nextAttemptAt).toBeDefined();
      expect(fake.hasExactVerifiedMemoryCopy).toHaveBeenCalledOnce();
      expect(await store.health()).toMatchObject({
        ready: true,
        fullQuotas: { sourcePeers: 1, contextGraphs: 0 },
      });
    });
  });

  it('keeps the entry owed when the Verified Memory read fails', async () => {
    await withInbox(async (open) => {
      const store = await open();
      const { info, log } = capturingLog();
      const recovery = new FinalizationRecovery(
        store,
        chain(),
        log,
        materializer(async () => { throw new Error('store offline'); }),
      );
      await recovery.receive(liveInput());

      await expect(recovery.processDueBatch(16)).resolves.toBe(1);
      expect(await store.list()).toMatchObject([{
        state: 'RECEIVED',
        failureSignature: 'workspace-unavailable',
      }]);
      expect(info).toContain(
        `Finalization recovery could not read Verified Memory for ${UAL}; keeping the entry: store offline`,
      );
    });
  });

  it.each([
    [
      'it settles normally',
      chain(),
      'applied' as const,
      { state: 'SETTLED' },
    ],
    [
      'its receipt is pending',
      chain({ resolveCanonicalFinalizationReceipt: async () => ({ status: 'pending' }) }),
      'applied' as const,
      { state: 'RECEIVED', failureSignature: 'receipt-pending' },
    ],
    [
      'its verified apply is deferred',
      chain(),
      'deferred' as const,
      { state: 'VERIFIED', failureSignature: 'apply-deferred' },
    ],
  ])('does not consult Verified Memory for a held SWM copy when %s', async (
    _label,
    replayChain,
    apply,
    expected,
  ) => {
    await withInbox(async (open) => {
      const store = await open();
      const fake = materializer(async () => true, { prepared: PREPARED, apply });
      const recovery = new FinalizationRecovery(store, replayChain, capturingLog().log, fake);
      await recovery.receive(liveInput());

      await expect(recovery.processDueBatch(16)).resolves.toBe(1);
      expect(await store.list()).toMatchObject([expected]);
      expect(fake.prepare).toHaveBeenCalledOnce();
      expect(fake.hasExactVerifiedMemoryCopy).not.toHaveBeenCalled();
    });
  });
});

describe('supersedeEntryHeldInVerifiedMemory', () => {
  function entry(overrides: Partial<FinalizationRecoveryEntry> = {}): FinalizationRecoveryEntry {
    return {
      key: 'entry',
      state: 'RECEIVED',
      chainId: 'base:84532',
      contextGraphId: CONTEXT_GRAPH,
      publisherUpgradePending: false,
      ual: UAL,
      txHash: message().txHash,
      assertionVersion: '1',
      merkleRoot: ROOT_HEX,
      kaId: PACKED_KA_ID.toString(),
      batchId: PACKED_KA_ID.toString(),
      envelopeSha256: '00',
      rawMessage: new Uint8Array(),
      generation: 0,
      attemptCount: 0,
      failureStreak: 0,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  function input(overrides: Partial<Parameters<typeof supersedeEntryHeldInVerifiedMemory>[0]> = {}) {
    return {
      entry: entry(),
      candidate: liveInput().candidate,
      merkleRoot: ROOT_HEX,
      failureCode: 'workspace-unavailable' as FinalizationRecoveryFailureCode | undefined,
      materializer: { hasExactVerifiedMemoryCopy: vi.fn(async () => true) },
      supersede: vi.fn(async () => true),
      log: capturingLog().log,
      ...overrides,
    };
  }

  it.each([
    ['a moved receipt', { state: 'REORGED' as const }],
    ['a late publisher upgrade', { state: 'REORGED' as const, publisherUpgradePending: true }],
  ])('keeps a REORGED entry owed, since %s is still to be applied', async (_label, overrides) => {
    const call = input({ entry: entry(overrides) });
    await expect(supersedeEntryHeldInVerifiedMemory(call)).resolves.toBe(false);
    expect(call.materializer.hasExactVerifiedMemoryCopy).not.toHaveBeenCalled();
    expect(call.supersede).not.toHaveBeenCalled();
  });

  it.each([
    ['an attempt that was not deferred', undefined],
    ['another deferral', 'apply-deferred' as const],
  ])('leaves %s alone', async (_label, failureCode) => {
    const call = input({ failureCode });
    await expect(supersedeEntryHeldInVerifiedMemory(call)).resolves.toBe(false);
    expect(call.materializer.hasExactVerifiedMemoryCopy).not.toHaveBeenCalled();
  });

  it('reports no closure when the entry moved on before the compare-and-set', async () => {
    const { info, log } = capturingLog();
    const call = input({ supersede: vi.fn(async () => false), log });
    await expect(supersedeEntryHeldInVerifiedMemory(call)).resolves.toBe(false);
    expect(call.supersede).toHaveBeenCalledWith(VERIFIED_MEMORY_SUPERSESSION_REASON);
    expect(info).toEqual([]);
  });

  it('reports a non-Error Verified Memory failure and keeps the entry', async () => {
    const { info, log } = capturingLog();
    const call = input({
      materializer: { hasExactVerifiedMemoryCopy: vi.fn(async () => { throw 'unreadable'; }) },
      log,
    });
    await expect(supersedeEntryHeldInVerifiedMemory(call)).resolves.toBe(false);
    expect(call.supersede).not.toHaveBeenCalled();
    expect(info).toEqual([
      `Finalization recovery could not read Verified Memory for ${UAL}; keeping the entry: unreadable`,
    ]);
  });
});
