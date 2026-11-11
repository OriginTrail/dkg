// SPDX-License-Identifier: Apache-2.0

/**
 * A Knowledge Asset's latest root and its publisher are read together.
 *
 * Background views issued in the same turn leave the EVM adapter as one
 * Multicall3 request. The VM reconcile pass and the ACK promotion lanes read
 * the root and then the publisher, so each pair cost two requests, and an
 * ordinal that stays pending reads the pair again on every sweep.
 * Pure: stub adapters, and the real EVM adapter over the chain package's
 * request-counting transport double. No hardhat.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { readLatestMerkleRootAndPublisher } from '../src/ka-latest-root-and-publisher.js';
import {
  background,
  checkedAdapter,
  PUBLISHER,
  rootOf,
} from '../../chain/test/fixtures/request-counting-adapter.js';

const ROOT = ethers.getBytes(rootOf(7n));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A chain whose two reads answer only when the test says so. */
function heldChain() {
  const root = deferred<Uint8Array>();
  const publisher = deferred<string>();
  const asked: string[] = [];
  return {
    root,
    publisher,
    asked,
    chain: {
      getLatestMerkleRoot: (kaId: bigint) => { asked.push(`root:${kaId}`); return root.promise; },
      getLatestMerkleRootPublisher: (kaId: bigint) => { asked.push(`publisher:${kaId}`); return publisher.promise; },
    },
  };
}

describe('readLatestMerkleRootAndPublisher', () => {
  it('asks for both views before either answers', async () => {
    const held = heldChain();

    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    expect(held.asked).toEqual(['root:7', 'publisher:7']);

    held.publisher.resolve(PUBLISHER);
    held.root.resolve(ROOT);
    await expect(read).resolves.toEqual({ merkleRoot: ROOT, publisherAddress: PUBLISHER });
  });

  it('reports the root\'s failure first, as when the publisher was read after it', async () => {
    const held = heldChain();
    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    held.publisher.reject(new Error('publisher read failed'));
    held.root.reject(new Error('root read failed'));
    await expect(read).rejects.toThrow('root read failed');
  });

  it('reports the publisher\'s failure when the root was read', async () => {
    const held = heldChain();
    const read = readLatestMerkleRootAndPublisher(held.chain, 7n);
    held.root.resolve(ROOT);
    held.publisher.reject(new Error('publisher read failed'));
    await expect(read).rejects.toThrow('publisher read failed');
  });

  it('takes no publisher as an empty address, as the callers always did', async () => {
    await expect(readLatestMerkleRootAndPublisher({ getLatestMerkleRoot: async () => ROOT }, 7n))
      .resolves.toEqual({ merkleRoot: ROOT, publisherAddress: '' });
    await expect(readLatestMerkleRootAndPublisher({
      getLatestMerkleRoot: async () => ROOT,
      getLatestMerkleRootPublisher: async () => undefined as unknown as string,
    }, 7n)).resolves.toEqual({ merkleRoot: ROOT, publisherAddress: '' });
  });

  it('costs one request through the adapter\'s background batching, where one read after the other costs two', async () => {
    const { adapter, requests } = await checkedAdapter();

    const together = await background(() => readLatestMerkleRootAndPublisher(adapter, 7n));
    expect(together).toEqual({ merkleRoot: ROOT, publisherAddress: PUBLISHER });
    expect(requests).toEqual(['multicall3.aggregate3']);

    requests.length = 0;
    await background(async () => {
      await adapter.getLatestMerkleRoot(7n);
      await adapter.getLatestMerkleRootPublisher(7n);
    });
    expect(requests).toEqual(['multicall3.aggregate3', 'multicall3.aggregate3']);
  });
});
