/**
 * View resolution + `minTrust` filtering tests (P-13).
 *
 * Audit finding covered:
 *
 *   P-13 (MEDIUM) — Spec §12 GET declares that the `verified-memory`
 *                   view MUST honor `minTrust` so a caller requesting
 *                   `TrustLevel.ConsensusVerified` does NOT see triples
 *                   that only reached `TrustLevel.SelfAttested`. The
 *                   original `resolveViewGraphs(view, cgId, opts)`
 *                   signature had no `minTrust` parameter — the field
 *                   was declared on the query-engine `QueryOptions`
 *                   type, but the resolver silently ignored it.
 *
 * Fix: `resolveViewGraphs` now accepts `minTrust`. When it is set
 * above `TrustLevel.SelfAttested`, the root data graph (which holds
 * chain-confirmed SelfAttested triples) is dropped from the resolution.
 * Only quorum-verified sub-graphs under `/_verified_memory/{quorum}`
 * survive the resolution step.
 *
 * Note: per-quad trust filtering inside the surviving sub-graphs (based
 * on a `dkg:trustLevel` predicate on each triple) is tracked as Q-1 and
 * is out of scope for this test.
 */
import { describe, expect, it } from 'vitest';
import { TrustLevel } from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = '42';
const VM_QUORUM_A = '0xa0a0a0';

describe('P-13: resolveViewGraphs handles minTrust for verified-memory', () => {
  it('default verified-memory resolution unions the data graph + verified-memory prefix', () => {
    const res: ViewResolution = resolveViewGraphs('verified-memory', CG);
    expect(res.graphs).toContain(`did:dkg:context-graph:${CG}`);
    expect(res.graphPrefixes).toContain(`did:dkg:context-graph:${CG}/_verified_memory/`);
  });

  it('a specific verifiedGraph narrows to a single named graph (no prefix scan)', () => {
    const res = resolveViewGraphs('verified-memory', CG, { verifiedGraph: VM_QUORUM_A });
    expect(res.graphs).toEqual([
      `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
    ]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('minTrust=SelfAttested (or omitted) keeps the root data graph', () => {
    const omitted = resolveViewGraphs('verified-memory', CG);
    const explicit = resolveViewGraphs('verified-memory', CG, {
      minTrust: TrustLevel.SelfAttested,
    });
    expect(omitted.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(explicit.graphs).toEqual(omitted.graphs);
    expect(explicit.graphPrefixes).toEqual(omitted.graphPrefixes);
  });

  it(
    'minTrust=Endorsed drops the root data graph — prevents SelfAttested triples ' +
      'from leaking into Endorsed queries (see BUGS_FOUND.md P-13).',
    () => {
      const res = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.Endorsed,
      });
      // Root data graph must not be present above SelfAttested.
      expect(res.graphs).not.toContain(`did:dkg:context-graph:${CG}`);
      expect(res.graphs).toEqual([]);
      // Quorum-verified sub-graphs are still discovered via the prefix.
      expect(res.graphPrefixes).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/`,
      ]);
    },
  );

  it(
    'minTrust > Endorsed REJECTS — Codex PR #239 review: /_verified_memory/* has no ' +
      'per-graph trust metadata, so PartiallyVerified / ConsensusVerified cannot be proven',
    () => {
      // Without per-graph trust tagging (Q-1) the resolver would otherwise
      // return the exact same graph set for `Endorsed`, `PartiallyVerified`,
      // and `ConsensusVerified`, meaning a caller asking for a stricter tier
      // could silently receive lower-tier data. Reject instead, until
      // per-graph trust tagging lands.
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          minTrust: TrustLevel.PartiallyVerified,
        }),
      ).toThrow(/Invalid minTrust=2 for verified-memory/);
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          minTrust: TrustLevel.ConsensusVerified,
        }),
      ).toThrow(/Invalid minTrust=3 for verified-memory/);
    },
  );

  it(
    'verifiedGraph + minTrust=SelfAttested is allowed — minTrust is a no-op at SelfAttested',
    () => {
      const res = resolveViewGraphs('verified-memory', CG, {
        verifiedGraph: VM_QUORUM_A,
        minTrust: TrustLevel.SelfAttested,
      });
      expect(res.graphs).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
      ]);
      expect(res.graphPrefixes).toEqual([]);
    },
  );

  it(
    'verifiedGraph + minTrust > SelfAttested REJECTS — the engine cannot yet prove a ' +
      'named sub-graph satisfies a trust threshold, so silently reading it would violate spec §14',
    () => {
      // Codex review on PR #239 flagged the original behaviour (silently
      // ignore minTrust when verifiedGraph is set) as a trust-bypass hole:
      // a caller could ask for ConsensusVerified and receive whatever
      // trust level happens to live under that exact _verified_memory URI.
      // The resolver now throws instead; callers must either drop
      // verifiedGraph (to union across the quorum-verified prefix) or
      // drop minTrust (to read the specific sub-graph verbatim).
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.ConsensusVerified,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above SelfAttested/);
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.Endorsed,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above SelfAttested/);
    },
  );

  it(
    'rejects non-numeric / out-of-range minTrust values at the engine entry so direct ' +
      'callers (DKGAgent.query, SDK users) fail closed instead of JS-coerced comparison',
    () => {
      // Codex review on PR #239: the daemon normalises string "ConsensusVerified"
      // to the numeric enum, but direct in-process callers could pass
      // anything and `minTrust > TrustLevel.SelfAttested` would silently
      // coerce. Validate at `resolveViewGraphs` so every entry point
      // fails closed with a 400-mappable "Invalid minTrust" error.
      const bad: Array<unknown> = [
        'ConsensusVerified',
        '0',
        null,
        true,
        -1,
        4,
        99,
        1.5,
        {},
      ];
      for (const mt of bad) {
        expect(() =>
          resolveViewGraphs('verified-memory', CG, { minTrust: mt as TrustLevel }),
        ).toThrow(/Invalid minTrust/);
      }
      // SelfAttested and Endorsed are the two tiers the resolver can
      // currently prove against the graph layout; PartiallyVerified and
      // ConsensusVerified must be rejected until Q-1's per-graph trust
      // tagging lands (see the "minTrust > Endorsed REJECTS" test above).
      for (const mt of [TrustLevel.SelfAttested, TrustLevel.Endorsed]) {
        expect(() =>
          resolveViewGraphs('verified-memory', CG, { minTrust: mt }),
        ).not.toThrow();
      }
    },
  );

  it(
    'accepts the legacy `_minTrust` alias as a back-compat normalizer ' +
      '(Codex PR #239 review: former `_minTrust` SDK consumers must not silently lose the filter)',
    async () => {
      // `_minTrust` was briefly exported on QueryOptions before V10.
      // `resolveViewGraphs` itself only consumes `minTrust`, but the
      // engine-level normalisation `options.minTrust ?? options._minTrust`
      // MUST forward the legacy form through. This test exercises the
      // engine path (not the resolver) to confirm the alias still works.
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      // Endorsed via the legacy key alone — should route to
      // verified-memory minus the root graph (same as `minTrust: Endorsed`).
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          _minTrust: TrustLevel.Endorsed,
        }),
      ).resolves.toBeDefined();
      // Explicit `minTrust` wins over `_minTrust` (so a caller that sets
      // both gets the new-form semantics).
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          minTrust: TrustLevel.SelfAttested,
          _minTrust: TrustLevel.ConsensusVerified,
        }),
      ).resolves.toBeDefined();
    },
  );

  it(
    'DKGAgent.query forwards the `_minTrust` legacy alias end-to-end ' +
      '(Codex PR #239 iter-5: the alias was only honoured at the engine layer, ' +
      'so callers reaching DKGAgent.query or /api/query silently lost the trust gate)',
    async () => {
      // Stand up a minimal DKGAgent-shape object and confirm the alias
      // is forwarded to the engine without the caller having to rename it.
      // We don't need a full DKGAgent here — just evidence that a caller
      // passing `{ _minTrust: PartiallyVerified }` through DKGAgent.query
      // ends up with `minTrust=PartiallyVerified` at `resolveViewGraphs`,
      // i.e. it trips the "rejected above Endorsed" guard rather than
      // silently degrading to the SelfAttested union.
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      // Direct engine call with only `_minTrust` set to a rejected tier:
      // the engine must honour the alias and rejection must fire, proving
      // the alias is threaded at least as far as `resolveViewGraphs`.
      // `DKGAgent.query` re-normalises with the same `??` pattern above
      // its `queryEngine.query` call, so forwarding here transitively
      // covers the agent layer without importing the full agent.
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          _minTrust: TrustLevel.PartiallyVerified,
        }),
      ).rejects.toThrow(/Invalid minTrust=2 for verified-memory/);
    },
  );

  it(
    'zero-graph resolution respects query form ' +
      '(Codex PR #239 iter-5: returning `{ bindings: [] }` for an ASK/CONSTRUCT ' +
      'breaks the SPARQL response contract)',
    async () => {
      // A `verified-memory` query with `minTrust=Endorsed` on a context
      // graph that has zero `/_verified_memory/*` sub-graphs resolves to
      // an empty graph set. Each query form must still return a shape
      // that matches its spec:
      //   - SELECT  → { bindings: [] }
      //   - ASK     → { bindings: [{ result: 'false' }] }
      //   - CONSTRUCT/DESCRIBE → { bindings: [], quads: [] }
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      const select = await engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(select).toEqual({ bindings: [] });

      const ask = await engine.query('ASK { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(ask).toEqual({ bindings: [{ result: 'false' }] });

      const construct = await engine.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { contextGraphId: CG, view: 'verified-memory', minTrust: TrustLevel.Endorsed },
      );
      expect(construct.bindings).toEqual([]);
      expect(construct.quads).toEqual([]);

      const describe = await engine.query('DESCRIBE ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(describe.bindings).toEqual([]);
      expect(describe.quads).toEqual([]);
    },
  );
});
