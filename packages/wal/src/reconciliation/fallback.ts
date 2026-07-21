import { bytesToHex, compareBytes, equalBytes } from './bytes.js';
import { ReconciliationError } from './errors.js';
import type { ReconciliationHead } from './head.js';
import { reconciliationHeadId, walObjectId, type ReconciliationHeadId, type WalObjectId } from './ids.js';
import { verifySetAgainstHead } from './head.js';

export interface IdFallbackPage {
  headId: ReconciliationHeadId;
  offset: number;
  ids: WalObjectId[];
  done: boolean;
}

export function createFallbackPages(
  ids: readonly WalObjectId[],
  head: ReconciliationHead,
  pageSize: number
): IdFallbackPage[] {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'pageSize must be a positive safe integer');
  }
  verifySetAgainstHead(ids, head);
  const sorted = [...ids].map(walObjectId).sort(compareBytes);
  const pages: IdFallbackPage[] = [];
  for (let offset = 0; offset < sorted.length; offset += pageSize) {
    const end = Math.min(sorted.length, offset + pageSize);
    pages.push({
      headId: reconciliationHeadId(head.headId),
      offset,
      ids: sorted.slice(offset, end),
      done: end === sorted.length
    });
  }
  if (pages.length === 0) {
    pages.push({ headId: reconciliationHeadId(head.headId), offset: 0, ids: [], done: true });
  }
  return pages;
}

export function verifyFallbackPages(
  pages: readonly IdFallbackPage[],
  head: ReconciliationHead
): WalObjectId[] {
  if (pages.length === 0) {
    throw new ReconciliationError('FALLBACK_DONE_MISMATCH', 'fallback requires one final page');
  }
  const ids: WalObjectId[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!equalBytes(page.headId, head.headId)) {
      throw new ReconciliationError('FALLBACK_HEAD_MISMATCH', 'fallback page is bound to another head');
    }
    if (page.offset !== expectedOffset) {
      throw new ReconciliationError('FALLBACK_OFFSET_MISMATCH', 'fallback page offset mismatch', {
        expected: expectedOffset,
        actual: page.offset
      });
    }
    if (page.done !== (index === pages.length - 1)) {
      throw new ReconciliationError('FALLBACK_DONE_MISMATCH', 'fallback page done marker mismatch');
    }
    ids.push(...page.ids.map(walObjectId));
    expectedOffset = ids.length;
  }
  if (ids.length !== head.objectCount) {
    throw new ReconciliationError('COUNT_MISMATCH', 'fallback object count mismatch', {
      expected: head.objectCount,
      actual: ids.length
    });
  }
  for (let index = 1; index < ids.length; index += 1) {
    if (compareBytes(ids[index - 1], ids[index]) >= 0) {
      throw new ReconciliationError('FALLBACK_ORDER_MISMATCH', 'fallback IDs are not strictly sorted', {
        id: bytesToHex(ids[index])
      });
    }
  }
  verifySetAgainstHead(ids, head);
  return ids;
}
