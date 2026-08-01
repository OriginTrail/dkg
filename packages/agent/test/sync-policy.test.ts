import { describe, expect, it } from 'vitest';
import {
  SYNC_ADMISSION_SOURCES,
  contextGraphPriority,
  countSyncPriorityClasses,
  normalizeSyncAdmissionSource,
  normalizeSyncContextGraphPriorities,
  orderContextGraphIdsByPriority,
  syncPriorityClass,
  validateSyncResponderSnapshotLimitsConfig,
} from '../src/sync/policy.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { authoritativeSyncPeerId, resolveCuratorSyncPeer } from '../src/dkg-agent-cg-resolve.js';

describe('sync Context Graph policy', () => {
  it('normalizes safe integer priorities and preserves stable input order for ties', () => {
    const priorities = normalizeSyncContextGraphPriorities({ high: 10, low: -4, tied: 10 });
    expect(orderContextGraphIdsByPriority(
      ['default-a', 'low', 'high', 'default-b', 'tied', 'high'],
      priorities,
    )).toEqual(['high', 'tied', 'default-a', 'default-b', 'low']);
    expect(contextGraphPriority(priorities, 'unknown')).toBe(0);
    expect(Object.isFrozen(priorities)).toBe(true);
  });

  it('allows preconfigured unknown IDs but rejects empty IDs and unsafe priorities', () => {
    expect(normalizeSyncContextGraphPriorities({ 'future-graph': -1 })).toEqual({ 'future-graph': -1 });
    expect(() => normalizeSyncContextGraphPriorities({ '': 1 })).toThrow(/syncContextGraphPriorities/);
    expect(() => normalizeSyncContextGraphPriorities({ graph: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/syncContextGraphPriorities\.graph/);
  });

  it('uses bounded priority classes and counts configured entries only', () => {
    expect(syncPriorityClass(9)).toBe('elevated');
    expect(syncPriorityClass(0)).toBe('default');
    expect(syncPriorityClass(-9)).toBe('deprioritized');
    expect(countSyncPriorityClasses({ a: 1, b: 0, c: -1, d: 2 })).toEqual({
      elevated: 2,
      default: 1,
      deprioritized: 1,
    });
  });
});

describe('sync responder snapshot config validation', () => {
  it('accepts positive safe integer leaves', () => {
    expect(() => validateSyncResponderSnapshotLimitsConfig({
      global: { rows: 10, bytesEstimate: 20 },
      local: { rows: 5, bytesEstimate: 10 },
    })).not.toThrow();
  });

  it.each([
    ['global.rows', { global: { rows: 0 } }],
    ['global.bytesEstimate', { global: { bytesEstimate: 1.5 } }],
    ['local.rows', { local: { rows: -1 } }],
    ['local.bytesEstimate', { local: { bytesEstimate: Number.MAX_SAFE_INTEGER + 1 } }],
  ])('reports the exact invalid leaf path %s', (path, config) => {
    expect(() => validateSyncResponderSnapshotLimitsConfig(config))
      .toThrow(`syncResponderSnapshotLimits.${path}`);
  });
});

describe('normalizeSyncAdmissionSource', () => {
  it('passes through every declared admission origin', () => {
    for (const source of SYNC_ADMISSION_SOURCES) {
      expect(normalizeSyncAdmissionSource(source)).toBe(source);
    }
  });

  it('clamps unknown, absent, and identifier-bearing origins to `unspecified`', () => {
    // These values become metric and log dimensions on the node-wide
    // `sync-global` scheduler, so the label space is a contract: an unbounded
    // or identifier-bearing origin would re-open the correlation-identifier
    // leak that collapsing the operation label was added to close, and would
    // multiply the diagnostic cardinality.
    expect(normalizeSyncAdmissionSource(undefined)).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('Catchup-Foreground')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('durable:urn:cg:private:abc')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('__proto__')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('toString')).toBe('unspecified');
  });

  it('keeps the declared origin set small and free of punctuation', () => {
    expect(new Set(SYNC_ADMISSION_SOURCES).size).toBe(SYNC_ADMISSION_SOURCES.length);
    expect(SYNC_ADMISSION_SOURCES.length).toBeLessThanOrEqual(12);
    for (const source of SYNC_ADMISSION_SOURCES) {
      expect(source).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

/**
 * These drive the REAL resolver — `resolveCuratorSyncPeer` and the two
 * lifecycle methods on their actual prototypes — not a stub of it. Which of
 * the two routes produced a peer id is what decides whether one peer's answer
 * may stand for a whole Context Graph, and that decision is made inside the
 * resolver, so stubbing it out would leave the interesting half untested.
 */
describe('curator sync-peer provenance', () => {
  const CG = 'cg/provenance';
  const HINT = '12D3KooWBootstrapHint';
  const CURATOR = '12D3KooWMetadataCurator';

  function agentWithMeta(meta: {
    curator?: string;
    curators?: string[];
    creator?: string;
    creators?: string[];
  }, findAgents: () => Promise<Array<{ agentAddress?: string; peerId: string }>> = async () => []) {
    return {
      getCgMeta: async () => ({ curators: [], creators: [], ...meta }),
      discovery: { findAgents },
    };
  }

  it('reports a metadata curator as authoritative EVEN when it equals the bootstrap hint', async () => {
    // The ordinary case on a healthy network: the join approval came from the
    // curator, so both routes name the same peer. Deriving provenance by
    // comparing the resolved id against the hint therefore reads the normal
    // case as "unconfirmed hint" and never lets the catch-up walk stop —
    // exactly where the early-stop optimisation is worth the most.
    const hints = new Map([[CG, CURATOR]]);
    const agent = agentWithMeta({ curator: `did:dkg:agent:${CURATOR}` });

    expect(await resolveCuratorSyncPeer(agent as never, hints, CG))
      .toEqual({ peerId: CURATOR, provenance: 'metadata' });
    // …and the resolver consumed the hint now that metadata has confirmed it.
    expect(hints.has(CG)).toBe(false);
  });

  it('marks an echoed bootstrap hint as NOT authoritative', async () => {
    // With no curator in `_meta` the resolver echoes the join-approval hint.
    // That hint can be stale — peer ids are cryptographic identities, so a
    // curator that rotated its libp2p key leaves an ordinary member on the id
    // it still names — so it may rank the walk but must never end it.
    const hints = new Map([[CG, HINT]]);

    expect(await resolveCuratorSyncPeer(agentWithMeta({}) as never, hints, CG))
      .toEqual({ peerId: HINT, provenance: 'bootstrap-hint' });
    // A non-DKG curator DID is equally unresolvable.
    expect(await resolveCuratorSyncPeer(agentWithMeta({ curator: 'did:web:example' }) as never, hints, CG))
      .toEqual({ peerId: HINT, provenance: 'bootstrap-hint' });
    // …as is a wallet-address curator no registry can resolve.
    expect(await resolveCuratorSyncPeer(
      agentWithMeta({ curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' }) as never,
      hints,
      CG,
    )).toEqual({ peerId: HINT, provenance: 'bootstrap-hint' });
    // The hint survives every fallback: it is still the best peer available.
    expect(hints.get(CG)).toBe(HINT);
  });

  it('reports no peer when neither route produced one', async () => {
    expect(await resolveCuratorSyncPeer(agentWithMeta({}) as never, new Map(), CG))
      .toEqual({ provenance: 'none' });
  });

  it('resolves a wallet-address curator through the registry as authoritative', async () => {
    const hints = new Map([[CG, HINT]]);
    const agent = agentWithMeta(
      { curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' },
      async () => [{ agentAddress: '0x00000000000000000000000000000000000000AB', peerId: CURATOR }],
    );

    expect(await resolveCuratorSyncPeer(agent as never, hints, CG))
      .toEqual({ peerId: CURATOR, provenance: 'metadata' });
  });

  it('answers ranking and authority from ONE resolution', async () => {
    // The catch-up boundary needs both notions, and resolving twice is not
    // free or even equivalent: each resolution reads `_meta` (and can drive the
    // registry fallback), and the resolver EVICTS the bootstrap hint once
    // metadata confirms a curator, so the second call runs against a different
    // map than the first.
    let metaReads = 0;
    const agent = {
      preferredSyncPeers: new Map([[CG, CURATOR]]),
      getCgMeta: async () => {
        metaReads += 1;
        return { curator: `did:dkg:agent:${CURATOR}`, curators: [], creators: [] };
      },
      discovery: { findAgents: async () => [] },
    };

    const resolved = await LifecycleSyncMethods.prototype.resolveSyncPeerWithProvenance
      .call(agent as never, CG);

    expect(resolved).toEqual({ peerId: CURATOR, provenance: 'metadata' });
    expect(metaReads).toBe(1);
    // Both narrow notions are derivable from it, matching the wrappers exactly.
    expect(resolved.peerId).toBe(CURATOR);
    expect(authoritativeSyncPeerId(resolved)).toBe(CURATOR);
    expect(authoritativeSyncPeerId({ peerId: CURATOR, provenance: 'bootstrap-hint' }))
      .toBeUndefined();
    expect(authoritativeSyncPeerId({ provenance: 'none' })).toBeUndefined();
  });

  it('ranks on any provenance but only lets metadata settle the walk', async () => {
    // The two lifecycle entry points, on their real prototypes: ranking takes
    // whatever peer is available, authority takes it only from metadata.
    const confirmedCurator = {
      preferredSyncPeers: new Map([[CG, CURATOR]]),
      ...agentWithMeta({ curator: `did:dkg:agent:${CURATOR}` }),
    };
    const hintOnly = {
      preferredSyncPeers: new Map([[CG, HINT]]),
      ...agentWithMeta({}),
    };
    const rank = LifecycleSyncMethods.prototype.resolvePreferredSyncPeerId;
    const authority = LifecycleSyncMethods.prototype.resolveAuthoritativeSyncPeerId;

    expect(await rank.call(confirmedCurator as never, CG)).toBe(CURATOR);
    expect(await authority.call(confirmedCurator as never, CG)).toBe(CURATOR);

    expect(await rank.call(hintOnly as never, CG)).toBe(HINT);
    expect(await authority.call(hintOnly as never, CG)).toBeUndefined();
  });
});
