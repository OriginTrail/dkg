// SPDX-License-Identifier: Apache-2.0
/**
 * FROZEN COPY of how `ChatMemoryManager.getSessionGraphDelta` selected the
 * subjects of a turn's graph delta before the selection was split into one query
 * per relation (`src/chat-graph-delta-subjects.ts`): ONE `SELECT DISTINCT` over a
 * UNION of seven branches with `LIMIT 5000`, then the four known subjects plus
 * every safe IRI of the answer. That query is refused on a working-memory view
 * that spans more than one graph (a UNION combined with DISTINCT/LIMIT), which is
 * why it was split; on a single graph it is the reference the split must agree
 * with. Copied from `packages/node-ui/src/chat-memory.ts` at b7b3c8e5d; do NOT
 * "fix" or modernize it.
 */
import { isSafeIri } from '@origintrail-official/dkg-core';

const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CHAT_TURN_PERSISTENCE_TRANSITION_TYPE = `${DKG_ONT}ChatTurnPersistenceTransition`;
const CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE = `${DKG_ONT}updatesTurn`;

export async function frozenGraphDeltaSubjects(
  query: (sparql: string) => Promise<{ bindings?: Array<Record<string, string>> }>,
  { sessionUri, turnUri, userMsgUri, assistantMsgUri }: { sessionUri: string; turnUri: string; userMsgUri: string; assistantMsgUri: string },
): Promise<string[]> {
  const relatedSubjectsResult = await query(
    `SELECT DISTINCT ?s WHERE {
        VALUES ?msg { <${userMsgUri}> <${assistantMsgUri}> }
        { BIND(<${sessionUri}> AS ?s) }
        UNION { BIND(<${turnUri}> AS ?s) }
        UNION { BIND(?msg AS ?s) }
        UNION {
          ?s <${RDF_TYPE}> <${CHAT_TURN_PERSISTENCE_TRANSITION_TYPE}> .
          ?s <${CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE}> <${turnUri}> .
        }
        UNION { <${assistantMsgUri}> <${DKG_ONT}usedTool> ?s }
        UNION { ?s <${DKG_ONT}mentionedIn> ?msg }
        UNION {
          ?entity <${DKG_ONT}mentionedIn> ?msg .
          ?s <${DKG_ONT}contains> ?entity .
          ?s <${DKG_ONT}extractedFrom> <${sessionUri}> .
        }
      } LIMIT 5000`,
  );
  const subjectSet = new Set<string>([sessionUri, turnUri, userMsgUri, assistantMsgUri]);
  for (const b of relatedSubjectsResult.bindings ?? []) {
    const iri = String(b.s ?? '').replace(/[<>]/g, '');
    if (!iri || !isSafeIri(iri)) continue;
    subjectSet.add(iri);
  }
  return [...subjectSet];
}
