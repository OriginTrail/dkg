// SPDX-License-Identifier: Apache-2.0

/**
 * Read-graph membership: which named graphs a read graph is the union of.
 *
 * A read graph holds the set union of the triples of its member graphs. This
 * module decides membership from three things only: the graph's name, the
 * context graph's registered sub-graphs and its registered child context
 * graphs ({@link ReadGraphRegistrySnapshot}), plus, for working memory, the
 * node's identity rule ({@link WorkingMemoryIdentityRule}).
 *
 * The rule is data. {@link readGraphMembership} returns a {@link GraphNameTest}
 * for one read graph; this module evaluates it, and the statements that keep a
 * read graph equal to its members render the same test as a SPARQL expression.
 * The layer that maps a write to its read graphs and the existence check in the
 * store therefore apply one rule.
 *
 * For the shared layers the rule selects the graphs that the view route reads
 * today for the same scope (`resolveViewGraphs` and `queryWithView` in the
 * query package): the exact graphs it names, the graphs it discovers under its
 * prefixes after the route filter (no `/_meta` and no `/staging/` anywhere in
 * the name), the per-cgId data graphs for a whole-context-graph VM read, and
 * nothing in a registered child context graph. On top of that it never admits
 * a graph with a `_private`, `_rules` or `_shared_memory_meta` path segment or
 * the read-graph partition segment (`READ_GRAPH_SEGMENT`), nor a bare
 * `…/staging` graph of a shared layer.
 *
 * Working memory follows the identity rule rather than the caller's spelling:
 * a draft graph belongs to the agent that its address maps to, in any
 * registered partition, so a read graph can hold an older draft graph that
 * the view route misses when the caller spells the address differently.
 */

import {
  MemoryLayer,
  READ_GRAPH_SEGMENT,
  canonicalKnowledgeAssetAgentAddress,
  compareCodePoint,
  contextGraphDataUri,
  isReadGraphAgentAddress,
  isReadGraphEligibleContextGraphId,
  knowledgeAssetAgentAddressesEqual,
  readScope,
  validateSubGraphName,
  type ReadGraphKey,
  type ReadScope,
} from '@origintrail-official/dkg-core';

/**
 * The version of the membership rule in this module. It is stored with each
 * read graph; a read graph built under another version is rebuilt. Change it
 * with any change to what {@link readGraphMembership} selects.
 */
export const READ_GRAPH_MEMBERSHIP_RULE_VERSION = 1;

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const WORKING_MEMORY_FAMILIES = ['_working_memory', 'assertion'] as const;
const EXCLUDED_SEGMENTS = ['_private', '_rules', READ_GRAPH_SEGMENT, '_shared_memory_meta'] as const;

/** The registry facts of one context graph that membership depends on, at one moment. */
export interface ReadGraphRegistrySnapshot {
  readonly contextGraphId: string;
  /** Registered sub-graph names. A name that `validateSubGraphName` refuses is ignored. */
  readonly subGraphNames: readonly string[];
  /**
   * Registered child context graphs, as their root graph IRIs
   * (`did:dkg:context-graph:{child}`). Only IRIs under the parent's root are
   * children; others are ignored.
   */
  readonly childContextGraphRoots: readonly string[];
}

/**
 * The node's identity rule for working memory, injected by the agent.
 *
 * `ownerOf` names the agent that owns the drafts written under an address, and
 * `addressesOf` lists every address an agent's drafts are written under. The
 * two must agree: `ownerOf(x) === a` exactly when `x` matches one of
 * `addressesOf(a)` under `knowledgeAssetAgentAddressesEqual`. Addresses are
 * canonical (`canonicalKnowledgeAssetAgentAddress`).
 * {@link workingMemoryIdentityRule} builds a rule that keeps this contract.
 */
export interface WorkingMemoryIdentityRule {
  ownerOf(address: string): string | undefined;
  addressesOf(agentAddress: string): readonly string[];
}

/**
 * The rule the node applies today: every agent owns its own drafts, in any
 * letter case of an EVM address, and the default agent also owns the drafts
 * written under the node's peer ID before it had a wallet address.
 */
export function workingMemoryIdentityRule(node: {
  readonly defaultAgentAddress?: string;
  readonly peerId?: string;
}): WorkingMemoryIdentityRule {
  const canonical = (address: string) => canonicalKnowledgeAssetAgentAddress(address);
  const defaultAgent = node.defaultAgentAddress ? canonical(node.defaultAgentAddress) : undefined;
  const peer = defaultAgent && node.peerId && canonical(node.peerId) !== defaultAgent
    ? canonical(node.peerId)
    : undefined;
  return {
    ownerOf(address) {
      const agent = canonical(address);
      if (!isReadGraphAgentAddress(agent)) return undefined;
      return peer !== undefined && agent === peer ? defaultAgent : agent;
    },
    addressesOf(agentAddress) {
      const agent = canonical(agentAddress);
      if (!isReadGraphAgentAddress(agent) || (peer !== undefined && agent === peer)) return [];
      return peer !== undefined && agent === defaultAgent ? [agent, peer] : [agent];
    },
  };
}

/**
 * A test on a graph name. Every kind maps to one SPARQL string function on
 * `STR(?g)`, so a test renders as one expression with the same answer.
 */
export type GraphNameTest =
  | { readonly kind: 'equals'; readonly iri: string }
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'contains'; readonly text: string }
  /** A path segment equal to `segment`: `/segment/` occurs in the name followed by `/`. */
  | { readonly kind: 'segment'; readonly segment: string }
  /** The name is `prefix` followed by one non-empty segment and nothing else. */
  | { readonly kind: 'one-segment-after'; readonly prefix: string }
  /**
   * The name is `prefix`, then an address segment, then `/` and anything. The
   * address matches when it equals one of `addresses` under
   * `knowledgeAssetAgentAddressesEqual` (EVM addresses in any letter case).
   */
  | { readonly kind: 'address-after'; readonly prefix: string; readonly addresses: readonly string[] }
  | { readonly kind: 'not'; readonly test: GraphNameTest }
  | { readonly kind: 'all'; readonly tests: readonly GraphNameTest[] }
  | { readonly kind: 'any'; readonly tests: readonly GraphNameTest[] };

/** Evaluate a membership test on one graph name. */
export function matchesGraphNameTest(test: GraphNameTest, graph: string): boolean {
  switch (test.kind) {
    case 'equals': return graph === test.iri;
    case 'prefix': return graph.startsWith(test.prefix);
    case 'contains': return graph.includes(test.text);
    case 'segment': return `${graph}/`.includes(`/${test.segment}/`);
    case 'one-segment-after': {
      if (!graph.startsWith(test.prefix)) return false;
      const rest = graph.slice(test.prefix.length);
      return rest.length > 0 && !rest.includes('/');
    }
    case 'address-after': {
      if (!graph.startsWith(test.prefix)) return false;
      const rest = graph.slice(test.prefix.length);
      const end = rest.indexOf('/');
      if (end <= 0) return false;
      const address = rest.slice(0, end);
      return test.addresses.some((candidate) => knowledgeAssetAgentAddressesEqual(address, candidate));
    }
    case 'not': return !matchesGraphNameTest(test.test, graph);
    case 'all': return test.tests.every((inner) => matchesGraphNameTest(inner, graph));
    case 'any': return test.tests.some((inner) => matchesGraphNameTest(inner, graph));
  }
}

const NOTHING: GraphNameTest = Object.freeze({ kind: 'any', tests: Object.freeze([]) });

/**
 * The membership test of one read graph under a registry snapshot. Every graph
 * that passes it is a member; no other graph is.
 */
export function readGraphMembership(
  key: ReadGraphKey,
  registry: ReadGraphRegistrySnapshot,
  identity: WorkingMemoryIdentityRule,
): GraphNameTest {
  const { contextGraphId } = key.scope;
  if (contextGraphId !== registry.contextGraphId) {
    throw new Error(`Registry snapshot of ${registry.contextGraphId} cannot decide membership in ${contextGraphId}`);
  }
  if (!isReadGraphEligibleContextGraphId(contextGraphId)) return NOTHING;
  const root = contextGraphDataUri(contextGraphId);
  const subGraphs = registeredSubGraphNames(registry);
  let bases: readonly string[];
  if (key.scope.kind === 'sub-graph') {
    // Default deny: an unregistered name has no members.
    if (!subGraphs.includes(key.scope.subGraphName)) return NOTHING;
    bases = [`${root}/${key.scope.subGraphName}`];
  } else {
    bases = [root, ...subGraphs.map((name) => `${root}/${name}`)];
  }

  const routes: GraphNameTest[] = [];
  switch (key.layer) {
    case MemoryLayer.VerifiableMemory:
      for (const base of bases) routes.push(equals(base), sharedLayerPrefix(`${base}/_verifiable_memory/`));
      // The per-cgId data graphs `{root}/context/{onChainId}` belong to a whole-context-graph read only.
      if (key.scope.kind === 'context-graph') routes.push(all(oneSegmentAfter(`${root}/context/`), ...ROUTE_FILTER));
      break;
    case MemoryLayer.SharedWorkingMemory:
      for (const base of bases) routes.push(equals(`${base}/_shared_memory`), sharedLayerPrefix(`${base}/_shared_memory/`));
      break;
    case MemoryLayer.WorkingMemory: {
      const addresses = identity.addressesOf(key.agentAddress);
      if (addresses.length === 0) return NOTHING;
      for (const base of bases) {
        for (const family of WORKING_MEMORY_FAMILIES) {
          routes.push(all({ kind: 'address-after', prefix: `${base}/${family}/`, addresses }, ...ROUTE_FILTER));
        }
      }
      break;
    }
    default:
      throw new Error(`Unknown read-graph layer: ${String((key as { layer: unknown }).layer)}`);
  }

  const exclusions: GraphNameTest[] = EXCLUDED_SEGMENTS.map((segment) => ({ kind: 'segment', segment }));
  for (const child of registeredChildContextGraphRoots(registry, root)) {
    exclusions.push(equals(child), { kind: 'prefix', prefix: `${child}/` });
  }
  return all(any(...routes), not(any(...exclusions)));
}

/** Whether `graph` is a member of the read graph `key` under a registry snapshot. */
export function isReadGraphMember(
  graph: string,
  key: ReadGraphKey,
  registry: ReadGraphRegistrySnapshot,
  identity: WorkingMemoryIdentityRule,
): boolean {
  return matchesGraphNameTest(readGraphMembership(key, registry, identity), graph);
}

/**
 * Every read graph that `graph` is a member of, in every context graph that
 * can own its name. A context-graph ID can contain `/`, so one name can sit in
 * several context graphs: each candidate whose registry `registryOf` returns
 * is asked. A context graph without a snapshot has no read graphs here.
 *
 * The result is exactly the keys `k` with `isReadGraphMember(graph, k, …)`, for
 * an identity rule that keeps its contract.
 */
export function readGraphsOfMemberGraph(
  graph: string,
  registryOf: (contextGraphId: string) => ReadGraphRegistrySnapshot | undefined,
  identity: WorkingMemoryIdentityRule,
): ReadGraphKey[] {
  if (!graph.startsWith(CONTEXT_GRAPH_PREFIX)) return [];
  const segments = graph.slice(CONTEXT_GRAPH_PREFIX.length).split('/');
  const keys: ReadGraphKey[] = [];
  // An eligible context-graph ID has no `_`-prefixed segment, so the candidates stop at the first one.
  for (let length = 1; length <= segments.length && !segments[length - 1]!.startsWith('_'); length += 1) {
    const contextGraphId = segments.slice(0, length).join('/');
    if (!isReadGraphEligibleContextGraphId(contextGraphId)) continue;
    const registry = registryOf(contextGraphId);
    if (!registry) continue;
    for (const key of candidateKeys(contextGraphId, segments.slice(length), registry, identity)) {
      if (isReadGraphMember(graph, key, registry, identity)) keys.push(key);
    }
  }
  return keys;
}

/** Keys whose membership could hold `tail` under `contextGraphId`; the caller tests each one. */
function candidateKeys(
  contextGraphId: string,
  tail: readonly string[],
  registry: ReadGraphRegistrySnapshot,
  identity: WorkingMemoryIdentityRule,
): ReadGraphKey[] {
  const whole = readScope(contextGraphId);
  if (tail.length === 0) return [{ scope: whole, layer: MemoryLayer.VerifiableMemory }];
  const subGraphName = registeredSubGraphNames(registry).includes(tail[0]!) ? tail[0]! : undefined;
  const scopes: ReadScope[] = subGraphName === undefined ? [whole] : [whole, readScope(contextGraphId, subGraphName)];
  const partition = subGraphName === undefined ? tail : tail.slice(1);
  const keys: ReadGraphKey[] = [];
  for (const scope of scopes) {
    keys.push({ scope, layer: MemoryLayer.VerifiableMemory }, { scope, layer: MemoryLayer.SharedWorkingMemory });
  }
  const family = partition[0];
  const address = partition[1];
  if (address !== undefined && (WORKING_MEMORY_FAMILIES as readonly (string | undefined)[]).includes(family)) {
    const owner = identity.ownerOf(address);
    if (owner !== undefined && isReadGraphAgentAddress(owner)) {
      for (const scope of scopes) keys.push({ scope, layer: MemoryLayer.WorkingMemory, agentAddress: owner });
    }
  }
  return keys;
}

/** The registered sub-graph names that membership uses: valid, distinct, in code-point order. */
export function registeredSubGraphNames(registry: ReadGraphRegistrySnapshot): string[] {
  return [...new Set(registry.subGraphNames.filter((name) => validateSubGraphName(name).valid))].sort(compareCodePoint);
}

function registeredChildContextGraphRoots(registry: ReadGraphRegistrySnapshot, root: string): string[] {
  return [...new Set(registry.childContextGraphRoots.filter((child) => child.startsWith(`${root}/`)))].sort(compareCodePoint);
}

// The view route's filter on discovered graphs (`filterRouteGraphsByPrefix` in the query package).
const ROUTE_FILTER: readonly GraphNameTest[] = Object.freeze([
  not({ kind: 'contains', text: '/_meta' }),
  not({ kind: 'contains', text: '/staging/' }),
]);

/** A shared-layer prefix as the view route reads it, without the layer's bare staging graph. */
function sharedLayerPrefix(prefix: string): GraphNameTest {
  return all({ kind: 'prefix', prefix }, ...ROUTE_FILTER, not(equals(`${prefix}staging`)));
}

function equals(iri: string): GraphNameTest {
  return { kind: 'equals', iri };
}

function oneSegmentAfter(prefix: string): GraphNameTest {
  return { kind: 'one-segment-after', prefix };
}

function not(test: GraphNameTest): GraphNameTest {
  return { kind: 'not', test };
}

function all(...tests: GraphNameTest[]): GraphNameTest {
  return { kind: 'all', tests };
}

function any(...tests: GraphNameTest[]): GraphNameTest {
  return { kind: 'any', tests };
}
