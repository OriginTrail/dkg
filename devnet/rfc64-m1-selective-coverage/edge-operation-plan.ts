import {
  type EdgeSyncOperationV1,
  type GraphSnapshotExpectationV1,
  type SelectiveCoverageCorpusV1,
} from './manifest.ts';

export type EdgeOperationPhaseV1 = EdgeSyncOperationV1['phase'];
export type EdgeSnapshotSelectorV1 = 'selectedSnapshot' | 'finalSnapshot';

export interface EdgeOperationPlanStepV1<
  Phase extends EdgeOperationPhaseV1 = EdgeOperationPhaseV1,
> {
  readonly sequence: number;
  readonly phase: Phase;
  readonly source: EdgeSyncOperationV1['source'];
  readonly syncMode: EdgeSyncOperationV1['syncMode'];
  readonly contextGraphId: string;
  readonly completedWave: EdgeSyncOperationV1['completedWave'];
  readonly snapshotSelector: EdgeSnapshotSelectorV1;
  readonly completedSnapshot: GraphSnapshotExpectationV1;
}

export interface EdgeOperationPlanV1 {
  readonly ordered: readonly EdgeOperationPlanStepV1[];
  readonly selection: readonly EdgeOperationPlanStepV1<'selection'>[];
  readonly postRestartAutomatic: readonly EdgeOperationPlanStepV1<'post-restart-auto'>[];
  readonly postRestartExplicit: readonly EdgeOperationPlanStepV1<'post-restart-explicit'>[];
}

/**
 * Derive the one canonical Edge state-machine plan from the anchored corpus.
 *
 * Corpus order is preserved within each phase. The collector executes these
 * phase slices, while the verifier compares evidence against `ordered`, so a
 * new phase or policy branch cannot silently drift between the two.
 */
export function buildEdgeOperationPlan(
  corpus: SelectiveCoverageCorpusV1,
): EdgeOperationPlanV1 {
  const selection: EdgeOperationPlanStepV1<'selection'>[] = [];
  const postRestartAutomatic: EdgeOperationPlanStepV1<'post-restart-auto'>[] = [];
  const postRestartExplicit: EdgeOperationPlanStepV1<'post-restart-explicit'>[] = [];

  for (const graph of corpus.graphs) {
    if (graph.accessPolicy !== 0 || graph.edgePolicy === 'unselected') continue;
    selection.push({
      sequence: selection.length,
      phase: 'selection',
      source: 'user',
      syncMode: graph.edgePolicy,
      contextGraphId: graph.contextGraphId,
      completedWave: 'selected',
      snapshotSelector: 'selectedSnapshot',
      completedSnapshot: graph.selectedSnapshot,
    });
  }

  for (const graph of corpus.graphs) {
    if (graph.accessPolicy === 0 && graph.edgePolicy === 'always-on') {
      postRestartAutomatic.push({
        sequence: selection.length + postRestartAutomatic.length,
        phase: 'post-restart-auto',
        source: 'reconciler',
        syncMode: 'always-on',
        contextGraphId: graph.contextGraphId,
        completedWave: 'final',
        snapshotSelector: 'finalSnapshot',
        completedSnapshot: graph.finalSnapshot,
      });
    }
  }

  for (const graph of corpus.graphs) {
    if (graph.accessPolicy === 0 && graph.edgePolicy === 'on-demand') {
      postRestartExplicit.push({
        sequence: selection.length
          + postRestartAutomatic.length
          + postRestartExplicit.length,
        phase: 'post-restart-explicit',
        source: 'user',
        syncMode: 'on-demand',
        contextGraphId: graph.contextGraphId,
        completedWave: 'final',
        snapshotSelector: 'finalSnapshot',
        completedSnapshot: graph.finalSnapshot,
      });
    }
  }

  const frozenSelection = freezeSteps(selection);
  const frozenAutomatic = freezeSteps(postRestartAutomatic);
  const frozenExplicit = freezeSteps(postRestartExplicit);
  return Object.freeze({
    ordered: Object.freeze([
      ...frozenSelection,
      ...frozenAutomatic,
      ...frozenExplicit,
    ]),
    selection: frozenSelection,
    postRestartAutomatic: frozenAutomatic,
    postRestartExplicit: frozenExplicit,
  });
}

/** Compare an observed operation to a plan step, excluding its runtime job ID. */
export function matchesEdgeOperationPlanStep(
  operation: EdgeSyncOperationV1 | undefined,
  step: EdgeOperationPlanStepV1,
): boolean {
  return operation?.sequence === step.sequence
    && operation.phase === step.phase
    && operation.source === step.source
    && operation.syncMode === step.syncMode
    && operation.contextGraphId === step.contextGraphId
    && operation.completedWave === step.completedWave
    && exactSnapshot(operation.completedSnapshot, step.completedSnapshot);
}

export function findEdgeOperationPlanStep(
  plan: EdgeOperationPlanV1,
  contextGraphId: string,
  phase: EdgeOperationPhaseV1,
): EdgeOperationPlanStepV1 | undefined {
  return plan.ordered.find((step) =>
    step.contextGraphId === contextGraphId && step.phase === phase);
}

function freezeSteps<Phase extends EdgeOperationPhaseV1>(
  steps: readonly EdgeOperationPlanStepV1<Phase>[],
): readonly EdgeOperationPlanStepV1<Phase>[] {
  return Object.freeze(steps.map((step) => Object.freeze(step)));
}

function exactSnapshot(
  left: GraphSnapshotExpectationV1,
  right: GraphSnapshotExpectationV1,
): boolean {
  return exactPlane(left.vm, right.vm) && exactPlane(left.swm, right.swm);
}

function exactPlane(
  left: GraphSnapshotExpectationV1['vm'],
  right: GraphSnapshotExpectationV1['vm'],
): boolean {
  return left.headDigest === right.headDigest
    && left.inventoryDigest === right.inventoryDigest
    && left.assetCount === right.assetCount
    && left.dataTripleCount === right.dataTripleCount;
}
