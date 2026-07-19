import { WAL_OBJECT_ID_LENGTH, assertLength, compareBytes, copyBytes, equalBytes } from './bytes.js';
import { setCommitment } from './set-commitment.js';

export interface IdFallbackPage {
  offset: number;
  ids: Uint8Array[];
  done: boolean;
}

export function createFallbackPages(ids: readonly Uint8Array[], pageSize: number): IdFallbackPage[] {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError('pageSize must be a positive safe integer');
  const sorted = [...ids].map((id) => {
    assertLength(id, WAL_OBJECT_ID_LENGTH, 'walObjectId');
    return copyBytes(id);
  }).sort(compareBytes);
  const pages: IdFallbackPage[] = [];
  for (let offset = 0; offset < sorted.length; offset += pageSize) {
    const end = Math.min(sorted.length, offset + pageSize);
    pages.push({ offset, ids: sorted.slice(offset, end), done: end === sorted.length });
  }
  if (pages.length === 0) pages.push({ offset: 0, ids: [], done: true });
  return pages;
}

export function verifyFallbackPages(
  pages: readonly IdFallbackPage[],
  expectedCount: number,
  expectedRoot: Uint8Array
): Uint8Array[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new RangeError('expectedCount is invalid');
  const ids: Uint8Array[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page.offset !== expectedOffset) throw new RangeError('fallback page offset mismatch');
    if (page.done !== (index === pages.length - 1)) throw new RangeError('fallback page done marker mismatch');
    ids.push(...page.ids.map(copyBytes));
    expectedOffset = ids.length;
  }
  if (ids.length !== expectedCount) throw new RangeError('fallback object count mismatch');
  for (let index = 1; index < ids.length; index += 1) {
    if (compareBytes(ids[index - 1], ids[index]) >= 0) throw new RangeError('fallback IDs are not strictly sorted');
  }
  if (!equalBytes(setCommitment(ids), expectedRoot)) throw new RangeError('fallback set root mismatch');
  return ids;
}
