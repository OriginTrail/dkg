// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription admission refreshes the exact finalized authority generation
 * before it returns a registered admission. Registration can finalize while
 * the just-accepted public unregistered generation is still the catalog's
 * current authority, so returning `allowed` without that refresh would open a
 * permissive window on a graph that has meanwhile registered as private.
 *
 * These scenarios pin both failure exits of that refresh in
 * `resolveContextGraphSubscriptionBootstrapAuthority`:
 *   - the refresh yields no finalized evidence for the graph
 *     -> `chain-name-binding-unavailable`
 *   - the refresh read, or reconciling its evidence, throws
 *     -> `registered-authority-error`
 * Both must be `unavailable` (never `allowed`) so the caller route has no
 * admission to activate a subscription on, must not leak an `onChainId` that
 * would let a caller bind anyway, and must stay distinguishable from each
 * other so recovery can tell an empty finalized index from a failed read.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import type {
  RegisteredContextGraphAuthority,
} from '../src/registered-context-graph-authority.js';
import type {
  Rfc64CatalogAuthorityRefreshRequestV1,
} from '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import { selectedFixture } from './context-graph-registration-binding.fixture.js';

const CG_ID = 'subscription-bootstrap-refresh-cg';
const ON_CHAIN_ID = 77n;

const AUTHORITY_INDEX_ID = ON_CHAIN_ID.toString(10);

// `ContextGraphAuthorityIndexId` is a branded canonical decimal string; these
// scenarios never inspect the evidence, only that this exact frozen request is
// the one handed to the reconciler, so the brand is asserted structurally.
const FINALIZED_EVIDENCE_REQUEST = Object.freeze({
  kind: 'finalized-evidence',
  evidence: Object.freeze({
    contextGraphAuthorityIndexId: AUTHORITY_INDEX_ID,
    batchTargetIds: Object.freeze([AUTHORITY_INDEX_ID]),
    snapshot: null,
  }),
}) as unknown as Rfc64CatalogAuthorityRefreshRequestV1;

/**
 * Build the exact admission state this boundary needs: the first authority
 * read proves accepted-absence (which is what makes the bootstrap path
 * reconcile at all), and every later read reports a finalized registration.
 * Only the refresh collaborators differ per scenario.
 */
function createBootstrapAgent(options: {
  refresh: (
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, Rfc64CatalogAuthorityRefreshRequestV1>>;
  reconcile?: (
    contextGraphId: string,
    signal: AbortSignal | undefined,
    request: Rfc64CatalogAuthorityRefreshRequestV1,
  ) => Promise<unknown>;
}) {
  const fixture = selectedFixture();
  const agent = fixture.agent as unknown as DKGAgent;

  const registeredAuthority = vi.fn(
    async (): Promise<RegisteredContextGraphAuthority> => (
      registeredAuthority.mock.calls.length === 1
        ? { kind: 'unavailable', reason: 'finalized-name-absence-unaccepted' }
        : { kind: 'public', onChainId: ON_CHAIN_ID }
    ),
  );
  const reconcile = vi.fn(options.reconcile ?? (async (
    _contextGraphId: string,
    _signal: AbortSignal | undefined,
    _request: Rfc64CatalogAuthorityRefreshRequestV1,
  ) => null));
  const refresh = vi.fn(options.refresh);

  Reflect.set(agent, 'resolveRegisteredContextGraphAuthority', registeredAuthority);
  Reflect.set(agent, 'reconcileRfc64CatalogAccessAuthorityV1', reconcile);
  Reflect.set(agent, 'createRfc64CatalogAuthorityRefreshRequestsV1', refresh);

  return { agent, registeredAuthority, reconcile, refresh };
}

const resolveBootstrap = (agent: DKGAgent) => (
  agent.resolveContextGraphSubscriptionBootstrapAuthority(CG_ID, {
    allowSubscriptionFallback: false,
  })
);

describe('subscription bootstrap finalized-generation refresh', () => {
  it('refuses admission when the finalized refresh returns no entry for the graph', async () => {
    const { agent, reconcile, refresh, registeredAuthority } = createBootstrapAgent({
      refresh: async () => new Map(),
    });

    const decision = await resolveBootstrap(agent);

    // Exact object: an `onChainId` must not ride along on a denial, or a
    // caller could bind the subscription it was just refused.
    expect(decision).toEqual({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-name-binding-unavailable',
      metadataBootstrap: 'eligible',
      dependency: 'chain',
    });
    expect(decision).not.toHaveProperty('onChainId');

    // Only the finalized-absence seed reconciled; the missing entry must not
    // be reconciled as if it were evidence.
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      CG_ID,
      expect.any(AbortSignal),
      { kind: 'finalized-absence' },
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith([CG_ID], expect.any(AbortSignal));
    // The bootstrap returned on the refresh failure, so the post-refresh
    // re-resolve (a third authority read) never happened.
    expect(registeredAuthority).toHaveBeenCalledTimes(2);
  });

  it.each(['auto', 'finalized-absence'] as const)(
    'refuses admission when the finalized refresh downgrades to a %s request',
    async (kind) => {
      const { agent, reconcile, registeredAuthority } = createBootstrapAgent({
        refresh: async () => new Map([[
          CG_ID,
          Object.freeze({ kind }) as Rfc64CatalogAuthorityRefreshRequestV1,
        ]]),
      });

      const decision = await resolveBootstrap(agent);

      expect(decision).toEqual({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason: 'chain-name-binding-unavailable',
        metadataBootstrap: 'eligible',
        dependency: 'chain',
      });
      // A non-evidence request must never be handed to the reconciler here:
      // only the finalized-absence seed from the earlier step ran.
      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile.mock.calls[0]?.[2]).toEqual({ kind: 'finalized-absence' });
      expect(registeredAuthority).toHaveBeenCalledTimes(2);
    },
  );

  it('reports an authority error when the finalized refresh read throws', async () => {
    const { agent, reconcile, registeredAuthority } = createBootstrapAgent({
      refresh: async () => {
        throw new Error('authority index read failed');
      },
    });

    const decision = await resolveBootstrap(agent);

    expect(decision).toEqual({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'registered-authority-error',
      metadataBootstrap: 'eligible',
      dependency: 'unknown',
    });
    expect(decision).not.toHaveProperty('onChainId');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(registeredAuthority).toHaveBeenCalledTimes(2);
  });

  it('reports an authority error when reconciling the finalized evidence throws', async () => {
    const { agent, reconcile, refresh, registeredAuthority } = createBootstrapAgent({
      refresh: async () => new Map([[CG_ID, FINALIZED_EVIDENCE_REQUEST]]),
      reconcile: async (_contextGraphId, _signal, request) => {
        if (request.kind === 'finalized-evidence') {
          throw new Error('catalog reconcile rejected the finalized evidence');
        }
        return null;
      },
    });

    const decision = await resolveBootstrap(agent);

    expect(decision).toEqual({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'registered-authority-error',
      metadataBootstrap: 'eligible',
      dependency: 'unknown',
    });
    expect(refresh).toHaveBeenCalledOnce();
    // Seed reconcile, then the evidence reconcile that threw. No re-resolve.
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[1]?.[2]).toBe(FINALIZED_EVIDENCE_REQUEST);
    expect(registeredAuthority).toHaveBeenCalledTimes(2);
  });

  it('keeps the absent-evidence and refresh-error denials distinguishable', async () => {
    const absent = createBootstrapAgent({ refresh: async () => new Map() });
    const failed = createBootstrapAgent({
      refresh: async () => {
        throw new Error('authority index read failed');
      },
    });

    const [absentDecision, failedDecision] = await Promise.all([
      resolveBootstrap(absent.agent),
      resolveBootstrap(failed.agent),
    ]);

    // Both are unavailable, but recovery distinguishes "the finalized index
    // had nothing for this name" from "the refresh itself failed".
    expect(absentDecision.outcome).toBe('unavailable');
    expect(failedDecision.outcome).toBe('unavailable');
    expect(absentDecision.reason).not.toBe(failedDecision.reason);
    expect([absentDecision.reason, failedDecision.reason]).toEqual([
      'chain-name-binding-unavailable',
      'registered-authority-error',
    ]);
  });

  it('admits the registered authority once finalized evidence reconciles', async () => {
    const { agent, reconcile, refresh, registeredAuthority } = createBootstrapAgent({
      refresh: async () => new Map([[CG_ID, FINALIZED_EVIDENCE_REQUEST]]),
    });

    const decision = await resolveBootstrap(agent);

    // Control for the two denials above: the same wiring with real finalized
    // evidence re-resolves and admits, so the denials are caused by the
    // refresh failure and not by the harness.
    expect(decision).toEqual({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      metadataBootstrap: 'eligible',
      onChainId: ON_CHAIN_ID,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[1]?.aborted).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[1]?.[2]).toBe(FINALIZED_EVIDENCE_REQUEST);
    // Initial absence read, post-seed read, and the post-refresh re-resolve.
    expect(registeredAuthority).toHaveBeenCalledTimes(3);
  });
});
