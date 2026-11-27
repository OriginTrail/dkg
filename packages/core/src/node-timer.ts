/** Largest delay that Node.js timers accept without replacing it with 1 ms. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Use an operator value only when Node.js can represent it as a timer delay.
 * Invalid values use the supplied, already-safe fallback.
 */
export function resolveNodeTimerDelayMs(value: unknown, fallback: number): number {
  if (!isNodeTimerDelayMs(fallback)) {
    throw new Error('Node timer fallback must be an integer from 1 through 2147483647 ms');
  }
  return isNodeTimerDelayMs(value) ? value : fallback;
}

/** Reject a timer value before Node.js can silently replace it with a 1 ms delay. */
export function assertNodeTimerDelayMs(value: unknown, label: string): asserts value is number {
  if (!isNodeTimerDelayMs(value)) {
    throw new Error(`${label} must be an integer from 1 through 2147483647 ms`);
  }
}

function isNodeTimerDelayMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_NODE_TIMER_DELAY_MS;
}
