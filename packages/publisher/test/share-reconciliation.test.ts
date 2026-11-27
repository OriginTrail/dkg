import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { shareEvidenceMatchesRequest } from '../src/share-completion-evidence.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { validateShareReconciliationInput } from '../src/share-reconciliation.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_PAYLOAD, PROMOTE_CONTEXT_GRAPH_ID, jobSubject, literal, serializeJobRecord } from '../src/async-promote-queue-utils.js';
import { SHARE_AUTHOR, shareEvidence } from './_helpers/share-completion-evidence.js';

import { mk, put, PREPARATION_ERROR, STARTED } from './_helpers/share-retention-fixtures.js';

const proof = shareEvidence();
const request = { contextGraphId: proof.contextGraphId, assertionName: proof.assertionName,
  agentAddress: SHARE_AUTHOR, entities: 'all' as const };
const input = { ...request, authorAddress: SHARE_AUTHOR, kaUal: proof.seal.kaUal,
  assertionVersion: proof.seal.assertionVersion, merkleRoot: proof.seal.assertionMerkleRoot };

describe('retained share reconciliation', () => {
  let store: OxigraphStore, queue: TripleStoreAsyncPromoteQueue;
  beforeEach(() => { store = new OxigraphStore(); queue = new TripleStoreAsyncPromoteQueue(store); });
  async function complete(withEvidence = true) {
    const id = await queue.enqueue(request), job = (await queue.claimNext('worker'))!;
    await queue.recordCommitMarker(id, job.lease!.claimToken, 'swmInserted');
    await queue.succeed(id, job.lease!.claimToken, { promotedCount: 1, succeededAt: Date.now(),
      ...(withEvidence ? { shareEvidence: proof } : {}) });
    return id;
  }
  it('continues to prove an unrelated share after retirement and still rejects malformed queue subjects', async () => {
    const id = await complete();
    const failed = mk('other-job', 'failed', { bound: true, commitMarker: STARTED,
      attempt: { count: 1, maxRetries: 3, lastError: PREPARATION_ERROR } });
    await put(store, failed);
    const before = await queue.reconcileShare(input);
    expect(before).toMatchObject({ outcome: 'proven', jobId: id });
    const preview = await queue.retireFailedJob(failed.jobId);
    if (preview.outcome !== 'eligible') throw Error('missing preview');
    expect(await queue.retireFailedJob(failed.jobId, {
      expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true,
    })).toMatchObject({ outcome: 'retired' });
    expect(await queue.reconcileShare(input)).toEqual(before);
    await store.insert([{ graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI, subject: 'urn:example:incomplete',
      predicate: PROMOTE_CONTEXT_GRAPH_ID, object: literal('other') }]);
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'incomplete_inventory' });
  });
  it('exposes reconciliation only through the synchronized queue capability', async () => {
    const exports = await import('../src/index.js');
    expect(exports).not.toHaveProperty('reconcileRetainedShare');
    expect(exports).not.toHaveProperty('reconcileRetainedShareUnlocked');
  });
  it.each(['missing', 'mismatched'] as const)('cannot overlook a retained payload with a %s context index', async kind => {
    await complete();
    const hiddenId = await complete();
    await store.deleteByPattern({ graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      subject: jobSubject(hiddenId), predicate: PROMOTE_CONTEXT_GRAPH_ID });
    if (kind === 'mismatched') await store.insert([{ graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      subject: jobSubject(hiddenId), predicate: PROMOTE_CONTEXT_GRAPH_ID, object: literal('another-context') }]);
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'incomplete_inventory', inventory: { complete: false } });
  });
  it('ignores valid unrelated-context records after checking their canonical identity', async () => {
    const id = await complete(), job = (await queue.getStatus(id))!;
    await store.insert(serializeJobRecord({ ...job, jobId: 'unrelated',
      request: { ...request, contextGraphId: 'another-context' }, result: undefined,
    }, DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads);
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'proven', jobId: id });
  });
  it('proves actual persisted completion after queue reconstruction without another enqueue', async () => {
    const id = await complete();
    const next = new TripleStoreAsyncPromoteQueue(store);
    const enqueue = vi.spyOn(next, 'enqueue');
    expect(await next.reconcileShare(input)).toMatchObject({ outcome: 'proven', jobId: id,
      mutationRetryAllowed: false, evidence: proof, inventory: { complete: true } });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { agentAddress: '0x5555555555555555555555555555555555555555' },
    { assertionVersion: '1' }, { merkleRoot: `0x${'bb'.repeat(32)}` },
    { kaUal: `did:dkg:evm:31337/${SHARE_AUTHOR}/8` },
    { entities: ['urn:partial'] }, { subGraphName: 'other' }, { shareOperationId: 'previous-epoch' },
  ])('does not associate a different exact selector: %j', async different => {
    await complete();
    expect(await queue.reconcileShare({ ...input, ...different })).toMatchObject({
      outcome: 'unproven', mutationRetryAllowed: false });
  });
  it('normalizes mixed-case identity before canonical scalar validation', () => {
    const normalized = validateShareReconciliationInput({ ...input,
      authorAddress: `0x${input.authorAddress.slice(2).toUpperCase()}`,
      merkleRoot: `0x${input.merkleRoot.slice(2).toUpperCase()}` });
    expect(normalized.authorAddress).toBe(input.authorAddress.toLowerCase());
    expect(normalized.merkleRoot).toBe(input.merkleRoot.toLowerCase());
  });
  it('rejects an internally inconsistent author and native identity before reads', async () => {
    const query = vi.spyOn(store, 'query');
    await expect(queue.reconcileShare({ ...input, authorAddress: '0x5555555555555555555555555555555555555555' })).rejects.toThrow('author mismatch');
    expect(query).not.toHaveBeenCalled();
  });
  it('does not choose between multiple successful matching jobs', async () => {
    await complete(); await complete();
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'ambiguous' });
  });
  it('does not upgrade an old success from a matching current descriptor or request metadata', async () => {
    await queue.enqueue({ ...request, shareEvidence: proof });
    const job = (await queue.claimNext('worker'))!;
    expect(job.request).not.toHaveProperty('shareEvidence');
    await queue.recordCommitMarker(job.jobId, job.lease!.claimToken, 'swmInserted');
    await queue.succeed(job.jobId, job.lease!.claimToken, { promotedCount: 1, succeededAt: Date.now() });
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'unsupported_legacy_evidence' });
  });
  it('keeps a potentially matching legacy row from establishing uniqueness', async () => {
    await complete(false); await complete();
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'unsupported_legacy_evidence' });
  });
  it('keeps unfinished work unproven', async () => {
    await queue.enqueue(request);
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'unfinished' });
  });
  it('reports pruning conservatively and never writes on a reconciliation read', async () => {
    const id = await complete(); await queue.clearTerminalJob(id);
    const write = vi.spyOn(store, 'insert');
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'absent_or_pruned', mutationRetryAllowed: false });
    expect(write).not.toHaveBeenCalled();
  });
  it('fetches an overflow record from a real 1001-record context inventory', async () => {
    const id = await complete(), job = (await queue.getStatus(id))!;
    await store.insert(Array.from({ length: 1000 }, (_, i) => serializeJobRecord({ ...job,
      jobId: `retained-${i}`, request: { ...request, assertionName: `other-${i}` }, result: undefined,
    }, DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads).flat());
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'incomplete_inventory', inventory: { complete: false } });
  });
  it('waits for a competing fallback replacement instead of proving a temporarily incomplete inventory', async () => {
    await complete();
    let pause!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { pause = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    const fallback = new Proxy(store, { get(target, prop) {
      if (prop === 'replaceSubject') return undefined;
      if (prop === 'insert') return async (...args: Parameters<OxigraphStore['insert']>) => {
        if (armed) { pause(); await gate; }
        return target.insert(...args);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const writer = new TripleStoreAsyncPromoteQueue(fallback);
    await writer.enqueue(request);
    armed = true;
    const claim = writer.claimNext('fallback-worker');
    await paused;
    let settled = false;
    const observation = queue.reconcileShare(input).then(value => { settled = true; return value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { release(); await claim; }
    expect(await observation).toMatchObject({ outcome: 'unproven', reason: 'unfinished' });
  });
  it('does not hide an unavailable read behind an empty candidate set', async () => {
    vi.spyOn(store, 'query').mockRejectedValueOnce(new Error('store unavailable'));
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'unavailable', mutationRetryAllowed: false });
  });
  it('refuses conflicting payloads for one subject', async () => {
    const id = await complete();
    const job = (await queue.getStatus(id))!;
    await store.insert([{ graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI, subject: jobSubject(id), predicate: PROMOTE_PAYLOAD,
      object: literal(JSON.stringify({ ...job, updatedAt: job.updatedAt + 1 })) }]);
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'conflicting_evidence' });
  });
  it.each(['missing-payload', 'wrong-subject', 'unknown-version', 'bad-request-binding'] as const)(
    'does not silently omit a %s row', async corruption => {
      await complete();
      const id = await complete(), job = (await queue.getStatus(id))!;
      const originalSubject = jobSubject(id);
      let quads = serializeJobRecord(job, DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads;
      if (corruption === 'missing-payload') quads = quads.filter(q => q.predicate !== PROMOTE_PAYLOAD);
      else if (corruption === 'wrong-subject') quads = quads.map(q => ({ ...q, subject: 'urn:wrong:subject' }));
      else {
        const payload = JSON.parse(JSON.stringify(job));
        if (corruption === 'unknown-version') payload.result.shareEvidence.version = 999;
        else payload.result.shareEvidence.agentAddress = 'different-lane';
        quads = serializeJobRecord(payload, DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads;
      }
      await store.deleteByPattern({ graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI, subject: originalSubject });
      await store.insert(quads);
      expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', mutationRetryAllowed: false,
        reason: ['missing-payload', 'wrong-subject'].includes(corruption) ? 'incomplete_inventory' : 'conflicting_evidence' });
    });
  it('requires bound completion to match both the admitted seal digest and operation', () => {
    const recoveryBinding = { version: 1 as const, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(proof.seal),
      inventoryRequired: false, intent: { version: 1 as const, operationId: proof.shareOperationId,
        timestampMs: 1, confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] } };
    expect(shareEvidenceMatchesRequest(proof, { ...request, recoveryBinding })).toBe(true);
    expect(shareEvidenceMatchesRequest(proof, { ...request, recoveryBinding: { ...recoveryBinding, sealDigest: `0x${'bb'.repeat(32)}` } })).toBe(false);
    expect(shareEvidenceMatchesRequest({ ...proof, shareOperationId: 'another-operation' }, { ...request, recoveryBinding })).toBe(false);
  });
  it('rejects producer evidence from another lane at the success boundary', async () => {
    const id = await queue.enqueue(request), job = (await queue.claimNext('worker'))!;
    await queue.recordCommitMarker(id, job.lease!.claimToken, 'swmInserted');
    await expect(queue.succeed(id, job.lease!.claimToken, { promotedCount: 1, succeededAt: Date.now(),
      shareEvidence: { ...proof, agentAddress: 'different-peer' } })).rejects.toThrow('does not match');
    expect((await queue.getStatus(id))?.state).toBe('running');
  });
  describe('atomic bound share completion', () => {
    const boundRequest = { ...request, recoveryBinding: {
      version: 1 as const, sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(proof.seal),
      inventoryRequired: false, intent: { version: 1 as const, operationId: proof.shareOperationId,
        timestampMs: 1, confirmationRequired: false, accessPolicy: 'public' as const, allowedPeers: [] },
    } };
    const result = () => ({ promotedCount: 1, succeededAt: Date.now(), shareEvidence: proof });
    async function started() {
      const id = await queue.enqueue(boundRequest);
      const job = (await queue.claimNext('worker'))!;
      await queue.recordCommitMarker(id, job.lease!.claimToken, 'promoteStarted');
      return (await queue.getStatus(id))!;
    }

    it.each(['lane', 'seal', 'operation'] as const)('refuses %s mismatch without persisting any marker or result', async mismatch => {
      const job = await started();
      const variants = {
        lane: { ...proof, agentAddress: 'different-peer' },
        seal: { ...proof, seal: { ...proof.seal, assertionMerkleRoot: `0x${'bb'.repeat(32)}` } },
        operation: { ...proof, shareOperationId: 'other-operation' },
      };
      const write = vi.spyOn(store, 'replaceSubject');
      await expect(queue.succeedWithShareEvidence(job.jobId, job.lease!.claimToken,
        { ...result(), shareEvidence: variants[mismatch] })).rejects.toThrow('does not match');
      expect(write).not.toHaveBeenCalled();
      expect(await queue.getStatus(job.jobId)).toEqual(job);
    });

    it.each(['unbound', 'unstarted'] as const)('does not grant atomic completion authority to an %s job', async mode => {
      const id = await queue.enqueue(mode === 'unbound' ? request : boundRequest);
      const claimed = (await queue.claimNext('worker'))!;
      if (mode === 'unbound') await queue.recordCommitMarker(id, claimed.lease!.claimToken, 'promoteStarted');
      const before = await queue.getStatus(id);
      await expect(queue.succeedWithShareEvidence(id, claimed.lease!.claimToken, result())).rejects.toThrow('started, bound');
      expect(await queue.getStatus(id)).toEqual(before);
    });

    it.each(['wrong-token', 'expired'] as const)('refuses a %s lease without changing the durable started job', async mode => {
      let now = 1_000_000;
      queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100 });
      const job = await started();
      if (mode === 'expired') now += 100;
      const write = vi.spyOn(store, 'replaceSubject');
      await expect(queue.succeedWithShareEvidence(job.jobId,
        mode === 'wrong-token' ? 'stale-claim' : job.lease!.claimToken, result()))
        .rejects.toMatchObject({ name: 'PromoteJobLeaseError' });
      expect(write).not.toHaveBeenCalled();
      expect(await queue.getStatus(job.jobId)).toEqual(job);
    });

    it.each(['acknowledged', 'not-written', 'lost-ack'] as const)(
      'reconstructs exact success or the original started state after %s', async outcome => {
        const job = await started();
        const completion = result();
        const replace = store.replaceSubject.bind(store);
        const write = vi.spyOn(store, 'replaceSubject').mockImplementation(async (...args) => {
          if (outcome === 'not-written') throw new Error('store unavailable');
          await replace(...args);
          if (outcome === 'lost-ack') throw new Error('acknowledgement lost');
        });
        const finishing = queue.succeedWithShareEvidence(job.jobId, job.lease!.claimToken, completion);
        if (outcome === 'acknowledged') await expect(finishing).resolves.toBeUndefined();
        else await expect(finishing).rejects.toThrow(outcome === 'not-written' ? 'store unavailable' : 'acknowledgement lost');
        expect(write).toHaveBeenCalledTimes(1);
        write.mockRestore();

        // Reconstruct over the actual persisted triples, not the writer's local cache.
        const restarted = new TripleStoreAsyncPromoteQueue(store);
        const enqueue = vi.spyOn(restarted, 'enqueue');
        await restarted.recoverOnStartup();
        if (outcome === 'not-written') {
          expect(await restarted.getStatus(job.jobId)).toEqual(job);
          expect(await restarted.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'unfinished' });
        } else {
          const persisted = (await restarted.getStatus(job.jobId))!;
          expect(persisted).toMatchObject({ state: 'succeeded', result: completion,
            commitMarker: { ...job.commitMarker, swmInserted: true } });
          expect(persisted.lease).toBeUndefined();
          expect(persisted.request).toEqual(job.request);
          expect(persisted.attempt).toEqual(job.attempt);
          expect(await restarted.reconcileShare(input)).toMatchObject({ outcome: 'proven',
            jobId: job.jobId, evidence: proof, mutationRetryAllowed: false });
          await expect(restarted.succeedWithShareEvidence(job.jobId, job.lease!.claimToken, completion))
            .rejects.toMatchObject({ name: 'PromoteJobLeaseError' });
        }
        expect(await restarted.claimNext('replacement-worker')).toBeNull();
        expect(await restarted.list()).toHaveLength(1);
        expect(enqueue).not.toHaveBeenCalled();
      });
  });
  it.each([{ entities: undefined }, { assertionVersion: '0' }, { assertionVersion: '01' }, { authorAddress: `0x${'00'.repeat(20)}` }, { assertionVersion: '18446744073709551616' },
    { merkleRoot: 'not-a-root' }, { shareOperationId: 'with whitespace' }])('rejects incomplete or malformed intent %j', patch => {
    expect(() => validateShareReconciliationInput({ ...input, ...patch })).toThrow();
  });
});
