import { setTimeout as sleep } from 'node:timers/promises';

const SUCCESS_TERMINALS = new Set(['finalized', 'completed']);

export async function pollUntilFinalized(fetcher, { intervalMs = 1000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetcher();
    if (last && SUCCESS_TERMINALS.has(last.state)) {
      return { state: last.state, ual: last.ual ?? null };
    }
    if (last && last.state === 'failed') {
      throw new Error(`capture failed: ${last.error ?? '(no error message)'}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`poll timed out after ${timeoutMs}ms (last state=${last?.state ?? 'n/a'})`);
}
