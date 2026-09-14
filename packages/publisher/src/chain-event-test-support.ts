import { CHAIN_EVENT_POLLER_LANES } from './chain-event-lane-runner.js';
import type { LaneCursorPersistence } from './chain-event-lane-cursor-store.js';

/**
 * Seed every poller lane at one block for integration tests that exercise
 * foreground behavior against a shared chain without replaying its history.
 */
export async function seedChainEventPollerCursors(
  persistence: LaneCursorPersistence,
  blockNumber: number,
): Promise<void> {
  for (const lane of CHAIN_EVENT_POLLER_LANES) {
    await persistence.saveLane(lane, blockNumber);
  }
}
