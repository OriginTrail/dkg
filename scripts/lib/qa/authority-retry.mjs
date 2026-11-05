// Build-free harness orchestration over the same policy shipped in dkg-core.
import { RETRYABLE_AUTHORITY_CODES, isRetryableAuthorityAnswer, authorityRetryDelayMs }
  from '../../../packages/core/runtime/daemon-authority-retry.mjs';
export * from '../../../packages/core/runtime/daemon-authority-retry.mjs';

/**
 * Send a request until its answer is something other than the retryable
 * authority 503, or the retries run out, and give back the last answer.
 * `ask` answers `{ status, json, retryAfter }`; it may carry more. `codes` narrows
 * the codes for a request that may not be repeated on both. A client sends again
 * only what the route allows: a read, or a route that names the answer as safe
 * to repeat.
 */
export async function askWithAuthorityRetry(ask, {
  codes = RETRYABLE_AUTHORITY_CODES,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry,
} = {}) {
  for (let retry = 0; ; retry += 1) {
    const answer = await ask();
    if (!isRetryableAuthorityAnswer(answer.status, answer.json, codes)) return answer;
    const delayMs = authorityRetryDelayMs(retry, answer.retryAfter);
    if (delayMs === null) return answer;
    onRetry?.({ retry: retry + 1, delayMs });
    await sleep(delayMs);
  }
}
