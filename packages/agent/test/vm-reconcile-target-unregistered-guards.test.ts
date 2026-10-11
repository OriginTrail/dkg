/**
 * Fail-closed guards that stop an accepted RFC-64 *unregistered* authority from
 * silently degrading into legacy current-state chain resolution, plus the
 * adapter-capability guard on the exact-asset fetch lane.
 *
 * All three boundaries live in `dkg-agent-swm-host.ts`:
 *
 *  - `fetchContextGraphAssets` refuses to run when the chain adapter does not
 *    expose BOTH `getKAContextGraphId` and `readKnowledgeAssetVersionSnapshot`
 *    as callable functions. It must fail with `VmReconcileUnavailableError`
 *    and must not call the half of the pair that does exist.
 *  - `resolveVmReconcileTarget` refuses an accepted unregistered graph when the
 *    adapter has no finalized authority index at all, and again when the
 *    finalized lane answers `legacy-current`. Both must fail with
 *    `ContextGraphNotFoundError` and must never reach the legacy
 *    `resolveContextGraphIdByNameHash` reverse-name-hash fallback.
 *
 * Each unregistered case is paired with a control in which the very same state
 * is accepted as a *registered* authority, proving the guard — not some other
 * missing collaborator — is what closed the door.
 */
import { describe, expect, it, vi } from 'vitest';

import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { ContextGraphNotFoundError } from '../src/dkg-agent-types.js';
import { VmReconcileUnavailableError } from '../src/vm-reconcile-service.js';
import {
  LOCAL_ID,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

const NETWORK_ID = 'base:8453';
const CONTEXT_GRAPH = 'exact-fetch-cg';
const ON_CHAIN_ID = '9';
const UAL = 'did:dkg:base:8453/0x00000000000000000000000000000000000000a1/1';

/**
 * Minimal exact-asset-fetch host: everything the method touches BEFORE the
 * adapter-capability guard is real state, and `chain` carries only the
 * capabilities a given case wants to offer.
 */
function createFetchHost(chain: Record<string, unknown>) {
  const canReadContextGraph = vi.fn(async () => true);
  const host = {
    started: true,
    vmReconcileRuntimeReady: true,
    graphScopedStoreClosed: false,
    vmReconcileRotationClosed: false,
    vmReconcileLifecycleGeneration: 1,
    vmReconcileLifecycleController: new AbortController(),
    vmReconcilePhysicalRuns: new Set<Promise<unknown>>(),
    subscribedContextGraphs: new Map([[CONTEXT_GRAPH, {
      subscribed: true,
      onChainId: ON_CHAIN_ID,
    }]]),
    chain: { chainId: NETWORK_ID, ...chain },
    canReadContextGraph,
    // Belt-and-braces: the fetch body is never supposed to start here.
    getOrCreateFinalizationHandler: vi.fn(() => {
      throw new Error('exact-asset fetch started despite an incapable adapter');
    }),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const fetchAssets = () => SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
    host as never,
    CONTEXT_GRAPH,
    [UAL],
  );
  return { host, canReadContextGraph, fetchAssets };
}

/** The real `ContextGraphPolicySourceV1` discriminants (packages/core/src/cg-policy-objects.ts). */
type AcceptedPolicySource = 'owner-signed-unregistered' | 'finalized-chain';

/**
 * A `resolveVmReconcileTarget` fixture whose accepted-policy snapshot is driven
 * through the real `hasAcceptedRfc64UnregisteredAuthorityV1` predicate: only
 * the catalog *service* is a stub, the ownership classification is production
 * code.
 */
function createTargetFixture(options: {
  source: AcceptedPolicySource;
  authorityIndexRevisionReader?: { whenIdle: () => Promise<void> };
}) {
  const fixture = selectedFixture();
  const { agent } = fixture;
  const acceptedPolicySnapshot = vi.fn(() => ({
    policy: { accessPolicy: 0, source: { kind: options.source } },
    roster: null,
  }));
  Reflect.set(agent, 'rfc64PublicCatalogOwnerV1', {
    // Keep the harness-owned governor; only the policy service is scenario state.
    authorityReads: (agent as unknown as {
      rfc64PublicCatalogOwnerV1: { authorityReads: unknown };
    }).rfc64PublicCatalogOwnerV1.authorityReads,
    service: { acceptedPolicySnapshot },
  });
  Object.assign(agent.config as Record<string, unknown>, {
    rfc64CatalogDeploymentProfile: { networkId: NETWORK_ID },
  });
  // The operator switch is an earlier boundary; open it so the unregistered
  // guards are the only thing left that can close the target.
  Reflect.set(agent, 'vmReconcileEnabled', () => true);
  if (options.authorityIndexRevisionReader !== undefined) {
    Object.assign(agent.chain as Record<string, unknown>, {
      contextGraphAuthorityIndexRevisionReader: options.authorityIndexRevisionReader,
    });
  }
  return { ...fixture, acceptedPolicySnapshot };
}

describe('exact-asset fetch adapter-capability guard', () => {
  it('fails closed when the adapter cannot resolve a KA -> Context Graph slot', async () => {
    const readKnowledgeAssetVersionSnapshot = vi.fn(async () => ({}));
    const { canReadContextGraph, fetchAssets } = createFetchHost({
      readKnowledgeAssetVersionSnapshot,
    });

    await expect(fetchAssets()).rejects.toBeInstanceOf(VmReconcileUnavailableError);
    // Read authority is proven first, so the guard is genuinely the last word.
    expect(canReadContextGraph).toHaveBeenCalledOnce();
    // Half a capability pair is never used on its own.
    expect(readKnowledgeAssetVersionSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when the adapter cannot read a KA version snapshot', async () => {
    const getKAContextGraphId = vi.fn(async () => BigInt(ON_CHAIN_ID));
    const { fetchAssets } = createFetchHost({ getKAContextGraphId });

    await expect(fetchAssets()).rejects.toBeInstanceOf(VmReconcileUnavailableError);
    expect(getKAContextGraphId).not.toHaveBeenCalled();
  });

  it('treats a present but non-callable capability as an incapable adapter', async () => {
    const readKnowledgeAssetVersionSnapshot = vi.fn(async () => ({}));
    const { fetchAssets } = createFetchHost({
      // A truthy, non-function value must not satisfy the capability check.
      getKAContextGraphId: { call: 'not-a-function' },
      readKnowledgeAssetVersionSnapshot,
    });

    await expect(fetchAssets()).rejects.toBeInstanceOf(VmReconcileUnavailableError);
    expect(readKnowledgeAssetVersionSnapshot).not.toHaveBeenCalled();
  });
});

describe('VM reconcile target guards for an accepted unregistered authority', () => {
  it('refuses an unregistered authority when the adapter has no finalized index', async () => {
    const fixture = createTargetFixture({ source: 'owner-signed-unregistered' });
    expect(
      (fixture.agent.chain as Record<string, unknown>)
        .contextGraphAuthorityIndexRevisionReader,
    ).toBeUndefined();

    // The subscription is admitted and off every earlier not-found boundary
    // (it is not a system graph, has no local-create marker, and is a live
    // `subscribed` row), so the missing-index guard owns this rejection.
    const error = await fixture.agent.resolveVmReconcileTarget(LOCAL_ID)
      .then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(ContextGraphNotFoundError);
    // The guard constructs the error from the requested local id.
    expect((error as Error).message).toContain(`"${LOCAL_ID}"`);

    // The classification really ran against the active network/CG pair...
    expect(fixture.acceptedPolicySnapshot).toHaveBeenCalledWith(NETWORK_ID, LOCAL_ID);
    // ...and the legacy reverse-name-hash fallback was never consulted.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('still uses the legacy fallback for a finalized-chain authority without a finalized index', async () => {
    const fixture = createTargetFixture({ source: 'finalized-chain' });

    // Same adapter, same subscription, same missing index: only the accepted
    // policy source differs, and the legacy lane now resolves a target.
    await expect(fixture.agent.resolveVmReconcileTarget(LOCAL_ID))
      .resolves.toMatchObject({
        kind: 'subscription',
        bindingKind: 'reverse-name-hash',
        onChainId: '42',
      });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalled();
  });

  it('refuses an unregistered authority when the finalized lane answers legacy-current', async () => {
    const whenIdle = vi.fn(async () => undefined);
    const fixture = createTargetFixture({
      source: 'owner-signed-unregistered',
      // An index reader with no finalized resolution capability is exactly the
      // adapter shape that yields a `legacy-current` finalized binding.
      authorityIndexRevisionReader: { whenIdle },
    });

    const error = await fixture.agent.resolveVmReconcileTarget(LOCAL_ID)
      .then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(ContextGraphNotFoundError);
    // The guard constructs the error from the requested local id.
    expect((error as Error).message).toContain(`"${LOCAL_ID}"`);

    // `whenIdle` ran, so the finalized lane was entered and drained: this is
    // past the missing-index guard and past the selected-only branch. A
    // capability-less reader answers `legacy-current`, never `absent`, so the
    // unresolved-id boundary is excluded too — the legacy-current guard is the
    // only remaining site that can produce this rejection.
    expect(whenIdle).toHaveBeenCalled();
    // ...and it still did not fall back to current-state name-hash resolution.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('still uses the legacy fallback for a finalized-chain authority on a legacy-current answer', async () => {
    const whenIdle = vi.fn(async () => undefined);
    const fixture = createTargetFixture({
      source: 'finalized-chain',
      authorityIndexRevisionReader: { whenIdle },
    });

    // Identical adapter and identical `legacy-current` finalized answer: a
    // finalized-chain authority may still degrade to current-state resolution.
    await expect(fixture.agent.resolveVmReconcileTarget(LOCAL_ID))
      .resolves.toMatchObject({
        kind: 'subscription',
        bindingKind: 'reverse-name-hash',
        onChainId: '42',
      });
    expect(whenIdle).toHaveBeenCalled();
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalled();
  });
});
