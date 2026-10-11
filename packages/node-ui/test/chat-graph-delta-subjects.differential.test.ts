/**
 * Differential test for the subjects of a turn's graph delta.
 *
 * `selectGraphDeltaSubjects` reads the turn's related subjects with one query per
 * relation, because the single UNION query it replaced is refused on a
 * working-memory view that spans more than one graph. On a single graph, where the
 * old query runs, the two have to select the same subjects. This test writes
 * generated stores into an in-memory Oxigraph, runs the old query
 * (`helpers/frozen-graph-delta-subjects.ts`, a frozen copy) and the new selection
 * from every turn subject of every session as the anchor, and requires the same
 * set of subjects.
 *
 * A generated store has sessions that reuse turn ids, turns under scoped, legacy
 * and shared subjects, transitions on the anchor and on another subject of the
 * same turn id, tools the assistant used (and tools other messages used),
 * resources that mention either message of the turn (and another turn's), and
 * memories extracted from the session (and from another session) that contain an
 * entity a message mentions.
 */
import { describe, expect, it } from 'vitest';
import { selectGraphDeltaSubjects } from '../src/chat-graph-delta-subjects.js';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.js';
import { CHAT, DKG, RDF_TYPE, SCHEMA, createChatTurnStoreFixture } from './helpers/chat-turn-store.js';
import { frozenGraphDeltaSubjects } from './helpers/frozen-graph-delta-subjects.js';
import { chance, int, mulberry32, pick } from './helpers/seeded-random.js';

type Triple = [string, string, string];

interface Anchor {
  sessionUri: string;
  turnUri: string;
  userMsgUri: string;
  assistantMsgUri: string;
}

interface Stats {
  anchors: number;
  withTransitions: number;
  withTools: number;
  withMentions: number;
  withMemories: number;
}

function generateStore(seed: number): { triples: Triple[]; anchors: Anchor[] } {
  const rand = mulberry32(seed);
  const triples: Triple[] = [];
  const anchors: Anchor[] = [];
  let counter = 0;
  const next = (prefix: string) => `${CHAT}${prefix}:${seed}-${counter++}`;
  const sessions = Array.from({ length: 2 + int(rand, 2) }, (_, i) => `${CHAT}session:s-${i}`);
  const messagesOf = new Map<string, string[]>();
  for (const sessionUri of sessions) triples.push([sessionUri, RDF_TYPE, `${SCHEMA}Conversation`]);

  for (const sessionUri of sessions) {
    for (let t = 0; t < 1 + int(rand, 3); t += 1) {
      const turnId = `t${t}`;
      const user = next('msg');
      const assistant = next('msg');
      messagesOf.set(sessionUri, [...(messagesOf.get(sessionUri) ?? []), user, assistant]);
      for (const message of [user, assistant]) {
        triples.push([message, RDF_TYPE, `${SCHEMA}Message`], [message, `${SCHEMA}isPartOf`, sessionUri], [message, `${DKG}turnId`, JSON.stringify(turnId)]);
      }
      const kind = pick(rand, ['scoped', 'legacy', 'both'] as const);
      const subjects = [
        ...(kind !== 'legacy' ? [`${CHAT}session-turn:${encodeURIComponent(JSON.stringify([sessionUri, turnId]))}`] : []),
        ...(kind !== 'scoped' ? [`${CHAT}turn:${turnId}`] : []),
      ];
      for (const subject of subjects) {
        triples.push(
          [subject, RDF_TYPE, `${DKG}ChatTurn`], [subject, `${SCHEMA}isPartOf`, sessionUri], [subject, `${DKG}turnId`, JSON.stringify(turnId)],
          [subject, `${DKG}hasUserMessage`, user], [subject, `${DKG}hasAssistantMessage`, assistant],
        );
        anchors.push({ sessionUri, turnUri: subject, userMsgUri: user, assistantMsgUri: assistant });
      }
      // Transitions point at one subject or at another of the same turn id.
      for (let n = int(rand, 4); n > 0; n -= 1) {
        const transition = next('turn-transition');
        triples.push([transition, RDF_TYPE, `${DKG}ChatTurnPersistenceTransition`], [transition, `${DKG}updatesTurn`, pick(rand, subjects)], [transition, `${DKG}persistenceState`, JSON.stringify('stored')]);
      }
      // Resources that hang off the messages.
      for (let n = int(rand, 3); n > 0; n -= 1) triples.push([assistant, `${DKG}usedTool`, next('tool')]);
      for (let n = int(rand, 3); n > 0; n -= 1) triples.push([next('tool'), `${DKG}usedTool`, pick(rand, [user, assistant])]);
      for (let n = int(rand, 3); n > 0; n -= 1) triples.push([next('entity'), `${DKG}mentionedIn`, pick(rand, [user, assistant])]);
      if (chance(rand, 0.6)) {
        const entity = next('entity');
        const memory = `urn:dkg:memory:${seed}-${counter++}`;
        triples.push([entity, `${DKG}mentionedIn`, pick(rand, [user, assistant])], [memory, `${DKG}contains`, entity], [memory, `${DKG}extractedFrom`, chance(rand, 0.75) ? sessionUri : pick(rand, sessions)]);
      }
    }
  }
  return { triples, anchors };
}

describe('graph-delta subjects against the frozen single-UNION query, over a real store', () => {
  it('selects the same subjects from every turn subject, for every layout', async () => {
    const stats: Stats = { anchors: 0, withTransitions: 0, withTools: 0, withMentions: 0, withMemories: 0 };
    for (let seed = 1; seed <= 80; seed += 1) {
      const store = new OxigraphStore();
      const { tools, insert } = createChatTurnStoreFixture(store);
      const { triples, anchors } = generateStore(seed * 7919);
      await insert(...triples);
      const query = (sparql: string) => tools.query(sparql) as Promise<{ bindings?: Array<Record<string, string>> }>;

      for (const anchor of anchors) {
        const expected = await frozenGraphDeltaSubjects(query, anchor);
        const actual = await selectGraphDeltaSubjects(query, anchor);

        expect([...actual].sort(), `seed ${seed}, ${anchor.turnUri}`).toEqual([...expected].sort());
        expect(new Set(actual).size).toBe(actual.length);
        expect(actual.slice(0, 4)).toEqual([anchor.sessionUri, anchor.turnUri, anchor.userMsgUri, anchor.assistantMsgUri]);
        stats.anchors += 1;
        stats.withTransitions += actual.some((subject) => subject.includes('turn-transition')) ? 1 : 0;
        stats.withTools += actual.some((subject) => subject.includes(':tool:')) ? 1 : 0;
        stats.withMentions += actual.some((subject) => subject.includes(':entity:')) ? 1 : 0;
        stats.withMemories += actual.some((subject) => subject.startsWith('urn:dkg:memory:')) ? 1 : 0;
      }
    }
    // The generated stores must reach every relation the selection reads, or equality says little.
    expect(stats.anchors).toBeGreaterThan(300);
    expect(stats.withTransitions).toBeGreaterThan(100);
    expect(stats.withTools).toBeGreaterThan(100);
    expect(stats.withMentions).toBeGreaterThan(100);
    expect(stats.withMemories).toBeGreaterThan(30);
  }, 120_000);
});
