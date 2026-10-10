// SPDX-License-Identifier: Apache-2.0
import type {
  GetView,
  TrustLevel,
  OperationContext,
} from "@origintrail-official/dkg-core";
import type { PublicSnapshotMode } from "./public-snapshot-evidence.js";
export interface AgentQueryOptions {
  contextGraphId?: string;
  accessDenied?: "empty" | "error";
  redactQuery?: boolean;
  maxResponseBytes?: number;
  /** Explicit acceptance of configured-core chain evidence for this graph. */
  chainEvidenceMode?: PublicSnapshotMode;
  graphSuffix?: "_shared_memory";
  includeSharedMemory?: boolean;
  /** @deprecated Use includeSharedMemory */
  includeWorkspace?: boolean;
  /**
   * Opt-in for dashboard/count queries that intentionally enumerate all
   * registered public content partitions in a scoped `GRAPH ?g` scan.
   */
  includeContextGraphPartitions?: boolean;
  /**
   * Opt-in: allow the scoped query to reference the context graph's own
   * `_private` partition (excluded from the scope guard's allow-set by
   * default). Used by the EPCIS events query, whose SPARQL always names
   * `<cg>/_private`. Does not widen access for other callers.
   */
  includePrivate?: boolean;
  /** Cancel the underlying store request when the outer caller disconnects. */
  signal?: AbortSignal;
  /** Store admission lane used by the query engine. */
  priority?: import("@origintrail-official/dkg-storage").StoreWorkPriority;
  /** Store diagnostics / slow-query attribution label. */
  source?: string;
  operationCtx?: OperationContext;
  view?: GetView;
  agentAddress?: string;
  verifiedGraph?: string;
  assertionName?: string;
  subGraphName?: string;
  /**
   * EVM address of the authenticated caller, as resolved by an
   * outer layer (typically the daemon's per-request auth token).
   * When set, the agent layer enforces that `view: 'working-memory'`
   * queries can only read this caller's own WM — cross-agent reads
   * via a foreign `agentAddress` are silently denied.
   *
   * Undefined = no caller authentication context (in-process call
   * from trusted code). Backwards-compatible with callers that
   * predate A-1 — they bypass the isolation check.
   *
   * Invariant: on a `view: 'working-memory'` read, the agent layer
   * rejects (silently, with an empty-per-kind result) any
   * `agentAddress` that differs from `callerAgentAddress`. If
   * `agentAddress` is omitted, it defaults to `callerAgentAddress`
   * so an authenticated caller cannot escape isolation by omission.
   * See spec §04 / RFC-29 for the policy source.
   */
  callerAgentAddress?: string;
  /**
   * Minimum trust level for the verifiable-memory view (spec §14).
   * Values above `SelfAttested` require explicit writer-side
   * `dkg:trustLevel` metadata. Ignored for other views.
   */
  minTrust?: TrustLevel;
  /**
   * @deprecated Use `minTrust`. Legacy underscore alias preserved for
   * V10-rc SDK consumers. When both are supplied, `minTrust` wins.
   * See QueryOptions._minTrust for the deprecation policy.
   */
  _minTrust?: TrustLevel;
}
