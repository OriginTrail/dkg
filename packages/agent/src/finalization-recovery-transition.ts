// SPDX-License-Identifier: Apache-2.0
import type { FinalizationRecoveryEntry, FinalizationRecoveryStore } from './finalization-recovery-store.js';

/** Map the durable mutation outcome to the recovery API and its diagnostic. */
export async function transitionFinalizationRecoveryEntry(
  store: FinalizationRecoveryStore | undefined, entry: FinalizationRecoveryEntry,
  state: 'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED',
  reason: string | undefined, log: { warn(message: string): void },
): Promise<boolean> {
    if (!store) return false;
    try {
      const outcome = await store.transition(entry.key, entry.generation, state, reason);
      if (outcome.status === 'missing-evidence') {
        log.warn(`Finalization recovery inbox refused to settle ${entry.ual}: verified evidence missing`);
      }
      return outcome.status === 'changed';
    } catch (error) {
      log.warn(
        `Finalization recovery transition to ${state} failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
}
