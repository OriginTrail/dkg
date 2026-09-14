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
  it('single-flights concurrent normal reads through one immutable target snapshot', async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      await readGate;
      return new Map(targetIds.map((targetId) => [targetId, snapshot(targetId)]));
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({ readSnapshots });
    const batch = runtime.createBatch([ID_9, ID_10]);

    const first = batch.read(ID_9);
    const second = batch.read(ID_10);
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledOnce());
    expect(readSnapshots).toHaveBeenCalledWith([ID_9, ID_10]);
    releaseRead();

    await expect(first).resolves.toMatchObject({
      contextGraphAuthorityIndexId: ID_9,
      batchTargetIds: [ID_9, ID_10],
      snapshot: { contextGraphId: ID_9 },
    });
    await expect(second).resolves.toMatchObject({
      contextGraphAuthorityIndexId: ID_10,
      batchTargetIds: [ID_9, ID_10],
      snapshot: { contextGraphId: ID_10 },
    });
    await runtime.whenIdle();
  });

  it('delegates 4,097 logical targets once and merges only batch-owned rows', async () => {
    const requestedId = '4097' as ContextGraphAuthorityIndexId;
    const otherCallerId = '4096' as ContextGraphAuthorityIndexId;
    const subscribedIds = Array.from(
      { length: 4_097 },
      (_, index) => String(index + 1) as ContextGraphAuthorityIndexId,
    );
    let markReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      expect(targetIds).toHaveLength(4_097);
      const result = new Map(targetIds.map((targetId) => [targetId, snapshot(targetId)]));
      result.set('9999' as ContextGraphAuthorityIndexId, snapshot(
        '9999' as ContextGraphAuthorityIndexId,
      ));
      markReadStarted();
      await readGate;
      return result;
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({ readSnapshots });
    const batch = runtime.createBatch(subscribedIds);

    const requested = batch.read(requestedId);
    await readStarted;
    const otherCaller = batch.read(otherCallerId);
    releaseRead();

    await expect(requested).resolves.toMatchObject({
      contextGraphAuthorityIndexId: requestedId,
      batchTargetIds: expect.arrayContaining([requestedId]),
      snapshot: { contextGraphId: requestedId },
    });
    await expect(otherCaller).resolves.toMatchObject({
      contextGraphAuthorityIndexId: otherCallerId,
      snapshot: {
        contextGraphId: otherCallerId,
        owner: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(readSnapshots).toHaveBeenCalledOnce();
    expect(readSnapshots.mock.calls[0]?.[0][0]).toBe(subscribedIds[0]);
    expect(readSnapshots.mock.calls[0]?.[0]).toContain(otherCallerId);
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

  it('does not let a later explicit batch join an already running read', async () => {
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
      readSnapshots,
    });

    const stale = runtime.createBatch([ID_9]).read(ID_9);
    await firstReadStarted;
    owner = '0x2222222222222222222222222222222222222222';
    const fresh = runtime.createBatch([ID_9]).read(ID_9);
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledTimes(2));
    releaseFirstRead();

    await expect(stale).resolves.toMatchObject({
      snapshot: { owner: '0x1111111111111111111111111111111111111111' },
    });
    await expect(fresh).resolves.toMatchObject({
      snapshot: { owner: '0x2222222222222222222222222222222222222222' },
    });
  });

  it('shares one explicit batch across CG lanes and fences a later batch', async () => {
    let owner = '0x1111111111111111111111111111111111111111';
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => new Map(targetIds.map((targetId) => [targetId, snapshot(targetId, owner)])));
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({ readSnapshots });
    const firstPass = runtime.createBatch([ID_9, ID_10]);

    await expect(Promise.all([
      firstPass.read(ID_9),
      firstPass.read(ID_10),
    ])).resolves.toHaveLength(2);
    // A lane that reaches the owner after the read completed still consumes
    // the exact pass-owned evidence rather than starting another full batch.
    await firstPass.read(ID_10);
    expect(readSnapshots).toHaveBeenCalledOnce();

    owner = '0x2222222222222222222222222222222222222222';
    await expect(runtime.createBatch([ID_9]).read(ID_9))
      .resolves.toMatchObject({ snapshot: { owner } });
    expect(readSnapshots).toHaveBeenCalledTimes(2);
  });

  it('detaches a cancelled caller while shared physical evidence drains', async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => {
      await readGate;
      return new Map(targetIds.map((targetId) => [targetId, snapshot(targetId)]));
    });
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({ readSnapshots });
    const batch = runtime.createBatch([ID_9, ID_10]);
    const abort = new AbortController();

    const cancelled = batch.read(ID_9, abort.signal);
    const survivor = batch.read(ID_10);
    await vi.waitFor(() => expect(readSnapshots).toHaveBeenCalledOnce());
    abort.abort(new Error('caller closed'));
    await expect(cancelled).rejects.toThrow('caller closed');

    let idle = false;
    const drain = runtime.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    releaseRead();
    await expect(survivor).resolves.toMatchObject({
      snapshot: { contextGraphId: ID_10 },
    });
    await drain;
    expect(idle).toBe(true);
  });

  it('returns immutable evidence owned by the closed batch lifecycle', async () => {
    const runtime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      readSnapshots: async (targetIds) => new Map(
        targetIds.map((targetId) => [targetId, snapshot(targetId)]),
      ),
    });

    const evidence = await runtime.createBatch([ID_9, ID_10]).read(ID_9);
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
