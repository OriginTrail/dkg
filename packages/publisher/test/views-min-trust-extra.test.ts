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
 * Fix: `resolveViewGraphs` keeps the root data graph and verified-memory
 * graphs as candidates. `DKGQueryEngine` then enforces `minTrust` with
 * writer-side `dkg:trustLevel` metadata instead of graph-scope inference.
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
    'minTrust=Endorsed keeps root and verified-memory graphs as candidates',
    () => {
      const res = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.Endorsed,
      });
      expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
      expect(res.graphPrefixes).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/`,
      ]);
    },
  );

  it(
    'minTrust > Endorsed keeps root and verified-memory graphs for trust-tag filtering',
    () => {
      const partially = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.PartiallyVerified,
      });
      const consensus = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.ConsensusVerified,
      });
      for (const res of [partially, consensus]) {
        expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
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
    'verifiedGraph + minTrust above Endorsed is allowed and enforced by trust tags',
    () => {
      for (const minTrust of [
        TrustLevel.Endorsed,
        TrustLevel.PartiallyVerified,
        TrustLevel.ConsensusVerified,
      ]) {
        const res = resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust,
        });
        expect(res.graphs).toEqual([
          `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
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
          resolveViewGraphs('verified-memory', CG, { minTrust: mt as TrustLevel }),
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
          resolveViewGraphs('verified-memory', CG, { minTrust: mt }),
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
      // We probe with an untagged root-graph quad. If `_minTrust` is
      // silently dropped, the row remains visible; if it is honoured,
      // the trust metadata filter removes it.
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

      // `_minTrust=Endorsed` via the legacy key alone — the alias
      // MUST propagate to the trust metadata filter. Result: the
      // untagged probe quad is no longer visible.
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
      // `minTrust: SelfAttested` no trust filter is applied, so the
      // probe quad surfaces again and rules out the "alias overrides
      // explicit field" bug.
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
      // it, only `minTrust` is set. The engine must honour that
      // contract and apply the trust metadata filter; the untagged
      // root-graph quad must not be returned.
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
    'verifiedGraph + minTrust is ALLOWED on the exact-graph path and enforced by trust tags',
    async () => {
      const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
      const { DKGQueryEngine } = await import('@origintrail-official/dkg-query');
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.Endorsed,
        }),
      ).resolves.toBeDefined();

      await expect(
        engine.query('SELECT ?s WHERE { ?s ?p ?o }', {
          contextGraphId: CG,
          view: 'verified-memory',
          verifiedGraph: 'some-quorum',
          minTrust: TrustLevel.PartiallyVerified,
        }),
      ).resolves.toBeDefined();
    },
  );

  it(
    'empty trust-filtered results respect query form',
    async () => {
      // A `verified-memory` query with `minTrust=Endorsed` and no matching
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
