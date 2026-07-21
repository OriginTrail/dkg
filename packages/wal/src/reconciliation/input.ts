import { WAL_OBJECT_ID_LENGTH, bytesToHex, compareBytes, equalBytes } from './bytes.js';
import { ReconciliationError } from './errors.js';
import type { WalObjectId } from './ids.js';

export interface WalObjectIdInput {
  ids: Iterable<WalObjectId>;
  idCount?: number;
  idsAreSorted?: boolean;
}

export interface PreparedWalObjectIdInput {
  ids: Iterable<WalObjectId>;
  idCount: number;
}

function validateId(id: WalObjectId): void {
  if (!(id instanceof Uint8Array) || id.length !== WAL_OBJECT_ID_LENGTH) {
    throw new ReconciliationError('INVALID_WAL_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
}

function validateCount(idCount: number): void {
  if (!Number.isSafeInteger(idCount) || idCount < 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'idCount must be a non-negative safe integer');
  }
}

function validateOrderedPair(previous: WalObjectId, current: WalObjectId): void {
  const comparison = compareBytes(previous, current);
  if (comparison === 0) {
    throw new ReconciliationError(
      'DUPLICATE_WAL_OBJECT_ID',
      `duplicate WalObjectId: ${bytesToHex(current)}`
    );
  }
  if (comparison > 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'idsAreSorted input is not strictly sorted');
  }
}

function checkedSortedIterable(ids: Iterable<WalObjectId>, expectedCount: number): Iterable<WalObjectId> {
  return {
    *[Symbol.iterator](): Iterator<WalObjectId> {
      let count = 0;
      const previous = new Uint8Array(WAL_OBJECT_ID_LENGTH) as WalObjectId;
      let hasPrevious = false;
      for (const id of ids) {
        validateId(id);
        if (hasPrevious) validateOrderedPair(previous, id);
        previous.set(id);
        hasPrevious = true;
        count += 1;
        yield id;
      }
      if (count !== expectedCount) {
        throw new ReconciliationError('COUNT_MISMATCH', 'iterated WalObjectId count does not match idCount', {
          expected: expectedCount,
          actual: count
        });
      }
    }
  };
}

export function prepareWalObjectIdInput(input: WalObjectIdInput): PreparedWalObjectIdInput {
  if (input.idsAreSorted === true) {
    if (input.idCount === undefined) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'sorted streaming input requires idCount');
    }
    validateCount(input.idCount);
    return { ids: checkedSortedIterable(input.ids, input.idCount), idCount: input.idCount };
  }

  const sorted = [...input.ids];
  for (const id of sorted) validateId(id);
  sorted.sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (equalBytes(sorted[index - 1], sorted[index])) {
      throw new ReconciliationError(
        'DUPLICATE_WAL_OBJECT_ID',
        `duplicate WalObjectId: ${bytesToHex(sorted[index])}`
      );
    }
  }
  if (input.idCount !== undefined) {
    validateCount(input.idCount);
    if (sorted.length !== input.idCount) {
      throw new ReconciliationError('COUNT_MISMATCH', 'WalObjectId input count does not match idCount', {
        expected: input.idCount,
        actual: sorted.length
      });
    }
  }
  return { ids: sorted, idCount: sorted.length };
}
