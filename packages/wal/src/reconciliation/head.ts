import { equalBytes } from './bytes.js';
import { ReconciliationError } from './errors.js';
import {
  reconciliationHeadId,
  setCommitmentRoot,
  type ReconciliationHeadId,
  type SetCommitmentRoot,
  type WalObjectId
} from './ids.js';
import { setCommitment } from './set-commitment.js';

export interface ReconciliationHead {
  headId: ReconciliationHeadId;
  objectCount: number;
  objectSetRoot: SetCommitmentRoot;
}

export function reconciliationHead(
  headId: ReconciliationHeadId,
  objectCount: number,
  objectSetRoot: SetCommitmentRoot
): ReconciliationHead {
  if (!Number.isSafeInteger(objectCount) || objectCount < 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'head objectCount must be a non-negative safe integer');
  }
  return Object.freeze({
    headId: reconciliationHeadId(headId),
    objectCount,
    objectSetRoot: setCommitmentRoot(objectSetRoot)
  });
}

export function headForSet(headId: ReconciliationHeadId, ids: readonly WalObjectId[]): ReconciliationHead {
  return reconciliationHead(headId, ids.length, setCommitment(ids));
}

export function verifySetAgainstHead(ids: readonly WalObjectId[], head: ReconciliationHead): void {
  if (ids.length !== head.objectCount) {
    throw new ReconciliationError('COUNT_MISMATCH', 'set object count does not match the reconciliation head', {
      expected: head.objectCount,
      actual: ids.length
    });
  }
  if (!equalBytes(setCommitment(ids), head.objectSetRoot)) {
    throw new ReconciliationError('ROOT_MISMATCH', 'set root does not match the reconciliation head');
  }
}
