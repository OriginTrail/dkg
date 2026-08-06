/**
 * A node-local memo recording that THIS node verified a graph-scoped SWM
 * assertion graph against a specific content digest (issue #2079).
 *
 * Like `LOCAL_TRUSTED_KA_CONTROLS_GRAPH`, this graph deliberately lives outside
 * every context-graph prefix, so durable sync neither serves nor ingests it as
 * peer metadata.
 *
 * ## What this is, and what it is NOT
 *
 * It is a **memo of a measurement this node already took** — written only from
 * the branch that has just computed the digest over its own store content and
 * found it matching. It is never an independent claim that something is
 * materialized.
 *
 * That distinction is the whole design. A witness derived from anything a PEER
 * sent is unsound: the bulk `storeInsert(processed.verifiedMeta)` writes head
 * rows for every descriptor in verified metadata with no dependency on whether
 * that KA's graph was materialized, so using a head row as the witness grows
 * MORE likely to wrongly report "already done" the more catch-up rounds a node
 * runs. That design was proposed for #2079 and killed in review; this module
 * exists to be the sound alternative, not a variation on it.
 *
 * ## The witness is NOT sufficient on its own — callers must keep a count gate
 *
 * A witness records that the content WAS correct, not that it still IS. Three
 * paths remove an assertion graph without any lock this module can participate
 * in:
 *
 *   - the shared-memory TTL sweep (`cleanupExpiredSharedMemory`), on a timer;
 *   - VM promotion / publish / update (`dropGraph(swmGraph)`), under a
 *     DIFFERENT lock map than the sync materializer's;
 *   - the chain-reset wipe, whose scoped delete filters on the context-graph,
 *     publisher and changelog prefixes only — so a `urn:dkg:local:*` witness
 *     SURVIVES a wipe that deletes every context-graph triple.
 *
 * All three leave an empty or absent graph, which a `COUNT` catches for free.
 * **Callers must therefore treat a witness hit as valid only after a count gate
 * has already matched.** Do not "optimize" that count away: without it, the
 * three paths above become permanent silent divergence certified as parity.
 *
 * What the count does NOT catch is an equal-count replace (v1 → v2, same quad
 * count, different digest). That is why the digest is part of the read, and why
 * the write must EVICT any prior row for the graph rather than accumulate.
 */
import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { QueryOptions, Quad, TripleStore } from './triple-store.js';
import { tryReplaceSubjectAtomically } from './triple-store.js';

export const SWM_MATERIALIZATION_WITNESS_GRAPH = 'urn:dkg:local:swm-materialization-witness';

const WITNESS_DIGEST_PREDICATE = 'urn:dkg:local:swm-materialization-witness:digest';

/**
 * One subject per assertion graph — NOT per (graph, digest) pair.
 *
 * Keying the subject on the graph alone is what makes a new digest EVICT the
 * old claim in the same atomic replace. Folding the digest into the subject IRI
 * would leave the previous version's row standing, so a later return to that
 * digest — or any equal-count replace — would find a standing lie.
 *
 * PRECONDITION: `assertionGraph` carries no `#`. Every caller passes a
 * `knowledgeAssetLayerGraphUri`, which does not, but `assertSafeIri` does NOT
 * reject `#` — so a fragment-bearing graph would yield a double-fragment IRI
 * here. That would be a distinct, self-consistent subject rather than a
 * collision (both write and read derive it the same way), but it is outside
 * what this keying scheme intends.
 */
export function swmMaterializationWitnessSubject(assertionGraph: string): string {
  return `${assertionGraph}#dkg-swm-materialized`;
}

/**
 * Has this node verified `assertionGraph` at exactly `digest`?
 *
 * A bound-subject ASK: O(1) regardless of graph size. Both the subject and the
 * digest are bound, so a witness for a DIFFERENT digest reads as a miss rather
 * than a hit — which is what makes an equal-count version change safe.
 */
export async function readSwmMaterializationWitness(
  store: TripleStore,
  assertionGraph: string,
  digest: string,
  options: QueryOptions = {},
): Promise<boolean> {
  const subject = swmMaterializationWitnessSubject(assertionGraph);
  // Contained: this is a pure OPTIMISATION, so a transient store error must
  // degrade to "not memoized" and let the caller do the real read-back. Letting
  // it throw would make a check that used to succeed fail, which is a strictly
  // worse outcome than recomputing.
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
 * Record that this node verified `assertionGraph` at `digest`, evicting any
 * prior claim for that graph.
 *
 * Returns `false` when the store cannot do an atomic single-subject replace —
 * in which case NOTHING is written. That is deliberate and is the one place
 * this module departs from the usual `tryReplaceSubjectAtomically` idiom, which
 * falls back to delete-then-insert: a missing witness is always safe (it costs
 * one recomputation), whereas a non-atomic fallback could leave two digest rows
 * for one graph after an interrupted write — and a stale digest row IS a
 * standing lie. Never add a fallback here.
 */
export async function writeSwmMaterializationWitness(
  store: TripleStore,
  assertionGraph: string,
  digest: string,
  options: QueryOptions = {},
): Promise<boolean> {
  const subject = swmMaterializationWitnessSubject(assertionGraph);
  // Exactly ONE row. An earlier revision also stored a `verified-at-ms`
  // timestamp; nothing read it, and every witness write appends a changelog
  // marker and advances `seq`, so a second row doubled that churn for no
  // consumer. Add a row here only when something reads it.
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
 * Drop the witness for `assertionGraph`.
 *
 * Call this from every path that replaces or removes the graph's content WITHIN
 * a lock this module can see. The three unlockable paths named in the module
 * doc are covered by the caller's count gate instead — they cannot be covered
 * here, and pretending otherwise would be worse than leaving them to the count.
 */
export async function invalidateSwmMaterializationWitness(
  store: TripleStore,
  assertionGraph: string,
  options: QueryOptions = {},
): Promise<void> {
  await store.deleteByPattern(
    {
      graph: SWM_MATERIALIZATION_WITNESS_GRAPH,
      subject: swmMaterializationWitnessSubject(assertionGraph),
    },
    options,
  );
}
