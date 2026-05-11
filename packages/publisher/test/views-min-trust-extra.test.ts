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
 * Fix: `resolveViewGraphs` accepts `minTrust`. The root data graph is
 * dropped only when `minTrust` is strictly above `Endorsed` (i.e.
 * `PartiallyVerified` / `ConsensusVerified`). At `Endorsed`, the root
 * stays in scope so per-triple `dkg:trustLevel` filters apply (Axiom 6).
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

  it('minTrust=Endorsed keeps the root data graph (per-triple trustLevel is the gate)', () => {
    const res = resolveViewGraphs('verified-memory', CG, {
      minTrust: TrustLevel.Endorsed,
    });
    expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(res.graphPrefixes).toEqual([
      `did:dkg:context-graph:${CG}/_verified_memory/`,
    ]);
  });

  it(
    'minTrust > Endorsed resolves to the /_verified_memory/ prefix — per-triple trust ' +
      'filtering (Q-1) handles `PartiallyVerified` / `ConsensusVerified` downstream',
    () => {
      // Pre-Q-1 the resolver rejected above-Endorsed because per-graph
      // trust metadata was not available and returning the same graph
      // set as Endorsed would silently serve lower-trust data. Q-1
      // closed the hole at the PER-TRIPLE level (see
      // `DKGQueryEngine.queryWithView` + `injectMinTrustFilter`): the
      // user SPARQL is rewritten so every subject MUST carry
      // `<http://dkg.io/ontology/trustLevel> "N"` with
      // `N ≥ minTrust`, so sub-threshold triples in the sub-graph
      // prefix are excluded. Graph-scope: only strictly-above-Endorsed
      // tiers drop the root (see `Endorsed` dedicated test above).
      const partially = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.PartiallyVerified,
      });
      const consensus = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.ConsensusVerified,
      });
      for (const res of [partially, consensus]) {
        expect(res.graphs).not.toContain(`did:dkg:context-graph:${CG}`);
        expect(res.graphs).toEqual([]);
        expect(res.graphPrefixes).toEqual([
          `did:dkg:context-graph:${CG}/_verified_memory/`,
        ]);
      }
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
    'verifiedGraph + minTrust ABOVE Endorsed REJECTS — the engine cannot yet prove a ' +
      'named sub-graph satisfies PartiallyVerified/ConsensusVerified, so silently ' +
      'reading it would violate spec §14',
    () => {
      // Codex review on PR #239 originally flagged the "ignore minTrust
      // when verifiedGraph is set" behaviour as a trust-bypass hole.
      // Iter-6 refined that: because every `/_verified_memory/<id>`
      // graph is written only by quorum-verified paths, the implicit
      // floor on this path is Endorsed. `verifiedGraph + Endorsed`
      // therefore returns the single named graph (callers who want
      // SelfAttested still get it, callers who want Endorsed get the
      // same data), while `PartiallyVerified` / `ConsensusVerified`
      // remain rejected until Q-1 lands per-graph trust metadata.
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.ConsensusVerified,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above Endorsed/);
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.PartiallyVerified,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above Endorsed/);
      // Endorsed is now the Q-1 ceiling for the exact-graph path and
      // MUST succeed — the returned graph is the single sub-graph URI.
      const endorsed = resolveViewGraphs('verified-memory', CG, {
        verifiedGraph: VM_QUORUM_A,
        minTrust: TrustLevel.Endorsed,
      });
      expect(endorsed.graphs).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
      ]);
    },
  );

  it(
    'rejects garbage minTrust values at the engine entry, but accepts the spec-documented ' +
      'string forms ("self-attested" | "endorsed" | "partially-verified" | "consensus-verified" | "contested" ' +
      'and PascalCase equivalents) per dkgv10-spec §6 GET',
    () => {
      // Spec §6 (`02_AXIOMS.md`) lists the trust bands as kebab-case
      // string filter values. Earlier iterations rejected string inputs
      // outright at the engine entry — that broke spec parity with
      // `/api/query`, made `agent.query({ minTrust: 'consensus-verified'})`
      // unreachable, and forced JS callers to import the numeric enum
      // even though the HTTP contract is documented in strings. The fix
      // (Axiom 6.h) is to normalise the documented strings AND keep the
      // hard-fail on bogus values so we never JS-coerce silently.
      const bad: Array<unknown> = [
        'NotATrustLevel',
        '0',
        null,
        true,
        -1,
        99,
        1.5,
        {},
      ];
      for (const mt of bad) {
        expect(() =>
          resolveViewGraphs('verified-memory', CG, { minTrust: mt as TrustLevel }),
        ).toThrow(/Invalid minTrust/);
      }
      // Every valid TrustLevel (SelfAttested..Contested) resolves without
      // throwing. Per-triple filtering (Q-1) handles above-Endorsed tiers
      // downstream at `DKGQueryEngine.queryWithView` via
      // `injectMinTrustFilter`.
      for (const mt of [
        TrustLevel.SelfAttested,
        TrustLevel.Endorsed,
        TrustLevel.PartiallyVerified,
        TrustLevel.ConsensusVerified,
        TrustLevel.Contested,
      ]) {
        expect(() =>
          resolveViewGraphs('verified-memory', CG, { minTrust: mt }),
        ).not.toThrow();
      }
      // Spec-documented strings must round-trip without throwing.
      const validStrings = [
        'SelfAttested', 'Endorsed', 'PartiallyVerified', 'ConsensusVerified', 'Contested',
        'self-attested', 'endorsed', 'partially-verified', 'consensus-verified', 'contested',
      ];
      for (const s of validStrings) {
        expect(
          () => resolveViewGraphs('verified-memory', CG, { minTrust: s as unknown as TrustLevel }),
          `spec-documented minTrust string "${s}" must be accepted`,
        ).not.toThrow();
      }
    },
  );

  it(
    'accepts the legacy `_minTrust` alias as a back-compat normalizer ' +
      '(Codex PR #239 iter-7: assert the alias is materially threaded — ' +
      'previously this test only checked for `resolves.toBeDefined` which stayed green ' +
      'even if the alias was silently dropped on the way to the engine.)',
    async () => {
      // `_minTrust` was briefly exported on QueryOptions before V10.
      // `resolveViewGraphs` itself only consumes `minTrust`, but the
      // engine-level normalisation `options.minTrust ?? options._minTrust`
      // MUST forward the legacy form through.
      //
      // To prove the alias is actually honoured (not silently dropped)
      // we rely on the graph-scope contract from `resolveViewGraphs`:
      //   - `minTrust === undefined` (or SelfAttested) keeps the root
      //     data graph in the resolution;
      //   - `minTrust > SelfAttested` drops the root graph.
      // We insert a root-graph quad with no `dkg:trustLevel` and run a
      // SELECT with `_minTrust=Endorsed`. The trust rewriter must
      // exclude the row (not graph-dropped; fail-closed on missing trust).
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const rootGraph = `did:dkg:context-graph:${CG}`;
      await store.insert([
        {
          subject: 'urn:probe',
          predicate: 'http://schema.org/name',
          object: '"probe"',
          graph: rootGraph,
        },
      ]);
      const engine = new DKGQueryEngine(store);
      const probeSparql = 'SELECT ?s WHERE { ?s ?p ?o }';

      // `_minTrust=Endorsed` via the legacy key — the alias must
      // propagate; the per-triple trust filter excludes unstamped data.
      const aliased = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verified-memory',
        _minTrust: TrustLevel.Endorsed,
      });
      expect(aliased.bindings).toEqual([]);

      // Control: omit both `minTrust` keys. The root graph is in scope
      // and the probe quad surfaces — proves the emptiness above came
      // from the alias being honoured, not from the engine being broken.
      const unconstrained = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verified-memory',
      });
      expect(unconstrained.bindings.length).toBeGreaterThan(0);

      // Explicit `minTrust` wins over `_minTrust`. With
      // `minTrust: SelfAttested` the root graph stays in scope even
      // when `_minTrust: Endorsed` would filter it, so the probe quad
      // surfaces again — rules out the "alias overrides explicit
      // field" bug.
      const precedence = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.SelfAttested,
        _minTrust: TrustLevel.Endorsed,
      });
      expect(precedence.bindings.length).toBeGreaterThan(0);
    },
  );

  it(
    '`_minTrust` legacy alias is threaded into `resolveViewGraphs` ' +
      '(Codex PR #239 iter-6: end-to-end DKGAgent.query coverage lives in ' +
      '`packages/agent/test/query-min-trust-alias.test.ts`; this one pins the ' +
      'engine side of the contract — if the engine stops honouring either name ' +
      'the agent layer cannot mask it.)',
    async () => {
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const rootGraph = `did:dkg:context-graph:${CG}`;
      await store.insert([
        {
          subject: 'urn:probe-engine-side',
          predicate: 'http://schema.org/name',
          object: '"probe"',
          graph: rootGraph,
        },
      ]);
      const engine = new DKGQueryEngine(store);

      // `DKGAgent.query` collapses `opts.minTrust ?? opts._minTrust`
      // before calling `engine.query`, so by the time the engine sees
      // it, only `minTrust` is set. `PartiallyVerified` drops the root
      // graph, so the root-living probe quad must not be returned.
      const aboveEndorsed = await engine.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        {
          contextGraphId: CG,
          view: 'verified-memory',
          minTrust: TrustLevel.PartiallyVerified,
        },
      );
      expect(aboveEndorsed.bindings).toEqual([]);
    },
  );

  it(
    'minTrust is ignored on working-memory / shared-working-memory views ' +
      '(Codex PR #239 iter-6: the engine-entry validation rejected any number that ' +
      'was not a TrustLevel even on views where the field is documented as ignored, ' +
      'breaking callers who reuse a single options object across views)',
    async () => {
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      // A bogus minTrust value (99) must NOT trip the guard on these
      // views — it's a verified-memory-only concept.
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'working-memory',
          agentAddress: 'did:dkg:agent:0xabc',
          minTrust: 99 as unknown as TrustLevel,
        }),
      ).resolves.toBeDefined();

      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'shared-working-memory',
          minTrust: 99 as unknown as TrustLevel,
        }),
      ).resolves.toBeDefined();

      // …but it MUST still fail closed on verified-memory:
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          minTrust: 99 as unknown as TrustLevel,
        }),
      ).rejects.toThrow(/Invalid minTrust/);
    },
  );

  it(
    'verifiedGraph + minTrust=Endorsed is ALLOWED on the exact-graph path ' +
      '(Codex PR #239 iter-6: the previous iteration rejected any minTrust above ' +
      'SelfAttested on this path, but every `/_verified_memory/<id>` graph is ' +
      'populated only by quorum-verified writes so it already satisfies Endorsed)',
    async () => {
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      // Happy path: Endorsed + verifiedGraph → empty result, no throw.
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.Endorsed,
        }),
      ).resolves.toBeDefined();

      // Values ABOVE Endorsed must still be rejected (same Q-1 reason).
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.PartiallyVerified,
        }),
      ).rejects.toThrow(/cannot be combined with minTrust above Endorsed/);
    },
  );

  it(
    'zero-graph resolution respects query form ' +
      '(Codex PR #239 iter-5: returning `{ bindings: [] }` for an ASK/CONSTRUCT ' +
      'breaks the SPARQL response contract)',
    async () => {
      // `minTrust` strictly above `Endorsed` drops the root; with no
      // `/_verified_memory/*` graphs in the store, resolution is an
      // empty graph set. Each query form must still return a contract-
      // correct empty shape.
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      const select = await engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.PartiallyVerified,
      });
      expect(select).toEqual({ bindings: [] });

      const ask = await engine.query('ASK { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.PartiallyVerified,
      });
      expect(ask).toEqual({ bindings: [{ result: 'false' }] });

      const construct = await engine.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { contextGraphId: CG, view: 'verified-memory', minTrust: TrustLevel.PartiallyVerified },
      );
      expect(construct.bindings).toEqual([]);
      expect(construct.quads).toEqual([]);

      const describe = await engine.query('DESCRIBE ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verified-memory',
        minTrust: TrustLevel.PartiallyVerified,
      });
      expect(describe.bindings).toEqual([]);
      expect(describe.quads).toEqual([]);
    },
  );
});
