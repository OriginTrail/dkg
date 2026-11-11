// SPDX-License-Identifier: Apache-2.0

/**
 * Names of read graphs: the node-local, derived graphs that hold the merged
 * default graph of one read scope, and the state graph that records them.
 *
 * Everything lives in the reserved partition {@link READ_GRAPH_SEGMENT} under
 * the context graph's own prefix, so whatever protects or removes a context
 * graph's graphs by name covers its read graphs too:
 *
 *   did:dkg:context-graph:{cg}/_~read                                 partition root
 *   did:dkg:context-graph:{cg}/_~read/state                           state graph
 *   did:dkg:context-graph:{cg}/_~read/cg/{layer}                      whole context graph
 *   did:dkg:context-graph:{cg}/_~read/sub/{sub}/{layer}               one registered sub-graph
 *
 * `{layer}` is `_shared_memory` or `_verifiable_memory`, and for working
 * memory `_working_memory/{agent}` with the agent's canonical address. The
 * `cg` and `sub` segments keep two scopes from sharing a name: without them,
 * context graph `x/code` and sub-graph `code` of `x` would collide.
 *
 * The segment cannot occur in any context graph ID, because no ID can contain
 * `~` ({@link validateContextGraphId}), whichever rule it was created under. It
 * cannot be a sub-graph name either, because those cannot start with `_`
 * ({@link validateSubGraphName}). A context graph whose ID contains a
 * `_`-prefixed segment, which only older stores hold
 * ({@link validateNewContextGraphId}), gets no read graphs.
 */

import {
  canonicalKnowledgeAssetAgentAddress,
  validateContextGraphId,
  validateNewContextGraphId,
  validateSubGraphName,
} from './constants.js';
import { MemoryLayer, memoryLayerSlug } from './memory-model.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/**
 * The reserved partition segment that holds a context graph's read graphs and
 * their state. Its `~` keeps it out of every context graph ID, and its leading
 * `_` keeps it out of every sub-graph name.
 */
export const READ_GRAPH_SEGMENT = '_~read';

const STATE_SEGMENT = 'state';
const WHOLE_CONTEXT_GRAPH_SEGMENT = 'cg';
const SUB_GRAPH_SEGMENT = 'sub';
const AGENT_SEGMENT = /^[\w:.@-]+$/;

/**
 * A read scope a caller can name: a whole context graph (its root partition
 * and every registered sub-graph), or one registered sub-graph.
 */
export type ReadScope =
  | { readonly kind: 'context-graph'; readonly contextGraphId: string }
  | { readonly kind: 'sub-graph'; readonly contextGraphId: string; readonly subGraphName: string };

export type ReadScopeKind = ReadScope['kind'];

/** The shared layers have one read graph per scope. */
export type SharedReadGraphLayer = MemoryLayer.SharedWorkingMemory | MemoryLayer.VerifiableMemory;

/**
 * One read graph: a scope and a layer, plus the agent for working memory,
 * which has one read graph per agent and scope. Two keys name the same read
 * graph exactly when {@link readGraphIri} gives the same IRI for both.
 */
export type ReadGraphKey =
  | { readonly scope: ReadScope; readonly layer: SharedReadGraphLayer }
  | { readonly scope: ReadScope; readonly layer: MemoryLayer.WorkingMemory; readonly agentAddress: string };

/** The scope for a context graph, or for one of its sub-graphs when `subGraphName` is given. */
export function readScope(contextGraphId: string, subGraphName?: string): ReadScope {
  return subGraphName === undefined
    ? { kind: 'context-graph', contextGraphId }
    : { kind: 'sub-graph', contextGraphId, subGraphName };
}

/**
 * Whether a context graph can have read graphs: its ID passes the rule for new
 * IDs ({@link validateNewContextGraphId}), so it has no `_`-prefixed segment.
 * IDs from before that rule keep working, but get none.
 */
export function isReadGraphEligibleContextGraphId(contextGraphId: string): boolean {
  return validateNewContextGraphId(contextGraphId).valid;
}

/** Whether an agent address can name a working-memory read graph, after canonicalization. */
export function isReadGraphAgentAddress(agentAddress: string): boolean {
  const agent = canonicalKnowledgeAssetAgentAddress(agentAddress);
  return AGENT_SEGMENT.test(agent) && agent !== '.' && agent !== '..';
}

/** `did:dkg:context-graph:{cg}/_~read`, the root of a context graph's read-graph partition. */
export function readGraphPartitionRoot(contextGraphId: string): string {
  const validation = validateContextGraphId(contextGraphId);
  if (!validation.valid) throw new Error(`Invalid context graph ID for a read-graph name: ${validation.reason}`);
  return `${CONTEXT_GRAPH_PREFIX}${contextGraphId}/${READ_GRAPH_SEGMENT}`;
}

/**
 * True for the root of any context graph's read-graph partition and for every
 * graph under it: a context-graph IRI with a {@link READ_GRAPH_SEGMENT} path
 * segment after the first. It does not require a well-formed read-graph name,
 * so a stray graph in the partition is still recognized. Takes a bare IRI,
 * without angle brackets.
 */
export function isReadGraphPartitionIri(iri: string): boolean {
  if (!iri.startsWith(CONTEXT_GRAPH_PREFIX)) return false;
  return iri.slice(CONTEXT_GRAPH_PREFIX.length).split('/').indexOf(READ_GRAPH_SEGMENT, 1) !== -1;
}

/** `did:dkg:context-graph:{cg}/_~read/state`, the graph that holds the state rows of a context graph's read graphs. */
export function readGraphStateGraphIri(contextGraphId: string): string {
  return `${eligiblePartitionRoot(contextGraphId)}/${STATE_SEGMENT}`;
}

/** The IRI of one read graph. Throws for a scope or agent that cannot have one. */
export function readGraphIri(key: ReadGraphKey): string {
  const root = eligiblePartitionRoot(key.scope.contextGraphId);
  const scope = key.scope.kind === 'context-graph'
    ? WHOLE_CONTEXT_GRAPH_SEGMENT
    : `${SUB_GRAPH_SEGMENT}/${checkedSubGraphName(key.scope.subGraphName)}`;
  return `${root}/${scope}/${layerSegment(key)}`;
}

/**
 * The inverse of {@link readGraphIri}: the key of a read-graph IRI, or
 * `undefined` for any IRI that {@link readGraphIri} does not produce, such as
 * the partition root, the state graph or a non-canonical agent address.
 */
export function parseReadGraphIri(iri: string): ReadGraphKey | undefined {
  if (!iri.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const segments = iri.slice(CONTEXT_GRAPH_PREFIX.length).split('/');
  // An eligible context graph ID has no `_`-prefixed segment, so the first one is the partition.
  const partition = segments.findIndex((segment) => segment.startsWith('_'));
  if (partition < 1 || segments[partition] !== READ_GRAPH_SEGMENT) return undefined;
  const contextGraphId = segments.slice(0, partition).join('/');
  const rest = segments.slice(partition + 1);
  let scope: ReadScope;
  if (rest[0] === WHOLE_CONTEXT_GRAPH_SEGMENT) {
    scope = { kind: 'context-graph', contextGraphId };
    rest.splice(0, 1);
  } else if (rest[0] === SUB_GRAPH_SEGMENT && rest.length >= 2) {
    scope = { kind: 'sub-graph', contextGraphId, subGraphName: rest[1]! };
    rest.splice(0, 2);
  } else {
    return undefined;
  }
  const key = keyForLayer(scope, rest);
  if (!key) return undefined;
  try {
    return readGraphIri(key) === iri ? key : undefined;
  } catch {
    return undefined;
  }
}

function keyForLayer(scope: ReadScope, segments: readonly string[]): ReadGraphKey | undefined {
  if (segments.length === 1 && segments[0] === memoryLayerSlug(MemoryLayer.SharedWorkingMemory)) {
    return { scope, layer: MemoryLayer.SharedWorkingMemory };
  }
  if (segments.length === 1 && segments[0] === memoryLayerSlug(MemoryLayer.VerifiableMemory)) {
    return { scope, layer: MemoryLayer.VerifiableMemory };
  }
  if (segments.length === 2 && segments[0] === memoryLayerSlug(MemoryLayer.WorkingMemory)) {
    return { scope, layer: MemoryLayer.WorkingMemory, agentAddress: segments[1]! };
  }
  return undefined;
}

function eligiblePartitionRoot(contextGraphId: string): string {
  if (!isReadGraphEligibleContextGraphId(contextGraphId)) {
    throw new Error(`Context graph ${JSON.stringify(contextGraphId)} cannot have read graphs`);
  }
  return readGraphPartitionRoot(contextGraphId);
}

function checkedSubGraphName(subGraphName: string): string {
  const validation = validateSubGraphName(subGraphName);
  if (!validation.valid) throw new Error(`Invalid sub-graph name for a read-graph name: ${validation.reason}`);
  return subGraphName;
}

function layerSegment(key: ReadGraphKey): string {
  switch (key.layer) {
    case MemoryLayer.SharedWorkingMemory:
    case MemoryLayer.VerifiableMemory:
      return memoryLayerSlug(key.layer);
    case MemoryLayer.WorkingMemory: {
      if (!isReadGraphAgentAddress(key.agentAddress)) {
        throw new Error(`Agent address ${JSON.stringify(key.agentAddress)} cannot name a read graph`);
      }
      return `${memoryLayerSlug(MemoryLayer.WorkingMemory)}/${canonicalKnowledgeAssetAgentAddress(key.agentAddress)}`;
    }
    default:
      throw new Error(`Unknown read-graph layer: ${String((key as { layer: unknown }).layer)}`);
  }
}
