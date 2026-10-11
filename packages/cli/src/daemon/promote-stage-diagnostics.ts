// SPDX-License-Identifier: Apache-2.0

import { isPromoteStepName, type PromoteStepName } from '@origintrail-official/dkg-publisher';

/**
 * Reading the `[promote:<stage>]` tag the publisher puts on a failed promote.
 * One home for every daemon consumer of that tag: the async worker's attempt
 * log, its error classifier, and the synchronous route answers.
 *
 * A promote STAGE is by construction a producer-owned literal — it only exists
 * as an argument the publisher passes to `tagPromoteStep` — so the publisher
 * owns that set and the CLI narrows through its `isPromoteStepName` predicate;
 * a second copy here could only ever drift.
 */
const PROMOTE_STEP_TAG = /^\[promote:([^\]]*)\]\s*/;

/** The message without its leading stage tag, so a label is never read as message text. */
export function untagPromoteMessage(message: string): string {
  return message.replace(PROMOTE_STEP_TAG, '');
}

/** The producer-owned stage a tagged message names; any other or absent stage is `unknown`. */
export function diagnosticPromoteStage(message: string): PromoteStepName | 'unknown' {
  const candidate = PROMOTE_STEP_TAG.exec(message)?.[1];
  return candidate !== undefined && isPromoteStepName(candidate) ? candidate : 'unknown';
}
