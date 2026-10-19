import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { shareEvidenceMatchesRequest } from '../src/share-completion-evidence.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { validateShareReconciliationInput } from '../src/share-reconciliation.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_PAYLOAD, PROMOTE_CONTEXT_GRAPH_ID, jobSubject, literal, serializeJobRecord } from '../src/async-promote-queue-utils.js';
import { SHARE_AUTHOR, shareEvidence } from './_helpers/share-completion-evidence.js';

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
  it.each([{ entities: undefined }, { assertionVersion: '01' }, { assertionVersion: '18446744073709551616' },
    { merkleRoot: 'not-a-root' }, { shareOperationId: 'with whitespace' }])('rejects incomplete or malformed intent %j', patch => {
    expect(() => validateShareReconciliationInput({ ...input, ...patch })).toThrow();
  });
});
