import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_PAGE_SIZE,
} from '../../dkg-agent-constants.js';
import {
  decodeExactAssetUals,
  encodeExactAssetUals,
} from '../exact-assets.js';

export interface ByteBudgetPageHint {
  pageMode?: typeof SYNC_BYTE_BUDGET_PAGE_MODE;
  pageRowsHint?: number;
}

export interface PipeSyncRequestTail extends ByteBudgetPageHint {
  syncSessionId?: string;
  sinceBatchId?: string;
  assetUals?: string[];
}

/**
 * Normalize the additive byte-budget hint identically for authenticated JSON
 * envelopes and public pipe requests. A row hint without the matching
 * capability is intentionally inert.
 */
export function normalizeByteBudgetPageHint(
  pageMode: unknown,
  pageRowsHint: unknown,
): ByteBudgetPageHint {
  const normalizedMode = pageMode === SYNC_BYTE_BUDGET_PAGE_MODE
    ? SYNC_BYTE_BUDGET_PAGE_MODE
    : undefined;
  const rows = typeof pageRowsHint === 'number' ? pageRowsHint : Number.NaN;
  return {
    pageMode: normalizedMode,
    pageRowsHint: normalizedMode !== undefined &&
      Number.isSafeInteger(rows) &&
      rows > SYNC_PAGE_SIZE
      ? Math.min(rows, SYNC_BYTE_BUDGET_MAX_ROWS)
      : undefined,
  };
}

/**
 * Encode the ordered additive tail shared by public sync request builders.
 *
 * Byte-budget tokens deliberately precede the legacy session/since/assets
 * suffix. Old responders parse those narrowing fields from the end and ignore
 * the unknown capability tokens, preserving rolling wire compatibility.
 */
export function encodePipeSyncRequestTail(tail: PipeSyncRequestTail): string {
  const parts: string[] = [];
  const page = normalizeByteBudgetPageHint(tail.pageMode, tail.pageRowsHint);
  if (page.pageMode && page.pageRowsHint !== undefined) {
    parts.push('page-mode', page.pageMode, 'page-rows', String(page.pageRowsHint));
  }
  if (tail.syncSessionId) parts.push('session', tail.syncSessionId);
  if (tail.sinceBatchId) parts.push('since', tail.sinceBatchId);
  if (tail.assetUals) parts.push('assets', encodeExactAssetUals(tail.assetUals));
  return parts.length > 0 ? `|${parts.join('|')}` : '';
}

/**
 * Decode only the ordered keyed suffix emitted by
 * {@link encodePipeSyncRequestTail}. Walking backwards avoids interpreting
 * ordinary phase values as control tokens.
 */
export function decodePipeSyncRequestTail(parts: readonly string[]): PipeSyncRequestTail {
  let tail = parts.length;
  let sinceBatchId: string | undefined;
  let syncSessionId: string | undefined;
  let assetUals: string[] | undefined;
  let rawPageMode: unknown;
  let rawPageRowsHint: unknown;

  if (tail >= 2 && parts[tail - 2] === 'assets') {
    assetUals = decodeExactAssetUals(parts[tail - 1]);
    tail -= 2;
  }
  if (
    tail >= 2 &&
    parts[tail - 2] === 'since' &&
    /^\d+$/.test(parts[tail - 1])
  ) {
    sinceBatchId = parts[tail - 1];
    tail -= 2;
  }
  if (
    tail >= 2 &&
    parts[tail - 2] === 'session' &&
    parts[tail - 1].length > 0
  ) {
    syncSessionId = parts[tail - 1];
    tail -= 2;
  }
  if (
    tail >= 2 &&
    parts[tail - 2] === 'page-rows'
  ) {
    rawPageRowsHint = /^\d+$/.test(parts[tail - 1])
      ? Number(parts[tail - 1])
      : undefined;
    tail -= 2;
  }
  if (
    tail >= 2 &&
    parts[tail - 2] === 'page-mode'
  ) {
    rawPageMode = parts[tail - 1];
  }

  return {
    ...normalizeByteBudgetPageHint(rawPageMode, rawPageRowsHint),
    syncSessionId,
    sinceBatchId,
    assetUals,
  };
}
