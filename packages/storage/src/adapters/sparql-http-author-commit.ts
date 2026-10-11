import type { AbortableStoreWorkLifecycle } from '../abortable-store-work-lifecycle.js';
import type { GraphWriteGenTracker } from '../graph-write-gen.js';
import {
  executeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasResultV1,
} from '../rfc64-author-commit-execution.js';
import type { QueryResult } from '../triple-store.js';
import type { SparqlHttpOperationAdmissionV1 } from './managed-sparql-recovery.js';

/** One logical CAS lifetime; its HTTP legs take scheduler slots individually. */
export function runSparqlHttpAuthorCommitV1(input: {
  readonly lifecycle: AbortableStoreWorkLifecycle;
  readonly signal: AbortSignal | undefined;
  readonly storeGeneration: number | null;
  readonly touchedGraphs: readonly string[];
  readonly writeGen: GraphWriteGenTracker;
  readonly executeUpdate: (admission: SparqlHttpOperationAdmissionV1, signal: AbortSignal | undefined) => Promise<void>;
  readonly readReceipt: (admission: SparqlHttpOperationAdmissionV1, signal: AbortSignal | undefined) => Promise<QueryResult>;
  readonly cleanup: (admission: SparqlHttpOperationAdmissionV1) => Promise<void>;
  readonly indeterminateError: (cause: unknown) => Error;
}): Promise<Rfc64AuthorCommitCasResultV1> {
  // Holding activity between update, receipt and cleanup lets WAL maintenance
  // drain the whole admitted operation. No outer scheduler slot is acquired:
  // even a one-slot endpoint can run the individual HTTP continuations.
  return input.lifecycle.run(input.signal, async (signal) => {
    const admission: SparqlHttpOperationAdmissionV1 = {
      storeGeneration: input.storeGeneration,
      dispatched: false,
    };
    const scope = { kind: 'graphs' as const, graphs: input.touchedGraphs };
    try {
      return await executeRfc64AuthorCommitCasV1({
        executeUpdate: () => input.executeUpdate(admission, signal),
        readReceipt: () => input.readReceipt(admission, signal),
        cleanup: () => input.cleanup(admission),
        onCommitted: () => input.writeGen.recordWrite(scope),
      });
    } catch (error) {
      if (!admission.dispatched) throw error;
      // Only a boolean receipt certifies commit/conflict. A refused or lost
      // receipt after dispatch cannot prove the semantic graphs stayed put.
      input.writeGen.beginWrite(scope).indeterminate();
      throw input.indeterminateError(error);
    }
  });
}
