/**
 * Selected VM target resolution and subscription target revalidation — the two
 * places where reconciliation decides whether it still owns a *provable* chain
 * slot before it touches Verifiable Memory.
 *
 * `resolveSelectedVmReconcileTarget` must fail closed with
 * `ContextGraphOnChainIdUnresolvedError` in exactly two shapes:
 *   - the finalized authority index is live and projects NO target for the CG
 *     (the binding genuinely does not exist at the finalized horizon), and
 *   - the adapter has no finalized index at all AND cannot reverse a name
 *     commitment either, so there is no chain oracle that could answer.
 * Neither may be reported as a benign queue closure, and neither may fall back
 * to a legacy reverse lookup that the first case has already superseded.
 *
 * `revalidateVmReconcileTarget` re-proves a captured subscription target after
 * the work that captured it. An authoritative binding is self-proving and costs
 * no chain read; a reverse-name-hash binding must be re-confirmed against the
 * finalized index, and the answer counts only while the target is still the one
 * the scheduler holds — both while the read is in flight and after it lands.
 *
 * Hermetic: the real `resolveFinalizedVmReconcileBinding` and
 * `resolveFinalizedContextGraphAuthorityTargetsV1` run; only the chain-boundary
 * index reader is stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import {
  ContextGraphOnChainIdUnresolvedError,
  VmReconcileQueueClosedError,
} from '../src/vm-reconcile-service.js';
import { createCursorState, type CursorState } from '../src/reconcile-cursor.js';
import {
  LOCAL_ID,
  NAME_HASH,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

const ON_CHAIN_ID = 77n;
const DEPLOYMENT_ID = 'test:deployment-a';

type Fixture = ReturnType<typeof selectedFixture>;

/** Public method graph exercised here; the fixture agent is a real prototype. */
interface VmReconcileTargetHost {
  resolveSelectedVmReconcileTarget(
    localCgId: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
  revalidateVmReconcileTarget(
    localCgId: string,
    target: unknown,
    lifecycleGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

function host(fixture: Fixture): VmReconcileTargetHost {
  return fixture.agent as unknown as VmReconcileTargetHost;
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
    // through `contextGraphWireId` rather than compare raw adapter strings.
    nameHash: `0x${'AB'.repeat(32)}`,
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '1',
    sourceBlockNumber: '1024',
    sourceBlockHash: `0x${'33'.repeat(32)}`,
    ...overrides,
  };
}

/**
 * Wire a finalized authority index that projects snapshots straight from name
 * commitments, so the real target resolver yields `resolved-snapshot` targets
 * without any extra reader capability.
 */
function installFinalizedIndex(
  fixture: Fixture,
  resolve: (
    nameHashes: readonly string[],
  ) => Promise<Map<string, ContextGraphAuthoritySnapshot>>,
  onIdle: () => void = () => undefined,
) {
  const resolveSnapshots = vi.fn(resolve);
  const whenIdle = vi.fn(async () => { onIdle(); });
  Reflect.set(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader', {
    resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
    whenIdle,
  });
  Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set<string>());
  return { resolveSnapshots, whenIdle };
}

/** A selected-only CG: explicitly in sync scope, accepted public, unsubscribed. */
function selectedOnlyFixture(): Fixture {
  const fixture = selectedFixture();
  fixture.agent.subscribedContextGraphs.delete(LOCAL_ID);
  fixture.agent.config.syncContextGraphs = [LOCAL_ID];
  fixture.agent.config.rfc64PublicCatalogBootstrap = {
    acceptedPublicPolicies: [{
      policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: LOCAL_ID } },
      targets: [],
    }],
  };
  Reflect.set(fixture.agent.chain, 'deploymentId', DEPLOYMENT_ID);
  Reflect.set(fixture.agent, 'selectedVmReconcileBindingGeneration', 0);
  Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set<string>());
  return fixture;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    (value) => { throw new Error(`expected a rejection, resolved ${JSON.stringify(value)}`); },
    (err: unknown) => err,
  );
}

/**
 * A captured subscription target bound by reverse name hash — the provenance
 * that is NOT self-proving and therefore must be re-confirmed on revalidation.
 */
function reverseBoundTarget(fixture: Fixture) {
  const cursor = createCursorState(0);
  (fixture.agent.reconcileCursors as unknown as Map<string, CursorState>)
    .set(LOCAL_ID, cursor);
  fixture.agent.contextGraphBindingState.bindReverseCandidate(
    LOCAL_ID,
    fixture.subscription,
    ON_CHAIN_ID.toString(10),
    NAME_HASH,
  );
  return {
    kind: 'subscription' as const,
    sub: fixture.subscription,
    bindingKind: 'reverse-name-hash' as const,
    onChainId: ON_CHAIN_ID.toString(10),
    nameHash: NAME_HASH,
    bindingGeneration: fixture.agent.contextGraphBindingState.capture(LOCAL_ID),
    onChainCgId: ON_CHAIN_ID,
    cursor,
    watermarkBefore: 0,
  };
}

describe('resolveSelectedVmReconcileTarget failure-closed binding proof', () => {
  it('rejects a selected target the finalized index does not project, without a legacy fallback', async () => {
    const fixture = selectedOnlyFixture();
    // The index is live and answers authoritatively: this name commitment has
    // no finalized binding.
    const { resolveSnapshots, whenIdle } = installFinalizedIndex(
      fixture,
      async () => new Map(),
    );

    const error = await rejection(
      host(fixture).resolveSelectedVmReconcileTarget(LOCAL_ID, () => true),
    );

    expect(error).toBeInstanceOf(ContextGraphOnChainIdUnresolvedError);
    expect((error as Error).message).toBe(
      `Context graph "${LOCAL_ID}" has no resolved on-chain id`,
    );
    // An unresolved binding is a real, reportable condition — not the queue's
    // "stop, do not retry" cancellation signal.
    expect(error).not.toBeInstanceOf(VmReconcileQueueClosedError);
    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
    expect(resolveSnapshots).toHaveBeenCalledWith([NAME_HASH], expect.anything());
    // A finalized "absent" is the end of the inquiry: the superseded legacy
    // reverse lookup must never be consulted to contradict it.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(whenIdle).toHaveBeenCalledTimes(1);
    expect(fixture.agent.selectedVmReconcileCursors.size).toBe(0);
  });

  it('rejects a legacy-current selected target when the adapter cannot reverse a name commitment', async () => {
    const fixture = selectedOnlyFixture();
    // No finalized index at all, so the binding stays legacy-current...
    expect(Reflect.get(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader'))
      .toBeUndefined();
    // ...and the adapter also lacks the reverse-name-hash resolver, so nothing
    // on this node can answer "which numeric slot is this CG?".
    Reflect.set(fixture.agent.chain, 'resolveContextGraphIdByNameHash', undefined);

    const error = await rejection(
      host(fixture).resolveSelectedVmReconcileTarget(LOCAL_ID, () => true),
    );

    expect(error).toBeInstanceOf(ContextGraphOnChainIdUnresolvedError);
    expect((error as Error).message).toBe(
      `Context graph "${LOCAL_ID}" has no resolved on-chain id`,
    );
    expect(error).not.toBeInstanceOf(VmReconcileQueueClosedError);
    // No chain call was attempted: the capability was absent, not failing.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    // And no selected cursor was minted against an unproven slot.
    expect(fixture.agent.selectedVmReconcileCursors.size).toBe(0);
  });

  it('binds a legacy-current selected target once the reverse resolver is available', async () => {
    // Identical fixture to the previous scenario except that the adapter keeps
    // its reverse resolver — proving the rejection above is caused by the
    // missing capability and not by the selected-target fixture itself.
    const fixture = selectedOnlyFixture();

    const target = await host(fixture)
      .resolveSelectedVmReconcileTarget(LOCAL_ID, () => true);

    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledTimes(1);
    expect(target).toMatchObject({
      kind: 'rfc64-selected',
      deploymentId: DEPLOYMENT_ID,
      onChainId: '42',
      onChainCgId: 42n,
      nameHash: NAME_HASH,
      bindingGeneration: 1,
      watermarkBefore: 0,
    });
    expect(fixture.agent.selectedVmReconcileCursors.get(LOCAL_ID)?.record).toEqual({
      deploymentId: DEPLOYMENT_ID,
      contextGraphId: LOCAL_ID,
      onChainContextGraphId: '42',
      nameHash: NAME_HASH,
      watermark: 0,
    });
  });
});

describe('revalidateVmReconcileTarget subscription binding proof', () => {
  it('re-proves an authoritative binding locally, without reading the finalized index', async () => {
    const fixture = selectedFixture();
    const cursor = createCursorState(0);
    (fixture.agent.reconcileCursors as unknown as Map<string, CursorState>)
      .set(LOCAL_ID, cursor);
    // A durable authoritative binding names the numeric slot itself.
    fixture.subscription.onChainId = ON_CHAIN_ID.toString(10);
    const target = {
      kind: 'subscription' as const,
      sub: fixture.subscription,
      bindingKind: 'authoritative' as const,
      onChainId: ON_CHAIN_ID.toString(10),
      bindingGeneration: fixture.agent.contextGraphBindingState.capture(LOCAL_ID),
      onChainCgId: ON_CHAIN_ID,
      cursor,
      watermarkBefore: 0,
    };
    const { resolveSnapshots, whenIdle } = installFinalizedIndex(fixture, async () => {
      throw new Error('finalized index must not be read for an authoritative binding');
    });

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(true);

    expect(resolveSnapshots).not.toHaveBeenCalled();
    expect(whenIdle).not.toHaveBeenCalled();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('re-confirms a reverse-name-hash binding against the finalized index', async () => {
    const fixture = selectedFixture();
    const target = reverseBoundTarget(fixture);
    const { resolveSnapshots, whenIdle } = installFinalizedIndex(
      fixture,
      async (nameHashes) => new Map([[nameHashes[0]!, authoritySnapshot()]]),
    );

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(true);

    // Unlike the authoritative case, this binding DOES cost a finalized read.
    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
    expect(resolveSnapshots).toHaveBeenCalledWith([NAME_HASH], expect.anything());
    expect(whenIdle).toHaveBeenCalledTimes(1);
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('fails revalidation when the finalized index moved the name commitment to another slot', async () => {
    const fixture = selectedFixture();
    const target = reverseBoundTarget(fixture);
    // Same name commitment, different numeric slot: the captured target is
    // reconciling against a Context Graph that no longer owns the name.
    const { resolveSnapshots } = installFinalizedIndex(
      fixture,
      async (nameHashes) => new Map([
        [nameHashes[0]!, authoritySnapshot({ contextGraphId: '78' })],
      ]),
    );

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(false);

    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
  });

  it('fails revalidation when the finalized index no longer projects the binding at all', async () => {
    const fixture = selectedFixture();
    const target = reverseBoundTarget(fixture);
    const { resolveSnapshots } = installFinalizedIndex(fixture, async () => new Map());

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(false);

    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
  });

  it('abandons revalidation when the target rotates while the finalized read is in flight', async () => {
    const fixture = selectedFixture();
    const target = reverseBoundTarget(fixture);
    // The index would confirm the captured binding exactly; the only thing
    // that changes is that the scheduler dropped this target mid-read. The
    // fence the revalidator hands to the resolver must observe that.
    const { resolveSnapshots, whenIdle } = installFinalizedIndex(
      fixture,
      async (nameHashes) => {
        fixture.agent.contextGraphBindingState.invalidate(LOCAL_ID);
        return new Map([[nameHashes[0]!, authoritySnapshot()]]);
      },
    );

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(false);

    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });

  it('fails revalidation when the target rotates after the finalized answer is produced', async () => {
    const fixture = selectedFixture();
    const target = reverseBoundTarget(fixture);
    // Rotation lands in the index reader's release hook — after the finalized
    // evidence is computed and after every in-read fence has passed. Every
    // value comparison therefore matches, and only the post-await currency
    // check can reject this.
    const { resolveSnapshots, whenIdle } = installFinalizedIndex(
      fixture,
      async (nameHashes) => new Map([[nameHashes[0]!, authoritySnapshot()]]),
      () => { fixture.agent.contextGraphBindingState.invalidate(LOCAL_ID); },
    );

    await expect(host(fixture).revalidateVmReconcileTarget(LOCAL_ID, target, 0))
      .resolves.toBe(false);

    expect(resolveSnapshots).toHaveBeenCalledTimes(1);
    expect(whenIdle).toHaveBeenCalledTimes(1);
    // The evidence itself was a clean match — proof that the rejection came
    // from the currency fence and not from a value mismatch.
    const snapshots = await resolveSnapshots.mock.results[0]!.value as
      Map<string, ContextGraphAuthoritySnapshot>;
    expect(snapshots.get(NAME_HASH)?.contextGraphId).toBe(target.onChainId);
  });
});
