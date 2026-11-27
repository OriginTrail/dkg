// What a batch publish to Verifiable Memory came to, as one outcome line. The assertion
// list and the Verifiable Memory widget both publish through publishAssertionsToVm, and
// both say what happened from here, so the warning rules live in one place.
import { outcomeUnknownPublishNote, partialPublishWarning, type BatchPublishResult } from '../api.js';
import { succeededWithWarning, type ActionOutcome } from './actionOutcome.js';

export interface PublishOutcomeOptions {
  /** How the failure count names what failed: "2 could not be published", or with a noun, "2 assertions could not be published". */
  failedNoun?: string;
}

/**
 * The outcome of a batch publish. Something published is a success, or a warning when part
 * of it only minted on-chain (a 207 partial) or its on-chain outcome is unknown. Nothing
 * published but an unknown outcome is a warning too. Anything else is a failure, thrown as
 * an Error with the first failure's message, so the caller's error path shows it.
 */
export function publishOutcome(r: BatchPublishResult, { failedNoun }: PublishOutcomeOptions = {}): ActionOutcome {
  const unknownNote = outcomeUnknownPublishNote(r);
  const unknownTail = unknownNote ? ` — ${unknownNote}` : '';
  if (r.published > 0) {
    const n = r.failures.length;
    const what = failedNoun ? ` ${failedNoun}${n === 1 ? '' : 's'}` : '';
    const tail = n ? ` (${n}${what} could not be published)` : '';
    const partialTail = r.partial > 0 ? ` — ${r.partial}: ${partialPublishWarning(r.partialError)}` : '';
    return succeededWithWarning(
      `Published ${r.published} knowledge asset${r.published !== 1 ? 's' : ''} to Verifiable Memory${tail}${partialTail}${unknownTail}`,
      r.partial > 0 || Boolean(unknownNote),
    );
  }
  if (unknownNote && r.failures.length === 0) return succeededWithWarning(unknownNote, true);
  throw new Error(`${r.failures[0] ? `${r.failures[0].name}: ${r.failures[0].error}` : 'Publish failed'}${unknownTail}`);
}
