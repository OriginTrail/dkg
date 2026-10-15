import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_NEXT_RETRY_AT, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI,
  integer, jobSubject, literal,
} from '../src/async-lift-control-plane.js';
import { createAsyncLift2270Harness } from './_helpers/async-lift-2270-harness.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

describe('combined retry and accepted claim candidates', () => {
  const h = createAsyncLift2270Harness();
  beforeEach(() => h.reset());

  function selectionSources(calls: ReadonlyArray<readonly [unknown, { source?: string }?]>) {
    return calls.map(([, options]) => options?.source).filter((source) =>
      source === 'publisher.asyncLift.claimCandidates' || source === 'publisher.asyncLift.nextAccepted');
  }

  async function failure() {
    const p = h.createCorruptHeadPublisher({ retryBackoffBaseMs: 10_000, rand: () => 0.5 });
    const id = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'retry', shareOperationId: 'retry' }));
    await h.failWithCorruptHead(p, 'wallet-failure');
    return { p, id };
  }

  it('claims from a single combined snapshot when no retries are due', async () => {
    const p = h.createPublisher();
    const id = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const query = vi.spyOn(h.store, 'query');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(id);
    expect(selectionSources(query.mock.calls)).toEqual(['publisher.asyncLift.claimCandidates']);
    query.mockRestore();
  });

  it('retains the accepted-only read when automatic retry is disabled', async () => {
    const p = h.createPublisher({ autoRetryEnabled: false });
    const id = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const query = vi.spyOn(h.store, 'query');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(id);
    expect(selectionSources(query.mock.calls)).toEqual(['publisher.asyncLift.nextAccepted']);
    query.mockRestore();
  });

  it.each([false, true])('rereads accepted work after reacceptance with an existing candidate=%s', async (existing) => {
    const { p, id } = await failure();
    if (existing) await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'later', shareOperationId: 'later' }));
    h.advance(20_000);
    const query = vi.spyOn(h.store, 'query');
    const claimed = await p.claimNext('wallet-a');
    expect(claimed?.jobId).toBe(id);
    expect(claimed?.retries.retryCount).toBe(1);
    expect(selectionSources(query.mock.calls)).toEqual([
      'publisher.asyncLift.claimCandidates', 'publisher.asyncLift.nextAccepted',
    ]);
    query.mockRestore();
  });

  it('rereads conservatively when a decoded due index points to a future canonical retry', async () => {
    const { p, id } = await failure();
    await h.store.deleteByPattern({ graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject(id), predicate: CONTROL_NEXT_RETRY_AT });
    await h.store.insert([{ graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject(id), predicate: CONTROL_NEXT_RETRY_AT, object: integer(1) }]);
    const next = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'later', shareOperationId: 'later' }));
    const before = await p.getStatus(id);
    const query = vi.spyOn(h.store, 'query');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(next);
    expect(selectionSources(query.mock.calls)).toEqual([
      'publisher.asyncLift.claimCandidates', 'publisher.asyncLift.nextAccepted',
    ]);
    query.mockRestore();
    expect(await p.getStatus(id)).toEqual(before);
  });

  it('does not reinterpret malformed retry bindings as accepted work or force a fresh read', async () => {
    const p = h.createPublisher();
    const id = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await h.store.insert([
      { graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject('malformed'), predicate: CONTROL_NEXT_RETRY_AT, object: integer(1) },
      { graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject('malformed'), predicate: CONTROL_STATUS, object: literal('failed') },
      { graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject('malformed'), predicate: CONTROL_PAYLOAD, object: literal('{bad-json') },
    ]);
    const query = vi.spyOn(h.store, 'query');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(id);
    expect(selectionSources(query.mock.calls)).toEqual(['publisher.asyncLift.claimCandidates']);
    query.mockRestore();
  });

  it('retains held chain-proof failures and rereads when their derived retry index is due', async () => {
    const p = h.createPublisher();
    const held = await h.failAfterRecordedTxHash(p, kaVmPublishRequest({ name: 'held', shareOperationId: 'held' }));
    await h.store.insert([{ graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject(held.jobId), predicate: CONTROL_NEXT_RETRY_AT, object: integer(1) }]);
    const next = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'next', shareOperationId: 'next' }));
    const query = vi.spyOn(h.store, 'query');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(next);
    expect(selectionSources(query.mock.calls)).toEqual([
      'publisher.asyncLift.claimCandidates', 'publisher.asyncLift.nextAccepted',
    ]);
    query.mockRestore();
    expect((await p.getStatus(held.jobId))?.status).toBe('failed');
  });

  it('propagates a reaccept persistence failure before selecting or claiming accepted work', async () => {
    const { p, id } = await failure();
    const next = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'later', shareOperationId: 'later' }));
    h.advance(20_000);
    const error = new Error('reaccept store failure');
    const original = h.store.replaceSubject.bind(h.store);
    const replace = vi.spyOn(h.store, 'replaceSubject').mockImplementation(async (...args) => {
      if (args[1] === jobSubject(id)) throw error;
      return original(...args);
    });
    const query = vi.spyOn(h.store, 'query');
    await expect(p.claimNext('wallet-a')).rejects.toBe(error);
    expect(selectionSources(query.mock.calls)).toEqual(['publisher.asyncLift.claimCandidates']);
    query.mockRestore();
    replace.mockRestore();
    expect((await p.getStatus(next))?.status).toBe('accepted');
    expect((await p.getStatus(id))?.status).toBe('failed');
  });

  it('rereads the selected job under its job lock instead of trusting the candidate snapshot', async () => {
    const p = h.createPublisher();
    const id = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const original = h.store.query.bind(h.store);
    const query = vi.spyOn(h.store, 'query').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1]?.source === 'publisher.asyncLift.claimCandidates') {
        await h.store.deleteByPattern({ graph: DEFAULT_CONTROL_GRAPH_URI, subject: jobSubject(id), predicate: CONTROL_PAYLOAD });
      }
      return result;
    });
    expect(await p.claimNext('wallet-a')).toBeNull();
    expect(query.mock.calls.some(([, options]) => options?.source === 'publisher.asyncLift.getStatus')).toBe(true);
    query.mockRestore();
  });
});
