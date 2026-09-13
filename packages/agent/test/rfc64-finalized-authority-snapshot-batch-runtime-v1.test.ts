// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphAuthorityIndexId,
  ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';

import { Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1 } from
  '../src/rfc64/finalized-authority-snapshot-batch-runtime-v1.js';

const ID_9 = '9' as ContextGraphAuthorityIndexId;
const ID_10 = '10' as ContextGraphAuthorityIndexId;

function snapshot(
  contextGraphId: ContextGraphAuthorityIndexId,
  owner = '0x1111111111111111111111111111111111111111',
): ContextGraphAuthoritySnapshot {
  return {
    chainId: '20430',
    governanceContract: '0x3333333333333333333333333333333333333333',
    contextGraphId,
    owner,
    active: true,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: [owner],
    nameHash: `0x${contextGraphId.padStart(64, '0')}`,
    ownershipEra: '0',
    policyVersion: '0',
    rosterVersion: '0',
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
  };
}

describe('RFC-64 finalized authority snapshot batch runtime', () => {
  it('chunks 4,097 targets, preserves the requested graph, and merges only chunk-owned rows', async () => {
    const requestedId = '4097' as ContextGraphAuthorityIndexId;
    const secondChunkId = '4096' as ContextGraphAuthorityIndexId;
    const subscribedIds = Array.from(
      { length: 4_097 },
      (_, index) => String(index + 1) as ContextGraphAuthorityIndexId,
    );
    let markFirstChunkStarted!: () => void;
    let releaseFirstChunk!: () => void;
    const firstChunkStarted = new Promise<void>((resolve) => { markFirstChunkStarted = resolve; });
    const firstChunkGate = new Promise<void>((resolve) => { releaseFirstChunk = resolve; });
    const injectedOwner = '0xffffffffffffffffffffffffffffffffffffffff';
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      expect(targetIds.length).toBeLessThanOrEqual(4_096);
      const result = new Map(targetIds.map((targetId) => [targetId, snapshot(targetId)]));
      if (readSnapshots.mock.calls.length === 1) {
        // A custom reader returning an unrelated row must not let one chunk
        // inject authority into another chunk's caller.
        result.set(secondChunkId, snapshot(secondChunkId, injectedOwner));
        markFirstChunkStarted();
        await firstChunkGate;
      }
      return result;
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      collectionDelayMs: 0,
      collectAdditionalTargetIds: () => subscribedIds,
      readSnapshots,
    });

    const requested = runtime.read(requestedId);
    await firstChunkStarted;
    const overflowCaller = runtime.read(secondChunkId);
    releaseFirstChunk();

    await expect(requested).resolves.toMatchObject({
      contextGraphAuthorityIndexId: requestedId,
      batchTargetIds: expect.arrayContaining([requestedId]),
      snapshot: { contextGraphId: requestedId },
    });
    await expect(overflowCaller).resolves.toMatchObject({
      contextGraphAuthorityIndexId: secondChunkId,
      snapshot: {
        contextGraphId: secondChunkId,
        owner: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(readSnapshots).toHaveBeenCalledTimes(2);
    expect(readSnapshots.mock.calls.map(([targetIds]) => targetIds.length)).toEqual([
      4_096,
      1,
    ]);
    expect(readSnapshots.mock.calls[0]?.[0][0]).toBe(requestedId);
    expect(readSnapshots.mock.calls[0]?.[0]).not.toContain(secondChunkId);
    expect(readSnapshots.mock.calls[1]?.[0]).toEqual([secondChunkId]);
    await runtime.whenIdle();
  });

  it('starts a follow-up batch when a late caller was omitted from the closed target set', async () => {
    let markFirstReadStarted!: () => void;
    let releaseFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve; });
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      if (readSnapshots.mock.calls.length === 1) {
        markFirstReadStarted();
        await firstReadGate;
      }
      return new Map(targetIds.map((targetId) => [targetId, snapshot(targetId)]));
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      collectionDelayMs: 0,
      readSnapshots,
    });

    const first = runtime.read(ID_9);
    await firstReadStarted;
    const late = runtime.read(ID_10);
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledTimes(2));
    releaseFirstRead();

    await expect(first).resolves.toMatchObject({
      contextGraphAuthorityIndexId: ID_9,
      snapshot: { contextGraphId: ID_9 },
    });
    await expect(late).resolves.toMatchObject({
      contextGraphAuthorityIndexId: ID_10,
      snapshot: { contextGraphId: ID_10 },
    });
    expect(readSnapshots.mock.calls[0]?.[0]).toEqual([ID_9]);
    expect(readSnapshots.mock.calls[1]?.[0]).toEqual([ID_10]);
    await runtime.whenIdle();
  });

  it('does not let a freshness-fenced caller join an already running read', async () => {
    let markFirstReadStarted!: () => void;
    let releaseFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve; });
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let owner = '0x1111111111111111111111111111111111111111';
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      const capturedOwner = owner;
      if (readSnapshots.mock.calls.length === 1) {
        markFirstReadStarted();
        await firstReadGate;
      }
      return new Map(targetIds.map((targetId) => [
        targetId,
        snapshot(targetId, capturedOwner),
      ]));
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      collectionDelayMs: 0,
      readSnapshots,
    });

    const stale = runtime.read(ID_9);
    await firstReadStarted;
    owner = '0x2222222222222222222222222222222222222222';
    const fresh = runtime.read(ID_9, undefined, { requireReadAfterRequest: true });
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledTimes(2));
    releaseFirstRead();

    await expect(stale).resolves.toMatchObject({
      snapshot: { owner: '0x1111111111111111111111111111111111111111' },
    });
    await expect(fresh).resolves.toMatchObject({
      snapshot: { owner: '0x2222222222222222222222222222222222222222' },
    });
  });

  it('returns immutable evidence owned by the closed batch lifecycle', async () => {
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      collectionDelayMs: 0,
      collectAdditionalTargetIds: () => [ID_10],
      readSnapshots: async (targetIds) => new Map(
        targetIds.map((targetId) => [targetId, snapshot(targetId)]),
      ),
    });

    const evidence = await runtime.read(ID_9);
    expect(evidence.batchTargetIds).toEqual([ID_9, ID_10]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.batchTargetIds)).toBe(true);
    expect(Object.isFrozen(evidence.snapshot)).toBe(true);
    expect(Object.isFrozen(evidence.snapshot?.participantAgents)).toBe(true);
    expect(() => {
      (evidence.snapshot as { owner: string }).owner =
        '0x2222222222222222222222222222222222222222';
    }).toThrow();
    await runtime.whenIdle();
  });
});
