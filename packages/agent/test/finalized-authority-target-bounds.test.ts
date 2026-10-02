import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import {
  LOCAL_ID,
  NAME_HASH,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

const COLD_ID = 'cold-finalized-name';
const OTHER_NAME_HASH = `0x${'cd'.repeat(32)}`;
const OUT_OF_RANGE_UINT256 = 1n << 256n;
const ID_OUTSIDE_UINT256 = 'finalized Context Graph id is outside uint256';
const SNAPSHOT_MISMATCH =
  'finalized Context Graph authority snapshot does not match the requested active graph';

type Fixture = ReturnType<typeof selectedFixture>;

/**
 * A faithful finalized authority snapshot. Every field the chain boundary
 * publishes is populated so a scenario overrides exactly the one fact under
 * test and the guard sees a realistic projection rather than a stub.
 */
function makeSnapshot(
  overrides: Partial<ContextGraphAuthoritySnapshot> = {},
): ContextGraphAuthoritySnapshot {
  return {
    chainId: '8453',
    governanceContract: `0x${'11'.repeat(20)}`,
    contextGraphId: '7777',
    owner: `0x${'22'.repeat(20)}`,
    active: true,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: [`0x${'33'.repeat(20)}`],
    nameHash: NAME_HASH,
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '1',
    sourceBlockNumber: '1234',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
    ...overrides,
  };
}

/**
 * Address a name with no local subscription so registration routing reaches
 * the finalized authority index instead of a local/durable binding path.
 */
function useColdName(fixture: Fixture): void {
  fixture.agent.subscribedContextGraphs.clear();
  fixture.agent.wireIdToLocalCgId.clear();
  fixture.agent.contextGraphNameCommitment = () => NAME_HASH;
}

/**
 * An adapter whose only finalized capability is the batch id resolver, so the
 * agent builds `resolved-id` targets from the returned words.
 */
function installFinalizedIdReader(
  fixture: Fixture,
  idsByNameHash: ReadonlyMap<string, bigint>,
) {
  const resolveFinalizedContextGraphIdsByNameHashes = vi.fn(async () => idsByNameHash);
  const whenIdle = vi.fn(async () => undefined);
  Reflect.set(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader', {
    resolveFinalizedContextGraphIdsByNameHashes,
    readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
    whenIdle,
  });
  return { resolveFinalizedContextGraphIdsByNameHashes, whenIdle };
}

/**
 * An adapter whose only finalized capability is the batch snapshot resolver,
 * so the agent builds `resolved-snapshot` targets carrying full authority
 * evidence that the caller must re-validate.
 */
function installFinalizedSnapshotReader(
  fixture: Fixture,
  snapshotsByNameHash: ReadonlyMap<string, ContextGraphAuthoritySnapshot>,
) {
  const resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes = vi.fn(
    async () => snapshotsByNameHash,
  );
  const whenIdle = vi.fn(async () => undefined);
  Reflect.set(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader', {
    resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes,
    readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
    whenIdle,
  });
  return {
    resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes,
    whenIdle,
  };
}

describe('finalized Context Graph authority target bounds', () => {
  it.each([
    ['the zero slot', 0n],
    ['a word above uint256', OUT_OF_RANGE_UINT256],
  ])('fails closed when the finalized index binds a name to %s', async (
    _case,
    resolvedId,
  ) => {
    const fixture = selectedFixture();
    useColdName(fixture);
    const reader = installFinalizedIdReader(
      fixture,
      new Map([[NAME_HASH, resolvedId]]),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(COLD_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'chain-name-binding-unavailable',
        detail: ID_OUTSIDE_UINT256,
      });

    expect(reader.resolveFinalizedContextGraphIdsByNameHashes)
      .toHaveBeenCalledWith([NAME_HASH], {
        signal: expect.any(AbortSignal),
        // Registration discovery is a governed lane, so the adapter reports
        // whether a projection answered: a cache-served binding must not be
        // credited to the provider pool as recovery evidence.
        onContextGraphAuthorityProjectionServed: expect.any(Function),
      });
    // The physical index fence still runs, so the reported detail is the
    // guard's own message and not a teardown failure.
    expect(reader.whenIdle).toHaveBeenCalledOnce();
    // An out-of-range finalized word must never fall through to the
    // compatibility current-state resolver, which would answer 42 instead.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it.each([
    ['the graph is inactive', { active: false }],
    ['the id is not canonical decimal', { contextGraphId: '0042' }],
    ['the name commitment differs', { nameHash: OTHER_NAME_HASH }],
  ])('fails closed when the finalized snapshot says %s', async (
    _case,
    overrides: Partial<ContextGraphAuthoritySnapshot>,
  ) => {
    const fixture = selectedFixture();
    useColdName(fixture);
    const reader = installFinalizedSnapshotReader(
      fixture,
      new Map([[NAME_HASH, makeSnapshot(overrides)]]),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(COLD_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'chain-name-binding-unavailable',
        detail: SNAPSHOT_MISMATCH,
      });

    expect(reader.whenIdle).toHaveBeenCalledOnce();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('binds a cold name from a consistent finalized snapshot', async () => {
    const fixture = selectedFixture();
    useColdName(fixture);
    const reader = installFinalizedSnapshotReader(
      fixture,
      new Map([[NAME_HASH, makeSnapshot()]]),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(COLD_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 7777n,
        provenance: 'name-hash',
      });

    expect(reader.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .toHaveBeenCalledWith([NAME_HASH], {
        signal: expect.any(AbortSignal),
        // Registration discovery is a governed lane, so the adapter reports
        // whether a projection answered: a cache-served binding must not be
        // credited to the provider pool as recovery evidence.
        onContextGraphAuthorityProjectionServed: expect.any(Function),
      });
    expect(reader.whenIdle).toHaveBeenCalledOnce();
    // The finalized index owned the answer; the current-state resolver, which
    // returns the same id, was never consulted.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('binds a locally admitted name from a consistent finalized snapshot', async () => {
    const fixture = selectedFixture();
    const reader = installFinalizedSnapshotReader(
      fixture,
      new Map([[NAME_HASH, makeSnapshot()]]),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 7777n,
        provenance: 'reverse-name-hash',
      });

    expect(reader.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .toHaveBeenCalledWith([NAME_HASH], {
        signal: expect.any(AbortSignal),
        // Registration discovery is a governed lane, so the adapter reports
        // whether a projection answered: a cache-served binding must not be
        // credited to the provider pool as recovery evidence.
        onContextGraphAuthorityProjectionServed: expect.any(Function),
      });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range id carried by an otherwise consistent finalized snapshot', async () => {
    // The bounds guard owns every finalized target shape: a fully self
    // consistent active snapshot still cannot publish an unusable slot.
    const fixture = selectedFixture();
    useColdName(fixture);
    installFinalizedSnapshotReader(
      fixture,
      new Map([[NAME_HASH, makeSnapshot({
        contextGraphId: OUT_OF_RANGE_UINT256.toString(10),
      })]]),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(COLD_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'chain-name-binding-unavailable',
        detail: ID_OUTSIDE_UINT256,
      });
  });
});
