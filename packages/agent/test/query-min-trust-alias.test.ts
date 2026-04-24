/**
 * PR #239 iter-6 — `DKGAgent.query` must forward the legacy `_minTrust`
 * alias to `queryEngine.query` as `minTrust`. An earlier iteration of
 * the regression test for this change lived in the publisher package
 * and only exercised `DKGQueryEngine.query` directly (Codex flagged
 * this: the engine honoured the alias via its own `??` pattern, so a
 * regression that dropped the agent-layer fallback could land green).
 *
 * This test replaces that one by spying on `DKGAgent.query`'s exact
 * call site — `this.queryEngine.query(sparql, { ...options, minTrust:
 * options.minTrust ?? options._minTrust })` in
 * `packages/agent/src/dkg-agent.ts`. No mocks beyond a tiny stub
 * engine; no network, no chain, no peer-id.
 */
import { describe, it, expect } from 'vitest';
import { TrustLevel } from '@origintrail-official/dkg-core';
import type { QueryResult, QueryOptions } from '@origintrail-official/dkg-query';
import { DKGAgent } from '../src/dkg-agent.js';

function makeStubAgent(observer: (opts: QueryOptions | undefined) => void): InstanceType<typeof DKGAgent> {
  // The two things `DKGAgent.query` touches (beyond logging + the
  // engine) are: the optional per-context access-control helpers and
  // the private-graph scrubber. Stubbing them with "allow everything"
  // lets the call fall through to `queryEngine.query`, which is
  // where the alias fallback lives.
  const stubEngine = {
    async query(_sparql: string, opts?: QueryOptions): Promise<QueryResult> {
      observer(opts);
      return { bindings: [] };
    },
    async resolveKA(): Promise<never> {
      throw new Error('not used by this test');
    },
  };
  const agent = Object.create(DKGAgent.prototype) as InstanceType<typeof DKGAgent>;
  Object.assign(agent, {
    log: { info() {}, warn() {}, debug() {}, error() {} },
    config: {},
    queryEngine: stubEngine,
    subscribedContextGraphs: new Set<string>(),
    // `query()` falls through to `canReadContextGraph` / `isPrivateContextGraph`
    // / `sparqlReferencesPrivateGraphs` — stub to "allow everything" so
    // the code path reaches the `queryEngine.query(...)` call site.
    canReadContextGraph: async () => true,
    isPrivateContextGraph: async () => false,
    sparqlReferencesPrivateGraphs: () => false,
    listPrivateContextGraphIdsNotReadableBy: async () => [],
  });
  // `peerId` on DKGAgent is exposed via a getter — `Object.assign`
  // cannot set it, but `Object.defineProperty` can replace the
  // inherited descriptor on this specific instance.
  Object.defineProperty(agent, 'peerId', { value: 'peer-test', configurable: true });
  return agent;
}

describe('DKGAgent.query forwards `_minTrust` alias (PR #239 iter-6)', () => {
  it('only `_minTrust` set → engine sees `minTrust` with the same value', async () => {
    let seen: QueryOptions | undefined;
    const agent = makeStubAgent((o) => { seen = o; });
    await agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: 'cg-1',
      view: 'verified-memory',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _minTrust: TrustLevel.Endorsed,
    } as any);
    expect(seen?.minTrust).toBe(TrustLevel.Endorsed);
  });

  it('both set → `minTrust` wins, `_minTrust` is ignored', async () => {
    let seen: QueryOptions | undefined;
    const agent = makeStubAgent((o) => { seen = o; });
    await agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: 'cg-1',
      view: 'verified-memory',
      minTrust: TrustLevel.Endorsed,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _minTrust: TrustLevel.ConsensusVerified,
    } as any);
    expect(seen?.minTrust).toBe(TrustLevel.Endorsed);
  });

  it('neither set → engine sees `minTrust: undefined`', async () => {
    let seen: QueryOptions | undefined;
    const agent = makeStubAgent((o) => { seen = o; });
    await agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: 'cg-1',
      view: 'verified-memory',
    });
    expect(seen?.minTrust).toBeUndefined();
  });
});
