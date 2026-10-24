/**
 * Chat turns written straight into the chat-turns assertion in the RDF shape the
 * previous storage format used: one subject per turn id, `urn:dkg:chat:turn:<turnId>`,
 * which two sessions that reused an id shared. Nothing rewrites such turns, so
 * the current code has to keep reading and completing them; a test cannot create
 * one through the current `storeChatExchange`, so it writes the quads itself.
 *
 * `createLegacyChatTurnWriter` takes a getter for the running fixture parts
 * because the suite's agent only exists after its `beforeAll`.
 */
import { randomUUID } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, type ChatMemoryManager } from '@origintrail-official/dkg-node-ui';

export const CHAT = 'urn:dkg:chat:';
export const SCHEMA_ORG = 'http://schema.org/';
export const DKG = 'http://dkg.io/ontology/';
export const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_DATETIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';

/** The one subject the previous code wrote a turn id under, for every session. */
export const legacySubject = (turnId: string): string => `${CHAT}turn:${turnId}`;

/** The subject a new turn of `(sessionId, turnId)` is written under: the URI-encoded JSON of the pair. */
export const scopedSubject = (sessionId: string, turnId: string): string =>
  `${CHAT}session-turn:${encodeURIComponent(JSON.stringify([sessionId, turnId]))}`;

const quad = (subject: string, predicate: string, object: string) => ({ subject, predicate, object, graph: '' });

export interface LegacyTurnState {
  persistenceState: 'stored' | 'failed' | 'pending';
  userText: string;
  assistantText: string;
  failureReason?: string;
}

export function createLegacyChatTurnWriter(
  parts: () => { agent: DKGAgent; agentAddress: string; memoryManager: ChatMemoryManager },
) {
  /** What `storeChatExchange` wrote for a turn with a turn id before session-scoped subjects. */
  async function writeLegacyTurn(sessionId: string, turnId: string, turnState: LegacyTurnState): Promise<void> {
    const { agent, agentAddress, memoryManager } = parts();
    await memoryManager.ensureInitialized();
    const suffix = randomUUID().slice(0, 8);
    const session = `${CHAT}session:${sessionId}`;
    const turnUri = legacySubject(turnId);
    const user = `${CHAT}msg:legacy-user-${suffix}`;
    const assistant = `${CHAT}msg:legacy-assistant-${suffix}`;
    const at = new Date();
    const stamp = (offsetMs: number) => `"${new Date(at.getTime() + offsetMs).toISOString()}"^^<${XSD_DATETIME_IRI}>`;
    await agent.assertion.write(AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, [
      quad(session, RDF_TYPE_IRI, `${SCHEMA_ORG}Conversation`),
      quad(session, `${DKG}sessionId`, `"${sessionId}"`),
      quad(user, RDF_TYPE_IRI, `${SCHEMA_ORG}Message`),
      quad(user, `${SCHEMA_ORG}isPartOf`, session),
      quad(user, `${SCHEMA_ORG}author`, `${CHAT}actor:user`),
      quad(user, `${SCHEMA_ORG}dateCreated`, stamp(0)),
      quad(user, `${SCHEMA_ORG}text`, JSON.stringify(turnState.userText)),
      quad(assistant, RDF_TYPE_IRI, `${SCHEMA_ORG}Message`),
      quad(assistant, `${SCHEMA_ORG}isPartOf`, session),
      quad(assistant, `${SCHEMA_ORG}author`, `${CHAT}actor:agent`),
      quad(assistant, `${SCHEMA_ORG}dateCreated`, stamp(1)),
      quad(assistant, `${SCHEMA_ORG}text`, JSON.stringify(turnState.assistantText)),
      quad(assistant, `${DKG}replyTo`, user),
      quad(turnUri, RDF_TYPE_IRI, `${DKG}ChatTurn`),
      quad(turnUri, `${SCHEMA_ORG}isPartOf`, session),
      quad(turnUri, `${DKG}turnId`, JSON.stringify(turnId)),
      quad(turnUri, `${SCHEMA_ORG}dateCreated`, stamp(0)),
      quad(turnUri, `${DKG}hasUserMessage`, user),
      quad(turnUri, `${DKG}hasAssistantMessage`, assistant),
      quad(turnUri, `${DKG}persistenceState`, JSON.stringify(turnState.persistenceState)),
      ...(turnState.persistenceState === 'failed' && turnState.failureReason
        ? [quad(turnUri, `${DKG}failureReason`, JSON.stringify(turnState.failureReason))]
        : []),
      quad(user, `${DKG}turnId`, JSON.stringify(turnId)),
      quad(assistant, `${DKG}turnId`, JSON.stringify(turnId)),
    ], { agentAddress });
  }

  /**
   * A `stored` transition on `turnSubject`, stamped `at`, written straight to the
   * assertion: the completion as the previous code attached it, and the way a
   * test gets two `stored` transitions on one turn (the durable-turn owner never
   * writes a second one).
   */
  async function writeStoredTransition(turnSubject: string, turnId: string, assistantReply: string, at = new Date()): Promise<void> {
    const { agent, agentAddress } = parts();
    const transition = `${CHAT}turn-transition:legacy-${randomUUID().slice(0, 8)}`;
    await agent.assertion.write(AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, [
      quad(transition, RDF_TYPE_IRI, `${DKG}ChatTurnPersistenceTransition`),
      quad(transition, `${DKG}updatesTurn`, turnSubject),
      quad(transition, `${DKG}turnId`, JSON.stringify(turnId)),
      quad(transition, `${DKG}persistenceState`, JSON.stringify('stored')),
      quad(transition, `${SCHEMA_ORG}dateCreated`, `"${at.toISOString()}"^^<${XSD_DATETIME_IRI}>`),
      quad(transition, `${DKG}assistantReply`, JSON.stringify(assistantReply)),
    ], { agentAddress });
  }

  return { writeLegacyTurn, writeStoredTransition };
}
