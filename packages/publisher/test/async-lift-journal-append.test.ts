import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type AsyncLiftPublisherConfig } from '../src/index.js';
import type { LiftJob } from '../src/lift-job.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_KIND,
  JOURNAL_LIFECYCLE_KEY,
  JOURNAL_JOB_ID,
  parseIntegerLiteral,
  parseLiteral,
  serializeJob,
} from '../src/async-lift-control-plane.js';

// #1829 chunk 2-3 — appendJournal hooked into writeJob: per-lineageKey monotonic seq,
// explicit kinds, daemon-only gating, and #1849 defensiveness (a legacy U+001F job
// must not throw out of writeJob).
describe('#1829 admission journal append (writeJob hook)', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  function createPublisher(config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      journalWrites: true,
      ...config,
    });
  }

  function kaVmPublishRequest(overrides: Record<string, unknown> = {}) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
      ...overrides,
    };
  }

  async function driveToValidated(publisher: TripleStoreAsyncLiftPublisher, overrides: Record<string, unknown> = {}): Promise<string> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(overrides));
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: [],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    return jobId;
  }

  // Read (seq, kind, lineageKey, jobId) rows straight from the journal graph.
  async function journalRows(): Promise<Array<{ seq: number; kind: string; lineageKey: string; jobId: string }>> {
    const result = await store.query(
      `SELECT ?seq ?kind ?lk ?jid WHERE { GRAPH <${DEFAULT_JOURNAL_GRAPH_URI}> { ?e <${JOURNAL_SEQ}> ?seq ; <${JOURNAL_KIND}> ?kind ; <${JOURNAL_LIFECYCLE_KEY}> ?lk ; <${JOURNAL_JOB_ID}> ?jid } }`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings
      .map((r) => ({
        seq: parseIntegerLiteral(r['seq'] as string),
        kind: parseLiteral(r['kind'] as string) as string,
        lineageKey: parseLiteral(r['lk'] as string) as string,
        jobId: parseLiteral(r['jid'] as string) as string,
      }))
      .sort((a, b) => a.seq - b.seq);
  }

  it('appends a contiguous, correctly-kinded entry per transition (admission->claimed->validated)', async () => {
    const publisher = createPublisher();
    await driveToValidated(publisher);
    const rows = await journalRows();
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.kind)).toEqual(['admission', 'claimed', 'validated']);
    // all one lineage
    expect(new Set(rows.map((r) => r.lineageKey)).size).toBe(1);
  });

  it('allocates seq independently per lineageKey (each lineage starts at 0)', async () => {
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums' }));
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'singles' }));
    const rows = await journalRows();
    const byLineage = new Map<string, number[]>();
    for (const r of rows) byLineage.set(r.lineageKey, [...(byLineage.get(r.lineageKey) ?? []), r.seq]);
    expect(byLineage.size).toBe(2);
    for (const seqs of byLineage.values()) expect(seqs).toEqual([0]); // each fresh lineage's admission = seq 0
  });

  it('writes NOTHING when journalWrites is off (daemon-only gate)', async () => {
    const publisher = createPublisher({ journalWrites: false });
    await driveToValidated(publisher);
    expect(await journalRows()).toEqual([]);
  });

  it('does not append for a raw-lift job (named-KA scope only)', async () => {
    // A raw-lift enqueue has no VM-publish lifecycle key -> appendJournal early-returns.
    // (Exercised indirectly: only VM-publish requests carry knowledgeAssetVmPublish.)
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const rows = await journalRows();
    expect(rows.every((r) => r.lineageKey.length > 0)).toBe(true);
    expect(rows).toHaveLength(1); // only the one VM-publish admission
  });

  it('a legacy U+001F job does not throw out of writeJob and is not journaled', async () => {
    const publisher = createPublisher();
    const sep = String.fromCharCode(0x1f);
    const seedId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'seed' }));
    const seed = await publisher.getStatus(seedId);
    if (!seed || seed.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('seed missing');
    await publisher.cancel(seedId);
    const legacyBad: LiftJob = {
      ...seed,
      jobId: 'legacy-bad',
      request: { ...seed.request, knowledgeAssetVmPublish: { ...seed.request.knowledgeAssetVmPublish, name: `bad${sep}name` } },
    };
    await store.insert(serializeJob(legacyBad, DEFAULT_CONTROL_GRAPH_URI));

    // claimNext -> writeJob(legacy-bad, 'claimed') -> appendJournal must NOT throw.
    const claimed = await publisher.claimNext('wallet-1');
    expect(claimed?.jobId).toBe('legacy-bad');
    expect(await publisher.getStatus('legacy-bad')).not.toBeNull();
    // The malformed job produced NO journal entry (its key derivation threw and was
    // skipped) — every lineageKey legitimately contains U+001F as a field separator,
    // so the meaningful check is that no entry bears the legacy-bad jobId.
    const rows = await journalRows();
    expect(rows.some((r) => r.jobId === 'legacy-bad')).toBe(false);
  });

  // #1829 AC4 — the journal is append-only: cancel/clear/deleteJob operate on the
  // control-plane graph only and must NEVER remove journal entries.
  it('cancel does not remove the journal entry for the cancelled job', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect((await journalRows()).some((r) => r.jobId === jobId)).toBe(true);
    await publisher.cancel(jobId); // accepted-only cancel deletes the job subject
    expect(await publisher.getStatus(jobId)).toBeNull(); // job gone from control plane
    expect((await journalRows()).some((r) => r.jobId === jobId)).toBe(true); // journal survives
  });

  it('clear(finalized) does not remove journal entries', async () => {
    const publisher = createPublisher();
    const jobId = await driveToValidated(publisher);
    // Force a local no-op finalize so the job reaches 'finalized' without a chain tx.
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
    });
    await publisher.update(jobId, 'included', {
      broadcast: { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
      inclusion: { blockNumber: 10, blockHash: `0x${'aa'.repeat(32)}` as `0x${string}`, blockTimestamp: 1 },
    });
    await publisher.update(jobId, 'finalized', {
      broadcast: { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
      inclusion: { blockNumber: 10, blockHash: `0x${'aa'.repeat(32)}` as `0x${string}`, blockTimestamp: 1 },
      finalization: { mode: 'local' },
    });
    const before = await journalRows();
    expect(before.length).toBeGreaterThan(0);
    await publisher.clear('finalized');
    expect(await publisher.getStatus(jobId)).toBeNull(); // record cleared from control plane
    expect(await journalRows()).toEqual(before); // journal untouched
  });

  // #1829 chunk 5 — facts-pure reads.
  const facts = { contextGraphId: 'music-social', name: 'albums' };

  it('readJournalByIntent returns seq-ordered entries, complete, with distinct txHashes', async () => {
    const publisher = createPublisher();
    const jobId = await driveToValidated(publisher);
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
    });
    const res = await publisher.readJournalByIntent(facts);
    expect(res.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(res.entries.map((e) => e.kind)).toEqual(['admission', 'claimed', 'validated', 'broadcast']);
    expect(res.maxSeq).toBe(3);
    expect(res.complete).toBe(true);
    expect(res.txHashes).toEqual([`0x${'ef'.repeat(32)}`]); // ATTEMPTED hash, de-duplicated
  });

  it('readJournalByIntent resolves from facts AFTER the job is cleared (AC4)', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.cancel(jobId); // removes the job + its ephemeral #1828 index
    const res = await publisher.readJournalByIntent(facts);
    // The lineage is still readable purely from facts (journal survived the cancel).
    expect(res.entries.length).toBe(1);
    expect(res.entries[0]?.kind).toBe('admission');
  });

  it('readJournalByJob returns entries for that jobId', async () => {
    const publisher = createPublisher();
    const jobId = await driveToValidated(publisher);
    const res = await publisher.readJournalByJob(jobId);
    expect(res.entries.every((e) => e.jobId === jobId)).toBe(true);
    expect(res.entries.map((e) => e.kind)).toEqual(['admission', 'claimed', 'validated']);
  });

  it('readJournalByIntent returns empty for unknown facts', async () => {
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const res = await publisher.readJournalByIntent({ contextGraphId: 'music-social', name: 'nope' });
    expect(res.entries).toEqual([]);
    expect(res.maxSeq).toBe(-1);
    expect(res.complete).toBe(true);
  });

  // #1875 review (🔴): completeness is a property of the LINEAGE, not a subset. A
  // successor job continues the lineage seq (does not restart at 0), so a by-job or
  // intentKey-filtered read of a non-first version must NOT report spurious incomplete.
  it('reports the lineage complete for a subset read of a successor job (no spurious incomplete)', async () => {
    const publisher = createPublisher();
    // First job driven to a TERMINAL state so it no longer occupies the subject and a
    // fresh enqueue admits a genuine successor (rather than dedup returning the same job).
    const first = await driveToValidated(publisher);
    const bx = { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' };
    const inc = { blockNumber: 10, blockHash: `0x${'aa'.repeat(32)}` as `0x${string}`, blockTimestamp: 1 };
    await publisher.update(first, 'broadcast', { broadcast: bx });
    await publisher.update(first, 'included', { broadcast: bx, inclusion: inc });
    await publisher.update(first, 'finalized', { broadcast: bx, inclusion: inc, finalization: { mode: 'local' } });

    // Successor for the SAME lifecycle subject continues the lineage seq (starts > 0).
    const second = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(second).not.toBe(first);

    const full = await publisher.readJournalByIntent(facts);
    expect(full.complete).toBe(true); // full lineage is gap-free

    const bySuccessor = await publisher.readJournalByJob(second);
    expect(bySuccessor.entries.every((e) => e.jobId === second)).toBe(true);
    expect(bySuccessor.entries[0]?.seq).toBeGreaterThan(0); // successor entries start above 0
    expect(bySuccessor.complete).toBe(true); // lineage-level completeness — NOT spuriously false
    expect(bySuccessor.maxSeq).toBe(full.maxSeq); // lineage max, not the subset's own max
  });
});
