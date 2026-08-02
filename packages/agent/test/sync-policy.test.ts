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

  type MetaFacts = {
    curator?: string;
    curators?: string[];
    creator?: string;
    creators?: string[];
    declared?: boolean;
    accessPolicy?: string;
  };

  /**
   * Shape a fixture the way the projection actually shapes a record.
   *
   * `applyFact` records ONE declared curator twice — `pushUnique(record.curators,
   * o)` AND `record.curator ??= o` — so a real single-curator graph arrives with
   * `curators.length === 1` and a matching scalar, i.e. two entries once the
   * scalar is prepended. Fixtures that set only the scalar and leave the array
   * empty do NOT look like production, and a cardinality bug that rejects every
   * real graph would pass against them. Deriving the arrays here keeps every
   * fixture in the production shape by construction.
   */
  function projected(facts: MetaFacts) {
    return {
      ...facts,
      curators: facts.curators ?? (facts.curator ? [facts.curator] : []),
      creators: facts.creators ?? (facts.creator ? [facts.creator] : []),
    };
  }

  /**
   * `getCgMeta` is the MERGED projection (`_meta` + AGENTS + `_catalog` +
   * ONTOLOGY); `getOwnCgMetaFacts` is what the Context Graph declared about
   * itself. `ownMeta` defaults to `meta` — the ordinary case where they agree —
   * so any test exercising the difference has to say so out loud.
   *
   * `ownMeta` also carries a COMPLETE canonical definition by default
   * (`declared` + an access policy), because that is what a receiver's `_meta`
   * always holds: `curator-meta-refresh` refuses to install a snapshot without
   * it. A test that wants the partial shape states it explicitly.
   */
  function agentWithMeta(
    meta: MetaFacts,
    findAgents: () => Promise<Array<{ agentAddress?: string; peerId: string }>> = async () => [],
    ownMeta: MetaFacts = meta,
  ) {
    return {
      getCgMeta: async () => projected(meta),
      getOwnCgMetaFacts: async () => projected({
        declared: true,
        accessPolicy: 'private',
        ...ownMeta,
      }),
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

  it('never lets a registry match be an authority, however unique it looks locally', async () => {
    // `findAgents()` queries the LOCAL Agent Registry only, so "one match" means
    // one match on THIS node — not that the wallet has a single registration on
    // the network. Local cardinality cannot establish a binding, so this route
    // ranks and never settles.
    const hints = new Map([[CG, HINT]]);
    const agent = agentWithMeta(
      { curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' },
      async () => [{ agentAddress: '0x00000000000000000000000000000000000000AB', peerId: CURATOR }],
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, hints, CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(resolved.provenance).toBe('registry');
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('authorises a wallet curator the graph binds to a peer in its OWN _meta', async () => {
    // The route that keeps the early stop for V10 wallet-address curators: the
    // Context Graph itself declares both the curator DID and the creator peer.
    const hints = new Map([[CG, HINT]]);
    const declared = {
      curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
      creator: `did:dkg:agent:${CURATOR}`,
    };
    const agent = agentWithMeta(declared, async () => {
      throw new Error('an own-_meta binding must not need the registry');
    }, declared);

    const resolved = await resolveCuratorSyncPeer(agent as never, hints, CG);
    expect(resolved).toEqual({ peerId: CURATOR, provenance: 'metadata' });
    expect(authoritativeSyncPeerId(resolved)).toBe(CURATOR);
  });

  it('demotes a creator the MERGED projection supplied but the graph did not', async () => {
    // `getCgMeta()` unions `_meta` with AGENTS / `_catalog` / ONTOLOGY under
    // first-wins precedence and discards which graph supplied each fact. A
    // creator contributed by an AGENTS-only declaration therefore looks identical
    // to one the graph declared about itself — but only the latter may end the
    // walk. Here the projection offers a creator the graph's own `_meta` does not.
    const hints = new Map([[CG, HINT]]);
    const agent = agentWithMeta(
      {
        curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
        creator: `did:dkg:agent:${CURATOR}`,
      },
      async () => [],
      // The graph names the curator, but binds no creator peer itself.
      { curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' },
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, hints, CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(resolved.provenance).toBe('projection');
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('ranks but never settles a graph whose creator is not in its own _meta', async () => {
    // The public shape: the merged projection resolves a creator peer (from the
    // network-replicated ONTOLOGY graph), but the graph's own `_meta` declares
    // no creator. That peer is still the best one to walk FIRST — it is
    // returned as the resolved peer — but it may not end the walk on a claim
    // that the graph is empty. The fan-out reduction for this shape comes from
    // the peer's verified DATA narrowing the rest, which needs no trust; see
    // `preferredEvidence` in `catchup-runner-worker-impl.ts`.
    const agent = agentWithMeta(
      {
        curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
        creator: `did:dkg:agent:${CURATOR}`,
      },
      async () => {
        throw new Error('the registry fallback must not be reached here');
      },
      // The graph itself names the curator but binds no creator peer.
      { curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' },
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, new Map(), CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(resolved.provenance).toBe('projection');
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('refuses authority to a graph that never declared itself', async () => {
    // The reviewer's "identity-only partial own _meta": a couple of rows landed
    // in `<cg>/_meta` without the canonical definition. `_meta` accumulates from
    // several writers, so a curator row alone does not mean this node holds the
    // graph's definition — and two stray triples must not be able to end a walk.
    const declared = {
      curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
      creator: `did:dkg:agent:${CURATOR}`,
    };
    const agent = agentWithMeta(declared, async () => [], {
      ...declared,
      declared: false,
      accessPolicy: undefined,
    });

    const resolved = await resolveCuratorSyncPeer(agent as never, new Map(), CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('refuses authority when the graph declares two candidate creator peers', async () => {
    // `createContextGraph` calls this shape out directly — "stray creator/curator
    // triples (e.g. from a previous build that backfilled per node)" — and the
    // merged projection picks among creators in arbitrary order. Accepting
    // whichever one happens to match the candidate peer lets a stale member
    // speak for the graph.
    const agent = agentWithMeta(
      {
        curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
        creator: `did:dkg:agent:${CURATOR}`,
      },
      async () => {
        throw new Error('the registry fallback must not be reached here');
      },
      {
        curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
        creators: [`did:dkg:agent:${CURATOR}`, 'did:dkg:agent:12D3KooWStaleMember'],
      },
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, new Map(), CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(resolved.provenance).toBe('projection');
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('refuses authority when the graph declares two different curators', async () => {
    const agent = agentWithMeta(
      { curator: `did:dkg:agent:${CURATOR}` },
      async () => [],
      {
        curator: `did:dkg:agent:${CURATOR}`,
        curators: [`did:dkg:agent:${CURATOR}`, 'did:dkg:agent:12D3KooWOtherCurator'],
      },
    );

    expect(authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(agent as never, new Map(), CG),
    )).toBeUndefined();
  });

  it('demotes when the graph does not name that curator at all', async () => {
    // A curator the merged projection asserts but the graph never claimed.
    const agent = agentWithMeta(
      { curator: `did:dkg:agent:${CURATOR}` },
      async () => [],
      {},
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, new Map(), CG);
    expect(resolved.peerId).toBe(CURATOR);
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('fails closed to ranking when the source-qualified read is unavailable', async () => {
    // A receiver without the reader, or one whose read throws, must never be
    // upgraded to authority.
    const noReader = {
      getCgMeta: async () => ({ curator: `did:dkg:agent:${CURATOR}`, curators: [], creators: [] }),
      discovery: { findAgents: async () => [] },
    };
    expect(authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(noReader as never, new Map(), CG),
    )).toBeUndefined();

    const throwingReader = {
      ...noReader,
      getOwnCgMetaFacts: async () => { throw new Error('store unavailable'); },
    };
    expect(authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(throwingReader as never, new Map(), CG),
    )).toBeUndefined();
  });

  it('will not make an AMBIGUOUS registry match an authority', async () => {
    // `findAgents()` returns whichever registrations exist for a wallet, and the
    // code has always documented the pick as arbitrary when there are several.
    // That was harmless while this only ranked the walk. It is not harmless now
    // that `'metadata'` means "may end the walk": an ordinary member sharing the
    // curator's wallet could answer with a clean subset and stop the walk before
    // the real curator is ever contacted.
    const hints = new Map([[CG, HINT]]);
    const agent = agentWithMeta(
      { curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab' },
      async () => [
        { agentAddress: '0x00000000000000000000000000000000000000AB', peerId: '12D3KooWMemberA' },
        { agentAddress: '0x00000000000000000000000000000000000000ab', peerId: '12D3KooWMemberB' },
      ],
    );

    const resolved = await resolveCuratorSyncPeer(agent as never, hints, CG);
    // It still RANKS the walk — an arbitrary co-registrant is a better first try
    // than nothing…
    expect(resolved.peerId).toBe('12D3KooWMemberA');
    expect(resolved.provenance).toBe('registry');
    // …but it can never END it.
    expect(authoritativeSyncPeerId(resolved)).toBeUndefined();
  });

  it('keeps the deterministic metadata routes authoritative', async () => {
    // The positive complement, so the guard cannot be widened into something
    // that disables the early stop wholesale. Neither of these routes touches
    // the registry: a bare peer-id DID, and the projected DKG_CREATOR triple.
    const bareDid = agentWithMeta({ curator: `did:dkg:agent:${CURATOR}` }, async () => {
      throw new Error('a bare peer-id DID must not need the registry');
    });
    expect(authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(bareDid as never, new Map(), CG),
    )).toBe(CURATOR);

    const declared = {
      curator: 'did:dkg:agent:0x00000000000000000000000000000000000000ab',
      creator: `did:dkg:agent:${CURATOR}`,
    };
    const viaCreator = agentWithMeta(declared, async () => {
      throw new Error('the DKG_CREATOR route must not need the registry');
    }, declared);
    expect(authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(viaCreator as never, new Map(), CG),
    )).toBe(CURATOR);
  });

  it('answers ranking and authority from ONE resolution', async () => {
    // The catch-up boundary needs both notions, and resolving twice is not
    // free or even equivalent: each resolution reads `_meta` (and can drive the
    // registry fallback), and the resolver EVICTS the bootstrap hint once
    // metadata confirms a curator, so the second call runs against a different
    // map than the first.
    let metaReads = 0;
    // Production shape: the projection records the declared curator both as the
    // scalar and in the array, alongside the canonical definition facts.
    const declared = {
      declared: true,
      accessPolicy: 'private',
      curator: `did:dkg:agent:${CURATOR}`,
      curators: [`did:dkg:agent:${CURATOR}`],
      creators: [],
    };
    const agent = {
      preferredSyncPeers: new Map([[CG, CURATOR]]),
      getCgMeta: async () => {
        metaReads += 1;
        return declared;
      },
      // The graph declares this curator itself, so the binding is authoritative.
      getOwnCgMetaFacts: async () => declared,
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
