// SPDX-License-Identifier: Apache-2.0

import {
  resolveApprovedPrivateReplicaAuthority,
  type ApprovedPrivateReplicaAuthorityResolution,
} from './approved-private-replica.js';
import { isBoundedOperationTimeoutError, runBoundedOperation } from './bounded-operation.js';
import type { DKGAgent } from './dkg-agent.js';

/** Runs of the local proof one decision may use: the first and two more. */
export const APPROVED_PRIVATE_REPLICA_PROOF_MAX_RUNS = 3;

/** Why a run said nothing about the member, so the proof may run again. */
export type ApprovedPrivateReplicaProofRerunCause = 'metadata-moved' | 'timeout';

export type ApprovedPrivateReplicaProofOutcome =
  | Readonly<{ kind: 'proved'; resolution: ApprovedPrivateReplicaAuthorityResolution }>
  /** A run read unmoved metadata to the end and found no current proof. */
  | Readonly<{ kind: 'absent' }>
  /** Every run was discarded because the graph's metadata moved while it read. */
  | Readonly<{ kind: 'metadata-moved' }>;

/**
 * Run the approved member's local proof for one decision, and run it again
 * where a run said nothing about the member: its time limit ended it, or the
 * graph's metadata revision moved under reads that otherwise all held.
 *
 * Nothing is relaxed. Each run is the complete proof under its own time limit
 * and its own revision fence, the approval is read again before each run, and
 * every run is held to the request generation the first one read. A run that
 * finds anything else (no approval, another generation, a pending registration,
 * a failed read) ends the decision exactly as a single run does: `absent`, or
 * the error it threw. So does the last permitted run, whatever its cause.
 */
export async function resolveApprovedPrivateReplicaAuthorityWithinRuns(
  agent: DKGAgent,
  contextGraphId: string,
  approvedAgentAddress: string,
  fences: {
    readonly approvalStillHolds: () => boolean;
    readonly readMetadataRevision: () => string;
  },
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    /** Told before each further run, for the log. */
    readonly onRerun?: (cause: ApprovedPrivateReplicaProofRerunCause, run: number) => void;
  },
): Promise<ApprovedPrivateReplicaProofOutcome> {
  let requestGeneration: string | undefined;
  const acceptsRequestGeneration = (observed: string): boolean => (
    (requestGeneration ??= observed) === observed
  );
  for (let run = 1; ; run += 1) {
    const metadataRevision = fences.readMetadataRevision();
    let metadataMoved = false;
    let timeout: unknown;
    try {
      const resolution = await runBoundedOperation(
        (signal) => resolveApprovedPrivateReplicaAuthority(
          agent,
          contextGraphId,
          approvedAgentAddress,
          fences.approvalStillHolds,
          () => fences.readMetadataRevision() === metadataRevision,
          signal,
          { acceptsRequestGeneration, metadataMoved: () => { metadataMoved = true; } },
        ),
        {
          label: `resolveApprovedPrivateReplicaAuthority(${contextGraphId})`,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        },
      );
      if (resolution !== null) return { kind: 'proved', resolution };
      if (!metadataMoved) return { kind: 'absent' };
    } catch (error) {
      if (!isBoundedOperationTimeoutError(error)) throw error;
      timeout = error;
    }
    if (run >= APPROVED_PRIVATE_REPLICA_PROOF_MAX_RUNS || !fences.approvalStillHolds()) {
      if (timeout !== undefined) throw timeout;
      return { kind: 'metadata-moved' };
    }
    options.onRerun?.(timeout === undefined ? 'metadata-moved' : 'timeout', run + 1);
  }
}
