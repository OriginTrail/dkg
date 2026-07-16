/**
 * View resolution + `minTrust` filtering tests (P-13).
 *
 * Audit finding covered:
 *
 *   P-13 (MEDIUM) — Spec §12 GET declares that the `verifiable-memory`
 *                   view MUST honor `minTrust` so a caller requesting
 *                   `TrustLevel.ConsensusVerified` does NOT see triples
 *                   that only reached `TrustLevel.SelfAttested`. The
 *                   original `resolveViewGraphs(view, cgId, opts)`
 *                   signature had no `minTrust` parameter — the field
 *                   was declared on the query-engine `QueryOptions`
 *                   type, but the resolver silently ignored it.
 *
 * Fix: `resolveViewGraphs` keeps the root data graph and verifiable-memory
 * graphs as candidates. `DKGQueryEngine` then enforces `minTrust` with
 * writer-side `dkg:trustLevel` metadata instead of graph-scope inference.
 *
 * RC11 / PR-A (Codex review fix on #671): the root content graph
 * `did:dkg:context-graph:{id}` is unioned into VM alongside the
 * `_verifiable_memory/*` prefix — the PR2 first cut dropped it but that
 * broke immediate VM queries for existing publish callers. The tentative-VM
 * leak that change was guarding against is now plugged at the publisher
 * (root-graph insert deferred to the
 * chain-success branch).
 */
import { describe, expect, it } from 'vitest';
import { TrustLevel } from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = '42';
const VM_QUORUM_A = '0xa0a0a0';

describe('P-13: resolveViewGraphs handles minTrust for verifiable-memory', () => {
  it('default verifiable-memory resolution unions root context-graph + _verifiable_memory/ prefix (RC11 / PR-A: Codex #671)', () => {
    const res: ViewResolution = resolveViewGraphs('verifiable-memory', CG);
    // RC11 / PR-A (Codex review fix on #671): the root context-graph
    // is re-included alongside the `_verifiable_memory/*` prefix so a
    // successful publish is immediately observable via VM. The
    // tentative-VM leak the PR2 first cut was guarding against is now
    // plugged at the publisher (root-graph insert deferred to the
    // chain-success branch).
    expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(res.graphPrefixes).toContain(`did:dkg:context-graph:${CG}/_verifiable_memory/`);
  });

  it('a specific verifiedGraph narrows to a single named graph (no prefix scan)', () => {
    const res = resolveViewGraphs('verifiable-memory', CG, { verifiedGraph: VM_QUORUM_A });
    expect(res.graphs).toEqual([
      `did:dkg:context-graph:${CG}/_verifiable_memory/${VM_QUORUM_A}`,
    ]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('minTrust=SelfAttested (or omitted) matches the default resolution (RC11 / PR-A)', () => {
    const omitted = resolveViewGraphs('verifiable-memory', CG);
    const explicit = resolveViewGraphs('verifiable-memory', CG, {
      minTrust: TrustLevel.SelfAttested,
    });
    expect(omitted.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(explicit.graphs).toEqual(omitted.graphs);
    expect(explicit.graphPrefixes).toEqual(omitted.graphPrefixes);
  });

  it(
    'minTrust=Endorsed keeps the same graph candidates (trust enforced by writer-side metadata) (RC11 / PR-A)',
    () => {
      const res = resolveViewGraphs('verifiable-memory', CG, {
        minTrust: TrustLevel.Endorsed,
      });
      // Graph candidates are identical across trust floors — the floor
      // is enforced downstream by `injectMinTrustFilter` against
      // writer-side `dkg:trustLevel` quads.
      expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
      expect(res.graphPrefixes).toEqual([
        `did:dkg:context-graph:${CG}/_verifiable_memory/`,
      ]);
    },
  );

  it(
    'minTrust > Endorsed keeps the same graph candidates for trust-tag filtering (RC11 / PR-A)',
    () => {
      const partially = resolveViewGraphs('verifiable-memory', CG, {
        minTrust: TrustLevel.PartiallyVerified,
      });
      const consensus = resolveViewGraphs('verifiable-memory', CG, {
        minTrust: TrustLevel.ConsensusVerified,
      });
      for (const res of [partially, consensus]) {
        expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
        expect(res.graphPrefixes).toEqual([
          `did:dkg:context-graph:${CG}/_verifiable_memory/`,
        ]);
      }
    },
  );

  it(
    'verifiedGraph + minTrust=SelfAttested is allowed — minTrust is a no-op at SelfAttested',
    () => {
      const res = resolveViewGraphs('verifiable-memory', CG, {
        verifiedGraph: VM_QUORUM_A,
        minTrust: TrustLevel.SelfAttested,
      });
      expect(res.graphs).toEqual([
        `did:dkg:context-graph:${CG}/_verifiable_memory/${VM_QUORUM_A}`,
      ]);
      expect(res.graphPrefixes).toEqual([]);
    },
  );

  it(
    'verifiedGraph + minTrust above Endorsed is allowed and enforced by trust tags',
    () => {
      for (const minTrust of [
        TrustLevel.Endorsed,
        TrustLevel.PartiallyVerified,
        TrustLevel.ConsensusVerified,
      ]) {
        const res = resolveViewGraphs('verifiable-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust,
        });
        expect(res.graphs).toEqual([
          `did:dkg:context-graph:${CG}/_verifiable_memory/${VM_QUORUM_A}`,
        ]);
        expect(res.graphPrefixes).toEqual([]);
      }
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
          resolveViewGraphs('verifiable-memory', CG, { minTrust: mt as TrustLevel }),
        ).toThrow(/Invalid minTrust/);
      }
      // Every valid TrustLevel (SelfAttested..ConsensusVerified) must
      // resolve without throwing. `DKGQueryEngine.queryWithView`
      // enforces trust floors downstream via `injectMinTrustFilter`.
      for (const mt of [
        TrustLevel.SelfAttested,
        TrustLevel.Endorsed,
        TrustLevel.PartiallyVerified,
        TrustLevel.ConsensusVerified,
      ]) {
        expect(() =>
          resolveViewGraphs('verifiable-memory', CG, { minTrust: mt }),
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
      // We probe with an untagged verifiable-memory sub-graph quad. If
      // `_minTrust` is silently dropped, the row remains visible; if it
      // is honoured, the trust metadata filter removes it.
      //
      // The probe quad is placed in a `_verifiable_memory/*` sub-graph
      // so the trust filter is exercised on writer-side metadata, not
      // graph-scope. (RC11 / PR-A re-includes the root graph in VM —
      // see top-of-file commentary — but that's orthogonal: this test
      // pins the trust-filter contract, which fires regardless of
      // which VM-eligible graph the probe lives in.)
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const probeGraph = `did:dkg:context-graph:${CG}/_verifiable_memory/${VM_QUORUM_A}`;
      await store.insert([
        {
          subject: 'urn:probe',
          predicate: 'http://schema.org/name',
          object: '"probe"',
          graph: probeGraph,
        },
      ]);
      const engine = new DKGQueryEngine(store);
      const probeSparql = 'SELECT ?s WHERE { ?s ?p ?o }';

      // `_minTrust=Endorsed` via the legacy key alone — the alias
      // MUST propagate to the trust metadata filter. Result: the
      // untagged probe quad is no longer visible.
      const aliased = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verifiable-memory',
        _minTrust: TrustLevel.Endorsed,
      });
      expect(aliased.bindings).toEqual([]);

      // Control: omit both `minTrust` keys. The VM sub-graph is in
      // scope and the probe quad surfaces — proves the emptiness above
      // came from the alias being honoured, not from the engine being
      // broken.
      const unconstrained = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verifiable-memory',
      });
      expect(unconstrained.bindings.length).toBeGreaterThan(0);

      // Explicit `minTrust` wins over `_minTrust`. With
      // `minTrust: SelfAttested` no trust filter is applied, so the
      // probe quad surfaces again and rules out the "alias overrides
      // explicit field" bug.
      const precedence = await engine.query(probeSparql, {
        contextGraphId: CG,
        view: 'verifiable-memory',
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
      // RC11 / PR2: the probe quad lives in a `_verifiable_memory/*`
      // sub-graph (root graph is no longer in VM). The test still
      // proves the engine-side trust filter rejects untagged quads
      // even when the agent layer has already normalised the alias.
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const probeGraph = `did:dkg:context-graph:${CG}/_verifiable_memory/${VM_QUORUM_A}`;
      await store.insert([
        {
          subject: 'urn:probe-engine-side',
          predicate: 'http://schema.org/name',
          object: '"probe"',
          graph: probeGraph,
        },
      ]);
      const engine = new DKGQueryEngine(store);

      // `DKGAgent.query` collapses `opts.minTrust ?? opts._minTrust`
      // before calling `engine.query`, so by the time the engine sees
      // it, only `minTrust` is set. The engine must honour that
      // contract and apply the trust metadata filter; the untagged
      // sub-graph quad must not be returned.
      const aboveEndorsed = await engine.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        {
          contextGraphId: CG,
          view: 'verifiable-memory',
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
      // views — it's a verifiable-memory-only concept.
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

      // …but it MUST still fail closed on verifiable-memory:
      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verifiable-memory',
          minTrust: 99 as unknown as TrustLevel,
        }),
      ).rejects.toThrow(/Invalid minTrust/);
    },
  );

  it(
    'verifiedGraph + minTrust is ALLOWED on the exact-graph path and enforced by trust tags',
    async () => {
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verifiable-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.Endorsed,
        }),
      ).resolves.toBeDefined();

      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verifiable-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.PartiallyVerified,
        }),
      ).resolves.toBeDefined();
    },
  );

  it(
    'empty trust-filtered results respect query form',
    async () => {
      // A `verifiable-memory` query with `minTrust=Endorsed` and no matching
      // trust metadata must still return a shape that matches its query form:
      //   - SELECT  → { bindings: [] }
      //   - ASK     → { bindings: [{ result: 'false' }] }
      //   - CONSTRUCT/DESCRIBE → { bindings: [], quads: [] }
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      const select = await engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(select).toEqual({ bindings: [] });

      const ask = await engine.query('ASK { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(ask).toEqual({ bindings: [{ result: 'false' }] });

      const construct = await engine.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.Endorsed },
      );
      expect(construct.bindings).toEqual([]);
      expect(construct.quads).toEqual([]);

      const describe = await engine.query('DESCRIBE ?s WHERE { ?s ?p ?o }', {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.Endorsed,
      });
      expect(describe.bindings).toEqual([]);
      expect(describe.quads).toEqual([]);
    },
  );
});
