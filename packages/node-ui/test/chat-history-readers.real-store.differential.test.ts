/**
 * Differential test for the chat-history readers over a real SPARQL engine.
 *
 * `chat-history-readers.differential.test.ts` compares the readers row by row,
 * but the rows do not say which subject a turn is stored under. That is the
 * other half of what the readers do: a turn lives under a session-scoped
 * subject, under the legacy `turn:<turnId>` subject, or under a legacy subject
 * that two sessions share (the previous code wrote both onto one subject), and
 * the queries select among them (`chatTurnSubjectPattern`, and the session
 * list's own exclusive-subject filter). So this test generates whole stores into
 * an in-memory Oxigraph, runs the readers as they were before the history rows
 * were assembled by shared helpers (`helpers/frozen-history-readers.ts`) and the
 * current `ChatMemoryManager` against the same store, and requires identical
 * output and identical queries.
 *
 * A generated store has several sessions that REUSE the same turn ids, so shared
 * legacy subjects arise as they did in real data; turns under a scoped subject,
 * under a legacy one, and under both at once; turn-less messages; 0 to 3
 * transitions per subject in every order of states; transitions with no reply,
 * no timestamp, attachment refs and tool calls; timestamps drawn from a small
 * pool so they tie; and sessions of more than 100 messages.
 */
import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.js';
import { CHAT, DKG, RDF_TYPE, SCHEMA, createChatTurnStoreFixture } from './helpers/chat-turn-store.js';
import { FrozenChatHistoryReaders } from './helpers/frozen-history-readers.js';
import { chance, int, mulberry32, pick, type Rand } from './helpers/seeded-random.js';

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const TRANSITION_TYPE = `${DKG}ChatTurnPersistenceTransition`;

type Triple = [string, string, string];

interface Stats {
  sharedLegacySubjects: number;
  bothSubjects: number;
  scopedSubjects: number;
  turnlessMessages: number;
  cappedSessions: number;
  completedReplies: number;
  transitions: number;
}

const TEXTS = ['hello', 'line one\nline two', 'he said "hi"', '# Title\n\n- a\n- b', 'naïve — 😀', 'back\\slash'] as const;
const STATES = ['pending', 'failed', 'stored', 'stored', 'in_progress', 'skipped'] as const;
const TOOL_CALLS = [undefined, undefined, JSON.stringify(JSON.stringify([{ name: 'search', args: { q: 'x' }, result: 'y' }]))] as const;
const ATTACHMENTS = [
  undefined,
  undefined,
  JSON.stringify(JSON.stringify([{ fileName: 'a.pdf', contextGraphId: 'cg', assertionUri: 'urn:a', fileHash: 'h' }])),
] as const;

const scopedSubject = (sessionId: string, turnId: string) => `${CHAT}session-turn:${encodeURIComponent(JSON.stringify([sessionId, turnId]))}`;
const legacySubject = (turnId: string) => `${CHAT}turn:${turnId}`;
const stamp = (n: number) => `"2026-03-08T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z"^^<${XSD_DATETIME}>`;

interface GeneratedStore {
  triples: Triple[];
  sessionIds: string[];
  /** Sessions past the list's per-session cap. */
  bigSessions: Set<string>;
}

/** Generate one store's quads; every reader then runs over the same ones. */
function generateStore(seed: number, stats: Stats): GeneratedStore {
  const rand: Rand = mulberry32(seed);
  const triples: Triple[] = [];
  const sessionCount = 2 + int(rand, 3);
  // The single-session query costs a scan per message and turn, so only some stores carry a session past the list cap.
  const bigIndex = seed % 6 === 0 ? int(rand, sessionCount) : -1;
  let counter = 0;
  const written = new Set<string>();
  const add = (subject: string, predicate: string, object: string) => {
    const key = `${subject}\n${predicate}\n${object}`;
    if (written.has(key)) return;
    written.add(key);
    triples.push([subject, predicate, object]);
  };
  const legacyLinkedTo = new Map<string, Set<string>>();
  const sessionIds: string[] = [];
  const bigSessions = new Set<string>();

  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = `s-${index}`;
    sessionIds.push(sessionId);
    const sessionUri = `${CHAT}session:${sessionId}`;
    add(sessionUri, RDF_TYPE, `${SCHEMA}Conversation`);
    add(sessionUri, `${DKG}sessionId`, JSON.stringify(sessionId));
    const big = index === bigIndex;
    const turnCount = big ? 52 + int(rand, 10) : int(rand, 6);
    if (big) {
      stats.cappedSessions += 1;
      bigSessions.add(sessionId);
    }
    const tsPool = big ? 30 : 8;
    for (let t = 0; t < turnCount; t += 1) {
      const turnId = `t${t}`;
      const base = int(rand, tsPool);
      const userUri = `${CHAT}msg:${seed}-${counter++}`;
      const agentUri = `${CHAT}msg:${seed}-${counter++}`;
      const turnless = chance(rand, 0.15);
      const kind = pick(rand, ['scoped', 'scoped', 'legacy', 'legacy', 'legacy', 'both'] as const);
      for (const [uri, author, ts] of [[userUri, 'user', base], [agentUri, 'agent', base + int(rand, 2)]] as const) {
        add(uri, RDF_TYPE, `${SCHEMA}Message`);
        add(uri, `${SCHEMA}isPartOf`, sessionUri);
        add(uri, `${SCHEMA}author`, `${CHAT}actor:${author}`);
        add(uri, `${SCHEMA}dateCreated`, stamp(ts));
        add(uri, `${SCHEMA}text`, JSON.stringify(pick(rand, TEXTS)));
        if (!turnless) add(uri, `${DKG}turnId`, JSON.stringify(turnId));
      }
      const refs = pick(rand, ATTACHMENTS);
      if (refs !== undefined) add(userUri, `${DKG}attachmentRefs`, refs);
      if (turnless) {
        stats.turnlessMessages += 2;
        continue;
      }
      const subjects = kind === 'scoped' ? [scopedSubject(sessionId, turnId)]
        : kind === 'legacy' ? [legacySubject(turnId)]
        : [scopedSubject(sessionId, turnId), legacySubject(turnId)];
      if (kind === 'both') stats.bothSubjects += 1;
      for (const subject of subjects) {
        if (subject.startsWith(`${CHAT}session-turn:`)) stats.scopedSubjects += 1;
        else {
          const linked = legacyLinkedTo.get(subject) ?? new Set<string>();
          linked.add(sessionId);
          legacyLinkedTo.set(subject, linked);
        }
        add(subject, RDF_TYPE, `${DKG}ChatTurn`);
        add(subject, `${SCHEMA}isPartOf`, sessionUri);
        add(subject, `${DKG}turnId`, JSON.stringify(turnId));
        add(subject, `${SCHEMA}dateCreated`, stamp(base));
        add(subject, `${DKG}hasUserMessage`, userUri);
        // A malformed link names the user message as the assistant Message now and then.
        add(subject, `${DKG}hasAssistantMessage`, chance(rand, 0.04) ? userUri : agentUri);
        if (chance(rand, 0.9)) add(subject, `${DKG}persistenceState`, JSON.stringify(pick(rand, ['pending', 'failed', 'stored'] as const)));
        if (chance(rand, 0.2)) add(subject, `${DKG}failureReason`, JSON.stringify('turn failed'));
        for (let n = pick(rand, [0, 0, 1, 1, 2, 3]); n > 0; n -= 1) {
          const transition = `${CHAT}turn-transition:${seed}-${counter++}`;
          const state = pick(rand, STATES);
          stats.transitions += 1;
          add(transition, RDF_TYPE, TRANSITION_TYPE);
          add(transition, `${DKG}updatesTurn`, subject);
          add(transition, `${DKG}turnId`, JSON.stringify(turnId));
          add(transition, `${DKG}persistenceState`, JSON.stringify(state));
          if (chance(rand, 0.8)) add(transition, `${SCHEMA}dateCreated`, stamp(int(rand, 6)));
          if (chance(rand, 0.85)) add(transition, `${DKG}assistantReply`, JSON.stringify(`final ${pick(rand, TEXTS)} ${int(rand, 9)}`));
          if (chance(rand, 0.3)) add(transition, `${DKG}failureReason`, JSON.stringify('provider timed out'));
          const transitionRefs = pick(rand, ATTACHMENTS);
          if (transitionRefs !== undefined) add(transition, `${DKG}attachmentRefs`, transitionRefs);
          const toolCalls = pick(rand, TOOL_CALLS);
          if (toolCalls !== undefined) add(transition, `${DKG}toolCalls`, toolCalls);
        }
      }
    }
  }
  stats.sharedLegacySubjects += [...legacyLinkedTo.values()].filter((sessions) => sessions.size > 1).length;
  return { triples, sessionIds, bigSessions };
}

interface Recorded {
  sparql: string;
  opts: unknown;
}

/** The fixture's tools over `store`, recording the history reads (not the manager's own start-up read). */
function recordingTools(store: OxigraphStore) {
  const { tools } = createChatTurnStoreFixture(store);
  const calls: Recorded[] = [];
  return {
    calls,
    tools: {
      ...tools,
      query: async (sparql: string, opts?: unknown) => {
        if (!sparql.startsWith('SELECT ?sid WHERE')) calls.push({ sparql, opts });
        return tools.query(sparql);
      },
    },
  };
}

function expectSame(actual: unknown, expected: unknown, context: string) {
  try {
    expect(actual).toStrictEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } catch (error) {
    throw new Error(`${context}: ${(error as Error).message}`);
  }
}

const SEEDS = Array.from({ length: 96 }, (_, i) => 7000 + i * 104729);

describe('chat-history readers against the frozen pre-refactor readers, over a real store', () => {
  it('getRecentChats and getSession return the same messages and ask the same queries, for every subject layout', async () => {
    const stats: Stats = {
      sharedLegacySubjects: 0, bothSubjects: 0, scopedSubjects: 0, turnlessMessages: 0, cappedSessions: 0, completedReplies: 0, transitions: 0,
    };
    let sessionsRead = 0;
    let statuses = 0;
    for (const seed of SEEDS) {
      const store = new OxigraphStore();
      const { insert } = createChatTurnStoreFixture(store);
      const generated = generateStore(seed, stats);
      await insert(...generated.triples);

      for (const limit of [1, 3, 20]) {
        const before = recordingTools(store);
        const after = recordingTools(store);
        const expected = await new FrozenChatHistoryReaders(before.tools).getRecentChats(limit);
        const actual = await new ChatMemoryManager(after.tools, { apiKey: '' }).getRecentChats(limit);
        expectSame(actual, expected, `seed ${seed}, getRecentChats(${limit})`);
        expect(after.calls).toEqual(before.calls);
        for (const chat of actual) for (const message of chat.messages) if (message.text.startsWith('final')) stats.completedReplies += 1;
      }
      for (const sessionId of generated.sessionIds) {
        // A session past the list cap is read through a window: a full read of it is the slow query.
        const windows = generated.bigSessions.has(sessionId)
          ? [{ limit: 7, order: 'desc' as const }]
          : [{}, { limit: 7, order: 'desc' as const }, { limit: 100, order: 'asc' as const }];
        for (const opts of windows) {
          const before = recordingTools(store);
          const after = recordingTools(store);
          const expected = await new FrozenChatHistoryReaders(before.tools).getSession(sessionId, opts);
          const actual = await new ChatMemoryManager(after.tools, { apiKey: '' }).getSession(sessionId, opts);
          expectSame(actual, expected, `seed ${seed}, getSession(${sessionId}, ${JSON.stringify(opts)})`);
          expect(after.calls).toEqual(before.calls);
          if (actual) sessionsRead += 1;
          for (const message of actual?.messages ?? []) if (message.persistStatus) statuses += 1;
        }
      }
    }
    // The corpus has to reach the layouts the selection queries choose among.
    expect(stats.sharedLegacySubjects).toBeGreaterThan(80);
    expect(stats.bothSubjects).toBeGreaterThan(150);
    expect(stats.scopedSubjects).toBeGreaterThan(400);
    expect(stats.turnlessMessages).toBeGreaterThan(200);
    expect(stats.cappedSessions).toBeGreaterThanOrEqual(15);
    expect(stats.transitions).toBeGreaterThan(1000);
    expect(stats.completedReplies).toBeGreaterThan(500);
    expect(sessionsRead).toBeGreaterThan(400);
    expect(statuses).toBeGreaterThan(1500);
  }, 300_000);
});
