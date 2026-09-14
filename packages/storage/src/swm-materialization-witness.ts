/**
 * Backward-compatible storage-backed SWM materialization witness API.
 *
 * The agent now uses a bounded, revision-fenced process-local memo instead,
 * but these exports remain available for consumers of the current storage
 * package major. They can be removed in the next major release.
 */
import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { QueryOptions, Quad, TripleStore } from './triple-store.js';
import {
  deleteByPatternWithoutCount,
  tryReplaceSubjectAtomically,
} from './triple-store.js';

/** @deprecated Use the agent's revision-fenced materialization validation memo. */
export const SWM_MATERIALIZATION_WITNESS_GRAPH = 'urn:dkg:local:swm-materialization-witness';

const WITNESS_DIGEST_PREDICATE = 'urn:dkg:local:swm-materialization-witness:digest';

/**
 * Derive the legacy witness subject for one assertion graph.
 *
 * @deprecated Use the agent's revision-fenced materialization validation memo.
 */
export function swmMaterializationWitnessSubject(assertionGraph: string): string {
  return `${assertionGraph}#dkg-swm-materialized`;
}

/**
 * Read the legacy durable witness for an assertion graph and digest.
 *
 * @deprecated Use the agent's revision-fenced materialization validation memo.
 */
export async function readSwmMaterializationWitness(
  store: TripleStore,
  assertionGraph: string,
  digest: string,
  options: QueryOptions = {},
): Promise<boolean> {
  const subject = swmMaterializationWitnessSubject(assertionGraph);
  const result = await store
    .query(
      `ASK { GRAPH <${assertSafeIri(SWM_MATERIALIZATION_WITNESS_GRAPH)}> { `
      + `<${assertSafeIri(subject)}> <${assertSafeIri(WITNESS_DIGEST_PREDICATE)}> ${sparqlString(digest)} } }`,
      options,
    )
    .catch(() => null);
  return result?.type === 'boolean' && result.value === true;
}

/**
 * Write the legacy durable witness, atomically replacing any prior digest.
 *
 * @deprecated Use the agent's revision-fenced materialization validation memo.
 */
export async function writeSwmMaterializationWitness(
  store: TripleStore,
  assertionGraph: string,
  digest: string,
  options: QueryOptions = {},
): Promise<boolean> {
  const subject = swmMaterializationWitnessSubject(assertionGraph);
  const quads: Quad[] = [
    {
      subject,
      predicate: WITNESS_DIGEST_PREDICATE,
      object: sparqlString(digest),
      graph: SWM_MATERIALIZATION_WITNESS_GRAPH,
    },
  ];
  return tryReplaceSubjectAtomically(
    store,
    SWM_MATERIALIZATION_WITNESS_GRAPH,
    subject,
    quads,
    options,
  );
}

/**
 * Delete the legacy durable witness for an assertion graph.
 *
 * @deprecated Use the agent's revision-fenced materialization validation memo.
 */
export async function invalidateSwmMaterializationWitness(
  store: {
    deleteByPattern(
      pattern: { graph: string; subject: string },
      options?: QueryOptions,
    ): Promise<unknown>;
    deleteByPatternWithoutCount?(
      pattern: { graph: string; subject: string },
      options?: QueryOptions,
    ): Promise<void>;
  },
  assertionGraph: string,
  options: QueryOptions = {},
): Promise<void> {
  await deleteByPatternWithoutCount(store, {
    graph: SWM_MATERIALIZATION_WITNESS_GRAPH,
    subject: swmMaterializationWitnessSubject(assertionGraph),
  }, options);
}
