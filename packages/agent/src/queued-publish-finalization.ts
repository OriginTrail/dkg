import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { LiftJobTailStep } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from './dkg-agent.js';

/** The local confirmed publisher has already written VM and drained this exact SWM root. */
export async function retireLegacySwmAfterConfirmedLocalPublish(
  agent: DKGAgent,
  log: Pick<Logger, 'warn'>,
  contextGraphId: string,
  kaUal: string,
  assertionVersion: string,
  subGraphName: string | undefined,
  ctx: OperationContext,
): Promise<boolean> {
  try {
    await agent.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId,
      kaUal,
      assertionVersion,
      subGraphName,
    });
    return true;
  } catch (err) {
    log.warn(
      ctx,
      `Failed to retire the legacy SWM boundary after confirmed local VM publish: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

type RequiredFinalizationStep =
  | 'receiptWrite' | 'publishedGraphClear' | 'legacySwmRetire' | 'remainingSwmClear'
  | 'updateProvenance' | 'lifecycleStamp' | 'shareMarkerClear';
type StepOutcome = 'complete' | 'incomplete' | 'failed' | 'not-required';

interface QueuedPublishFinalizationPhase {
  confirmed: boolean;
  hasChainResult: boolean;
  receiptWrite(): Promise<void>;
  publishedGraphClear(): Promise<boolean>;
  legacySwmRetire(): Promise<boolean>;
  remainingSwmClear?: () => Promise<void>;
  updateProvenance?: () => Promise<void>;
  lifecycleStamp(): Promise<void>;
  /** Keeps its existing best-effort network handling; prerequisite failures still propagate. */
  finalizationGossip(): Promise<void>;
  shareMarkerClear(): Promise<void>;
  /** Records the durable placement obligation; does not await catalog placement. */
  catalogObserver(): Promise<boolean>;
  ended(step: LiftJobTailStep): void;
  failed(step: RequiredFinalizationStep, error: unknown): void;
}

/** A successful void write has completed; boolean cleanup callbacks keep their own verdict. */
function completedWrite(write: () => Promise<void>): () => Promise<boolean> {
  return async () => {
    await write();
    return true;
  };
}

/**
 * One ordered phase for both create and update. Required outcomes are collected locally,
 * rather than mutating a certificate across transaction preparation and two branch tails.
 * A caught local failure keeps running the remaining tail but leaves recovery responsible.
 */
export async function finalizeQueuedKnowledgeAssetVmPublish(
  phase: QueuedPublishFinalizationPhase,
): Promise<true | undefined> {
  const required = async (
    step: RequiredFinalizationStep,
    run: () => Promise<boolean>,
  ): Promise<StepOutcome> => {
    try {
      return await run() === true ? 'complete' : 'incomplete';
    } catch (error) {
      phase.failed(step, error);
      return 'failed';
    } finally {
      // Provenance has historically been part of the update tail without its own observation.
      if (step !== 'updateProvenance') phase.ended(step);
    }
  };

  const outcomes: StepOutcome[] = [];
  if (phase.confirmed) {
    outcomes.push(phase.hasChainResult
      ? await required('receiptWrite', completedWrite(phase.receiptWrite)) : 'not-required');
    const cleared = await required('publishedGraphClear', phase.publishedGraphClear);
    outcomes.push(cleared);
    // A thrown clear skips retirement, but an incomplete clear still attempts it, as before.
    if (cleared !== 'failed') outcomes.push(await required('legacySwmRetire', phase.legacySwmRetire));
    outcomes.push(phase.remainingSwmClear
      ? await required('remainingSwmClear', completedWrite(phase.remainingSwmClear)) : 'not-required');
    outcomes.push(phase.updateProvenance
      ? await required('updateProvenance', completedWrite(phase.updateProvenance)) : 'not-required');
    outcomes.push(await required('lifecycleStamp', completedWrite(phase.lifecycleStamp)));
    if (phase.hasChainResult) await phase.finalizationGossip();
    outcomes.push(await required('shareMarkerClear', completedWrite(phase.shareMarkerClear)));
  }
  const catalogCompletionRecorded = await phase.catalogObserver();
  phase.ended('catalogObserver');
  return phase.confirmed && phase.hasChainResult && catalogCompletionRecorded === true
    && outcomes.every((outcome) => outcome === 'complete' || outcome === 'not-required')
    ? true : undefined;
}
