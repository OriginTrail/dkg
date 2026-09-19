/**
 * `resolveFinalizedVmReconcileBinding` — snapshot acquisition for finalized
 * authority targets that the index projected WITHOUT an inline snapshot.
 *
 * A legacy-shaped authority index (one that can reverse a name commitment to a
 * numeric id but cannot project the authority state atomically) yields a
 * `resolved-id` target. VM reconciliation must then fetch the finalized
 * snapshot itself through the adapter's authority-reader capability, and must
 * fail closed when that capability is absent rather than reconciling against
 * unproven authority evidence.
 *
 * These scenarios also pin the cancellation contract around that read: an
 * inner failure that races a target rotation or an abort must surface as
 * `VmReconcileQueueClosedError` (the queue's "stop, do not retry" signal),
 * while a genuine failure on a still-current target must reach the caller
 * unchanged so it can be logged and retried.
 *
 * Hermetic: the real `resolveFinalizedContextGraphAuthorityTargetsV1` runs; only
 * the chain-boundary readers are stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import { VmReconcileQueueClosedError } from '../src/vm-reconcile-service.js';
import {
  LOCAL_ID,
  NAME_HASH,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

const ON_CHAIN_ID = 77n;

type FinalizedVmReconcileBinding =
  | { kind: 'legacy-current' }
  | { kind: 'absent' }
  | { kind: 'resolved'; nameHash: string; onChainId: string; onChainCgId: bigint };

/** Public method graph exercised here; the fixture agent is a real prototype. */
interface FinalizedBindingHost {
  resolveFinalizedVmReconcileBinding(
    localCgId: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<FinalizedVmReconcileBinding>;
}

function authoritySnapshot(
  overrides: Partial<ContextGraphAuthoritySnapshot> = {},
): ContextGraphAuthoritySnapshot {
  return {
    chainId: 'hardhat:31337',
    governanceContract: `0x${'11'.repeat(20)}`,
    contextGraphId: ON_CHAIN_ID.toString(10),
    owner: `0x${'22'.repeat(20)}`,
    active: true,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: [],
    // Deliberately upper-case wire form: evidence comparison must normalize
    // through `contextGraphWireId` instead of comparing raw adapter strings.
    nameHash: `0x${'AB'.repeat(32)}`,
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '1',
    sourceBlockNumber: '1024',
    sourceBlockHash: `0x${'33'.repeat(32)}`,
    ...overrides,
  };
}

type ReaderCapability =
  | { status: 'unsupported'; reason: 'get-context-graph-authority-snapshot-unavailable' }
  | {
      status: 'supported';
      reader: {
        getContextGraphAuthoritySnapshot: (
          contextGraphId: bigint,
          options?: { signal?: AbortSignal },
        ) => Promise<ContextGraphAuthoritySnapshot>;
      };
    };

/**
 * Wire an authority index that can only reverse name commitments to ids, so
 * the projected target is `resolved-id` and the caller owns the snapshot read.
 */
function resolvedIdTargetFixture(capability: ReaderCapability) {
  const fixture = selectedFixture();
  const whenIdle = vi.fn(async () => undefined);
  const resolveFinalizedContextGraphIdByNameHash = vi.fn(async () => ON_CHAIN_ID);
  Reflect.set(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader', {
    resolveFinalizedContextGraphIdByNameHash,
    whenIdle,
  });
  Reflect.set(fixture.agent, 'contextGraphAuthorityReaderCapability', capability);
  Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set<string>());
  return {
    agent: fixture.agent as unknown as FinalizedBindingHost,
    whenIdle,
    resolveFinalizedContextGraphIdByNameHash,
  };
}

function supportedCapability(
  getContextGraphAuthoritySnapshot: (
    contextGraphId: bigint,
    options?: { signal?: AbortSignal },
  ) => Promise<ContextGraphAuthoritySnapshot>,
) {
  const reader = { getContextGraphAuthoritySnapshot: vi.fn(getContextGraphAuthoritySnapshot) };
  return { capability: { status: 'supported' as const, reader }, reader };
}

const UNSUPPORTED_CAPABILITY = {
  status: 'unsupported' as const,
  reason: 'get-context-graph-authority-snapshot-unavailable' as const,
};

describe('resolveFinalizedVmReconcileBinding snapshot acquisition', () => {
  it('fails closed when a snapshotless finalized target has no authority reader', async () => {
    const { agent, whenIdle, resolveFinalizedContextGraphIdByNameHash } =
      resolvedIdTargetFixture(UNSUPPORTED_CAPABILITY);

    const error: unknown = await agent
      .resolveFinalizedVmReconcileBinding(LOCAL_ID, () => true)
      .then(
        (value) => { throw new Error(`expected a rejection, resolved ${JSON.stringify(value)}`); },
        (err: unknown) => err,
      );

    // The index DID project a finalized target; the missing piece is only the
    // snapshot reader, so this must be a hard configuration failure...
    expect(resolveFinalizedContextGraphIdByNameHash).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Finalized VM authority target has no snapshot reader');
    // ...and NOT the queue-closed signal, which would make the scheduler treat
    // a permanently misconfigured adapter as a benign cancellation.
    expect(error).not.toBeInstanceOf(VmReconcileQueueClosedError);
    // The index reader is released even on the throw path.
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });

  it('reads the finalized snapshot through the capability reader and returns its evidence', async () => {
    const { capability, reader } = supportedCapability(async () => authoritySnapshot());
    const { agent, whenIdle } = resolvedIdTargetFixture(capability);
    const controller = new AbortController();

    const binding = await agent.resolveFinalizedVmReconcileBinding(
      LOCAL_ID,
      () => true,
      controller.signal,
    );

    // The numeric id projected by the index is what gets read. The governed
    // lane composes the caller's signal with the coordinator lifetime, so this
    // asserts the forwarded cancellation still obeys the caller rather than
    // asserting signal identity.
    expect(reader.getContextGraphAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(reader.getContextGraphAuthoritySnapshot)
      .toHaveBeenCalledWith(ON_CHAIN_ID, {
        signal: expect.any(AbortSignal),
        onContextGraphAuthorityProjectionServed: expect.any(Function),
      });
    const forwarded = reader.getContextGraphAuthoritySnapshot.mock
      .calls[0]![1]!.signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    const reason = new Error('caller stopped the reconcile');
    controller.abort(reason);
    expect(forwarded).toMatchObject({ aborted: true, reason });
    expect(binding).toEqual({
      kind: 'resolved',
      nameHash: NAME_HASH,
      onChainId: '77',
      onChainCgId: ON_CHAIN_ID,
    });
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });

  it('rejects a reader snapshot that does not match the projected target', async () => {
    // Same target, but the reader answers for a different Context Graph. The
    // reader-supplied snapshot must be validated, not trusted.
    const { capability, reader } = supportedCapability(async () => authoritySnapshot({
      contextGraphId: '78',
    }));
    const { agent, whenIdle } = resolvedIdTargetFixture(capability);

    const error: unknown = await agent
      .resolveFinalizedVmReconcileBinding(LOCAL_ID, () => true)
      .then(
        (value) => { throw new Error(`expected a rejection, resolved ${JSON.stringify(value)}`); },
        (err: unknown) => err,
      );

    expect(reader.getContextGraphAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toBe(
      `Invalid finalized VM authority evidence for "${LOCAL_ID}"`,
    );
    expect(error).not.toBeInstanceOf(VmReconcileQueueClosedError);
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });

  it('converts a snapshot-read failure that races a target rotation into queue closure', async () => {
    let current = true;
    const boom = new Error('snapshot read exploded');
    // The target rotates out from under the read while it is in flight — the
    // exact production race the queue-closed signal exists for.
    const { capability, reader } = supportedCapability(async () => {
      current = false;
      throw boom;
    });
    const { agent, whenIdle } = resolvedIdTargetFixture(capability);

    const error: unknown = await agent
      .resolveFinalizedVmReconcileBinding(LOCAL_ID, () => current)
      .then(
        (value) => { throw new Error(`expected a rejection, resolved ${JSON.stringify(value)}`); },
        (err: unknown) => err,
      );

    expect(reader.getContextGraphAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(VmReconcileQueueClosedError);
    // The stale failure is swallowed rather than surfaced as a real fault.
    expect(error).not.toBe(boom);
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });

  it('propagates a snapshot-read failure unchanged while the target is still current', async () => {
    const boom = new Error('snapshot read exploded');
    const { capability, reader } = supportedCapability(async () => { throw boom; });
    const { agent, whenIdle } = resolvedIdTargetFixture(capability);

    // Identity, not message: a still-current target must surface the ORIGINAL
    // error (cause chain intact) so the scheduler can retry a real fault.
    await expect(agent.resolveFinalizedVmReconcileBinding(LOCAL_ID, () => true))
      .rejects.toBe(boom);

    expect(reader.getContextGraphAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });
});
