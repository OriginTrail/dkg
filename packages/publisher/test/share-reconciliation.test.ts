import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { shareEvidenceMatchesRequest } from '../src/share-completion-evidence.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { reconcileRetainedShare, validateShareReconciliationInput } from '../src/share-reconciliation.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_PAYLOAD, jobSubject, literal } from '../src/async-promote-queue-utils.js';
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
    expect(await reconcileRetainedShare(store, { ...input, ...different })).toMatchObject({
      outcome: 'unproven', mutationRetryAllowed: false });
  });
  it('rejects an internally inconsistent author and native identity before reads', async () => {
    const query = vi.spyOn(store, 'query');
    await expect(reconcileRetainedShare(store, { ...input, authorAddress: '0x5555555555555555555555555555555555555555' })).rejects.toThrow('author mismatch');
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
  it('refuses incomplete inventory rather than using a match before the cap', async () => {
    await complete();
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementationOnce(async (...args) => {
      const result = await query(...args);
      if (result.type !== 'bindings') throw new Error('expected bindings');
      return { ...result, bindings: Array.from({ length: 1001 }, () => result.bindings[0]) };
    });
    expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', reason: 'incomplete_inventory', inventory: { complete: false } });
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
      const query = store.query.bind(store);
      vi.spyOn(store, 'query').mockImplementationOnce(async (...args) => {
        const result = await query(...args);
        if (result.type !== 'bindings') throw new Error('expected bindings');
        const row = { ...result.bindings[0] };
        if (corruption === 'missing-payload') delete row.payload;
        else if (corruption === 'wrong-subject') row.job = 'urn:wrong:subject';
        else {
          const payload = JSON.parse(row.payload);
          if (corruption === 'unknown-version') payload.result.shareEvidence.version = 999;
          else payload.result.shareEvidence.agentAddress = 'different-lane';
          row.payload = JSON.stringify(payload);
        }
        return { ...result, bindings: [row] };
      });
      expect(await queue.reconcileShare(input)).toMatchObject({ outcome: 'unproven', mutationRetryAllowed: false });
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
