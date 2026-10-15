import type { LiftJob, PersistedLiftJob } from './lift-job.js';
import { StaleLiftJobClaimError, type ActiveLiftJobClaim, type ActiveLiftJobClaimSession } from './async-lift-publisher-types.js';
import type { AsyncLiftClaimProcessingOutcome, AsyncLiftClaimProcessingRelease } from './async-lift-claim-session.js';
import type { AsyncLiftJournalCompletion } from './async-lift-journal-completion.js';

/** Processing ownership extends through its awaited journal tail, independently of lock ownership. */
export async function processLiftClaim(input: {
  completion: AsyncLiftJournalCompletion;
  acquire(): Promise<ActiveLiftJobClaim | null>;
  open(claim: ActiveLiftJobClaim): ActiveLiftJobClaimSession;
  handle(session: ActiveLiftJobClaimSession): Promise<LiftJob>;
  read(jobId: string): Promise<PersistedLiftJob | null>;
  matches(job: PersistedLiftJob, claim: ActiveLiftJobClaim): boolean;
  recover(claim: ActiveLiftJobClaim): Promise<PersistedLiftJob | null>;
  activeTokens: Map<string, string>;
  released?: (release: AsyncLiftClaimProcessingRelease) => void;
}): Promise<AsyncLiftClaimProcessingOutcome> {
  let claim: ActiveLiftJobClaim | null = null;
  let outcome: AsyncLiftClaimProcessingOutcome | undefined;
  let release: AsyncLiftClaimProcessingRelease = { kind: 'faulted' };
  let recover = false;
  try {
    await input.completion.runOperation(async () => {
      claim = await input.acquire();
      if (!claim) return;
      try {
        const job = await input.handle(input.open(claim));
        outcome = { kind: 'processed', job };
        release = outcome;
      } catch (error) {
        if (!(error instanceof StaleLiftJobClaimError)) throw error;
        const current = await input.read(claim.jobId);
        if (current && !input.matches(current, claim)) {
          outcome = { kind: 'replaced', job: current };
          release = outcome;
        } else {
          recover = true;
          release = { kind: 'stale' };
        }
      }
    }, true); // Each worker lifecycle owns its completion, including a reentrant processNext.
  } finally {
    // Callback assignment survives await but is not tracked by TypeScript's local flow analysis.
    const acquired = claim as ActiveLiftJobClaim | null;
    if (acquired) {
      if (input.activeTokens.get(acquired.jobId) === acquired.claim.claimToken) input.activeTokens.delete(acquired.jobId);
      try { input.released?.(release); } catch { /* Scheduling cannot change cleanup or outcomes. */ }
    }
  }
  if (!claim) return { kind: 'idle' };
  if (recover) return { kind: 'recovered', job: await input.completion.runOperation(() => input.recover(claim!), true) };
  if (!outcome) throw new Error('Claim processing completed without an outcome');
  return outcome;
}
