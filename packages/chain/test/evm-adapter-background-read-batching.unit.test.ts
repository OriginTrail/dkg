// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter's own views over the batching seam: the same public reads, with
 * the number of physical requests they cost counted at the transport.
 */

import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  background,
  checkedAdapter,
  makeAdapter,
  PUBLISHER,
  rootOf,
} from './fixtures/request-counting-adapter.js';

afterEach(() => { delete process.env.DKG_DISABLE_RPC_READ_BATCHING; });

describe('adapter views in the background request class', () => {
  it('sends the first read directly while the bytecode check runs', async () => {
    const { adapter, requests } = makeAdapter();

    const root = await background(() => adapter.getLatestMerkleRoot(9n));

    expect(ethers.hexlify(root)).toBe(rootOf(9n));
    expect(requests).toEqual(['multicall3.getCode', 'kas.getLatestMerkleRoot']);
  });

  it('answers the three reads that authenticate an asset from one request', async () => {
    const { adapter, requests } = await checkedAdapter();

    const [root, rootCount, contextGraphId] = await background(() => Promise.all([
      adapter.getLatestMerkleRoot(7n),
      adapter.getMerkleRootCount(7n),
      adapter.getKAContextGraphId(7n),
    ]));

    expect(ethers.hexlify(root)).toBe(rootOf(7n));
    expect(rootCount).toBe(3n);
    expect(contextGraphId).toBe(42n);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('caps the aggregate request on every node, and leaves a direct view as it was', async () => {
    const { adapter, policies } = await checkedAdapter();

    await background(() => adapter.getLatestMerkleRoot(7n));
    await adapter.getLatestMerkleRoot(7n);

    expect(policies.get('multicall3.aggregate3')).toBe('watchdogPointRead');
    expect(policies.get('kas.getLatestMerkleRoot')).toBeUndefined();
  });

  it('answers a pass worth of positions and sizing reads from one request', async () => {
    const { adapter, requests } = await checkedAdapter();
    const ordinals = Array.from({ length: 10 }, (_unused, index) => BigInt(index));

    const [kaIds, contexts, count, publisher] = await background(() => Promise.all([
      Promise.all(ordinals.map((ordinal) => adapter.getContextGraphKCAt(42n, ordinal))),
      Promise.all(ordinals.map((ordinal) => adapter.getKnowledgeAssetUpdateContext(1_000n + ordinal))),
      adapter.getContextGraphKCCount(42n),
      adapter.getLatestMerkleRootPublisher(1_000n),
    ]));

    expect(kaIds).toEqual(ordinals.map((ordinal) => 1_000n + ordinal));
    expect(contexts[0]).toMatchObject({ merkleRootsCount: 3n, byteSize: 4_096n, merkleLeafCount: 17 });
    expect(count).toBe(10n);
    expect(publisher).toBe(PUBLISHER);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('returns the same values as the same reads issued in the foreground', async () => {
    const { adapter, requests } = await checkedAdapter();
    const read = () => Promise.all([
      adapter.getLatestMerkleRoot(5n),
      adapter.getMerkleRootCount(5n),
      adapter.getKnowledgeAssetUpdateContext(5n),
      adapter.getKAContextGraphId(5n),
      adapter.getContextGraphKCAt(42n, 3n),
      adapter.getLatestMerkleRootPublisher(5n),
    ]);

    const foreground = await read();
    const foregroundRequests = requests.splice(0);
    const batched = await background(read);

    expect(batched).toEqual(foreground);
    // One request per read in the foreground, as before; one for all in the background.
    expect(foregroundRequests.sort()).toEqual([
      'cgStorage.getContextGraphKaAt',
      'cgStorage.kaToContextGraph',
      'kas.getKnowledgeAssetUpdateContext',
      'kas.getKnowledgeAssetUpdateContext',
      'kas.getLatestMerkleRoot',
      'kas.getLatestMerkleRootPublisher',
    ]);
    expect(requests).toEqual(['multicall3.aggregate3']);
  });

  it('issues every read directly when the kill switch is set', async () => {
    const { adapter, requests } = await checkedAdapter();
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';

    await background(() => Promise.all([adapter.getLatestMerkleRoot(1n), adapter.getKAContextGraphId(1n)]));

    expect(requests).toEqual(['kas.getLatestMerkleRoot', 'cgStorage.kaToContextGraph']);
  });
});
