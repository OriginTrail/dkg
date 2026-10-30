// SPDX-License-Identifier: Apache-2.0
import { parseCanonicalDecimalU256, validateContextGraphId } from '@origintrail-official/dkg-core';

/** Snapshot v1 integers retain their uint256 domain and canonical wire spelling. */
export function isCanonicalSnapshotInteger(value: unknown, positive = false): value is string {
  try {
    const parsed = parseCanonicalDecimalU256(value);
    return !positive || parsed > 0n;
  }
  catch { return false; }
}

/** Shared domain policy; each caller retains its own envelope and error contract. */
export function isPublicGraphSnapshotScope<T extends { contextGraphId?: unknown; onChainId?: unknown }>(value: T):
  value is T & { contextGraphId: string; onChainId: string } {
  return typeof value.contextGraphId === 'string' && validateContextGraphId(value.contextGraphId).valid
    && isCanonicalSnapshotInteger(value.onChainId, true);
}
