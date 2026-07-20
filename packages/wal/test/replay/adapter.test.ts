import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeProtocolTuple } from '../../src/protocol/codec.js';
import { hashWalV1Domain } from '../../src/protocol/hashes.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../../src/protocol/schema.js';
import { rdfLogicalKeyV1 } from '../../src/rdf/keys.js';
import { canonicalizeNQuadsV1 } from '../../src/rdf/nquads.js';
import {
  deriveExplicitRdfCandidateV1,
  encodeAcceptedRdfMutationV1,
} from '../../src/rdf/outcome-encoder.js';
import { createRdfPolicyV1 } from '../../src/rdf/policy.js';
import {
  WalReplayConflictAdapterV1,
  type AdmittedWalReplayObjectV1,
  type WalReplayMergeInputV1,
  type WalReplaySemanticCoreV1,
  type WalReplaySemanticDecisionV1,
  type WalReplaySemanticStateV1,
  type WalReplayTransitionInputV1,
} from '../../src/replay/index.js';

const encoder = new TextEncoder();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const conformance = JSON.parse(readFileSync(
  resolve(packageRoot, '../../conformance/wal-v1/vectors/protocol-v1.json'),
  'utf8',
));
const GRAPH = 'urn:dkg:graph:replay';
const ENTITY = 'urn:dkg:asset:replay';
const NAMESPACE = id('namespace');
const AUTHOR = writer('author');
const POLICY_ID = id('policy');
const LOGICAL_COORDINATES = {
  contextGraphId: 'urn:dkg:context-graph:replay',
  subGraphName: 'main',
  authorAddress: AUTHOR,
  knowledgeAssetUalOrRootEntity: ENTITY,
} as const;
const LOGICAL_KEY = rdfLogicalKeyV1(LOGICAL_COORDINATES);
const POLICY = createRdfPolicyV1({
  allowedGraphPrefixes: ['urn:dkg:graph:'],
  maxQuadsPerMutation: 1_000n,
  maxWalObjectBytes: 1_000_000n,
  singleValuedPredicates: ['urn:p:name', 'urn:p:status'],
  multiValuedPredicates: ['urn:p:tag'],
  sharedWriteLogicalKeys: [LOGICAL_KEY],
  resolverAddresses: [AUTHOR],
  allowedPayloadKinds: [BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION)],
});

function id(label: string): Uint8Array {
  return hashWalV1Domain('walObjectId', encoder.encode(`replay-test:${label}`));
}

function writer(label: string): Uint8Array {
  return id(`writer:${label}`).slice(0, 20);
}

function fixedId(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function fixedWriter(value: number): Uint8Array {
  return new Uint8Array(20).fill(value);
}

function h(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function state(nquads: string): WalReplaySemanticStateV1<string> {
  const value = canonicalizeNQuadsV1(nquads);
  return { stateDigest: value.stateDigest, projection: value.text };
}

interface Fixture {
  readonly object: AdmittedWalReplayObjectV1;
  readonly result: string;
}

type FixtureOperation = 'PUT' | 'PATCH' | 'DELETE' | 'RESOLVE' | 'MOVE_TIER_TARGET';

function fixture(input: {
  readonly label: string;
  readonly operation: FixtureOperation;
  readonly baseHeads: readonly Uint8Array[];
  readonly base: string;
  readonly writerId?: Uint8Array;
  readonly writerEpoch?: bigint;
  readonly sequence?: bigint;
  readonly replace?: string;
  readonly deletes?: string;
  readonly inserts?: string;
}): Fixture {
  const writerId = input.writerId ?? writer(input.label);
  const encoderOperation = input.operation === 'PUT'
    ? 'PUT'
    : input.operation === 'DELETE'
      ? 'DELETE'
      : 'PATCH';
  const source = input.operation === 'PUT' || input.replace !== undefined
    ? {
        kind: 'replace' as const,
        graphs: [{ graphIri: GRAPH, nquads: input.replace ?? '' }],
      }
    : input.operation === 'DELETE'
      ? { kind: 'delete-logical-key' as const }
      : {
          kind: 'accepted-patch' as const,
          deletesNQuads: input.deletes ?? '',
          insertsNQuads: input.inserts ?? '',
        };
  const encoded = encodeAcceptedRdfMutationV1({
    operation: encoderOperation,
    logicalKey: LOGICAL_COORDINATES,
    writerId,
    memberWriterIds: [AUTHOR, writerId],
    baseHeads: input.baseHeads,
    baseNQuads: input.base,
    allowedGraphIris: [GRAPH],
    policyObjectId: POLICY_ID,
    policy: POLICY,
    source,
  });
  let mutation = encoded.dkgMutation;
  if (input.operation === 'RESOLVE' || input.operation === 'MOVE_TIER_TARGET') {
    const tuple = [...mutation] as unknown[];
    tuple[1] = BigInt(WAL_V1_ENUMS.mutationOperation[input.operation]);
    if (input.operation === 'MOVE_TIER_TARGET') tuple[6] = null;
    mutation = tuple as unknown as ProtocolTuple<'DkgMutationV1'>;
    encodeProtocolTuple('DkgMutationV1', mutation);
  }
  return {
    object: {
      objectId: id(input.label),
      namespaceId: NAMESPACE,
      writerId,
      writerEpoch: input.writerEpoch ?? 0n,
      sequence: input.sequence ?? 0n,
      mutation,
      policy: POLICY,
    },
    result: encoded.result.text,
  };
}

function line(predicate: string, object: string): string {
  return `<${ENTITY}> <${predicate}> ${object} <${GRAPH}> .`;
}

const BASE_TEXT = `${line('urn:p:name', '"old"')}\n`;

function baseFixture(label = 'base'): Fixture {
  return fixture({
    label,
    operation: 'PUT',
    baseHeads: [],
    base: '',
    replace: BASE_TEXT,
  });
}

class ScriptedSemanticCore implements WalReplaySemanticCoreV1<string> {
  readonly transitions: WalReplayTransitionInputV1<string>[] = [];
  readonly merges: WalReplayMergeInputV1<string>[] = [];
  readonly transitionDecisions = new Map<string, WalReplaySemanticDecisionV1<string>>();
  readonly mergeDecisions = new Map<string, WalReplaySemanticDecisionV1<string>>();

  initialState(): Promise<WalReplaySemanticStateV1<string>> {
    return Promise.resolve(state(''));
  }

  evaluateTransition(
    input: WalReplayTransitionInputV1<string>,
  ): Promise<WalReplaySemanticDecisionV1<string>> {
    this.transitions.push(input);
    const scripted = this.transitionDecisions.get(h(input.candidate.objectId));
    if (scripted !== undefined) return Promise.resolve(scripted);
    const rdf = input.candidate.mutation[6];
    if (rdf === null) return Promise.resolve({ status: 'rejected', reasonCode: 'NO_SCRIPTED_NON_RDF_OUTCOME' });
    const result = deriveExplicitRdfCandidateV1({ rdfMutation: rdf, baseNQuads: input.base.projection });
    return Promise.resolve({
      status: 'accepted',
      state: { stateDigest: result.stateDigest, projection: result.text },
    });
  }

  mergeCompatibleBranches(
    input: WalReplayMergeInputV1<string>,
  ): Promise<WalReplaySemanticDecisionV1<string>> {
    this.merges.push(input);
    const key = input.branches.map(branch => h(branch.headId)).sort().join(':');
    return Promise.resolve(this.mergeDecisions.get(key) ?? {
      status: 'rejected',
      reasonCode: 'NO_SCRIPTED_MERGE_OUTCOME',
    });
  }

  acceptMerge(objects: readonly AdmittedWalReplayObjectV1[], nquads: string): void {
    const key = objects.map(value => h(value.objectId)).sort().join(':');
    this.mergeDecisions.set(key, { status: 'accepted', state: state(nquads) });
  }
}

function adapter(core: ScriptedSemanticCore, limits = {}) {
  return new WalReplayConflictAdapterV1(core, limits);
}

function replay(core: ScriptedSemanticCore, objects: readonly AdmittedWalReplayObjectV1[]) {
  return adapter(core).replay({ namespaceId: NAMESPACE, logicalKey: LOGICAL_KEY, objects });
}

function ids(values: readonly Uint8Array[]): string[] {
  return values.map(h);
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length < 2) return [[...values]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map(tail => [value, ...tail]));
}

function projectionSummary(value: Awaited<ReturnType<typeof replay>>) {
  return {
    status: value.status,
    schedule: ids(value.schedule),
    maximalHeads: ids(value.maximalHeads),
    activeHeads: ids(value.activeHeads),
    conflictHeads: ids(value.conflictHeads),
    pendingHeads: ids(value.pendingHeads),
    commonBaseHeads: ids(value.commonBaseHeads),
    activeHeadsDigest: h(value.activeHeadsDigest),
    conflictHeadsDigest: h(value.conflictHeadsDigest),
    stateDigest: h(value.state.stateDigest),
    projection: value.state.projection,
  };
}

async function expectCode(promise: Promise<unknown>, code: string, disposition?: string) {
  await expect(promise).rejects.toMatchObject({ code, ...(disposition === undefined ? {} : { disposition }) });
}

describe('WalReplayConflictAdapterV1 deterministic orchestration', () => {
  it('returns the shared-core genesis projection for an empty admitted set', async () => {
    const value = await replay(new ScriptedSemanticCore(), []);
    expect(value.status).toBe('empty');
    expect(value.activeHeads).toEqual([]);
    expect(value.conflictHeads).toEqual([]);
    expect(value.state).toEqual(state(''));
  });

  it('uses one deterministic topological schedule under every arrival permutation', async () => {
    const base = baseFixture();
    const child = fixture({
      label: 'causal-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"new"'),
    });
    const outputs: ReturnType<typeof projectionSummary>[] = [];
    for (const order of permutations([base.object, child.object])) {
      const core = new ScriptedSemanticCore();
      const value = await replay(core, order);
      outputs.push(projectionSummary(value));
      expect(core.transitions.map(call => h(call.candidate.objectId)))
        .toEqual([h(base.object.objectId), h(child.object.objectId)]);
    }
    expect(outputs.every(value => JSON.stringify(value) === JSON.stringify(outputs[0]))).toBe(true);
    expect(outputs[0]).toMatchObject({
      status: 'apply',
      activeHeads: [h(child.object.objectId)],
      conflictHeads: [],
      projection: child.result,
    });
  });

  it('inserts newly-ready objects by byte ID rather than discovery order', async () => {
    const firstFixture = baseFixture('schedule-first');
    const otherFixture = fixture({
      label: 'schedule-other-root',
      operation: 'PUT',
      baseHeads: [],
      base: '',
      replace: `${line('urn:p:name', '"other"')}\n`,
    });
    const first = { ...firstFixture.object, objectId: fixedId(0x10) };
    const childFixture = fixture({
      label: 'schedule-child',
      operation: 'PATCH',
      baseHeads: [first.objectId],
      base: firstFixture.result,
      inserts: line('urn:p:tag', '"child"'),
    });
    const child = { ...childFixture.object, objectId: fixedId(0x20) };
    const other = { ...otherFixture.object, objectId: fixedId(0x30) };
    const value = await replay(new ScriptedSemanticCore(), [other, child, first]);
    expect(ids(value.schedule)).toEqual([h(first.objectId), h(child.objectId), h(other.objectId)]);
    expect(value.status).toBe('conflict');
  });

  it('traverses a diamond closure once per object and freezes its empty common base', async () => {
    const base = baseFixture('diamond-base');
    const left = fixture({
      label: 'diamond-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'diamond-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"ready"'),
    });
    const merged = `${BASE_TEXT}${line('urn:p:status', '"ready"')}\n${line('urn:p:tag', '"left"')}\n`;
    const child = fixture({
      label: 'diamond-child',
      operation: 'PATCH',
      baseHeads: [left.object.objectId, right.object.objectId],
      base: merged,
      deletes: line('urn:p:status', '"ready"'),
      inserts: line('urn:p:status', '"done"'),
    });
    const independent = fixture({
      label: 'diamond-independent',
      operation: 'PUT',
      baseHeads: [],
      base: '',
      replace: `${line('urn:p:name', '"independent"')}\n`,
    });
    const core = new ScriptedSemanticCore();
    core.acceptMerge([left.object, right.object], merged);
    const value = await replay(core, [child.object, independent.object, right.object, base.object, left.object]);
    expect(value.status).toBe('conflict');
    expect(value.commonBaseHeads).toEqual([]);
    expect(value.activeHeads).toEqual([]);
    expect(ids(value.conflictHeads)).toEqual([h(child.object.objectId), h(independent.object.objectId)].sort());
  });

  it('asks the shared core to merge disjoint patches and converges for all six permutations', async () => {
    const base = baseFixture('disjoint-base');
    const name = fixture({
      label: 'disjoint-name',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"new"'),
    });
    const status = fixture({
      label: 'disjoint-status',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"ready"'),
    });
    const merged = `${line('urn:p:name', '"new"')}\n${line('urn:p:status', '"ready"')}\n`;
    const outputs: ReturnType<typeof projectionSummary>[] = [];
    for (const order of permutations([status.object, base.object, name.object])) {
      const core = new ScriptedSemanticCore();
      core.acceptMerge([name.object, status.object], merged);
      const value = await replay(core, order);
      outputs.push(projectionSummary(value));
      expect(core.transitions).toHaveLength(3);
      expect(core.merges).toHaveLength(1);
      expect(core.merges[0]!.compatibility).toEqual({
        compatible: true,
        reasons: ['disjoint-patch-footprints'],
      });
    }
    expect(outputs.every(value => JSON.stringify(value) === JSON.stringify(outputs[0]))).toBe(true);
    expect(outputs[0]).toMatchObject({
      status: 'merge',
      activeHeads: [h(status.object.objectId), h(name.object.objectId)].sort(),
      conflictHeads: [],
      projection: canonicalizeNQuadsV1(merged).text,
    });
  });

  it('matches the frozen semantic-outcome head and conflict digest vectors', async () => {
    const vector = conformance.replayConflict.find(
      (value: { name: string }) => value.name === 'semantic-core-overlapping-patches',
    );
    const base = baseFixture('vector-base');
    const left = fixture({
      label: 'vector-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"left"'),
    });
    const right = fixture({
      label: 'vector-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"right"'),
    });
    const fixedBase = {
      ...base.object,
      objectId: new Uint8Array(Buffer.from(vector.input.semanticActiveHeads[0], 'hex')),
    };
    const fixedLeft = {
      ...left.object,
      objectId: new Uint8Array(Buffer.from(vector.input.semanticConflictHeads[0], 'hex')),
      mutation: withHeads(left.object.mutation, [fixedBase.objectId]),
    };
    const fixedRight = {
      ...right.object,
      objectId: new Uint8Array(Buffer.from(vector.input.semanticConflictHeads[1], 'hex')),
      mutation: withHeads(right.object.mutation, [fixedBase.objectId]),
    };
    const value = await replay(new ScriptedSemanticCore(), [fixedRight, fixedBase, fixedLeft]);
    expect(value.status).toBe(vector.expected.status);
    expect(ids(value.activeHeads)).toEqual(vector.expected.activeHeads);
    expect(ids(value.conflictHeads)).toEqual(vector.expected.conflictHeads);
    expect(h(value.activeHeadsDigest)).toBe(vector.expected.headDigest);
    expect(h(value.conflictHeadsDigest)).toBe(vector.expected.conflictDigest);
  });

  it('allows only shared-core-approved add-only overlap on a signed multi-valued predicate', async () => {
    const base = baseFixture('multi-base');
    const left = fixture({
      label: 'multi-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'multi-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"right"'),
    });
    const merged = `${BASE_TEXT}${line('urn:p:tag', '"left"')}\n${line('urn:p:tag', '"right"')}\n`;
    const core = new ScriptedSemanticCore();
    core.acceptMerge([left.object, right.object], merged);
    const value = await replay(core, [right.object, base.object, left.object]);
    expect(value.status).toBe('merge');
    expect(core.merges[0]!.compatibility).toEqual({
      compatible: true,
      reasons: ['add-only-multi-valued-patch'],
    });
    expect(value.state.projection).toBe(canonicalizeNQuadsV1(merged).text);
  });

  it.each(['different-policy', 'chain-binding'] as const)(
    'retains protocol conflict for %s without asking the core to choose a winner',
    async kind => {
    const base = baseFixture(`protocol-conflict-base-${kind}`);
    const left = fixture({
      label: `protocol-conflict-left-${kind}`,
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const rightFixture = fixture({
      label: `protocol-conflict-right-${kind}`,
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"right"'),
    });
    const tuple = [...rightFixture.object.mutation] as unknown[];
    if (kind === 'different-policy') tuple[5] = id('different-policy-object');
    else tuple[7] = chainBinding(1);
    const right = {
      ...rightFixture.object,
      mutation: tuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', right.mutation);
    const core = new ScriptedSemanticCore();
    const value = await replay(core, [right, base.object, left.object]);
    expect(value.status).toBe('conflict');
    expect(ids(value.conflictHeads)).toEqual([h(left.object.objectId), h(right.objectId)].sort());
    expect(core.merges).toHaveLength(0);
    },
  );

  it('retains concurrent non-RDF tier branches after the core validates each branch', async () => {
    const base = baseFixture('tier-conflict-base');
    const left = fixture({
      label: 'tier-conflict-left',
      operation: 'MOVE_TIER_TARGET',
      baseHeads: [base.object.objectId],
      base: base.result,
    });
    const right = fixture({
      label: 'tier-conflict-right',
      operation: 'MOVE_TIER_TARGET',
      baseHeads: [base.object.objectId],
      base: base.result,
    });
    const core = new ScriptedSemanticCore();
    core.transitionDecisions.set(h(left.object.objectId), { status: 'accepted', state: state(base.result) });
    core.transitionDecisions.set(h(right.object.objectId), { status: 'accepted', state: state(base.result) });
    const value = await replay(core, [right.object, base.object, left.object]);
    expect(value.status).toBe('conflict');
    expect(ids(value.activeHeads)).toEqual([h(base.object.objectId)]);
    expect(ids(value.conflictHeads)).toEqual([h(left.object.objectId), h(right.object.objectId)].sort());
    expect(core.transitions).toHaveLength(3);
  });

  it.each([
    ['same-key patch', 'patch', 'patch'],
    ['replace/patch', 'replace', 'patch'],
    ['replace/replace', 'replace', 'replace'],
    ['delete/update', 'delete', 'patch'],
  ] as const)('retains every incompatible %s branch without an ID winner', async (_name, leftKind, rightKind) => {
    const base = baseFixture(`conflict-base-${leftKind}-${rightKind}`);
    const branch = (side: 'left' | 'right', kind: typeof leftKind): Fixture => {
      const label = `conflict-${leftKind}-${rightKind}-${side}`;
      if (kind === 'delete') {
        return fixture({ label, operation: 'DELETE', baseHeads: [base.object.objectId], base: base.result });
      }
      if (kind === 'replace') {
        return fixture({
          label,
          operation: 'PATCH',
          baseHeads: [base.object.objectId],
          base: base.result,
          replace: `${line('urn:p:name', `"${side}"`)}\n`,
        });
      }
      return fixture({
        label,
        operation: 'PATCH',
        baseHeads: [base.object.objectId],
        base: base.result,
        deletes: line('urn:p:name', '"old"'),
        inserts: line('urn:p:name', `"${side}"`),
      });
    };
    const left = branch('left', leftKind);
    const right = branch('right', rightKind);
    const expectedConflicts = [h(left.object.objectId), h(right.object.objectId)].sort();
    for (const order of permutations([left.object, base.object, right.object])) {
      const core = new ScriptedSemanticCore();
      const value = await replay(core, order);
      expect(value.status).toBe('conflict');
      expect(ids(value.activeHeads)).toEqual([h(base.object.objectId)]);
      expect(ids(value.conflictHeads)).toEqual(expectedConflicts);
      expect(value.state.projection).toBe(base.result);
      expect(core.transitions).toHaveLength(3);
      expect(core.merges).toHaveLength(0);
    }
  });

  it('evaluates and caches a compatible multi-base before its causal successor', async () => {
    const base = baseFixture('multi-base-root');
    const left = fixture({
      label: 'multi-base-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'multi-base-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"ready"'),
    });
    const merged = `${BASE_TEXT}${line('urn:p:status', '"ready"')}\n${line('urn:p:tag', '"left"')}\n`;
    const successor = fixture({
      label: 'multi-base-successor',
      operation: 'PATCH',
      baseHeads: [right.object.objectId, left.object.objectId],
      base: merged,
      deletes: line('urn:p:status', '"ready"'),
      inserts: line('urn:p:status', '"done"'),
    });
    const core = new ScriptedSemanticCore();
    core.acceptMerge([left.object, right.object], merged);
    const value = await replay(core, [successor.object, right.object, base.object, left.object]);
    expect(value.status).toBe('apply');
    expect(ids(value.activeHeads)).toEqual([h(successor.object.objectId)]);
    expect(value.state.projection).toBe(successor.result);
    expect(core.merges).toHaveLength(1);
    expect(core.transitions.map(call => h(call.candidate.objectId)).at(-1)).toBe(h(successor.object.objectId));
  });

  it('accepts only a complete conflict resolution authorized by the shared core', async () => {
    const base = baseFixture('resolve-base');
    const left = fixture({
      label: 'resolve-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"left"'),
    });
    const right = fixture({
      label: 'resolve-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"right"'),
    });
    const resolution = fixture({
      label: 'resolve-complete',
      operation: 'RESOLVE',
      baseHeads: [right.object.objectId, left.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"resolved"'),
      writerId: AUTHOR,
      sequence: 1n,
    });
    const core = new ScriptedSemanticCore();
    const value = await replay(core, [resolution.object, right.object, base.object, left.object]);
    expect(value.status).toBe('apply');
    expect(ids(value.activeHeads)).toEqual([h(resolution.object.objectId)]);
    const call = core.transitions.find(input => h(input.candidate.objectId) === h(resolution.object.objectId));
    expect(call).toMatchObject({ resolution: true });
    expect(ids(call!.currentConflictHeads)).toEqual([h(right.object.objectId), h(left.object.objectId)].sort());

    const denied = new ScriptedSemanticCore();
    denied.transitionDecisions.set(h(resolution.object.objectId), {
      status: 'rejected',
      reasonCode: 'UNAUTHORIZED_RESOLVER',
    });
    await expectCode(
      replay(denied, [base.object, left.object, right.object, resolution.object]),
      'WAL_REPLAY_SEMANTIC_REJECTED',
      'quarantine',
    );
  });

  it('rejects stale and structurally partial RESOLVE objects before projection changes', async () => {
    const base = baseFixture('resolve-negative-base');
    const compatible = fixture({
      label: 'resolve-stale-compatible',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"value"'),
    });
    const stale = fixture({
      label: 'resolve-stale',
      operation: 'RESOLVE',
      baseHeads: [compatible.object.objectId],
      base: compatible.result,
      inserts: line('urn:p:status', '"resolved"'),
      writerId: AUTHOR,
      sequence: 2n,
    });
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, compatible.object, stale.object]),
      'WAL_REPLAY_STALE_RESOLUTION',
      'quarantine',
    );

    const partialMutation = [...stale.object.mutation] as unknown[];
    partialMutation[3] = [base.object.objectId, compatible.object.objectId].sort(compareBytes);
    const partial = { ...stale.object, objectId: id('resolve-partial'), mutation: partialMutation as unknown as ProtocolTuple<'DkgMutationV1'> };
    encodeProtocolTuple('DkgMutationV1', partial.mutation);
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, compatible.object, partial]),
      'WAL_REPLAY_INCOMPLETE_RESOLUTION',
      'quarantine',
    );
  });

  it('keeps a shared-core-pending tier transition inactive and visible', async () => {
    const base = baseFixture('tier-base');
    const tier = fixture({
      label: 'tier-pending',
      operation: 'MOVE_TIER_TARGET',
      baseHeads: [base.object.objectId],
      base: base.result,
    });
    const core = new ScriptedSemanticCore();
    core.transitionDecisions.set(h(tier.object.objectId), { status: 'pending', reasonCode: 'WAITING_FOR_FINALITY' });
    const value = await replay(core, [tier.object, base.object]);
    expect(value.status).toBe('pending');
    expect(ids(value.activeHeads)).toEqual([h(base.object.objectId)]);
    expect(ids(value.pendingHeads)).toEqual([h(tier.object.objectId)]);
    expect(value.state.projection).toBe(base.result);
  });

  it('keeps a concurrent frontier inactive when one branch or the shared merge is pending', async () => {
    const base = baseFixture('pending-frontier-base');
    const left = fixture({
      label: 'pending-frontier-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'pending-frontier-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"right"'),
    });
    const branchPending = new ScriptedSemanticCore();
    branchPending.transitionDecisions.set(h(left.object.objectId), {
      status: 'pending',
      reasonCode: 'WAITING_FOR_CHAIN',
    });
    const branchValue = await replay(branchPending, [right.object, base.object, left.object]);
    expect(branchValue.status).toBe('pending');
    expect(ids(branchValue.activeHeads)).toEqual([h(base.object.objectId)]);
    expect(ids(branchValue.pendingHeads)).toEqual([h(left.object.objectId), h(right.object.objectId)].sort());
    expect(branchPending.merges).toHaveLength(0);

    const mergePending = new ScriptedSemanticCore();
    const mergeKey = [h(left.object.objectId), h(right.object.objectId)].sort().join(':');
    mergePending.mergeDecisions.set(mergeKey, { status: 'pending', reasonCode: 'MERGE_CONTEXT_PENDING' });
    const mergeValue = await replay(mergePending, [left.object, base.object, right.object]);
    expect(mergeValue.status).toBe('pending');
    expect(ids(mergeValue.activeHeads)).toEqual([h(base.object.objectId)]);
    expect(ids(mergeValue.pendingHeads)).toEqual([h(left.object.objectId), h(right.object.objectId)].sort());
    expect(mergePending.merges).toHaveLength(1);
  });

  it('quarantines a compatible frontier when the shared core rejects its merge', async () => {
    const base = baseFixture('merge-rejected-base');
    const left = fixture({
      label: 'merge-rejected-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'merge-rejected-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"right"'),
    });
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, left.object, right.object]),
      'WAL_REPLAY_SEMANTIC_REJECTED',
      'quarantine',
    );
  });

  it('propagates pending causal bases without invoking their descendants', async () => {
    const base = baseFixture('pending-base-root');
    const tier = fixture({
      label: 'pending-base-tier',
      operation: 'MOVE_TIER_TARGET',
      baseHeads: [base.object.objectId],
      base: base.result,
    });
    const child = fixture({
      label: 'pending-base-child',
      operation: 'PATCH',
      baseHeads: [tier.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"after-tier"'),
    });
    const core = new ScriptedSemanticCore();
    core.transitionDecisions.set(h(tier.object.objectId), { status: 'pending', reasonCode: 'WAITING_FOR_FINALITY' });
    const value = await replay(core, [child.object, base.object, tier.object]);
    expect(value.status).toBe('pending');
    expect(ids(value.pendingHeads)).toEqual([h(tier.object.objectId), h(child.object.objectId)].sort());
    expect(core.transitions.map(call => h(call.candidate.objectId)))
      .toEqual([h(base.object.objectId), h(tier.object.objectId)]);
  });

  it('retains same-position author equivocation, blocks the lane, and activates no lexical winner', async () => {
    const base = baseFixture('equivocation-base');
    const laneWriter = writer('equivocator');
    const left = fixture({
      label: 'equivocation-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"left"'),
      writerId: laneWriter,
      writerEpoch: 9n,
      sequence: 12n,
    });
    const right = fixture({
      label: 'equivocation-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"right"'),
      writerId: laneWriter,
      writerEpoch: 9n,
      sequence: 12n,
    });
    const expected = [h(left.object.objectId), h(right.object.objectId)].sort();
    for (const order of permutations([right.object, base.object, left.object])) {
      const core = new ScriptedSemanticCore();
      const value = await replay(core, order);
      expect(value.status).toBe('blocked');
      expect(ids(value.activeHeads)).toEqual([h(base.object.objectId)]);
      expect(ids(value.conflictHeads)).toEqual(expected);
      expect(value.equivocations).toHaveLength(1);
      expect(ids(value.equivocations[0]!.objectIds)).toEqual(expected);
      expect(value.equivocations[0]).toMatchObject({ writerEpoch: 9n, sequence: 12n });
      expect(core.transitions.map(call => h(call.candidate.objectId))).toEqual([h(base.object.objectId)]);
    }
  });

  it('blocks every descendant of equivocation while retaining origin evidence', async () => {
    const base = baseFixture('equivocation-descendant-base');
    const laneWriter = writer('equivocation-descendant-writer');
    const left = fixture({
      label: 'equivocation-descendant-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
      writerId: laneWriter,
      writerEpoch: 1n,
      sequence: 4n,
    });
    const right = fixture({
      label: 'equivocation-descendant-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"right"'),
      writerId: laneWriter,
      writerEpoch: 1n,
      sequence: 4n,
    });
    const descendant = fixture({
      label: 'equivocation-descendant-tip',
      operation: 'PATCH',
      baseHeads: [left.object.objectId, right.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"descendant"'),
    });
    const core = new ScriptedSemanticCore();
    const value = await replay(core, [descendant.object, right.object, base.object, left.object]);
    expect(value.status).toBe('blocked');
    expect(ids(value.conflictHeads)).toEqual([h(descendant.object.objectId)]);
    expect(ids(value.equivocations[0]!.objectIds))
      .toEqual([h(left.object.objectId), h(right.object.objectId)].sort());
    expect(core.transitions.map(call => h(call.candidate.objectId))).toEqual([h(base.object.objectId)]);
  });

  it('orders multiple equivocation records by writer, epoch, and sequence only', async () => {
    const base = baseFixture('equivocation-order-base');
    const writerA = fixedWriter(0x11);
    const writerB = fixedWriter(0x22);
    const positions = [
      { writerId: writerB, writerEpoch: 1n, sequence: 1n, label: 'writer-b' },
      { writerId: writerA, writerEpoch: 2n, sequence: 1n, label: 'writer-a-epoch-2' },
      { writerId: writerA, writerEpoch: 1n, sequence: 2n, label: 'writer-a-sequence-2' },
      { writerId: writerA, writerEpoch: 1n, sequence: 1n, label: 'writer-a-sequence-1' },
    ];
    const objects = positions.flatMap(position => [0, 1].map(side => fixture({
      label: `equivocation-order-${position.label}-${side}`,
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', `"${position.label}-${side}"`),
      writerId: position.writerId,
      writerEpoch: position.writerEpoch,
      sequence: position.sequence,
    }).object));
    for (const order of [objects, [...objects].reverse()]) {
      const value = await replay(new ScriptedSemanticCore(), [base.object, ...order]);
      expect(value.status).toBe('blocked');
      expect(value.equivocations.map(item => `${h(item.writerId)}:${item.writerEpoch}:${item.sequence}`)).toEqual([
        `${h(writerA)}:1:1`,
        `${h(writerA)}:1:2`,
        `${h(writerA)}:2:1`,
        `${h(writerB)}:1:1`,
      ]);
    }
  });

  it('quarantines a semantic result that disagrees with the signed result digest', async () => {
    const base = baseFixture('bad-result-base');
    const child = fixture({
      label: 'bad-result-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"value"'),
    });
    const core = new ScriptedSemanticCore();
    core.transitionDecisions.set(h(child.object.objectId), { status: 'accepted', state: state('') });
    await expectCode(
      replay(core, [child.object, base.object]),
      'WAL_REPLAY_SEMANTIC_RESULT_MISMATCH',
      'quarantine',
    );
  });

  it('fails closed when the shared core returns a malformed state digest', async () => {
    const malformedInitial: WalReplaySemanticCoreV1<string> = {
      initialState: async () => ({ stateDigest: new Uint8Array(31), projection: '' }),
      evaluateTransition: async () => ({ status: 'rejected', reasonCode: 'unused' }),
      mergeCompatibleBranches: async () => ({ status: 'rejected', reasonCode: 'unused' }),
    };
    await expectCode(
      new WalReplayConflictAdapterV1(malformedInitial).replay({
        namespaceId: NAMESPACE,
        logicalKey: LOGICAL_KEY,
        objects: [],
      }),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );

    const base = baseFixture('malformed-state-base');
    const malformedTransition = new ScriptedSemanticCore();
    malformedTransition.transitionDecisions.set(h(base.object.objectId), {
      status: 'accepted',
      state: { stateDigest: new Uint8Array(31), projection: base.result },
    });
    await expectCode(
      replay(malformedTransition, [base.object]),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );

    const left = fixture({
      label: 'malformed-merge-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'malformed-merge-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"right"'),
    });
    const malformedMerge = new ScriptedSemanticCore();
    const mergeKey = [h(left.object.objectId), h(right.object.objectId)].sort().join(':');
    malformedMerge.mergeDecisions.set(mergeKey, {
      status: 'accepted',
      state: { stateDigest: new Uint8Array(31), projection: '' },
    });
    await expectCode(
      replay(malformedMerge, [base.object, left.object, right.object]),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );
  });

  it('quarantines missing closure, cycles, mixed scope, duplicate IDs, and base digest mismatches', async () => {
    const base = baseFixture('structure-base');
    const child = fixture({
      label: 'structure-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"value"'),
    });
    await expectCode(replay(new ScriptedSemanticCore(), [child.object]), 'WAL_REPLAY_MISSING_PARENT');
    await expectCode(replay(new ScriptedSemanticCore(), [base.object, base.object]), 'WAL_REPLAY_DUPLICATE_OBJECT');
    await expectCode(replay(new ScriptedSemanticCore(), [
      { ...base.object, namespaceId: id('other-namespace') },
    ]), 'WAL_REPLAY_MIXED_SCOPE');

    const leftMutation = [...base.object.mutation] as unknown[];
    leftMutation[3] = [child.object.objectId];
    leftMutation[4] = [child.object.objectId];
    const cycleBase = { ...base.object, mutation: leftMutation as unknown as ProtocolTuple<'DkgMutationV1'> };
    const cycleChildMutation = [...child.object.mutation] as unknown[];
    cycleChildMutation[3] = [cycleBase.objectId];
    cycleChildMutation[4] = [cycleBase.objectId];
    const cycleChild = { ...child.object, mutation: cycleChildMutation as unknown as ProtocolTuple<'DkgMutationV1'> };
    encodeProtocolTuple('DkgMutationV1', cycleBase.mutation);
    encodeProtocolTuple('DkgMutationV1', cycleChild.mutation);
    await expectCode(replay(new ScriptedSemanticCore(), [cycleBase, cycleChild]), 'WAL_REPLAY_CAUSAL_CYCLE');

    const wrongBase = fixture({
      label: 'wrong-base-digest',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: '',
      inserts: line('urn:p:tag', '"value"'),
    });
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, wrongBase.object]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
    );
  });

  it('fails closed on malformed scope, author positions, tuples, reset bases, and ordinary base relations', async () => {
    expect(() => adapter(new ScriptedSemanticCore(), { maximumObjects: 0 }))
      .toThrow(expect.objectContaining({ code: 'WAL_REPLAY_INVALID_CONFIGURATION', disposition: 'blocked' }));
    await expectCode(
      adapter(new ScriptedSemanticCore()).replay({
        namespaceId: new Uint8Array(31),
        logicalKey: LOGICAL_KEY,
        objects: [],
      }),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );

    const base = baseFixture('malformed-base');
    await expectCode(
      replay(new ScriptedSemanticCore(), [{ ...base.object, writerEpoch: -1n }]),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );
    const invalidTuple = [...base.object.mutation] as unknown[];
    invalidTuple[1] = 99n;
    await expectCode(
      replay(new ScriptedSemanticCore(), [{
        ...base.object,
        objectId: id('malformed-tuple'),
        mutation: invalidTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
      }]),
      'WAL_REPLAY_INVALID_OBJECT',
      'quarantine',
    );

    const resetTuple = [...base.object.mutation] as unknown[];
    resetTuple[1] = BigInt(WAL_V1_ENUMS.mutationOperation.SNAPSHOT);
    resetTuple[3] = [base.object.objectId];
    resetTuple[4] = [base.object.objectId];
    const reset = {
      ...base.object,
      objectId: id('malformed-reset'),
      mutation: resetTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', reset.mutation);
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, reset]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
      'quarantine',
    );
    const resetBaseOnlyTuple = [...reset.mutation] as unknown[];
    resetBaseOnlyTuple[3] = [];
    const resetBaseOnly = {
      ...reset,
      objectId: id('malformed-reset-base-only'),
      mutation: resetBaseOnlyTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', resetBaseOnly.mutation);
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, resetBaseOnly]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
      'quarantine',
    );
    const validResetTuple = [...base.object.mutation] as unknown[];
    validResetTuple[1] = BigInt(WAL_V1_ENUMS.mutationOperation.SNAPSHOT);
    const validReset = {
      ...base.object,
      objectId: id('valid-reset'),
      mutation: validResetTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', validReset.mutation);
    await expect(replay(new ScriptedSemanticCore(), [validReset])).resolves.toMatchObject({ status: 'apply' });

    const child = fixture({
      label: 'malformed-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"child"'),
    });
    const mismatchTuple = [...child.object.mutation] as unknown[];
    mismatchTuple[3] = [];
    const mismatch = {
      ...child.object,
      objectId: id('ordinary-base-mismatch'),
      mutation: mismatchTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', mismatch.mutation);
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, mismatch]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
      'quarantine',
    );
  });

  it('rejects non-maximal bases and ordinary advancement over unresolved conflicts', async () => {
    const base = baseFixture('non-max-base');
    const child = fixture({
      label: 'non-max-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"child"'),
    });
    const descendant = fixture({
      label: 'non-max-descendant',
      operation: 'PATCH',
      baseHeads: [child.object.objectId],
      base: child.result,
      inserts: line('urn:p:status', '"descendant"'),
    });
    const nonMaxTuple = [...descendant.object.mutation] as unknown[];
    const nonMaxHeads = [base.object.objectId, child.object.objectId].sort(compareBytes);
    nonMaxTuple[3] = nonMaxHeads;
    nonMaxTuple[4] = nonMaxHeads;
    const nonMax = {
      ...descendant.object,
      objectId: id('non-maximal-base-object'),
      mutation: nonMaxTuple as unknown as ProtocolTuple<'DkgMutationV1'>,
    };
    encodeProtocolTuple('DkgMutationV1', nonMax.mutation);
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, child.object, nonMax]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
      'quarantine',
    );

    const left = fixture({
      label: 'ordinary-conflict-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"left"'),
    });
    const right = fixture({
      label: 'ordinary-conflict-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      deletes: line('urn:p:name', '"old"'),
      inserts: line('urn:p:name', '"right"'),
    });
    const ordinary = fixture({
      label: 'ordinary-over-conflict',
      operation: 'PATCH',
      baseHeads: [left.object.objectId, right.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"invalid"'),
    });
    await expectCode(
      replay(new ScriptedSemanticCore(), [base.object, left.object, right.object, ordinary.object]),
      'WAL_REPLAY_CAUSAL_BASE_MISMATCH',
      'quarantine',
    );
  });

  it('enforces every replay resource bound with stable blocked outcomes', async () => {
    const base = baseFixture('limit-base');
    const child = fixture({
      label: 'limit-child',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: `${line('urn:p:tag', '"value"')}\n${line('urn:p:status', '"ready"')}\n`,
    });
    const run = (limits: ConstructorParameters<typeof WalReplayConflictAdapterV1<string>>[1]) =>
      adapter(new ScriptedSemanticCore(), limits).replay({
        namespaceId: NAMESPACE,
        logicalKey: LOGICAL_KEY,
        objects: [base.object, child.object],
      });
    await expectCode(run({ maximumObjects: 1 }), 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');
    await expectCode(run({ maximumCausalDepth: 1 }), 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');
    await expectCode(run({ maximumTouchedKeysPerMutation: 1 }), 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');

    const left = fixture({
      label: 'limit-left',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"left"'),
    });
    const right = fixture({
      label: 'limit-right',
      operation: 'PATCH',
      baseHeads: [base.object.objectId],
      base: base.result,
      inserts: line('urn:p:tag', '"right"'),
    });
    const conflictLimited = adapter(new ScriptedSemanticCore(), { maximumConflictHeads: 1 }).replay({
      namespaceId: NAMESPACE,
      logicalKey: LOGICAL_KEY,
      objects: [base.object, left.object, right.object],
    });
    await expectCode(conflictLimited, 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');
    const workLimited = adapter(new ScriptedSemanticCore(), { maximumRecomputationWork: 1 }).replay({
      namespaceId: NAMESPACE,
      logicalKey: LOGICAL_KEY,
      objects: [base.object, left.object, right.object],
    });
    await expectCode(workLimited, 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');

    const multiBase = fixture({
      label: 'limit-parents',
      operation: 'RESOLVE',
      baseHeads: [left.object.objectId, right.object.objectId],
      base: base.result,
      inserts: line('urn:p:status', '"resolved"'),
      writerId: AUTHOR,
      sequence: 3n,
    });
    const parentLimited = adapter(new ScriptedSemanticCore(), { maximumParentsPerMutation: 1 }).replay({
      namespaceId: NAMESPACE,
      logicalKey: LOGICAL_KEY,
      objects: [base.object, left.object, right.object, multiBase.object],
    });
    await expectCode(parentLimited, 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');
    const frontierLimited = adapter(new ScriptedSemanticCore(), { maximumConflictHeads: 1 }).replay({
      namespaceId: NAMESPACE,
      logicalKey: LOGICAL_KEY,
      objects: [base.object, left.object, right.object, multiBase.object],
    });
    await expectCode(frontierLimited, 'WAL_REPLAY_RESOURCE_LIMIT', 'blocked');
  });

  it('contains no provider/wall-clock input and no alternate semantic implementation surface', () => {
    const replayRoot = resolve(packageRoot, 'src/replay');
    const files = sourceFiles(replayRoot);
    const source = files.map(path => readFileSync(path, 'utf8')).join('\n');
    expect(source).not.toMatch(/providerPeerId|arrivalTime|wallClock|Date\.now/);
    expect(source).not.toMatch(/class\s+.*(?:Reducer|SemanticEngine)|function\s+.*(?:reduceDkg|evaluateDkg)/i);
    expect(source).not.toMatch(/from ['"].*packages\/agent|@origintrail-official\/dkg-agent/);
  });
});

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function chainBinding(blockNumber: number): ProtocolTuple<'ChainBindingV1'> {
  return [
    2043n,
    id('chain-context'),
    id('chain-ka'),
    1n,
    id('chain-root'),
    id(`chain-tx-${blockNumber}`),
    BigInt(blockNumber),
    id(`chain-block-${blockNumber}`),
    0n,
    0n,
    1n,
    64n,
  ];
}

function withHeads(
  mutation: ProtocolTuple<'DkgMutationV1'>,
  heads: readonly Uint8Array[],
): ProtocolTuple<'DkgMutationV1'> {
  const tuple = [...mutation] as unknown[];
  const sorted = [...heads].sort(compareBytes);
  tuple[3] = sorted;
  tuple[4] = sorted;
  const value = tuple as unknown as ProtocolTuple<'DkgMutationV1'>;
  encodeProtocolTuple('DkgMutationV1', value);
  return value;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }).map(path => relative(packageRoot, path)).map(path => resolve(packageRoot, path));
}
