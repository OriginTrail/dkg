// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — how a queued executor tells its queue where the time after the confirmation of its
 * transaction went. Observation only: the queue hands the executor an observer on its execution
 * input, the executor calls it as it ends each step it runs, and the queue's timing line splits
 * the executor's tail at those reports.
 */

/**
 * What a queued executor does between the confirmation of its transaction and its return, in the
 * order it does it. The executor reports the end of each step it runs:
 *
 * - `publish`: the publish or update call returned, its own post-receipt work included;
 * - `receiptWrite`: the publish receipt was written;
 * - `publishedGraphClear`: the published asset's shared-memory graph was cleared;
 * - `legacySwmRetire`: the legacy shared-memory copy of the asset was retired;
 * - `remainingSwmClear`: the rest of shared memory was cleared, when the request asked for it;
 * - `lifecycleStamp`: the lifecycle record was stamped (for an update, its provenance too);
 * - `graphIdRead`: the on-chain id of the context graph was read for the announcement;
 * - `finalizationGossip`: the finalization was announced to the graph's topic;
 * - `shareMarkerClear`: the share-complete marker was cleared;
 * - `catalogObserver`: the post-confirmation catalog observer returned.
 */
export const LIFT_JOB_TAIL_STEPS = [
  'publish',
  'receiptWrite',
  'publishedGraphClear',
  'legacySwmRetire',
  'remainingSwmClear',
  'lifecycleStamp',
  'graphIdRead',
  'finalizationGossip',
  'shareMarkerClear',
  'catalogObserver',
] as const;
export type LiftJobTailStep = typeof LIFT_JOB_TAIL_STEPS[number];

/**
 * How an executor reports that a step just ended. It carries the step's name and nothing else, is
 * synchronous and never awaited, and its failure can never affect the publish: the executor
 * contains a throw.
 */
export type LiftJobTailStepObserver = (step: LiftJobTailStep) => void;
