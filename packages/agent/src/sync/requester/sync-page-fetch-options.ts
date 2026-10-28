// SPDX-License-Identifier: Apache-2.0
import type { SyncWorkAdmission } from '../work-admission.js';
import type { DurableManifestDigest, DurableManifestPrefixDigest, SyncCheckpointScope, SyncCheckpointStore } from '../checkpoint/state.js';
import type { VerifiedDurableBoundary } from '../durable-recovery-boundary-seed.js';
import type { SyncPageProgress } from './page-fetch.js';

/**
 * Optional modifiers for one Agent-owned page fetch.
 *
 * Keep these named: checkpoint identity, cancellation, recovery semantics and
 * accumulation ceilings are independent concerns. A positional tail made it
 * too easy for a new modifier to occupy an older modifier's slot.
 */
export interface SyncPageFetchOptions {
  readonly workAdmission?: SyncWorkAdmission;
  readonly snapshotRef?: string;
  readonly sinceBatchId?: string;
  readonly signal?: AbortSignal;
  readonly recovery?: boolean;
  readonly forceFreshSession?: boolean;
  /** Completed canonical META generation that defines a durable DATA plan. */
  readonly manifestDigest?: DurableManifestDigest;
  readonly durableResumeBoundary?: VerifiedDurableBoundary;
  /** Canonical prefix proof for any candidate checkpoint offset. */
  readonly manifestPrefixDigestAtOffset?: (
    offset: number,
  ) => DurableManifestPrefixDigest | undefined;
  readonly assetUals?: string[];
  /**
   * Permit the selected-SWM transfer owner to retain a validated metadata
   * prefix after a retryable transport interruption. Checkpoint identity is
   * intentionally independent of this transfer policy.
   */
  readonly returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  readonly requesterScope?: SyncCheckpointScope;
  /** Override used by proof-only callers that own a private in-memory store. */
  readonly checkpointStore?: SyncCheckpointStore;
  /** Proof-only requester state is invocation-local and must not survive this call. */
  readonly ephemeralRequesterState?: boolean;
  readonly maxAcceptedQuads?: number;
  readonly maxAcceptedHeapBytesEstimate?: number;
  /**
   * Soft owner boundary after a page made forward progress, given the rows and
   * estimated heap retained so far and the page's own rows. True yields an
   * incomplete prefix without a timeout; callers still verify and checkpoint.
   */
  readonly shouldStopAfterPage?: (progress: SyncPageProgress) => boolean;
}

