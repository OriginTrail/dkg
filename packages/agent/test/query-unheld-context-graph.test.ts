// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { resolveKnowledgeAssetRead } from '../src/knowledge-asset-read-resolution.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const OUTSIDER = '0x00000000000000000000000000000000000000ff';
/** Registered on chain as private; only OWNER is on its roster. */
const CHAIN_PRIVATE_CG = `${OWNER}/unheld-answer-chain-private`;
/** Created on this node as private, never registered; only OWNER may read it. */
const LOCAL_PRIVATE_CG = `${OWNER}/unheld-answer-local-private`;
/** Never created anywhere. */
const MISSING_CG = `${OWNER}/unheld-answer-never-created`;
/** Data in its graphs, without a declaration, subscription or local create. */
const UNDECLARED_CG = `${OWNER}/unheld-answer-undeclared`;
/** Never created; this node holds a child context graph of it, whose graphs share its IRI prefix. */
const PARENT_CG = `${OWNER}/unheld-answer-parent`;
const CHILD_CG = `${PARENT_CG}/child`;
const MARKER = 'urn:unheld-answer:marker';
const MARKER_CLASS = 'urn:unheld-answer:Class';
const ON_CHAIN_ID = 7n;
const SELECT = `SELECT ?s WHERE { ?s a <${MARKER_CLASS}> }`;

/** How the node resolves an id it holds nothing of. */
type Regime = 'local-fallback' | 'finalized-absence';
type Outcome = { answer: unknown } | { error: { name: unknown; code: unknown; message: unknown } };

// One request per refusal or answer shape the scoped query path has.
const REQUESTS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ['a plain SELECT', SELECT, {}],
  ['a count', 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }', {}],
  ['an ASK', 'ASK { ?s ?p ?o }', {}],
  ['a CONSTRUCT', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', {}],
  ['a row without a pattern', 'SELECT (1 AS ?one) WHERE { }', {}],
  ['a SERVICE clause', 'SELECT ?s WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }', {}],
  ['a FROM clause', 'SELECT ?s FROM <urn:unheld-answer:other> WHERE { ?s ?p ?o }', {}],
  ['a GRAPH variable inside a nested SELECT', 'SELECT ?s WHERE { { SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } } }', {}],
  ['a GRAPH IRI outside the context graph', 'SELECT ?s WHERE { GRAPH <urn:unheld-answer:other> { ?s ?p ?o } }', {}],
  ['a removed view', SELECT, { view: 'long-term-memory' }],
  ['an unknown trust level', SELECT, { view: 'verifiable-memory', minTrust: 9 }],
  ['an invalid sub-graph name', SELECT, { subGraphName: '../x' }],
  ['a sub-graph', SELECT, { subGraphName: 'tasks' }],
  ['the working-memory view', SELECT, { view: 'working-memory' }],
  ['the shared-memory view', SELECT, { view: 'shared-working-memory' }],
  ['the verifiable-memory view', SELECT, { view: 'verifiable-memory' }],
];

describe('a query for a context graph this node holds nothing of', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop();
      await agent.store.close();
    }
    agent = undefined;
  });

  async function fixture(regime: Regime) {
    const chain = new MockChainAdapter();
    const created = await DKGAgent.create({ name: 'QueryUnheldContextGraph', chainAdapter: chain, store: new OxigraphStore() });
    agent = created;
    // A host identity is enough for local create and query; no peer runs.
    vi.spyOn(created, 'peerId', 'get').mockReturnValue('peer-query-unheld-context-graph');
    created.gossip = {
      subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), publish: vi.fn(async () => undefined),
    } as unknown as DKGAgent['gossip'];
    const runtime = created as unknown as { rfc64PublicCatalogServiceV1: unknown };
    vi.spyOn(runtime, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({ acceptedPolicySnapshot: () => null });

    // Only the chain registration is replaced, once the graphs exist. Read authority and query execution stay real.
    let registered = false;
    const resolveRegistration = created.resolveContextGraphRegistrationBinding.bind(created);
    vi.spyOn(created, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id, options) => {
      if (!registered) return resolveRegistration(id, options);
      if (id === CHAIN_PRIVATE_CG) return { kind: 'registered' as const, onChainId: ON_CHAIN_ID, provenance: 'numeric-id' as const };
      // A node with a finalized name index proves an unregistered name absent; no policy for it was accepted.
      if (regime === 'finalized-absence' && id !== LOCAL_PRIVATE_CG) {
        return { kind: 'unavailable' as const, reason: 'finalized-name-absence-unaccepted' as const,
          detail: 'finalized name absence has no accepted unregistered authority', detailCode: 'no-accepted-authority' as const };
      }
      return resolveRegistration(id, options);
    });
    vi.spyOn(chain, 'resolveContextGraphIdsByNameHashes').mockImplementation(async (names) => new Map(names.map((name) => [
      name, registered && name === created.contextGraphNameCommitment(CHAIN_PRIVATE_CG) ? ON_CHAIN_ID : null,
    ])));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(async (id) => registered && id === ON_CHAIN_ID);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([OWNER]);

    await created.createContextGraph({ id: CHAIN_PRIVATE_CG, name: 'Chain private graph', accessPolicy: 1, callerAgentAddress: OWNER });
    await created.createContextGraph({
      id: LOCAL_PRIVATE_CG, name: 'Local private graph', accessPolicy: 1, allowedAgents: [OWNER], callerAgentAddress: OWNER,
    });
    await created.createContextGraph({
      id: CHILD_CG, name: 'Child private graph', accessPolicy: 1, allowedAgents: [OWNER], callerAgentAddress: OWNER,
    });
    registered = true;
    const marker = (graph: string) => ({ subject: MARKER, predicate: DKG_ONTOLOGY.RDF_TYPE, object: MARKER_CLASS, graph });
    await created.store.insert([
      marker(contextGraphDataGraphUri(CHAIN_PRIVATE_CG)),
      marker(contextGraphDataGraphUri(LOCAL_PRIVATE_CG)),
      marker(contextGraphDataGraphUri(CHILD_CG)),
      marker(`${contextGraphDataGraphUri(UNDECLARED_CG)}/_verifiable_memory/${OWNER}/1`),
    ]);
    return { agent: created, execution: vi.spyOn(created.queryEngine, 'query') };
  }

  /** The answer or error, with the requested id written as `<id>` so two ids compare. */
  const outcome = (query: Promise<unknown>, contextGraphId: string): Promise<Outcome> => query.then(
    (answer) => ({ answer }),
    (error: { name?: unknown; code?: unknown; message?: unknown }) => ({ error: { name: error.name, code: error.code, message: error.message } }),
  ).then((result) => JSON.parse(JSON.stringify(result).split(contextGraphId).join('<id>')) as Outcome);

  const ask = (target: DKGAgent, contextGraphId: string, sparql: string, options: Record<string, unknown>, callerAgentAddress = OUTSIDER) =>
    outcome(target.query(sparql, { ...options, contextGraphId, callerAgentAddress }), contextGraphId);

  describe.each(['local-fallback', 'finalized-absence'] as const)('when the node finds an id it holds nothing of by %s', (regime) => {
    describe.each([
      ['as for an empty result', {}],
      ['with the access error a strict caller asks for', { accessDenied: 'error' }],
    ] as const)('answers %s', (_mode, mode) => {
      it.each(REQUESTS)('%s as for a private context graph the caller may not read', async (_label, sparql, options) => {
        const { agent: target, execution } = await fixture(regime);
        for (const missing of [MISSING_CG, UNDECLARED_CG.slice(0, -1), PARENT_CG]) {
          for (const denied of [CHAIN_PRIVATE_CG, LOCAL_PRIVATE_CG]) {
            const expected = await ask(target, denied, sparql, { ...options, ...mode });
            expect(await ask(target, missing, sparql, { ...options, ...mode }), `${missing} against ${denied}`).toEqual(expected);
          }
        }
        // Neither request reaches the engine: the answer cannot depend on what it would refuse or compute.
        expect(execution).not.toHaveBeenCalled();
      });
    });

    it('refuses a knowledge asset read as for a private context graph the caller may not read', async () => {
      const { agent: target } = await fixture(regime);
      const read = async (cg: string) => {
        const resolution = await resolveKnowledgeAssetRead(target, { cg, name: 'unheld-answer-asset', kind: 'identifier', lookup: 'descriptor' },
          { callerAgentAddress: OUTSIDER });
        return { outcome: resolution.outcome, target: resolution.target };
      };
      for (const denied of [CHAIN_PRIVATE_CG, LOCAL_PRIVATE_CG]) {
        expect(await read(denied)).toEqual({ outcome: 'refused', target: null });
      }
      for (const missing of [MISSING_CG, UNDECLARED_CG.slice(0, -1), PARENT_CG]) {
        expect(await read(missing), missing).toEqual({ outcome: 'refused', target: null });
      }
    });
  });

  it('keeps refusals informative for a caller who may read the context graph', async () => {
    const { agent: target } = await fixture('local-fallback');
    for (const contextGraphId of [CHAIN_PRIVATE_CG, LOCAL_PRIVATE_CG]) {
      expect(await ask(target, contextGraphId, SELECT, {}, OWNER)).toEqual({ answer: { bindings: [{ s: MARKER }] } });
      for (const mode of [{}, { accessDenied: 'error' }]) {
        expect(await ask(target, contextGraphId, REQUESTS[5][1], mode, OWNER)).toMatchObject(
          { error: { message: 'SPARQL rejected: SERVICE clauses are not allowed' } });
        expect(await ask(target, contextGraphId, REQUESTS[6][1], mode, OWNER)).toMatchObject(
          { error: { message: 'Scoped query violation: FROM clauses are not allowed on scoped local queries' } });
      }
    }
  });

  it('reads a context graph that holds data without a declaration, and refuses its requests as before', async () => {
    const { agent: target, execution } = await fixture('local-fallback');
    for (const mode of [{}, { accessDenied: 'error' }]) {
      expect(await ask(target, UNDECLARED_CG, SELECT, { ...mode, view: 'verifiable-memory' })).toEqual({ answer: { bindings: [{ s: MARKER }] } });
      expect(await ask(target, UNDECLARED_CG, REQUESTS[5][1], mode)).toMatchObject(
        { error: { message: 'SPARQL rejected: SERVICE clauses are not allowed' } });
    }
    expect(execution).toHaveBeenCalledTimes(4);
  });
});
