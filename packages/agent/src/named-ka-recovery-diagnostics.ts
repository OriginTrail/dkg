// SPDX-License-Identifier: Apache-2.0

/**
 * What a deferred named-KA recovery says about itself, beside its message.
 *
 * The recovery sets these fields where it throws. The pending log reads them
 * through {@link namedKaRecoveryDiagnostics}, so it never has to take a message
 * apart to learn what the deferral is about.
 */

import {
  describeKnowledgeAssetVersionSnapshotUnavailable,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';

export interface NamedKaRecoveryDiagnostics {
  /** Why recovery is pending, without the asset it is about: the same text for every asset one cause holds. */
  readonly pendingReason?: string;
  /** Why the chain adapter could establish no version view, when that is the cause and the adapter says. */
  readonly versionViewUnavailable?: KnowledgeAssetVersionSnapshotUnavailable;
}

/** The diagnostics `error` carries. An error from anywhere else carries none. */
export function namedKaRecoveryDiagnostics(error: unknown): NamedKaRecoveryDiagnostics {
  if (error === null || typeof error !== 'object') return {};
  const { pendingReason, versionViewUnavailable } = error as NamedKaRecoveryDiagnostics;
  return {
    ...(typeof pendingReason === 'string' && pendingReason.length > 0 ? { pendingReason } : {}),
    ...(isVersionViewReport(versionViewUnavailable) ? { versionViewUnavailable } : {}),
  };
}

function isVersionViewReport(value: unknown): value is KnowledgeAssetVersionSnapshotUnavailable {
  if (value === null || typeof value !== 'object') return false;
  const report = value as Partial<KnowledgeAssetVersionSnapshotUnavailable>;
  return typeof report.reason === 'string'
    && Number.isInteger(report.endpointCount)
    && Array.isArray(report.endpoints);
}

/** `: <why>` for a message, from the adapter's report, or nothing without one. */
export function versionViewCause(report: KnowledgeAssetVersionSnapshotUnavailable | undefined): string {
  return report === undefined ? '' : `: ${describeKnowledgeAssetVersionSnapshotUnavailable(report)}`;
}

/**
 * The endpoints that hold recovery, in words: every configured endpoint was
 * asked and none supplied a view. Nothing when the report names no endpoint, and
 * nothing when something other than the endpoints ended the read (the caller's
 * deadline, the node's own request budget): those are not for an operator to
 * fix at an endpoint.
 */
export function versionViewBlockingEndpoints(
  report: KnowledgeAssetVersionSnapshotUnavailable | undefined,
): string | undefined {
  if (report === undefined || report.reason !== 'endpoints-failed' || report.endpoints.length === 0) {
    return undefined;
  }
  return describeKnowledgeAssetVersionSnapshotUnavailable(report);
}
