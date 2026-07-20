import { compareCanonicalCbor, encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { encodeProtocolTuple } from '../protocol/codec.js';
import { hashWalV1Domain } from '../protocol/hashes.js';
import { WAL_V1_ENUMS } from '../protocol/schema.js';
import { bytesEqualV1, rdfTouchedKeyV1 } from '../rdf/keys.js';
import { requireCanonicalNQuadsV1 } from '../rdf/nquads.js';
import { validateRdfPolicyV1 } from '../rdf/policy.js';
import { replayError } from './errors.js';
import {
  WAL_REPLAY_LIMITS_V1,
  type AdmittedWalReplayObjectV1,
  type WalReplayEquivocationEvidenceV1,
  type WalReplayLimitsV1,
  type WalReplayProjectionStatusV1,
  type WalReplayProjectionV1,
  type WalReplayProtocolCompatibilityV1,
  type WalReplaySemanticCoreV1,
  type WalReplaySemanticStateV1,
} from './types.js';

const OPERATION = Object.freeze({
  RESOLVE: BigInt(WAL_V1_ENUMS.mutationOperation.RESOLVE),
  SNAPSHOT: BigInt(WAL_V1_ENUMS.mutationOperation.SNAPSHOT),
  MOVE_TIER_SOURCE: BigInt(WAL_V1_ENUMS.mutationOperation.MOVE_TIER_SOURCE),
  MOVE_TIER_TARGET: BigInt(WAL_V1_ENUMS.mutationOperation.MOVE_TIER_TARGET),
  LEGACY_GENESIS: BigInt(WAL_V1_ENUMS.mutationOperation.LEGACY_GENESIS),
  DELETE: BigInt(WAL_V1_ENUMS.mutationOperation.DELETE),
});
const PATCH_MODE = BigInt(WAL_V1_ENUMS.mutationMode.PATCH);
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

interface ReplayNode<Projection> {
  readonly value: AdmittedWalReplayObjectV1;
  readonly id: string;
  readonly parents: readonly string[];
  readonly children: Set<string>;
  depth: number;
  projection?: InternalProjection<Projection>;
}

interface InternalProjection<Projection> {
  readonly status: WalReplayProjectionStatusV1;
  readonly state: WalReplaySemanticStateV1<Projection>;
  readonly activeHeads: readonly string[];
  readonly conflictHeads: readonly string[];
  readonly pendingHeads: readonly string[];
  readonly commonBaseHeads: readonly string[];
}

interface ReplayGraph<Projection> {
  readonly nodes: ReadonlyMap<string, ReplayNode<Projection>>;
  readonly schedule: readonly string[];
  readonly maximalHeads: readonly string[];
  readonly equivocations: readonly WalReplayEquivocationEvidenceV1[];
}

class ReplayWorkBudget {
  private used = 0;

  constructor(private readonly maximum: number) {}

  consume(amount = 1): void {
    this.used += amount;
    if (this.used > this.maximum) {
      replayError(
        'WAL_REPLAY_RESOURCE_LIMIT',
        'replay recomputation work exceeds the configured bound',
        'blocked',
        'RECOMPUTATION_WORK_LIMIT',
      );
    }
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function fixedBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    replayError(
      'WAL_REPLAY_INVALID_OBJECT',
      `${label} must be exactly ${length} bytes`,
      'quarantine',
      'INVALID_FIXED_BYTES',
    );
  }
  return new Uint8Array(value);
}

function validateState<Projection>(
  state: WalReplaySemanticStateV1<Projection>,
  label: string,
): WalReplaySemanticStateV1<Projection> {
  fixedBytes(state.stateDigest, 32, `${label}.stateDigest`);
  return state;
}

function sortedHex(values: Iterable<string>): string[] {
  // Every caller supplies a set of unique bytes32 IDs.
  return [...values].sort((left, right) => left < right ? -1 : 1);
}

function sortedIds(values: readonly Uint8Array[]): Uint8Array[] {
  return values.map(value => fixedBytes(value, 32, 'head ID')).sort(compareCanonicalCbor);
}

function sameHexSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bytesArrayEqual(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqualV1(left, right);
}

function configurationValue(value: number, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    replayError(
      'WAL_REPLAY_INVALID_CONFIGURATION',
      `${label} must be a safe integer greater than or equal to ${minimum}`,
      'blocked',
      'INVALID_REPLAY_LIMIT',
    );
  }
  return value;
}

function normalizeLimits(overrides: Partial<WalReplayLimitsV1>): WalReplayLimitsV1 {
  const value = { ...WAL_REPLAY_LIMITS_V1, ...overrides };
  return {
    maximumObjects: configurationValue(value.maximumObjects, 'maximumObjects'),
    maximumParentsPerMutation: configurationValue(value.maximumParentsPerMutation, 'maximumParentsPerMutation'),
    maximumTouchedKeysPerMutation: configurationValue(value.maximumTouchedKeysPerMutation, 'maximumTouchedKeysPerMutation'),
    maximumConflictHeads: configurationValue(value.maximumConflictHeads, 'maximumConflictHeads'),
    maximumCausalDepth: configurationValue(value.maximumCausalDepth, 'maximumCausalDepth'),
    maximumRecomputationWork: configurationValue(value.maximumRecomputationWork, 'maximumRecomputationWork'),
  };
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function validateObjectMetadata(value: AdmittedWalReplayObjectV1): void {
  fixedBytes(value.objectId, 32, 'objectId');
  fixedBytes(value.namespaceId, 32, 'namespaceId');
  fixedBytes(value.writerId, 20, 'writerId');
  if (
    typeof value.writerEpoch !== 'bigint'
    || value.writerEpoch < 0n
    || value.writerEpoch > MAX_U64
    || typeof value.sequence !== 'bigint'
    || value.sequence < 0n
    || value.sequence > MAX_U64
  ) {
    replayError(
      'WAL_REPLAY_INVALID_OBJECT',
      'writerEpoch and sequence must be unsigned 64-bit integers',
      'quarantine',
      'INVALID_AUTHOR_POSITION',
    );
  }
  try {
    encodeProtocolTuple('DkgMutationV1', value.mutation);
    validateRdfPolicyV1(value.policy);
  } catch (error) {
    replayError(
      'WAL_REPLAY_INVALID_OBJECT',
      'replay input contains a non-canonical mutation or policy tuple',
      'quarantine',
      'INVALID_PROTOCOL_TUPLE',
      error,
    );
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return bytesArrayEqual(
    encodeCanonicalCbor(left as Parameters<typeof encodeCanonicalCbor>[0]),
    encodeCanonicalCbor(right as Parameters<typeof encodeCanonicalCbor>[0]),
  );
}

function patchInsertionPredicates(value: AdmittedWalReplayObjectV1): ReadonlyMap<string, string> | null {
  // pairCompatibility calls this only after proving both payloads are PATCH.
  const rdf = value.mutation[6]!;
  if (requireCanonicalNQuadsV1(rdf[6]).quadCount !== 0) return null;
  const inserts = requireCanonicalNQuadsV1(rdf[7]);
  const predicates = new Map<string, string>();
  for (const quad of inserts.quads) {
    const key = hex(rdfTouchedKeyV1(quad.graph, quad.subject, quad.predicate));
    const previous = predicates.get(key);
    /* v8 ignore start -- two distinct predicates reaching one bytes32 key requires a BLAKE3 collision. */
    if (previous !== undefined && previous !== quad.predicate) return null;
    /* v8 ignore stop */
    predicates.set(key, quad.predicate);
  }
  return predicates;
}

function pairCompatibility(
  left: AdmittedWalReplayObjectV1,
  right: AdmittedWalReplayObjectV1,
): WalReplayProtocolCompatibilityV1 {
  if (!bytesArrayEqual(left.mutation[5], right.mutation[5])) {
    return { compatible: false, reasons: ['different-policy'] };
  }
  if (!sameCanonicalValue(left.mutation[7], right.mutation[7])) {
    return { compatible: false, reasons: ['chain-binding-disagreement'] };
  }
  const leftOperation = left.mutation[1];
  const rightOperation = right.mutation[1];
  if (
    leftOperation === OPERATION.DELETE
    || rightOperation === OPERATION.DELETE
    || leftOperation === OPERATION.RESOLVE
    || rightOperation === OPERATION.RESOLVE
  ) return { compatible: false, reasons: ['delete-or-resolution'] };
  if (
    leftOperation === OPERATION.MOVE_TIER_SOURCE
    || leftOperation === OPERATION.MOVE_TIER_TARGET
    || rightOperation === OPERATION.MOVE_TIER_SOURCE
    || rightOperation === OPERATION.MOVE_TIER_TARGET
    || left.mutation[6] === null
    || right.mutation[6] === null
  ) return { compatible: false, reasons: ['tier-or-non-rdf'] };
  const leftRdf = left.mutation[6];
  const rightRdf = right.mutation[6];
  if (leftRdf[1] !== PATCH_MODE || rightRdf[1] !== PATCH_MODE) {
    return { compatible: false, reasons: ['replace'] };
  }
  const leftTouched = new Set(leftRdf[8].map(hex));
  const overlap = rightRdf[8].map(hex).filter(key => leftTouched.has(key));
  if (overlap.length === 0) {
    return { compatible: true, reasons: ['disjoint-patch-footprints'] };
  }
  const leftPredicates = patchInsertionPredicates(left);
  const rightPredicates = patchInsertionPredicates(right);
  const multiValued = new Set(left.policy[6]);
  if (
    leftPredicates !== null
    && rightPredicates !== null
    && overlap.every(key => {
      const leftPredicate = leftPredicates.get(key);
      const rightPredicate = rightPredicates.get(key);
      return leftPredicate !== undefined
        && leftPredicate === rightPredicate
        && multiValued.has(leftPredicate);
    })
  ) return { compatible: true, reasons: ['add-only-multi-valued-patch'] };
  return { compatible: false, reasons: ['overlapping-patch-footprints'] };
}

function frontierCompatibility<Projection>(
  heads: readonly string[],
  graph: ReplayGraph<Projection>,
  budget: ReplayWorkBudget,
): WalReplayProtocolCompatibilityV1 {
  const reasons = new Set<WalReplayProtocolCompatibilityV1['reasons'][number]>();
  let compatible = true;
  for (let left = 0; left < heads.length; left += 1) {
    for (let right = left + 1; right < heads.length; right += 1) {
      budget.consume();
      const result = pairCompatibility(
        graph.nodes.get(heads[left]!)!.value,
        graph.nodes.get(heads[right]!)!.value,
      );
      compatible &&= result.compatible;
      for (const reason of result.reasons) reasons.add(reason);
    }
  }
  return { compatible, reasons: [...reasons].sort() };
}

function closure<Projection>(
  head: string,
  graph: ReplayGraph<Projection>,
  budget: ReplayWorkBudget,
): Set<string> {
  const output = new Set<string>();
  const pending = [head];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (output.has(current)) continue;
    budget.consume();
    output.add(current);
    for (const parent of graph.nodes.get(current)!.parents) pending.push(parent);
  }
  return output;
}

function maximalWithin<Projection>(
  values: readonly string[],
  graph: ReplayGraph<Projection>,
  budget: ReplayWorkBudget,
): string[] {
  const sorted = sortedHex(new Set(values));
  if (sorted.length < 2) return sorted;
  const nonMaximal = new Set<string>();
  for (const head of sorted) {
    const ancestors = closure(head, graph, budget);
    ancestors.delete(head);
    for (const candidate of sorted) if (ancestors.has(candidate)) nonMaximal.add(candidate);
  }
  return sorted.filter(value => !nonMaximal.has(value));
}

function maximalCommonBase<Projection>(
  heads: readonly string[],
  graph: ReplayGraph<Projection>,
  budget: ReplayWorkBudget,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  let common = closure(heads[0]!, graph, budget);
  for (let index = 1; index < heads.length; index += 1) {
    const next = closure(heads[index]!, graph, budget);
    common = new Set([...common].filter(value => next.has(value)));
  }
  for (const value of excluded) common.delete(value);
  return sortedHex([...common].filter(value => {
    const node = graph.nodes.get(value)!;
    return ![...node.children].some(child => common.has(child));
  }));
}

function equivocationBlockedSet<Projection>(graph: ReplayGraph<Projection>): Set<string> {
  const blocked = new Set(graph.equivocations.flatMap(value => value.objectIds.map(hex)));
  const pending = [...blocked];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of graph.nodes.get(current)!.children) {
      if (blocked.has(child)) continue;
      blocked.add(child);
      pending.push(child);
    }
  }
  return blocked;
}

function buildGraph<Projection>(
  values: readonly AdmittedWalReplayObjectV1[],
  namespaceId: Uint8Array,
  logicalKey: Uint8Array,
  limits: WalReplayLimitsV1,
  budget: ReplayWorkBudget,
): ReplayGraph<Projection> {
  if (values.length > limits.maximumObjects) {
    replayError('WAL_REPLAY_RESOURCE_LIMIT', 'replay object count exceeds the configured bound', 'blocked', 'OBJECT_LIMIT');
  }
  const nodes = new Map<string, ReplayNode<Projection>>();
  const positions = new Map<string, ReplayNode<Projection>[]>();
  for (const value of values) {
    validateObjectMetadata(value);
    if (!bytesArrayEqual(value.namespaceId, namespaceId) || !bytesArrayEqual(value.mutation[2], logicalKey)) {
      replayError(
        'WAL_REPLAY_MIXED_SCOPE',
        'every replay object must belong to the requested namespace and logical key',
        'quarantine',
        'MIXED_REPLAY_SCOPE',
      );
    }
    const id = hex(value.objectId);
    if (nodes.has(id)) {
      replayError('WAL_REPLAY_DUPLICATE_OBJECT', 'replay input contains a duplicate object ID', 'quarantine', 'DUPLICATE_OBJECT');
    }
    const parents = value.mutation[3].map(hex);
    const baseHeads = value.mutation[4].map(hex);
    if (
      parents.length > limits.maximumParentsPerMutation
      || baseHeads.length > limits.maximumParentsPerMutation
    ) replayError('WAL_REPLAY_RESOURCE_LIMIT', 'mutation parent/base-head count exceeds the configured bound', 'blocked', 'PARENT_LIMIT');
    const touchedCount = value.mutation[6]?.[8].length ?? 0;
    if (touchedCount > limits.maximumTouchedKeysPerMutation) {
      replayError('WAL_REPLAY_RESOURCE_LIMIT', 'mutation touched-key count exceeds the configured bound', 'blocked', 'TOUCHED_KEY_LIMIT');
    }
    const operation = value.mutation[1];
    if (operation === OPERATION.SNAPSHOT || operation === OPERATION.LEGACY_GENESIS) {
      if (parents.length !== 0 || baseHeads.length !== 0) {
        replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'snapshot/genesis reset must use empty parents and baseHeads', 'quarantine', 'RESET_BASE_MISMATCH');
      }
    } else if (!sameHexSet(parents, baseHeads)) {
      if (operation === OPERATION.RESOLVE) {
        replayError('WAL_REPLAY_INCOMPLETE_RESOLUTION', 'RESOLVE parents and baseHeads must contain the same complete conflict frontier', 'quarantine', 'INCOMPLETE_RESOLUTION');
      }
      replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'mutation parents must equal its exact baseHeads', 'quarantine', 'PARENTS_BASE_HEADS_MISMATCH');
    }
    const node: ReplayNode<Projection> = { value, id, parents, children: new Set(), depth: 0 };
    nodes.set(id, node);
    const position = `${hex(value.writerId)}:${value.writerEpoch}:${value.sequence}`;
    const atPosition = positions.get(position) ?? [];
    atPosition.push(node);
    positions.set(position, atPosition);
  }
  for (const node of nodes.values()) {
    for (const parent of node.parents) {
      budget.consume();
      const parentNode = nodes.get(parent);
      if (parentNode === undefined) {
        replayError('WAL_REPLAY_MISSING_PARENT', 'replay closure is missing a referenced parent', 'blocked', 'MISSING_CAUSAL_PARENT');
      }
      parentNode.children.add(node.id);
    }
  }

  const indegree = new Map([...nodes].map(([id, node]) => [id, node.parents.length] as const));
  const ready = sortedHex([...nodes.keys()].filter(id => indegree.get(id) === 0));
  const schedule: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = nodes.get(id)!;
    node.depth = node.parents.length === 0
      ? 1
      : 1 + Math.max(...node.parents.map(parent => nodes.get(parent)!.depth));
    if (node.depth > limits.maximumCausalDepth) {
      replayError('WAL_REPLAY_RESOURCE_LIMIT', 'causal depth exceeds the configured bound', 'blocked', 'CAUSAL_DEPTH_LIMIT');
    }
    schedule.push(id);
    for (const child of sortedHex(node.children)) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) insertSorted(ready, child);
    }
  }
  if (schedule.length !== nodes.size) {
    replayError('WAL_REPLAY_CAUSAL_CYCLE', 'replay parent graph contains a causal cycle', 'quarantine', 'CAUSAL_CYCLE');
  }
  for (const node of nodes.values()) {
    const exactMaximalParents = maximalWithin(node.parents, { nodes, schedule, maximalHeads: [], equivocations: [] }, budget);
    if (!sameHexSet(exactMaximalParents, node.parents)) {
      replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'mutation baseHeads contains a non-maximal ancestor', 'quarantine', 'NON_MAXIMAL_BASE_HEAD');
    }
  }
  const maximalHeads = sortedHex([...nodes.values()].filter(node => node.children.size === 0).map(node => node.id));
  if (maximalHeads.length > limits.maximumConflictHeads) {
    replayError('WAL_REPLAY_RESOURCE_LIMIT', 'maximal replay heads exceed the conflict-head bound', 'blocked', 'CONFLICT_HEAD_LIMIT');
  }
  const equivocations = [...positions.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      writerId: new Uint8Array(group[0]!.value.writerId),
      writerEpoch: group[0]!.value.writerEpoch,
      sequence: group[0]!.value.sequence,
      objectIds: sortedIds(group.map(node => node.value.objectId)),
    }))
    .sort((left, right) => {
      const writer = compareCanonicalCbor(left.writerId, right.writerId);
      if (writer !== 0) return writer;
      if (left.writerEpoch !== right.writerEpoch) return left.writerEpoch < right.writerEpoch ? -1 : 1;
      // Equal writer/epoch/sequence entries were combined into one group.
      return left.sequence < right.sequence ? -1 : 1;
    });
  return { nodes, schedule, maximalHeads, equivocations };
}

function headDigest(domain: 'replayHeads' | 'replayConflict', heads: readonly string[]): Uint8Array {
  return hashWalV1Domain(domain, encodeCanonicalCbor(heads.map(fromHex)));
}

export interface ReplayAdmittedWalSetInputV1 {
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly objects: readonly AdmittedWalReplayObjectV1[];
}

/**
 * Deterministic causal/replay orchestration over an injected shared semantic
 * core. This class owns no DKG authorization, lifecycle, VM, finality, crypto,
 * or RDF-state decision.
 */
export class WalReplayConflictAdapterV1<Projection> {
  private readonly limits: WalReplayLimitsV1;

  constructor(
    private readonly semanticCore: WalReplaySemanticCoreV1<Projection>,
    limits: Partial<WalReplayLimitsV1> = {},
  ) {
    this.limits = normalizeLimits(limits);
  }

  async replay(input: ReplayAdmittedWalSetInputV1): Promise<WalReplayProjectionV1<Projection>> {
    const namespaceId = fixedBytes(input.namespaceId, 32, 'namespaceId');
    const logicalKey = fixedBytes(input.logicalKey, 32, 'logicalKey');
    const budget = new ReplayWorkBudget(this.limits.maximumRecomputationWork);
    const graph = buildGraph<Projection>(input.objects, namespaceId, logicalKey, this.limits, budget);
    const initial = validateState(await this.semanticCore.initialState({ namespaceId, logicalKey }), 'initial state');
    const equivocationBlocked = equivocationBlockedSet(graph);
    const empty: InternalProjection<Projection> = {
      status: 'empty',
      state: initial,
      activeHeads: [],
      conflictHeads: [],
      pendingHeads: [],
      commonBaseHeads: [],
    };
    const frontierCache = new Map<string, InternalProjection<Projection>>([['', empty]]);

    const projectFrontier = async (rawHeads: readonly string[]): Promise<InternalProjection<Projection>> => {
      const heads = maximalWithin(rawHeads, graph, budget);
      const key = heads.join(':');
      const cached = frontierCache.get(key);
      if (cached !== undefined) return cached;
      if (heads.length > this.limits.maximumConflictHeads) {
        replayError('WAL_REPLAY_RESOURCE_LIMIT', 'frontier exceeds the conflict-head bound', 'blocked', 'CONFLICT_HEAD_LIMIT');
      }
      /* v8 ignore start -- topological replay caches every singleton before any descendant can reference it. */
      if (heads.length === 1) {
        const singleton = graph.nodes.get(heads[0]!)!.projection;
        if (singleton === undefined) {
          replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'frontier references a transition before its causal base', 'blocked', 'UNRESOLVED_CAUSAL_BASE');
        }
        frontierCache.set(key, singleton);
        return singleton;
      }
      /* v8 ignore stop */
      const branches = heads.map(head => graph.nodes.get(head)!.projection!);
      const commonBaseHeads = maximalCommonBase(heads, graph, budget);
      const commonBase = await projectFrontier(commonBaseHeads);
      if (branches.some(branch => branch.status === 'pending')) {
        const pending: InternalProjection<Projection> = {
          status: 'pending',
          state: commonBase.state,
          activeHeads: commonBase.activeHeads,
          conflictHeads: commonBase.conflictHeads,
          pendingHeads: sortedHex(new Set(branches.flatMap(branch => branch.pendingHeads).concat(heads))),
          commonBaseHeads,
        };
        frontierCache.set(key, pending);
        return pending;
      }
      const compatibility = frontierCompatibility(heads, graph, budget);
      if (!compatibility.compatible) {
        const conflict: InternalProjection<Projection> = {
          status: 'conflict',
          state: commonBase.state,
          activeHeads: commonBase.activeHeads,
          conflictHeads: heads,
          pendingHeads: [],
          commonBaseHeads,
        };
        frontierCache.set(key, conflict);
        return conflict;
      }
      const decision = await this.semanticCore.mergeCompatibleBranches({
        namespaceId,
        logicalKey,
        commonBase: commonBase.state,
        commonBaseHeads: commonBaseHeads.map(fromHex),
        branches: heads.map((head, index) => ({
          headId: fromHex(head),
          candidate: graph.nodes.get(head)!.value,
          state: branches[index]!.state,
        })),
        compatibility,
      });
      if (decision.status === 'rejected') {
        replayError('WAL_REPLAY_SEMANTIC_REJECTED', 'shared semantic core rejected a compatible merge', 'quarantine', decision.reasonCode);
      }
      if (decision.status === 'pending') {
        const pending: InternalProjection<Projection> = {
          status: 'pending',
          state: commonBase.state,
          activeHeads: commonBase.activeHeads,
          conflictHeads: commonBase.conflictHeads,
          pendingHeads: heads,
          commonBaseHeads,
        };
        frontierCache.set(key, pending);
        return pending;
      }
      const merged: InternalProjection<Projection> = {
        status: 'merge',
        state: validateState(decision.state, 'compatible merge result'),
        activeHeads: heads,
        conflictHeads: [],
        pendingHeads: [],
        commonBaseHeads,
      };
      frontierCache.set(key, merged);
      return merged;
    };

    for (const id of graph.schedule) {
      const node = graph.nodes.get(id)!;
      // Same-position objects and everything causally descended from them are
      // retained as evidence but never presented to the semantic core as a
      // candidate for activation.
      if (equivocationBlocked.has(id)) continue;
      const base = await projectFrontier(node.parents);
      const operation = node.value.mutation[1];
      const resolution = operation === OPERATION.RESOLVE;
      if (resolution) {
        if (base.status !== 'conflict') {
          replayError('WAL_REPLAY_STALE_RESOLUTION', 'RESOLVE base is not a current conflict frontier', 'quarantine', 'STALE_RESOLUTION');
        }
      } else if (base.status === 'conflict') {
        replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'ordinary mutation cannot advance an unresolved conflict frontier', 'quarantine', 'UNRESOLVED_CONFLICT_BASE');
      }
      if (base.status === 'pending') {
        const pending: InternalProjection<Projection> = {
          status: 'pending',
          state: base.state,
          activeHeads: base.activeHeads,
          conflictHeads: base.conflictHeads,
          pendingHeads: sortedHex([...base.pendingHeads, id]),
          commonBaseHeads: base.commonBaseHeads,
        };
        node.projection = pending;
        frontierCache.set(id, pending);
        continue;
      }
      const rdf = node.value.mutation[6];
      if (rdf !== null && !bytesArrayEqual(rdf[2], base.state.stateDigest)) {
        replayError('WAL_REPLAY_CAUSAL_BASE_MISMATCH', 'mutation baseStateDigest does not match its deterministic causal base', 'quarantine', 'BASE_STATE_DIGEST_MISMATCH');
      }
      const decision = await this.semanticCore.evaluateTransition({
        candidate: node.value,
        base: base.state,
        activeBaseHeads: base.activeHeads.map(fromHex),
        currentConflictHeads: base.conflictHeads.map(fromHex),
        resolution,
      });
      if (decision.status === 'rejected') {
        replayError('WAL_REPLAY_SEMANTIC_REJECTED', 'shared semantic core rejected a replay transition', 'quarantine', decision.reasonCode);
      }
      if (decision.status === 'pending') {
        const pending: InternalProjection<Projection> = {
          status: 'pending',
          state: base.state,
          activeHeads: base.activeHeads,
          conflictHeads: base.conflictHeads,
          pendingHeads: [id],
          commonBaseHeads: base.commonBaseHeads,
        };
        node.projection = pending;
        frontierCache.set(id, pending);
        continue;
      }
      const state = validateState(decision.state, 'transition result');
      if (rdf !== null && !bytesArrayEqual(rdf[3], state.stateDigest)) {
        replayError('WAL_REPLAY_SEMANTIC_RESULT_MISMATCH', 'shared semantic result does not match the signed resultStateDigest', 'quarantine', 'RESULT_STATE_DIGEST_MISMATCH');
      }
      const applied: InternalProjection<Projection> = {
        status: 'apply',
        state,
        activeHeads: [id],
        conflictHeads: [],
        pendingHeads: [],
        commonBaseHeads: node.parents,
      };
      node.projection = applied;
      frontierCache.set(id, applied);
    }

    let projection: InternalProjection<Projection>;
    if (graph.equivocations.length > 0) {
      const equivocationHeads = sortedHex(graph.equivocations.flatMap(value => value.objectIds.map(hex)));
      const blockedHeads = sortedHex(
        graph.maximalHeads.filter(head => equivocationBlocked.has(head)),
      );
      // At least one maximal graph head descends from every retained
      // equivocation, so blockedHeads cannot be empty.
      const conflictHeads = blockedHeads;
      const commonBaseHeads = maximalCommonBase(equivocationHeads, graph, budget, equivocationBlocked);
      const commonBase = await projectFrontier(commonBaseHeads);
      projection = {
        status: 'blocked',
        state: commonBase.state,
        activeHeads: commonBase.activeHeads,
        conflictHeads,
        pendingHeads: [],
        commonBaseHeads,
      };
    } else {
      projection = await projectFrontier(graph.maximalHeads);
    }

    return {
      status: projection.status,
      namespaceId,
      logicalKey,
      schedule: graph.schedule.map(fromHex),
      maximalHeads: graph.maximalHeads.map(fromHex),
      activeHeads: projection.activeHeads.map(fromHex),
      conflictHeads: projection.conflictHeads.map(fromHex),
      pendingHeads: projection.pendingHeads.map(fromHex),
      commonBaseHeads: projection.commonBaseHeads.map(fromHex),
      activeHeadsDigest: headDigest('replayHeads', projection.activeHeads),
      conflictHeadsDigest: headDigest('replayConflict', projection.conflictHeads),
      state: projection.state,
      equivocations: graph.equivocations,
    };
  }
}
