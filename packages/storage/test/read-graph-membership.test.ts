import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MemoryLayer,
  READ_GRAPH_SEGMENT,
  knowledgeAssetAgentAddressesEqual,
  readGraphIri,
  readScope,
  type ReadGraphKey,
} from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_MEMBERSHIP_RULE_VERSION,
  isReadGraphMember,
  matchesGraphNameTest,
  readGraphMembership,
  readGraphsOfMemberGraph,
  registeredSubGraphNames,
  workingMemoryIdentityRule,
  type GraphNameTest,
  type ReadGraphRegistrySnapshot,
} from '../src/read-graph/membership.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

const AGENT = '0x' + 'ab'.repeat(20);
const AGENT_MIXED = '0x' + 'aB'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
/** The partition segment without its `~`: an ordinary segment, which older context graph IDs may hold. */
const LOOK_ALIKE = READ_GRAPH_SEGMENT.replace('~', '');
const identity = workingMemoryIdentityRule({ defaultAgentAddress: AGENT_MIXED, peerId: PEER });
const VM = MemoryLayer.VerifiableMemory;
const SWM = MemoryLayer.SharedWorkingMemory;
const WM = MemoryLayer.WorkingMemory;

function registry(contextGraphId: string, subGraphNames: string[] = [], children: string[] = []): ReadGraphRegistrySnapshot {
  return { contextGraphId, subGraphNames, childContextGraphRoots: children.map((child) => `did:dkg:context-graph:${child}`) };
}

function members(key: ReadGraphKey, snapshot: ReadGraphRegistrySnapshot, graphs: string[]): string[] {
  return graphs.filter((graph) => isReadGraphMember(graph, key, snapshot, identity));
}

describe('read-graph membership, shared layers', () => {
  const root = 'did:dkg:context-graph:0xabc/proj';
  const snapshot = registry('0xabc/proj', ['code', 'kid'], ['0xabc/proj/kid']);
  const graphs = [
    root,
    `${root}/_verifiable_memory/${AGENT}/1`,
    `${root}/_verifiable_memory/${AGENT}/1/_meta`,
    `${root}/_verifiable_memory/staging/ab12`,
    `${root}/_verifiable_memory/staging`,
    `${root}/_verifiable_memory/${AGENT}/2/_private`,
    `${root}/context/7`,
    `${root}/context/7/_meta`,
    `${root}/context/7/_private`,
    `${root}/code`,
    `${root}/code/_verifiable_memory/${AGENT}/3`,
    `${root}/docs/_verifiable_memory/${AGENT}/4`,
    `${root}/kid`,
    `${root}/kid/_verifiable_memory/${AGENT}/5`,
    `${root}/_meta`,
    `${root}/_private`,
    `${root}/_rules`,
    `${root}/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`,
    `${root}/_shared_memory`,
    `${root}/_shared_memory/${AGENT}/6`,
    `${root}/_shared_memory/staging/ab12`,
    `${root}/_shared_memory/staging`,
    `${root}/_shared_memory_meta`,
    `${root}/code/_shared_memory`,
    `${root}/code/_shared_memory/${AGENT}/7`,
    `${root}/docs/_shared_memory`,
    `${root}/_working_memory/${AGENT}/8`,
    'did:dkg:context-graph:0xabc/other/_verifiable_memory/0xaa/1',
    'urn:dkg:internal:atomic-graph-replace:x',
  ];

  it('selects the graphs the VM view reads for the whole context graph', () => {
    expect(members({ scope: readScope('0xabc/proj'), layer: VM }, snapshot, graphs)).toEqual([
      root,
      `${root}/_verifiable_memory/${AGENT}/1`,
      `${root}/context/7`,
      `${root}/code`,
      `${root}/code/_verifiable_memory/${AGENT}/3`,
    ]);
  });

  it('selects one registered sub-graph for a sub-graph scope, and nothing for an unregistered name', () => {
    expect(members({ scope: readScope('0xabc/proj', 'code'), layer: VM }, snapshot, graphs)).toEqual([
      `${root}/code`,
      `${root}/code/_verifiable_memory/${AGENT}/3`,
    ]);
    expect(members({ scope: readScope('0xabc/proj', 'docs'), layer: VM }, snapshot, graphs)).toEqual([]);
    // A registered sub-graph that is also a registered child context graph stays with the child.
    expect(members({ scope: readScope('0xabc/proj', 'kid'), layer: VM }, snapshot, graphs)).toEqual([]);
  });

  it('selects the SWM bucket and per-KA graphs, never staging or metadata', () => {
    expect(members({ scope: readScope('0xabc/proj'), layer: SWM }, snapshot, graphs)).toEqual([
      `${root}/_shared_memory`,
      `${root}/_shared_memory/${AGENT}/6`,
      `${root}/code/_shared_memory`,
      `${root}/code/_shared_memory/${AGENT}/7`,
    ]);
  });

  it('mirrors the route filter, which reads names, when a context-graph ID contains a staging segment', () => {
    const odd = 'did:dkg:context-graph:acme/staging/v1';
    const oddRegistry = registry('acme/staging/v1');
    expect(members({ scope: readScope('acme/staging/v1'), layer: VM }, oddRegistry, [
      odd, `${odd}/_verifiable_memory/${AGENT}/1`, `${odd}/context/7`,
    ])).toEqual([odd]);
  });

  it('gives a context graph with a reserved segment no members', () => {
    const legacy = registry('tenant/_old');
    expect(readGraphMembership({ scope: readScope('tenant/_old'), layer: VM }, legacy, identity))
      .toEqual({ kind: 'any', tests: [] });
  });

  it('refuses a registry snapshot of another context graph, and an unknown layer', () => {
    expect(() => readGraphMembership({ scope: readScope('a'), layer: VM }, registry('b'), identity))
      .toThrow(/cannot decide membership/);
    expect(() => readGraphMembership({ scope: readScope('a'), layer: 'XX' } as unknown as ReadGraphKey, registry('a'), identity))
      .toThrow(/Unknown read-graph layer/);
  });

  it('stamps a rule version', () => {
    expect(READ_GRAPH_MEMBERSHIP_RULE_VERSION).toBe(1);
  });
});

describe('read-graph membership, working memory', () => {
  const root = 'did:dkg:context-graph:x';
  const snapshot = registry('x', ['code']);
  const graphs = [
    `${root}/_working_memory/${AGENT}/1`,
    `${root}/_working_memory/${AGENT_MIXED}/2`,
    `${root}/_working_memory/${PEER}/3`,
    `${root}/assertion/${AGENT}/draft`,
    `${root}/assertion/${AGENT}/draft/_named_graph/Zm9v`,
    `${root}/assertion/${AGENT}/draft/_meta`,
    `${root}/_working_memory/${OTHER}/4`,
    `${root}/code/_working_memory/${AGENT}/5`,
    `${root}/docs/_working_memory/${AGENT}/6`,
    `${root}/_working_memory/${AGENT}`,
    `${root}/_shared_memory/${AGENT}/7`,
  ];

  it('gives the default agent its drafts in any spelling, its peer-ID drafts and its registered sub-graphs', () => {
    expect(members({ scope: readScope('x'), layer: WM, agentAddress: AGENT }, snapshot, graphs)).toEqual([
      `${root}/_working_memory/${AGENT}/1`,
      `${root}/_working_memory/${AGENT_MIXED}/2`,
      `${root}/_working_memory/${PEER}/3`,
      `${root}/assertion/${AGENT}/draft`,
      `${root}/assertion/${AGENT}/draft/_named_graph/Zm9v`,
      `${root}/code/_working_memory/${AGENT}/5`,
    ]);
  });

  it('keeps other agents apart, and gives the peer ID no read graph of its own', () => {
    expect(members({ scope: readScope('x'), layer: WM, agentAddress: OTHER }, snapshot, graphs))
      .toEqual([`${root}/_working_memory/${OTHER}/4`]);
    expect(members({ scope: readScope('x'), layer: WM, agentAddress: PEER }, snapshot, graphs)).toEqual([]);
    expect(members({ scope: readScope('x', 'code'), layer: WM, agentAddress: AGENT }, snapshot, graphs))
      .toEqual([`${root}/code/_working_memory/${AGENT}/5`]);
  });

  it('keeps the identity contract: ownerOf and addressesOf agree', () => {
    const addresses = fc.oneof(
      fc.constantFrom(AGENT, AGENT_MIXED, AGENT.toUpperCase().replace('0X', '0x'), PEER, OTHER, PEER.toLowerCase(), '', 'a/b', 'a b'),
      fc.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{8,20}$/),
    );
    fc.assert(fc.property(addresses, addresses, (address, agent) => {
      // ownerOf(x) is the agent a exactly when x matches one of addressesOf(a).
      const owned = identity.addressesOf(agent).some((candidate) => knowledgeAssetAgentAddressesEqual(address, candidate));
      const owner = identity.ownerOf(address);
      expect(owned).toBe(owner !== undefined && identity.addressesOf(agent).length > 0 && identity.ownerOf(agent) === owner);
    }), propertyOptions());
  });

  it('builds a plain rule without a default agent or with a peer ID equal to it', () => {
    const plain = workingMemoryIdentityRule({});
    expect(plain.ownerOf(PEER)).toBe(PEER);
    expect(plain.addressesOf(AGENT_MIXED)).toEqual([AGENT]);
    expect(plain.ownerOf('a b')).toBeUndefined();
    expect(plain.addressesOf('a b')).toEqual([]);
    const same = workingMemoryIdentityRule({ defaultAgentAddress: AGENT, peerId: AGENT_MIXED });
    expect(same.addressesOf(AGENT)).toEqual([AGENT]);
  });
});

describe('read graphs of a written graph', () => {
  it('finds every read graph in every context graph that can own the name', () => {
    const registries = new Map([
      ['a', registry('a', ['b'])],
      ['a/b', registry('a/b')],
    ]);
    const graph = `did:dkg:context-graph:a/b/_verifiable_memory/${AGENT}/1`;
    const keys = readGraphsOfMemberGraph(graph, (id) => registries.get(id), identity).map(readGraphIri);
    expect(keys.sort()).toEqual([
      `did:dkg:context-graph:a/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`,
      `did:dkg:context-graph:a/${READ_GRAPH_SEGMENT}/sub/b/_verifiable_memory`,
      `did:dkg:context-graph:a/b/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`,
    ]);
    expect(readGraphsOfMemberGraph('urn:x:y', (id) => registries.get(id), identity)).toEqual([]);
    expect(readGraphsOfMemberGraph(graph, () => undefined, identity)).toEqual([]);
  });

  it('maps a peer-ID draft to the default agent', () => {
    const graph = `did:dkg:context-graph:x/_working_memory/${PEER}/1`;
    expect(readGraphsOfMemberGraph(graph, (id) => (id === 'x' ? registry('x') : undefined), identity).map(readGraphIri))
      .toEqual([`did:dkg:context-graph:x/${READ_GRAPH_SEGMENT}/cg/_working_memory/${AGENT}`]);
  });
});

// ── Properties ────────────────────────────────────────────────────────────

/**
 * Today's view route for VM and SWM, written the way the query engine reads
 * it (`resolveViewGraphs`, `queryWithView`, `filterRouteGraphsByPrefix`), plus
 * the exclusions that membership adds on top of it.
 */
function referenceViewMember(graph: string, layer: MemoryLayer.VerifiableMemory | MemoryLayer.SharedWorkingMemory,
  contextGraphId: string, subGraphName: string | undefined, snapshot: ReadGraphRegistrySnapshot): boolean {
  if (contextGraphId.split('/').some((segment) => segment.startsWith('_'))) return false;
  const root = `did:dkg:context-graph:${contextGraphId}`;
  const subs = registeredSubGraphNames(snapshot);
  if (subGraphName !== undefined && !subs.includes(subGraphName)) return false;
  const routeFiltered = (prefix: string) => graph.startsWith(prefix) && !graph.includes('/_meta') && !graph.includes('/staging/');
  const resolve = (sub?: string) => {
    const base = sub ? `${root}/${sub}` : root;
    return layer === VM
      ? graph === base || routeFiltered(`${base}/_verifiable_memory/`)
      : graph === `${base}/_shared_memory` || routeFiltered(`${base}/_shared_memory/`);
  };
  let selected = resolve(subGraphName);
  if (subGraphName === undefined) {
    for (const sub of subs) selected ||= resolve(sub);
    if (layer === VM && routeFiltered(`${root}/context/`)) {
      const rest = graph.slice(`${root}/context/`.length);
      selected ||= rest.length > 0 && !rest.includes('/');
    }
  }
  for (const child of snapshot.childContextGraphRoots) {
    if (child.startsWith(`${root}/`) && (graph === child || graph.startsWith(`${child}/`))) selected = false;
  }
  // Added by membership: reserved partitions anywhere, and a shared layer's bare staging graph.
  const segments = graph.split('/');
  if (['_private', '_rules', READ_GRAPH_SEGMENT, '_shared_memory_meta'].some((segment) => segments.slice(1).includes(segment))) selected = false;
  if (/\/_(?:shared|verifiable)_memory\/staging$/.test(graph)) selected = false;
  return selected;
}

const SUB_POOL = ['code', 'docs', 'staging', 'kid'];
const CONTEXT_GRAPH_POOL = ['x', '0xabc/proj', 'x/code', 'acme/staging/v1', 'a/b/c'];
const TAIL_SEGMENTS = ['_verifiable_memory', '_shared_memory', '_working_memory', 'assertion', 'context', 'staging',
  '_meta', '_private', '_rules', READ_GRAPH_SEGMENT, LOOK_ALIKE, '_shared_memory_meta', '_metadata', '_named_graph',
  AGENT, AGENT_MIXED, OTHER, PEER, '7', 'cg', 'sub', ...SUB_POOL];

const snapshotArbitrary = (contextGraphId: string) => fc.record({
  subGraphNames: fc.subarray([...SUB_POOL, '_hidden', 'a/b']),
  children: fc.subarray(['kid', 'code/x', 'zzz']),
}).map(({ subGraphNames, children }) => ({
  contextGraphId,
  subGraphNames,
  childContextGraphRoots: [...children.map((child) => `did:dkg:context-graph:${contextGraphId}/${child}`), 'did:dkg:context-graph:elsewhere'],
}));

const graphArbitrary = (contextGraphId: string) => fc.array(fc.constantFrom(...TAIL_SEGMENTS), { maxLength: 5 })
  .map((tail) => [`did:dkg:context-graph:${contextGraphId}`, ...tail].join('/'));

const scenario = fc.constantFrom(...CONTEXT_GRAPH_POOL).chain((contextGraphId) => fc.record({
  contextGraphId: fc.constant(contextGraphId),
  snapshot: snapshotArbitrary(contextGraphId),
  graph: graphArbitrary(contextGraphId),
  sub: fc.option(fc.constantFrom(...SUB_POOL), { nil: undefined }),
}));

describe('read-graph membership properties', () => {
  it('equals the view route plus its exclusions for VM and SWM', () => {
    fc.assert(fc.property(scenario, fc.constantFrom(VM, SWM), ({ contextGraphId, snapshot, graph, sub }, layer) => {
      const key: ReadGraphKey = { scope: readScope(contextGraphId, sub), layer };
      expect(isReadGraphMember(graph, key, snapshot, identity), graph)
        .toBe(referenceViewMember(graph, layer, contextGraphId, sub, snapshot));
    }), { ...propertyOptions(), numRuns: Math.max(propertyOptions().numRuns, 2_000) });
  });

  it('finds exactly the read graphs whose membership holds a written graph', () => {
    const agents = [AGENT, OTHER, PEER];
    fc.assert(fc.property(scenario, ({ contextGraphId, snapshot, graph }) => {
      const registryOf = (id: string) => (id === contextGraphId ? snapshot : undefined);
      const found = new Set(readGraphsOfMemberGraph(graph, registryOf, identity).map(readGraphIri));
      const scopes = [readScope(contextGraphId), ...SUB_POOL.map((name) => readScope(contextGraphId, name))];
      for (const scope of scopes) {
        const keys: ReadGraphKey[] = [{ scope, layer: VM }, { scope, layer: SWM },
          ...agents.map((agentAddress) => ({ scope, layer: WM, agentAddress }) as ReadGraphKey)];
        for (const key of keys) {
          const iri = readGraphIri(key);
          expect(found.has(iri), `${graph} in ${iri}`).toBe(isReadGraphMember(graph, key, snapshot, identity));
        }
      }
    }), { ...propertyOptions(), numRuns: Math.max(propertyOptions().numRuns, 2_000) });
  });

  it('never admits a reserved partition, a read graph or another context graph', () => {
    fc.assert(fc.property(scenario, fc.constantFrom(VM, SWM, WM), ({ contextGraphId, snapshot, graph, sub }, layer) => {
      const key = (layer === WM
        ? { scope: readScope(contextGraphId, sub), layer, agentAddress: AGENT }
        : { scope: readScope(contextGraphId, sub), layer }) as ReadGraphKey;
      if (!isReadGraphMember(graph, key, snapshot, identity)) return;
      const tail = graph.slice(`did:dkg:context-graph:${contextGraphId}`.length).split('/');
      for (const reserved of ['_meta', '_private', '_rules', READ_GRAPH_SEGMENT, '_shared_memory_meta']) expect(tail).not.toContain(reserved);
      expect(graph === `did:dkg:context-graph:${contextGraphId}` || graph.startsWith(`did:dkg:context-graph:${contextGraphId}/`)).toBe(true);
      for (const child of snapshot.childContextGraphRoots) expect(graph === child || graph.startsWith(`${child}/`)).toBe(false);
    }), propertyOptions());
  });

  it('evaluates every kind of name test', () => {
    const tests: Array<[GraphNameTest, string, boolean]> = [
      [{ kind: 'equals', iri: 'urn:a' }, 'urn:a', true],
      [{ kind: 'prefix', prefix: 'urn:a/' }, 'urn:a', false],
      [{ kind: 'contains', text: '/x' }, 'urn:a/x/y', true],
      [{ kind: 'segment', segment: '_meta' }, 'urn:a/_meta', true],
      [{ kind: 'segment', segment: '_meta' }, 'urn:a/_metadata', false],
      [{ kind: 'one-segment-after', prefix: 'urn:a/' }, 'urn:a/b', true],
      [{ kind: 'one-segment-after', prefix: 'urn:a/' }, 'urn:a/', false],
      [{ kind: 'one-segment-after', prefix: 'urn:a/' }, 'urn:a/b/c', false],
      [{ kind: 'address-after', prefix: 'urn:a/', addresses: [AGENT] }, `urn:a/${AGENT_MIXED}/1`, true],
      [{ kind: 'address-after', prefix: 'urn:a/', addresses: [AGENT] }, `urn:a/${AGENT}`, false],
      [{ kind: 'address-after', prefix: 'urn:a/', addresses: [PEER] }, `urn:a/${PEER.toLowerCase()}/1`, false],
      [{ kind: 'not', test: { kind: 'equals', iri: 'urn:a' } }, 'urn:a', false],
      [{ kind: 'all', tests: [] }, 'urn:a', true],
      [{ kind: 'any', tests: [] }, 'urn:a', false],
    ];
    for (const [test, graph, expected] of tests) expect(matchesGraphNameTest(test, graph), JSON.stringify(test)).toBe(expected);
  });
});
