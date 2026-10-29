// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ParsedGraphScopedFinalization } from './finalization-graph-envelope.js';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryFailureCode,
} from './finalization-recovery-store.js';

/** The exact graph-scoped assertion one finalization names. */
export interface ExactVerifiedMemoryCopyQuery {
  readonly contextGraphId: string;
  readonly candidate: ParsedGraphScopedFinalization;
  /** The root the stored content must verify against. */
  readonly merkleRoot: Uint8Array;
}

export const VERIFIED_MEMORY_SUPERSESSION_REASON =
  'exact assertion is already confirmed in Verified Memory';

export interface VerifiedMemorySupersessionInput {
  readonly entry: FinalizationRecoveryEntry;
  readonly candidate: ParsedGraphScopedFinalization;
  /** The chain-current root that replay matched the entry against. */
  readonly merkleRoot: string;
  /** Why the materialization replay just attempted was deferred; undefined when it was not. */
  readonly failureCode: FinalizationRecoveryFailureCode | undefined;
  readonly materializer: {
    hasExactVerifiedMemoryCopy(query: ExactVerifiedMemoryCopyQuery): Promise<boolean>;
  };
  /** Compare-and-set of the entry's generation to SUPERSEDED. */
  readonly supersede: (reason: string) => Promise<boolean>;
  readonly log: { info(message: string): void };
}

/**
 * Close a replayed entry whose local copy could not be prepared when Verified
 * Memory already holds its exact assertion. Chain reconciliation materializes
 * an asset on a node that never held its SWM copy; the finalization then has
 * nothing left to apply, and retrying it for the whole retry window only holds
 * its source's live inbox quota.
 *
 * Replay calls this only after it matched the entry against the chain's
 * current root, root count and context-graph binding. The entry becomes
 * SUPERSEDED, not SETTLED: a SETTLED entry carries the receipt evidence that
 * later receipt checks revalidate, and this one has none. Only a RECEIVED
 * entry closes. A REORGED one stays owed, since a moved receipt or a late
 * publisher's access semantics are still to be applied to the copy, and so
 * does an entry whose Verified Memory read fails.
 */
export async function supersedeEntryHeldInVerifiedMemory(
  input: VerifiedMemorySupersessionInput,
): Promise<boolean> {
  const { entry } = input;
  if (input.failureCode !== 'workspace-unavailable' || entry.state !== 'RECEIVED') {
    return false;
  }
  let held: boolean;
  try {
    held = await input.materializer.hasExactVerifiedMemoryCopy({
      contextGraphId: entry.contextGraphId,
      candidate: input.candidate,
      merkleRoot: ethers.getBytes(input.merkleRoot),
    });
  } catch (error) {
    input.log.info(
      `Finalization recovery could not read Verified Memory for ${entry.ual}; keeping the entry: `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (!held || !await input.supersede(VERIFIED_MEMORY_SUPERSESSION_REASON)) return false;
  input.log.info(
    `Finalization recovery closed the entry for ${entry.ual}: `
      + 'Verified Memory already holds this exact assertion',
  );
  return true;
}
