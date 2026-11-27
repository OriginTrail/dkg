// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import {
  CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE,
  CHAT_TURN_PERSISTENCE_TRANSITION_TYPE,
  DKG_ONT,
  RDF_TYPE,
} from './chat-vocabulary.js';

/**
 * The most subjects one graph delta reads: the turn, its session and messages,
 * and what hangs off them. Every relation query is bounded by it, and so is the
 * set they form together, the turn's own subjects and its transitions first.
 * Past it the subjects that survive are not chosen by any order.
 */
export const GRAPH_DELTA_MAX_SUBJECTS = 5000;

/** What a graph delta is anchored on: the session, the turn it reads and the turn's two messages. */
export interface GraphDeltaAnchors {
  sessionUri: string;
  turnUri: string;
  userMsgUri: string;
  assistantMsgUri: string;
}

type SelectQuery = (sparql: string) => Promise<{ bindings?: Array<Record<string, string>> }>;

/**
 * The subjects a turn's graph delta carries, in the order the delta lists them:
 * the session, the turn and its two messages; then every transition that points
 * at the turn (a turn that completed after it was first written keeps its
 * messages and records the new state and the final reply on a transition node:
 * `recordChatTurnPersistenceTransition`); then the tools the assistant used, the
 * subjects that mention either message, and the memories extracted from the
 * session that contain an entity a message mentions. Each subject appears once.
 *
 * The relations are read by independent queries, never one UNION. A read of the
 * working-memory view can span more than one graph (a by-name read also includes
 * the assertion's scoped child graphs, and an agent address can have several
 * candidate layer graphs), and the query engine refuses a UNION combined with
 * DISTINCT or LIMIT across graphs, so a single UNION query fails the whole read
 * on such a node. A subject that is not a safe IRI is skipped. A relation that
 * cannot be read fails the call: a delta that silently left the transitions out
 * would show the first report of a turn that has since completed.
 */
export async function selectGraphDeltaSubjects(
  query: SelectQuery,
  { sessionUri, turnUri, userMsgUri, assistantMsgUri }: GraphDeltaAnchors,
): Promise<string[]> {
  const related = async (pattern: string): Promise<string[]> => {
    const result = await query(`SELECT DISTINCT ?s WHERE { ${pattern} } LIMIT ${GRAPH_DELTA_MAX_SUBJECTS}`);
    return (result.bindings ?? []).map((binding) => String(binding.s ?? '').replace(/[<>]/g, ''));
  };
  const messages = `VALUES ?msg { <${userMsgUri}> <${assistantMsgUri}> }`;
  const [transitions, tools, mentions, memories] = await Promise.all([
    related(`
        ?s <${RDF_TYPE}> <${CHAT_TURN_PERSISTENCE_TRANSITION_TYPE}> .
        ?s <${CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE}> <${turnUri}> .`),
    related(`<${assistantMsgUri}> <${DKG_ONT}usedTool> ?s .`),
    related(`${messages} ?s <${DKG_ONT}mentionedIn> ?msg .`),
    related(`
        ${messages}
        ?entity <${DKG_ONT}mentionedIn> ?msg .
        ?s <${DKG_ONT}contains> ?entity .
        ?s <${DKG_ONT}extractedFrom> <${sessionUri}> .`),
  ]);
  const subjects = new Set<string>([sessionUri, turnUri, userMsgUri, assistantMsgUri]);
  for (const iri of [...transitions, ...tools, ...mentions, ...memories]) {
    if (subjects.size >= GRAPH_DELTA_MAX_SUBJECTS) break;
    if (!iri || !isSafeIri(iri)) continue;
    subjects.add(iri);
  }
  return [...subjects];
}
