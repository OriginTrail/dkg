// Polling to a deadline for the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs).

import { sleep } from '../member-sharing/devnet.mjs';

/**
 * Polls `check` every `everyMs` until it answers { ok: true } or `deadline`
 * (a time) has come. The last interval is shortened so that the last poll is
 * sent `leadMs` before the deadline, where its answer can still come in time:
 * no stretch of the deadline longer than that goes unread, and no poll is
 * made once it has passed. The first poll is always made. Resolves to the
 * last answer.
 */
export async function pollUntil(check, deadline, everyMs, { leadMs = 250 } = {}) {
  for (;;) {
    const last = await check();
    if (last.ok) return last;
    const left = deadline - leadMs - Date.now();
    if (left <= 0) return last;
    await sleep(Math.min(everyMs, left));
  }
}
