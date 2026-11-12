import { describe, expect, it } from 'vitest';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import {
  MemoryLayer, SEMANTICS_UNSUPPORTED_CODE, TrustLevel, VIEW_NOT_READY_CODE, readGraphIri, readScope,
  type ReadGraphKey,
} from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS, workingMemoryIdentityRule, type ReadGraphState, type ReadGraphStateRow,
} from '@origintrail-official/dkg-storage';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';
import {
  SemanticsUnsupportedError, VIEW_NOT_READY_RETRY_AFTER_SECONDS, ViewNotReadyError,
  assertNoMergedSemanticsWithoutView, isViewDatasetPlanCurrent, mergedViewDatasetPlan, planViewDataset, requestedViewSemantics,
  withMergedViewDataset, type MergedViewDatasetPlan, type ViewReadGraphs,
} from '../src/view-dataset-plan.js';

const CG = 'plan-cg';
const DEFAULT_AGENT = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const PEER_ID = '12D3KooWExamplePeer';
const VM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });

function row(readGraph: string, state: ReadGraphState = 'ready', generation = 7,
  versions: Partial<Pick<ReadGraphStateRow, 'ruleVersion' | 'builderVersion'>> = {}): ReadGraphStateRow {
  return { readGraph, state, generation, ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion,
    builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion, ...versions };
}

function readGraphs(rows: readonly ReadGraphStateRow[], options: {
  keeps?: (key: ReadGraphKey) => boolean; serves?: (key: ReadGraphKey) => boolean;
  defaultSemantics?: ViewReadGraphs['defaultSemantics'];
} = {}): ViewReadGraphs & { kept: ReadGraphKey[] } {
  const kept: ReadGraphKey[] = [];
  const byGraph = new Map(rows.map(entry => [entry.readGraph, entry]));
  return {
    kept,
    keeps: (key) => { kept.push(key); return options.keeps?.(key) ?? true; },
    state: (readGraph) => byGraph.get(readGraph),
    identity: workingMemoryIdentityRule({ defaultAgentAddress: DEFAULT_AGENT, peerId: PEER_ID }),
    defaultSemantics: options.defaultSemantics,
    ...(options.serves ? { serves: options.serves } : {}),
  };
}

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('the semantics a request asks for', () => {
  it('accepts merged and per-asset, and refuses anything else', () => {
    expect(requestedViewSemantics(undefined)).toBeUndefined();
    expect(requestedViewSemantics({ semantics: 'merged' })).toBe('merged');
    expect(requestedViewSemantics({ semantics: 'per-asset' })).toBe('per-asset');
    for (const value of ['MERGED', 'any', 1, null]) {
      expect(() => requestedViewSemantics({ semantics: value as never })).toThrow(ScopedQueryViolationError);
    }
  });

  it('refuses merged on a query without a view', () => {
    const error = refusal(() => assertNoMergedSemanticsWithoutView({ contextGraphId: CG, semantics: 'merged' }));
    expect(error).toBeInstanceOf(SemanticsUnsupportedError);
    expect(error).toMatchObject({ code: SEMANTICS_UNSUPPORTED_CODE, message: 'semantics "merged" does not apply to a query without a view' });
    expect(() => assertNoMergedSemanticsWithoutView({ contextGraphId: CG, semantics: 'per-asset' })).not.toThrow();
    expect(() => assertNoMergedSemanticsWithoutView(undefined)).not.toThrow();
  });
});

describe('planning a view query', () => {
  it('answers per asset without semantics, unless the node defaults the context graph to merged', () => {
    expect(planViewDataset('verifiable-memory', CG, {}, undefined)).toEqual({ kind: 'per-asset' });
    expect(planViewDataset('verifiable-memory', CG, {}, readGraphs([row(VM)]))).toEqual({ kind: 'per-asset' });
    const merged = readGraphs([row(VM)], { defaultSemantics: (id) => (id === CG ? 'merged' : 'per-asset') });
    expect(planViewDataset('verifiable-memory', CG, {}, merged)).toEqual({ kind: 'merged', readGraph: VM, generation: 7 });
    expect(planViewDataset('verifiable-memory', CG, { semantics: 'per-asset' }, merged)).toEqual({ kind: 'per-asset' });
  });

  it('names the read graph of the scope and layer: whole context graph, sub-graph, and each view', () => {
    const swmSub = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.SharedWorkingMemory });
    const source = readGraphs([row(VM, 'ready', 3), row(swmSub, 'ready', 11)]);
    expect(planViewDataset('verifiable-memory', CG, { semantics: 'merged' }, source))
      .toEqual({ kind: 'merged', readGraph: VM, generation: 3 });
    expect(planViewDataset('shared-working-memory', CG, { semantics: 'merged', subGraphName: 'code' }, source))
      .toEqual({ kind: 'merged', readGraph: swmSub, generation: 11 });
    expect(source.kept).toEqual([
      { scope: readScope(CG), layer: MemoryLayer.VerifiableMemory },
      { scope: readScope(CG, 'code'), layer: MemoryLayer.SharedWorkingMemory },
    ]);
  });

  it('keys working memory by the agent that owns the address, the default agent for its peer ID', () => {
    const owner = DEFAULT_AGENT.toLowerCase();
    const wm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: owner });
    const source = readGraphs([row(wm, 'ready', 5)]);
    for (const agentAddress of [PEER_ID, DEFAULT_AGENT, owner]) {
      expect(planViewDataset('working-memory', CG, { semantics: 'merged', agentAddress }, source))
        .toEqual({ kind: 'merged', readGraph: wm, generation: 5 });
    }
  });

  it.each([
    ['a working-memory read by assertion name', 'working-memory', { agentAddress: DEFAULT_AGENT, assertionName: 'draft' }],
    ['a read of one verified graph', 'verifiable-memory', { verifiedGraph: 'did:dkg:context-graph:plan-cg/_verifiable_memory/0xaa/1' }],
    ['minTrust above SelfAttested', 'verifiable-memory', { minTrust: TrustLevel.Endorsed }],
    ['minTrust above SelfAttested', 'verifiable-memory', { _minTrust: TrustLevel.ConsensusVerified }],
    ['includePrivate', 'shared-working-memory', { includePrivate: true }],
    ['graphSuffix or includeSharedMemory', 'verifiable-memory', { includeSharedMemory: true }],
    ['graphSuffix or includeSharedMemory', 'verifiable-memory', { graphSuffix: '_shared_memory' as const }],
    ['this scope on this node', 'working-memory', {}],
    ['this scope on this node', 'working-memory', { agentAddress: '../escape' }],
  ] as const)('does not apply merged to %s', (what, view, extra) => {
    const source = readGraphs([row(VM)]);
    const error = refusal(() => planViewDataset(view, CG, { semantics: 'merged', ...extra }, source));
    expect(error).toBeInstanceOf(SemanticsUnsupportedError);
    expect(error).toMatchObject({ code: SEMANTICS_UNSUPPORTED_CODE, message: `semantics "merged" does not apply to ${what}` });
    // A request that did not ask is answered per asset.
    const defaulted = readGraphs([row(VM)], { defaultSemantics: () => 'merged' });
    expect(planViewDataset(view, CG, { ...extra }, defaulted)).toEqual({ kind: 'per-asset' });
  });

  it('refuses a malformed minTrust on verifiable memory, as the per-asset route does', () => {
    for (const minTrust of ['Endorsed', Number.NaN, 1.5, 7]) {
      for (const source of [readGraphs([row(VM)]), readGraphs([row(VM)], { defaultSemantics: () => 'merged' })]) {
        for (const options of [{ semantics: 'merged' as const, minTrust }, { _minTrust: minTrust }]) {
          if (source.defaultSemantics === undefined && !('semantics' in options)) continue;
          expect(() => planViewDataset('verifiable-memory', CG, options as never, source)).toThrow(/^Invalid minTrust .* must be one of/);
        }
      }
    }
  });

  it('applies merged where minTrust is the floor, or belongs to another view', () => {
    const swm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory });
    const source = readGraphs([row(VM), row(swm)]);
    expect(planViewDataset('verifiable-memory', CG, { semantics: 'merged', minTrust: TrustLevel.SelfAttested }, source).kind).toBe('merged');
    expect(planViewDataset('shared-working-memory', CG, { semantics: 'merged', minTrust: TrustLevel.Endorsed }, source).kind).toBe('merged');
  });

  it.each([
    ['a node that keeps no read graphs', CG, undefined],
    ['a scope whose read graphs are off', CG, readGraphs([row(VM)], { keeps: () => false })],
    ['a context graph that cannot have read graphs', 'legacy/_old', readGraphs([])],
  ] as const)('refuses an explicit merged on %s', (_label, contextGraphId, source) => {
    expect(refusal(() => planViewDataset('verifiable-memory', contextGraphId, { semantics: 'merged' }, source)))
      .toMatchObject({ code: SEMANTICS_UNSUPPORTED_CODE, message: 'semantics "merged" does not apply to this scope on this node' });
  });

  it('answers requests merged only from a read graph the node serves, when it says which', () => {
    const kept = readGraphs([row(VM)], { serves: () => false, defaultSemantics: () => 'merged' });
    expect(refusal(() => planViewDataset('verifiable-memory', CG, { semantics: 'merged' }, kept)))
      .toMatchObject({ code: SEMANTICS_UNSUPPORTED_CODE, message: 'semantics "merged" does not apply to this scope on this node' });
    expect(planViewDataset('verifiable-memory', CG, {}, kept)).toEqual({ kind: 'per-asset' });
    const served = readGraphs([row(VM)], { serves: () => true });
    expect(planViewDataset('verifiable-memory', CG, { semantics: 'merged' }, served)).toEqual({ kind: 'merged', readGraph: VM, generation: 7 });
  });

  it('answers 503 for an explicit merged without a state row, and a default per asset', () => {
    const source = readGraphs([], { defaultSemantics: () => 'merged' });
    expect(refusal(() => planViewDataset('verifiable-memory', CG, { semantics: 'merged' }, source)))
      .toMatchObject({ code: VIEW_NOT_READY_CODE, retryAfterSeconds: VIEW_NOT_READY_RETRY_AFTER_SECONDS });
    expect(planViewDataset('verifiable-memory', CG, {}, source)).toEqual({ kind: 'per-asset' });
  });

  it.each([
    ['while building', [row(VM, 'building')]],
    ['while dirty', [row(VM, 'dirty')]],
    ['while repairing', [row(VM, 'repairing')]],
    ['while rebuilding', [row(VM, 'rebuilding')]],
    ['when built under another membership rule', [row(VM, 'ready', 7, { ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion + 1 })]],
    ['when built by a builder this release does not accept', [row(VM, 'ready', 7, { builderVersion: 999 })]],
  ] as const)('answers 503 for a read graph that is not ready: %s', (_label, rows) => {
    for (const options of [{ semantics: 'merged' as const }, {}]) {
      const source = readGraphs(rows, { defaultSemantics: () => 'merged' });
      const error = refusal(() => planViewDataset('verifiable-memory', CG, options, source));
      expect(error).toBeInstanceOf(ViewNotReadyError);
      expect(error).toMatchObject({ code: VIEW_NOT_READY_CODE, retryable: true, retryAfterSeconds: VIEW_NOT_READY_RETRY_AFTER_SECONDS });
      expect((error as ViewNotReadyError).hint).toContain('per-asset');
    }
  });
});

describe('the merged plan of a sample', () => {
  const plan: MergedViewDatasetPlan = { kind: 'merged', readGraph: VM, generation: 7 };

  it('names the read graph whatever the query asked for, also where requests are not answered merged yet', () => {
    for (const source of [readGraphs([row(VM)]), readGraphs([row(VM)], { serves: () => false })]) {
      for (const semantics of [undefined, 'per-asset', 'merged'] as const) {
        expect(mergedViewDatasetPlan('verifiable-memory', CG, { semantics }, source)).toEqual(plan);
      }
    }
  });

  it('has none where merged does not apply or the read graph is not ready, and never throws', () => {
    expect(mergedViewDatasetPlan('verifiable-memory', CG, {}, undefined)).toBeUndefined();
    expect(mergedViewDatasetPlan('verifiable-memory', CG, {}, readGraphs([row(VM)], { keeps: () => false }))).toBeUndefined();
    expect(mergedViewDatasetPlan('verifiable-memory', CG, {}, readGraphs([row(VM, 'dirty')]))).toBeUndefined();
    expect(mergedViewDatasetPlan('verifiable-memory', CG, { minTrust: TrustLevel.Endorsed }, readGraphs([row(VM)]))).toBeUndefined();
    expect(mergedViewDatasetPlan('verifiable-memory', CG, { minTrust: 'Endorsed' as never }, readGraphs([row(VM)]))).toBeUndefined();
  });
});

describe('the check after the read', () => {
  const plan: MergedViewDatasetPlan = { kind: 'merged', readGraph: VM, generation: 7 };

  it('holds only while the read graph is ready at the planned generation', () => {
    expect(isViewDatasetPlanCurrent(plan, readGraphs([row(VM, 'ready', 7)]))).toBe(true);
    expect(isViewDatasetPlanCurrent(plan, readGraphs([row(VM, 'ready', 8)]))).toBe(false);
    expect(isViewDatasetPlanCurrent(plan, readGraphs([row(VM, 'dirty', 7)]))).toBe(false);
    expect(isViewDatasetPlanCurrent(plan, readGraphs([]))).toBe(false);
  });
});

describe('the dataset of a merged query', () => {
  const scope = (source: string) => {
    const prepared = prepareSparql(source);
    if (prepared.status !== 'valid') throw new Error('Expected valid test input');
    return prepareGraphScope(prepared);
  };

  it('sets the read graph as the default graph, and named graphs only when given', () => {
    expect(withMergedViewDataset(scope('SELECT ?s WHERE { ?s ?p ?o }'), VM, []).source)
      .toBe(`SELECT ?s FROM <${VM}> WHERE { ?s ?p ?o }`);
    const withNamed = withMergedViewDataset(scope('SELECT ?g WHERE { ?s ?p ?o GRAPH ?g { ?s ?q ?x } }'), VM, ['urn:g:1', 'urn:g:2']);
    expect(withNamed.source).toContain(`FROM <${VM}>`);
    expect(withNamed.source).toContain('FROM NAMED <urn:g:1> FROM NAMED <urn:g:2>');
    expect(withNamed.hasDatasetClause).toBe(true);
  });
});
