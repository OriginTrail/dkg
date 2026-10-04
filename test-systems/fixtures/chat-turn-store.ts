// SPDX-License-Identifier: Apache-2.0
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

export const GRAPH = 'urn:test:chat-ownership';
export const CHAT = 'urn:dkg:chat:';
export const DKG = 'http://dkg.io/ontology/';
export const SCHEMA = 'http://schema.org/';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Shared RDF model and Oxigraph-backed assertion tools; suites own manager construction. */
export function createChatTurnStoreFixture(store: Pick<TripleStore, 'query' | 'insert'>) {
  const tools = {
    query: (sparql: string) => store.query(sparql.replace(/\bWHERE\b/, `FROM <${GRAPH}> WHERE`)),
    listContextGraphs: async () => [{ id: 'agent-context' }],
    createContextGraph: async () => {},
    createAssertion: async () => ({ assertionUri: GRAPH, alreadyExists: true }),
    writeAssertion: async (_cg: string, _name: string, quads: Quad[]) => {
      await store.insert(quads.map((quad) => ({ ...quad, graph: GRAPH })));
      return { written: quads.length };
    },
  };
  const insert = (...triples: Array<[string, string, string]>) => store.insert(triples.map(([subject, predicate, object]) => ({ subject, predicate, object, graph: GRAPH })));
  const seed = async (session: string, turn: string, reply: string, state = 'pending', turnId = '1', timestamp = '2026-10-01T00:00:00Z') => {
    const sessionUri = `${CHAT}session:${session}`;
    const messageUri = `${CHAT}message:${session}:${encodeURIComponent(turn)}`;
    await insert(
      [sessionUri, RDF_TYPE, `${SCHEMA}Conversation`],
      [sessionUri, `${DKG}sessionId`, JSON.stringify(session)],
      [turn, RDF_TYPE, `${DKG}ChatTurn`],
      [turn, `${SCHEMA}isPartOf`, sessionUri],
      [turn, `${DKG}turnId`, JSON.stringify(turnId)],
      [turn, `${DKG}persistenceState`, JSON.stringify(state)],
      [turn, `${SCHEMA}dateCreated`, `"${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`],
      [turn, `${DKG}hasUserMessage`, messageUri],
      [turn, `${DKG}hasAssistantMessage`, messageUri],
      [messageUri, `${SCHEMA}isPartOf`, sessionUri],
      [messageUri, `${SCHEMA}author`, `${CHAT}agent`],
      [messageUri, `${SCHEMA}text`, JSON.stringify(reply)],
      [messageUri, `${DKG}turnId`, JSON.stringify(turnId)],
      [messageUri, `${SCHEMA}dateCreated`, `"${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`],
    );
  };
  return { tools, insert, seed };
}
