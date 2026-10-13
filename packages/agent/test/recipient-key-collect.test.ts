// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { WorkspaceAgentRecipient } from '@origintrail-official/dkg-publisher';
import { RecipientKeyCollect } from '../src/internal/recipient-key-collect.js';
import { RecipientKeyRouteFence } from '../src/internal/recipient-key-route-fence.js';

const AGENT = '0x1111111111111111111111111111111111111111';
const recipients = (): WorkspaceAgentRecipient[] => [{
  purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE, recipientId: `did:dkg:agent:${AGENT}`,
  recipientKeyId: 'urn:key', encryptionKeyAlgorithm: 'X25519',
  publicKeyBytes: new Uint8Array([1, 2]), agentAddress: AGENT, peerId: 'peer',
}];
const store = new OxigraphStore();
afterEach(() => vi.restoreAllMocks());
afterAll(() => store.close());

async function setup(load = vi.fn(async () => recipients())) {
  const fence = new RecipientKeyRouteFence(store);
  await fence.ensureReady();
  let now = 0;
  const collect = new RecipientKeyCollect(fence, load, () => now);
  return { fence, collect, load, advance: (ms: number) => { now += ms; } };
}

describe('recipient key collect generations', () => {
  it('shares one in-flight collect, owns caller bytes, and expires the short memo', async () => {
    const { collect, load, advance } = await setup();
    const result = await Promise.all(Array.from({ length: 20 }, () => collect.resolve(AGENT)));
    expect(load).toHaveBeenCalledOnce();
    result[0][0].publicKeyBytes![0] = 99;
    expect(result[1][0].publicKeyBytes![0]).toBe(1);
    expect((await collect.resolve(AGENT))[0].publicKeyBytes![0]).toBe(1);
    advance(1001);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bypasses a memo as soon as a key write starts and recollects after settlement', async () => {
    const { fence, collect, load } = await setup();
    await collect.resolve(AGENT);
    const settle = fence.begin({ quads: [{ subject: `did:dkg:agent:${AGENT}`, predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"other"', graph: 'urn:profile' }] });
    expect(fence.hasPendingWrites).toBe(true);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(2);
    settle('changed');
    expect(fence.hasPendingWrites).toBe(false);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps a memo during unrelated queue mutations', async () => {
    const { fence, collect, load } = await setup();
    await collect.resolve(AGENT);
    const settle = fence.begin({ removals: [{ subject: 'urn:job', graph: 'urn:queue' }] });
    expect(fence.hasPendingWrites).toBe(false);
    await collect.resolve(AGENT);
    settle('changed');
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledOnce();
  });

  it('drops a failed collect, so the same generation loads again and memoizes the result', async () => {
    const { fence, collect, load, advance } = await setup();
    await collect.resolve(AGENT);
    // The memo expires by age alone: the fence stays cacheable at one revision throughout,
    // so nothing but the eviction of the failure can let the retry reach the loader.
    advance(1001);
    const revision = fence.revision;
    load.mockRejectedValueOnce(new Error('key lookup failed'));
    const failed = await Promise.allSettled([collect.resolve(AGENT), collect.resolve(AGENT)]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(fence.cacheable).toBe(true);
    expect(fence.revision).toBe(revision);
    expect((await collect.resolve(AGENT))[0].publicKeyBytes![0]).toBe(1);
    expect(load).toHaveBeenCalledTimes(3);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not keep a collect that a key write overlapped, even one that changed nothing', async () => {
    let release!: (value: WorkspaceAgentRecipient[]) => void;
    const held = new Promise<WorkspaceAgentRecipient[]>((resolve) => { release = resolve; });
    const load = vi.fn(async () => recipients()).mockImplementationOnce(() => held);
    const { fence, collect } = await setup(load);
    const first = collect.resolve(AGENT);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const settle = fence.begin({ quads: [{ subject: `did:dkg:agent:${AGENT}`, predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"other"', graph: 'urn:profile' }] });
    release(recipients());
    await first;
    const revision = fence.revision;
    settle('unchanged');
    // Cacheable again at the same revision: only a dropped collect lets this one load.
    expect(fence.cacheable).toBe(true);
    expect(fence.revision).toBe(revision);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never memoizes after an indeterminate key write that can commit later', async () => {
    const { fence, collect, load } = await setup();
    await collect.resolve(AGENT);
    fence.begin({ quads: [{ subject: `did:dkg:agent:${AGENT}`, predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"other"', graph: 'urn:profile' }] })('indeterminate');
    await fence.ensureReady();
    await collect.resolve(AGENT);
    await collect.resolve(AGENT);
    expect(load).toHaveBeenCalledTimes(3);
    expect(fence.cacheable).toBe(false);
  });

  describe('a removal that only its graph proves harmless', () => {
    const GRAPH = 'urn:profile:fresh';
    const keyIn = (graph: string) => ({
      quads: [{ subject: `did:dkg:agent:${AGENT}`, predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, object: '"key"', graph }],
    });

    it('does not reuse a key that a timed-out removal of its graph can still delete', async () => {
      let stored = recipients();
      const { fence, collect } = await setup(vi.fn(async () => stored));
      // The graph holds no key fact when its removal starts, so the removal says nothing about keys yet.
      const settleRemoval = fence.begin({ removals: [{ graph: GRAPH }] });
      expect(fence.hasPendingWrites).toBe(false);
      // A key lands in that graph while the removal is in flight: the removal can now delete a key.
      fence.begin(keyIn(GRAPH))('changed');
      expect(fence.hasPendingWrites).toBe(true);
      // The removal times out. The backend may still run it, and nothing will say when.
      settleRemoval('indeterminate');
      expect(fence.hasPendingWrites).toBe(false);
      expect(await collect.resolve(AGENT)).toHaveLength(1);
      stored = [];
      // Inside what would be the memo's lifetime: a memoized answer would still carry the deleted key.
      expect(await collect.resolve(AGENT)).toEqual([]);
      expect(fence.cacheable).toBe(false);
    });

    it('counts as a pending key write from the moment its graph gains a key, until it settles', async () => {
      const { fence, collect, load } = await setup();
      const settleRemoval = fence.begin({ removals: [{ graph: GRAPH }] });
      fence.begin(keyIn(GRAPH))('changed');
      expect(fence.hasPendingWrites).toBe(true);
      await collect.resolve(AGENT);
      await collect.resolve(AGENT);
      expect(load).toHaveBeenCalledTimes(2);
      const revision = fence.revision;
      settleRemoval('changed');
      expect(fence.hasPendingWrites).toBe(false);
      expect(fence.revision).toBeGreaterThan(revision);
      // It settled with a known outcome, so the memo works again.
      await collect.resolve(AGENT);
      await collect.resolve(AGENT);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('stops memoizing when a key lands in a graph that a timed-out removal may still empty', async () => {
      const { fence, collect, load } = await setup();
      fence.begin({ removals: [{ graph: GRAPH }] })('indeterminate');
      // No key fact is at stake yet: the memo is unaffected.
      await collect.resolve(AGENT);
      await collect.resolve(AGENT);
      expect(load).toHaveBeenCalledOnce();
      fence.begin(keyIn(GRAPH))('changed');
      expect(fence.cacheable).toBe(false);
      await collect.resolve(AGENT);
      await collect.resolve(AGENT);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('stays out of the way while its graph never holds a key, whatever its outcome', async () => {
      const { fence, collect, load } = await setup();
      await collect.resolve(AGENT);
      for (const outcome of ['changed', 'unchanged', 'indeterminate'] as const) {
        const settleRemoval = fence.begin({ removals: [{ graph: 'urn:staging:1' }, { graph: 'urn:staging:2' }] });
        // A key written elsewhere meanwhile does not make this removal a key write.
        fence.begin(keyIn('urn:profile:other'))('unchanged');
        expect(fence.hasPendingWrites).toBe(false);
        await collect.resolve(AGENT);
        settleRemoval(outcome);
        expect(fence.cacheable).toBe(true);
      }
      await collect.resolve(AGENT);
      expect(load).toHaveBeenCalledOnce();
    });
  });

  it('never lets an old in-flight generation overwrite a newer collect', async () => {
    let release!: (value: WorkspaceAgentRecipient[]) => void;
    const old = new Promise<WorkspaceAgentRecipient[]>((resolve) => { release = resolve; });
    const load = vi.fn(async () => recipients()).mockImplementationOnce(() => old);
    const { fence, collect } = await setup(load);
    const first = collect.resolve(AGENT);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    fence.noteQuads([{ subject: `did:dkg:agent:${AGENT}`, predicate: DKG_ONTOLOGY.DKG_REVOKED_AT, object: '"now"', graph: 'urn:profile' }]);
    await collect.resolve(AGENT);
    release([{ ...recipients()[0], publicKeyBytes: new Uint8Array([99]) }]);
    await first;
    expect((await collect.resolve(AGENT))[0].publicKeyBytes![0]).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
