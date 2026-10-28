// SPDX-License-Identifier: Apache-2.0
import { type DurableRecoveryInput } from './durable-recovery-authority.js';
import type { ExactBatchStreamOutcome, ExactRecoveryTransportMode } from './sync/requester/exact-recovery-transport.js';
import { type DurableSyncAdmissionOutcome } from './sync/requester/admission-boundary.js';
import { type ChallengePinnedGraphScopedAsset } from './sync/requester/graph-scoped-materialization.js';
import { type PhaseCallback } from '@origintrail-official/dkg-publisher';
import { type ExactAssetSelection } from './sync/exact-assets.js';
import { type ExactAssetResponderCapability, type VerifiedFullSnapshot } from './sync/requester/durable-sync.js';
import { type ExactAssetFetchSessionPolicy, type ExactDurableFetchDisposition } from './sync/requester/exact-durable-fetch.js';
import { type SyncAdmissionSource } from './sync/policy.js';
import { type DurableSyncResult } from './dkg-agent-types.js';

export type ExactRecoveryOptions = {
  onWorkStarted?: () => void;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  exactRecoveryTransportMode?: ExactRecoveryTransportMode;
  totalTimeoutMs?: number;
};

export type ExactKnowledgeAssetSyncOptions = DurableRecoveryInput & ExactRecoveryOptions & {
  forceFreshExactSession?: boolean;
};

export type ExactKnowledgeAssetRefreshSyncOptions = ExactKnowledgeAssetSyncOptions & {
  exactFetchPurpose?: 'vm-update-refresh';
};

export type DurableRecoverySchedulingOptions = {
  stopOnBackoffWorthyFailure?: boolean;
  /**
   * Outer wall-clock budget for the complete legacy durable operation.
   * Network transfer and post-fetch chain authentication retain separate
   * phase deadlines, but neither may extend work beyond this caller boundary.
   */
  totalTimeoutMs?: number;
  /**
   * Soft graph-settlement scheduling quantum. Once it expires, a recovery
   * finishes and checkpoints the asset already in flight, then returns before
   * starting another asset. Unlike `totalTimeoutMs`, this never aborts an
   * authentication or atomic materialization that has already started.
   */
  settlementSliceTimeoutMs?: number;
  /**
   * Cancels the whole durable operation. Paging and graph-scoped chain
   * authentication observe the signal directly; verification and atomic
   * materialization check it before any subsequent commit boundary.
   */
  signal?: AbortSignal;
  /** Called synchronously when local capacity admits physical work. */
  onWorkStarted?: () => void;
  /** Internal lifecycle fence for exact VM recovery. */
  isCurrent?: () => boolean;
  /**
   * Called synchronously after graph-scoped authentication succeeds and
   * immediately before atomic materialization is dispatched. This is a
   * settlement boundary, not a generic progress callback.
   */
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  /** Admission override for foreground VM recovery. */
  priority?: number;
  /**
   * Which trigger asked for this sync. Recorded as a bounded dimension on
   * node-wide scheduler diagnostics so queue pressure can be attributed to an
   * origin.
   *
   * The closed union, so an ordinary in-process caller cannot introduce an
   * unbounded or identifier-bearing label. The catch-up Worker RPC is the one
   * path where the compile-time union guarantees nothing — a `postMessage`
   * payload is whatever crossed the wire — and that edge clamps with
   * `normalizeSyncAdmissionSource` in the CLI bridge before calling in.
   * The scheduler re-clamps anyway, as defence in depth.
   */
  source?: SyncAdmissionSource;
};

export type DurableRecoveryOptions = DurableRecoverySchedulingOptions & {
  /** Selection-bound requester policy; a refresh always identifies its exact assets. */
  exactAssetFetchPolicy?: ExactAssetFetchSessionPolicy;
  /** Internal transport decision; required streams never replay an enlarged selection. */
  exactRecoveryTransportMode?: ExactRecoveryTransportMode;
};

type LegacyExactAssetFetchOptions = {
  /** @deprecated Use the selection-bound exactAssetFetchPolicy. */
  exactAssetSelection?: ExactAssetSelection;
  /** @deprecated Use the vm-update-refresh exactAssetFetchPolicy. */
  forceFreshExactSession?: boolean;
};

export type DurableSyncOptions = DurableRecoveryInput & DurableRecoveryOptions & LegacyExactAssetFetchOptions;

export interface ExactKnowledgeAssetSyncResult {
  readonly admission: DurableSyncAdmissionOutcome;
  readonly result: DurableSyncResult;
  readonly disposition: ExactDurableFetchDisposition;
  readonly responderCapability?: ExactAssetResponderCapability;
  readonly authenticatedAssets?: readonly ChallengePinnedGraphScopedAsset[];
  /** Physically applied by the experimental stream, even if final transport close failed. */
  readonly committedExactAssetUals?: readonly string[];
  /** Present only when the exact-batch stream settled this fetch with one of these outcomes. */
  readonly streamOutcome?: ExactBatchStreamOutcome;
}

export type PhysicalDurableSyncResult = {
  readonly result: DurableSyncResult;
  readonly exactFetchDisposition?: ExactDurableFetchDisposition;
  readonly exactResponderCapability?: ExactAssetResponderCapability;
  readonly authenticatedExactAssets?: readonly ChallengePinnedGraphScopedAsset[];
  readonly committedExactAssetUals?: readonly string[];
  readonly exactStreamOutcome?: ExactBatchStreamOutcome;
};

export type AdmittedDurableSyncResult = PhysicalDurableSyncResult & {
  readonly admission: DurableSyncAdmissionOutcome;
};

export interface DurableGraphCommonOptions {
  onPhase?: PhaseCallback;
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  onAccessDenied?: (contextGraphId: string) => void;
  stopOnBackoffWorthyFailure?: boolean;
  fetchTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  operationFetchDeadline?: number;
  operationDeadline?: number;
  settlementSliceTimeoutMs?: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface DurableGraphOptions extends DurableGraphCommonOptions {
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
  exactAssetFetchPolicy?: ExactAssetFetchSessionPolicy;
  exactRecoveryTransportMode?: ExactRecoveryTransportMode;
}

export type LegacyDurableContextGraphOptions = DurableRecoveryInput & DurableGraphOptions & LegacyExactAssetFetchOptions;
