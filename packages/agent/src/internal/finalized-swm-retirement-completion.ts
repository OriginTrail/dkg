import { setTimeout as delay } from 'node:timers/promises';
export interface VerifiedVmMarkerRetirementEvidence {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly assertionVersion: bigint;
}

/** Every arrival shares the same conservative failure and bounded retry rule. */
export async function completeVerifiedVmMarkerRetirement(params: {
  readonly evidence: VerifiedVmMarkerRetirementEvidence;
  readonly retireMarker: (input: VerifiedVmMarkerRetirementEvidence) => Promise<void>;
  readonly warn: (message: string) => void;
  readonly scheduleRetry: (key: string, work: (signal: AbortSignal) => Promise<void>) => boolean;
}): Promise<void> {
  const evidence = Object.freeze({
    contextGraphId: params.evidence.contextGraphId,
    kaUal: params.evidence.kaUal,
    assertionVersion: params.evidence.assertionVersion,
    subGraphName: params.evidence.subGraphName,
  });
  const attempt = async (): Promise<boolean> => {
    try {
      await params.retireMarker(evidence);
      return true;
    } catch (cause) {
      try {
        params.warn(`Deferred legacy SWM boundary retirement after finalized VM twin cleanup for `
          + `${evidence.kaUal}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } catch { /* Diagnostics cannot change a successful physical cleanup. */ }
      return false;
    }
  };
  if (!await attempt()) {
    const key = JSON.stringify(['finalized-swm-marker', evidence.contextGraphId,
      evidence.subGraphName ?? null, evidence.kaUal, String(evidence.assertionVersion)]);
    params.scheduleRetry(key, async (signal) => {
      for (const delayMs of [250, 1_000, 5_000]) {
        await delay(delayMs, undefined, { signal, ref: false });
        signal.throwIfAborted();
        if (await attempt()) return;
      }
    });
  }
  // A marker failure never resurrects a physically retired twin or changes
  // the arrival path's outcome. Later arrivals also retry an already-retired twin.
}
