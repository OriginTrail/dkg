import { isDefinitiveSparqlUpdateRejectionV1 } from './sparql-http-response-error.js';
import type { GraphWriteGenTracker } from '../graph-write-gen.js';
import {
  executeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasResultV1,
} from '../rfc64-author-commit-execution.js';
import type { QueryResult } from '../triple-store.js';

/** One logical CAS lifetime; its HTTP legs take scheduler slots individually. */
export async function runSparqlHttpAuthorCommitV1(input: {
  readonly wasDispatched: () => boolean;
  readonly touchedGraphs: readonly string[];
  readonly writeGen: GraphWriteGenTracker;
  readonly executeUpdate: () => Promise<void>;
  readonly readReceipt: () => Promise<QueryResult>;
  readonly cleanup: () => Promise<void>;
  readonly indeterminateError: (cause: unknown) => Error;
}): Promise<Rfc64AuthorCommitCasResultV1> {
  let updateRejected = false;
  const scope = { kind: 'graphs' as const, graphs: input.touchedGraphs };
  try {
    return await executeRfc64AuthorCommitCasV1({
      executeUpdate: async () => {
        try { await input.executeUpdate(); }
        catch (error) {
          updateRejected = isDefinitiveSparqlUpdateRejectionV1(error);
          throw error;
        }
      },
      readReceipt: () => input.readReceipt(),
      cleanup: () => input.cleanup(),
      onCommitted: () => input.writeGen.recordWrite(scope),
    });
  } catch (error) {
    if (!input.wasDispatched() || updateRejected) throw error;
    // Only a boolean receipt certifies commit/conflict. A refused or lost
    // receipt after dispatch cannot prove the semantic graphs stayed put.
    input.writeGen.beginWrite(scope).indeterminate();
    throw input.indeterminateError(error);
  }
}
