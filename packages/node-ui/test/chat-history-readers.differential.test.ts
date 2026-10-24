/**
 * Differential test for the chat-history readers of `ChatMemoryManager`, at the
 * level of the rows a store returns.
 *
 * `getSession` and `getRecentChats` assemble their messages from those rows, and
 * the assembly now keeps ONE accumulated message per message URI (a Map from URI
 * to the message object) built by helpers the two readers share
 * (`src/chat-history-rows.ts`). This test is the proof that moving to that shape
 * changed nothing: it runs the readers as they were before
 * (`helpers/frozen-history-readers.ts`, a verbatim frozen copy) and the current
 * `ChatMemoryManager` over the same generated stores, and requires
 *
 *   - identical output (`toStrictEqual`, which also tells a missing key from a
 *     key holding `undefined`, and the JSON text, which also fixes key order), and
 *   - identical queries (same text, same options, same count): the batch query
 *     and its two-query shape are part of what must not move.
 *
 * A store here is a few sessions of messages and turns, each turn with 0 to 3
 * transitions in every order of states, turn-less messages, turns whose
 * transitions have no reply or no timestamp, a session of more than 100 messages
 * (so the list cap bites, including on messages that come back several times),
 * timestamps drawn from a small pool so they tie, a message that belongs to two
 * sessions, rows with no message URI and rows with no session. The rows are what
 * the two queries return for it, in the order their ORDER BY gives, and again in
 * a shuffled order (the readers must agree for any row order).
 *
 * What this cannot show: which subject a turn is stored under (legacy,
 * session-scoped, or one two sessions share) does not appear in the projected
 * columns, so the row-level corpus cannot vary it.
 * `chat-history-readers.real-store.differential.test.ts` does, over a real
 * SPARQL engine.
 */
import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { FrozenChatHistoryReaders } from './helpers/frozen-history-readers.js';
import { chance, int, mulberry32, pick, shuffled, type Rand } from './helpers/seeded-random.js';

const CHAT = 'urn:dkg:chat:';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const AGENT_ADDRESS = 'did:dkg:agent:test';

type Row = Record<string, string>;

// --- a seeded generator -----------------------------------------------------

interface Transition {
  state: string | undefined;
  reply: string | undefined;
  ts: string | undefined;
  failureReason: string | undefined;
  attachmentRefs: string | undefined;
  toolCalls: string | undefined;
}

interface Msg {
  uri: string;
  author: 'user' | 'agent';
  text: string;
  ts: string;
  turnId: string | undefined;
  attachmentRefs: string | undefined;
}

interface Turn {
  id: string;
  state: string | undefined;
  failureReason: string | undefined;
  /** The message the turn names as its assistant Message (a malformed link names a user message). */
  assistantUri: string;
  transitions: Transition[];
}

interface GenSession {
  uri: string;
  sessionId: string;
  msgs: Msg[];
  turns: Turn[];
}

interface Corpus {
  sessions: GenSession[];
  /** What the session-list query's first query answers: one binding per session root. */
  sessionBindings: Row[];
}

interface Stats {
  cappedSessions: number;
  completedReplies: number;
  multiTransitionMessages: number;
  turnlessMessages: number;
  sharedMessages: number;
}

const TEXTS = ['hello', '', 'line one\nline two', 'he said "hi"', '# Title\n\n- a\n- b', 'naïve — 😀', 'back\\slash', 'tab\there'] as const;
const STATES = ['pending', 'failed', 'stored', 'stored', 'stored', 'in_progress', 'skipped', 'weird'] as const;
const REPLIES = ['final answer', 'multi\nline "reply"', '# md\n\n- x', '', undefined, 'later answer'] as const;
const TOOL_CALLS = [
  undefined,
  undefined,
  JSON.stringify(JSON.stringify([{ name: 'search', args: { q: 'x' }, result: 'y' }])),
  'not json',
] as const;
const ATTACHMENTS = [
  undefined,
  undefined,
  undefined,
  JSON.stringify(JSON.stringify([{ fileName: 'a.pdf', contextGraphId: 'cg', assertionUri: 'urn:a', fileHash: 'h' }])),
  'garbage',
] as const;

const stamp = (n: number) => `2026-03-08T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`;

function generateCorpus(seed: number, stats: Stats): Corpus {
  const rand = mulberry32(seed);
  const sessionCount = 1 + int(rand, 5);
  const bigIndex = chance(rand, 0.45) ? int(rand, sessionCount) : -1;
  const sessions: GenSession[] = [];
  let msgCounter = 0;
  for (let index = 0; index < sessionCount; index += 1) {
    const big = index === bigIndex;
    const turnCount = big ? 52 + int(rand, 12) : int(rand, 7);
    const tsPool = big ? 30 : 10;
    const session: GenSession = { uri: `${CHAT}session:s-${index}`, sessionId: `s-${index}`, msgs: [], turns: [] };
    for (let t = 0; t < turnCount; t += 1) {
      const base = int(rand, tsPool);
      const tied = chance(rand, 0.5);
      const userUri = `${CHAT}msg:${seed}-${msgCounter++}`;
      const agentUri = `${CHAT}msg:${seed}-${msgCounter++}`;
      const hasTurn = chance(rand, 0.88);
      const turnId = hasTurn ? `t${t}` : undefined;
      session.msgs.push(
        { uri: userUri, author: 'user', text: pick(rand, TEXTS), ts: stamp(base), turnId, attachmentRefs: pick(rand, ATTACHMENTS) },
        { uri: agentUri, author: 'agent', text: pick(rand, TEXTS), ts: stamp(base + (tied ? 0 : 1)), turnId, attachmentRefs: undefined },
      );
      if (!hasTurn) {
        stats.turnlessMessages += 2;
        continue;
      }
      const transitions: Transition[] = Array.from({ length: pick(rand, [0, 0, 1, 1, 2, 3]) }, () => {
        const state = chance(rand, 0.06) ? undefined : pick(rand, STATES);
        return {
          state,
          reply: pick(rand, REPLIES),
          ts: chance(rand, 0.2) ? undefined : stamp(int(rand, 6)),
          failureReason: pick(rand, [undefined, 'boom', 'provider timed out']),
          attachmentRefs: pick(rand, ATTACHMENTS),
          toolCalls: pick(rand, TOOL_CALLS),
        };
      });
      session.turns.push({
        id: turnId!,
        state: chance(rand, 0.05) ? undefined : pick(rand, ['pending', 'failed', 'stored'] as const),
        failureReason: pick(rand, [undefined, 'turn failed']),
        assistantUri: chance(rand, 0.04) ? userUri : agentUri,
        transitions,
      });
    }
    sessions.push(session);
  }
  // A message that belongs to two sessions (it comes back under both).
  if (sessions.length > 1 && chance(rand, 0.25)) {
    const [from, to] = [sessions[0], sessions[sessions.length - 1]];
    if (from.msgs.length > 0) {
      to.msgs.push(from.msgs[int(rand, from.msgs.length)]);
      stats.sharedMessages += 1;
    }
  }
  // Session roots: the order the first query answers in, a root that repeats a
  // session id, one that is not a safe IRI and one with no `sid`.
  const sessionBindings: Row[] = shuffled(rand, sessions).map((s) => ({ s: s.uri, sid: JSON.stringify(s.sessionId) }));
  if (chance(rand, 0.3) && sessions.length > 0) sessionBindings.push({ s: `${CHAT}session:dup-root`, sid: JSON.stringify(sessions[0].sessionId) });
  if (chance(rand, 0.2)) sessionBindings.push({ s: 'not an iri<', sid: '"bad"' });
  if (chance(rand, 0.15)) sessionBindings.splice(int(rand, sessionBindings.length + 1), 0, { s: `${CHAT}session:no-sid` });
  return { sessions, sessionBindings };
}

// --- the rows the two queries return ------------------------------------------

const literal = (rand: Rand, value: string) => (chance(rand, 0.3) ? `"${value}"^^<${XSD_DATETIME}>` : `"${value}"`);
const bracketed = (rand: Rand, uri: string) => (chance(rand, 0.1) ? `<${uri}>` : uri);

/** The rows of the session-list query for the sessions named in its VALUES, in its ORDER BY. */
function listRows(corpus: Corpus, sessionUris: readonly string[], seed: number, stats: Stats): Row[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const keyed: Array<{ key: [string, string, string]; row: Row }> = [];
  const wanted = new Set(sessionUris);
  for (const session of corpus.sessions) {
    if (!wanted.has(session.uri)) continue;
    const perUri = new Map<string, number>();
    for (const msg of session.msgs) {
      const turn = session.turns.find((candidate) => candidate.assistantUri === msg.uri);
      const joined = (turn?.transitions ?? []).filter((tr) => tr.state !== undefined && tr.reply !== undefined);
      const base: Row = {
        session: session.uri,
        m: bracketed(rand, msg.uri),
        author: `${CHAT}actor:${msg.author}`,
        text: JSON.stringify(msg.text),
        ts: literal(rand, msg.ts),
      };
      if (joined.length === 0) {
        keyed.push({ key: [session.uri, msg.ts, ''], row: base });
      } else {
        for (const tr of joined) {
          keyed.push({
            key: [session.uri, msg.ts, tr.ts ?? ''],
            row: { ...base, transitionState: JSON.stringify(tr.state), transitionAssistantReply: JSON.stringify(tr.reply) },
          });
        }
        if (joined.length > 1) perUri.set(msg.uri, joined.length);
      }
    }
    stats.multiTransitionMessages += perUri.size;
    if (session.msgs.length > 100) stats.cappedSessions += 1;
  }
  // Rows that name no message URI (the query never joins one to a turn), and one that names no session.
  if (chance(rand, 0.25) && corpus.sessions.length > 0) {
    const [first] = corpus.sessions;
    for (let i = 0; i < 1 + int(rand, 3); i += 1) {
      const uriless: Row = {
        session: first.uri,
        author: `${CHAT}actor:${pick(rand, ['user', 'agent'] as const)}`,
        text: JSON.stringify(pick(rand, TEXTS)),
        ts: `"${stamp(int(rand, 10))}"`,
      };
      // The query joins a turn's transitions through the message URI, so it cannot
      // return such a row with a transition; a reader must still treat one as it always did.
      if (chance(rand, 0.4)) Object.assign(uriless, { transitionState: JSON.stringify('stored'), transitionAssistantReply: JSON.stringify('final: must not complete a row with no URI') });
      keyed.push({ key: [first.uri, stamp(int(rand, 10)), ''], row: uriless });
    }
  }
  if (chance(rand, 0.15)) {
    keyed.push({ key: ['', stamp(0), ''], row: { m: `${CHAT}msg:orphan-${seed}`, author: `${CHAT}actor:agent`, text: '"orphan"', ts: `"${stamp(0)}"` } });
  }
  keyed.sort((a, b) => a.key[0].localeCompare(b.key[0]) || a.key[1].localeCompare(b.key[1]) || a.key[2].localeCompare(b.key[2]));
  return keyed.map(({ row }) => row);
}

/** The rows of the single-session query for one session: its first `limit` messages by `ts`, joined to their turns. */
function sessionRows(session: GenSession, limit: number, order: 'ASC' | 'DESC', seed: number): Row[] {
  const rand = mulberry32(seed ^ 0x85ebca6b);
  const sign = order === 'ASC' ? 1 : -1;
  const chosen = session.msgs
    .map((msg, index) => ({ msg, index }))
    .sort((a, b) => sign * a.msg.ts.localeCompare(b.msg.ts) || a.index - b.index)
    .slice(0, limit);
  const keyed: Array<{ ts: string; row: Row }> = [];
  for (const { msg } of chosen) {
    const base: Row = {
      m: bracketed(rand, msg.uri),
      author: `${CHAT}actor:${msg.author}`,
      text: JSON.stringify(msg.text),
      ts: literal(rand, msg.ts),
    };
    if (msg.turnId !== undefined) base.turnId = JSON.stringify(msg.turnId);
    if (msg.attachmentRefs !== undefined) base.attachmentRefs = msg.attachmentRefs;
    // The turn join: the turn whose id the message carries, or, for a message with
    // no turn id, every turn of the session (the OPTIONAL leaves ?turnId free).
    const turns = msg.turnId === undefined ? session.turns : session.turns.filter((turn) => turn.id === msg.turnId);
    if (turns.length === 0) {
      keyed.push({ ts: msg.ts, row: base });
      continue;
    }
    for (const turn of turns) {
      const withTurn: Row = { ...base };
      if (msg.turnId === undefined) withTurn.turnId = JSON.stringify(turn.id);
      if (turn.state !== undefined) withTurn.persistenceState = JSON.stringify(turn.state);
      if (turn.failureReason !== undefined) withTurn.failureReason = JSON.stringify(turn.failureReason);
      const transitions = turn.transitions.filter((tr) => tr.state !== undefined);
      if (transitions.length === 0) {
        keyed.push({ ts: msg.ts, row: withTurn });
        continue;
      }
      for (const tr of transitions) {
        const row: Row = { ...withTurn, transitionState: JSON.stringify(tr.state) };
        if (tr.failureReason !== undefined) row.transitionFailureReason = JSON.stringify(tr.failureReason);
        if (tr.reply !== undefined) row.transitionAssistantReply = JSON.stringify(tr.reply);
        if (tr.attachmentRefs !== undefined) row.transitionAttachmentRefs = tr.attachmentRefs;
        if (tr.toolCalls !== undefined) row.transitionToolCalls = tr.toolCalls;
        keyed.push({ ts: msg.ts, row });
      }
    }
  }
  keyed.sort((a, b) => sign * a.ts.localeCompare(b.ts));
  return keyed.map(({ row }) => row);
}

// --- a store that answers the readers' queries from a corpus ------------------

interface RecordedCall {
  sparql: string;
  opts: unknown;
}

function storeOver(corpus: Corpus, seed: number, stats: Stats, rowOrder: 'sorted' | 'shuffled') {
  const calls: RecordedCall[] = [];
  const reorder = (rows: Row[], salt: number) => (rowOrder === 'sorted' ? rows : shuffled(mulberry32(seed ^ salt), rows));
  const query = async (sparql: string, opts?: unknown) => {
    // The manager's own "known sessions" read on first use is not a history read.
    if (sparql.startsWith('SELECT ?sid WHERE')) return { bindings: [] };
    calls.push({ sparql, opts });
    if (sparql.startsWith('SELECT ?s ?sid (MAX')) return { bindings: corpus.sessionBindings };
    if (sparql.startsWith('SELECT ?session ?author')) {
      const values = /VALUES \?session \{([^}]*)\}/.exec(sparql)![1];
      const uris = [...values.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
      return { bindings: reorder(listRows(corpus, uris, seed, stats), 1) };
    }
    if (sparql.startsWith('SELECT ?m ?author')) {
      const sessionUri = /isPartOf> <(urn:dkg:chat:session:[^>]+)>/.exec(sparql)![1];
      const [, order, limit] = /ORDER BY (ASC|DESC)\(\?ts\) LIMIT (\d+)/.exec(sparql)!;
      const session = corpus.sessions.find((candidate) => candidate.uri === sessionUri);
      return { bindings: session ? reorder(sessionRows(session, Number(limit), order as 'ASC' | 'DESC', seed), 2) : [] };
    }
    throw new Error(`unexpected query: ${sparql.slice(0, 80)}`);
  };
  return { query, calls };
}

function managerOver(query: (sparql: string, opts?: unknown) => Promise<unknown>) {
  return new ChatMemoryManager(
    {
      query: query as never,
      createAssertion: async () => ({ assertionUri: 'urn:test:assertion', alreadyExists: false }),
      writeAssertion: async () => ({ written: 0 }),
      createContextGraph: async () => undefined,
      listContextGraphs: async () => [{ id: 'agent-context', name: 'Agent Context' }],
    },
    { apiKey: '' },
    { agentAddress: AGENT_ADDRESS },
  );
}

const SEEDS = Array.from({ length: 240 }, (_, i) => 1000 + i * 7919);
const newStats = (): Stats => ({ cappedSessions: 0, completedReplies: 0, multiTransitionMessages: 0, turnlessMessages: 0, sharedMessages: 0 });

/** Both results, and proof they are the same thing: equal values, equal keys (also `undefined` ones), equal JSON text. */
function expectSame(actual: unknown, expected: unknown, context: string) {
  try {
    expect(actual).toStrictEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } catch (error) {
    throw new Error(`${context}: ${(error as Error).message}`);
  }
}

describe.each(['sorted', 'shuffled'] as const)('chat-history readers against the frozen pre-refactor readers, rows %s', (rowOrder) => {
  it('getRecentChats lists the same messages and asks the same queries, over generated stores', async () => {
    const stats = newStats();
    let messages = 0;
    for (const seed of SEEDS) {
      const corpus = generateCorpus(seed, stats);
      for (const limit of [1, 3, 20, 100]) {
        const before = storeOver(corpus, seed, stats, rowOrder);
        const after = storeOver(corpus, seed, stats, rowOrder);

        const expected = await new FrozenChatHistoryReaders({ query: before.query }, AGENT_ADDRESS).getRecentChats(limit);
        const actual = await managerOver(after.query).getRecentChats(limit);

        expectSame(actual, expected, `seed ${seed}, limit ${limit}`);
        expect(after.calls).toEqual(before.calls);
        messages += actual.reduce((sum, chat) => sum + chat.messages.length, 0);
        for (const chat of actual) for (const msg of chat.messages) if (msg.text.startsWith('final')) stats.completedReplies += 1;
      }
    }
    // The corpus must reach what the refactor touches, or the equality above says little.
    expect(messages).toBeGreaterThan(20000);
    expect(stats.cappedSessions).toBeGreaterThan(200);
    expect(stats.multiTransitionMessages).toBeGreaterThan(2000);
    expect(stats.completedReplies).toBeGreaterThan(500);
    expect(stats.turnlessMessages).toBeGreaterThan(1000);
    expect(stats.sharedMessages).toBeGreaterThan(10);
  });

  it('getSession returns the same messages and asks the same queries, over generated stores', async () => {
    const stats = newStats();
    let withTransitions = 0;
    let withStatus = 0;
    let withToolCalls = 0;
    let withRefs = 0;
    // Half the seeds: a session's rows include the join of every turn-less message to every turn.
    for (const seed of SEEDS.filter((_, i) => i % 2 === 0)) {
      const corpus = generateCorpus(seed, stats);
      for (const session of corpus.sessions) {
        for (const opts of [{}, { limit: 7, order: 'desc' as const }, { limit: 100, order: 'asc' as const }]) {
          const before = storeOver(corpus, seed, stats, rowOrder);
          const after = storeOver(corpus, seed, stats, rowOrder);

          const expected = await new FrozenChatHistoryReaders({ query: before.query }, AGENT_ADDRESS).getSession(session.sessionId, opts);
          const actual = await managerOver(after.query).getSession(session.sessionId, opts);

          expectSame(actual, expected, `seed ${seed}, session ${session.sessionId}, ${JSON.stringify(opts)}`);
          expect(after.calls).toEqual(before.calls);
          for (const msg of actual?.messages ?? []) {
            if (msg.text.startsWith('final')) withTransitions += 1;
            if (msg.persistStatus) withStatus += 1;
            if (msg.toolCalls) withToolCalls += 1;
            if (msg.attachmentRefs) withRefs += 1;
          }
        }
      }
    }
    expect(withTransitions).toBeGreaterThan(300);
    expect(withStatus).toBeGreaterThan(10000);
    expect(withToolCalls).toBeGreaterThan(500);
    expect(withRefs).toBeGreaterThan(1000);
  }, 120_000);
});

describe('chat-history readers against the frozen pre-refactor readers: hand-built stores', () => {
  const row = (session: string, n: number, author: 'user' | 'agent', extra: Row = {}): Row => ({
    session,
    m: `${CHAT}msg:h-${n}`,
    author: `${CHAT}actor:${author}`,
    text: JSON.stringify(`m${n}`),
    ts: `"${stamp(n)}"`,
    ...extra,
  });
  const done = (reply: string, state = 'stored'): Row => ({ transitionState: JSON.stringify(state), transitionAssistantReply: JSON.stringify(reply) });
  const A = `${CHAT}session:s-a`;
  const B = `${CHAT}session:s-b`;

  /** Run both list readers over fixed session roots and list rows. */
  async function bothList(rows: Row[], sessions: string[] = [A, B]) {
    const query = async (sparql: string) => {
      if (sparql.startsWith('SELECT ?sid WHERE')) return { bindings: [] };
      if (sparql.startsWith('SELECT ?s ?sid (MAX')) {
        return { bindings: sessions.map((s) => ({ s, sid: JSON.stringify(s.slice(`${CHAT}session:`.length)) })) };
      }
      return { bindings: rows };
    };
    const expected = await new FrozenChatHistoryReaders({ query }, AGENT_ADDRESS).getRecentChats(10);
    const actual = await managerOver(query).getRecentChats(10);
    expectSame(actual, expected, 'hand-built list');
    return actual;
  }

  it('a message past the cap is not listed however many transitions it comes back with, and does not use up a later message\'s place', async () => {
    const rows: Row[] = [];
    for (let n = 0; n < 100; n += 1) rows.push(row(A, n, n % 2 ? 'agent' : 'user'));
    // The 101st message comes back five times, each with a transition, and a 102nd follows.
    for (let i = 0; i < 5; i += 1) rows.push(row(A, 100, 'agent', done(`final ${i}`)));
    rows.push(row(A, 101, 'user'));
    // Another session, with a full message list of its own.
    rows.push(row(B, 200, 'user'), row(B, 201, 'agent', done('b final')));

    const chats = await bothList(rows);

    expect(chats.map((chat) => chat.messages.length)).toEqual([100, 2]);
    expect(chats[1].messages[1].text).toBe('b final');
  });

  it('a message that comes back under two sessions is listed once, under the first row that names it, and completed by the latest row that names it', async () => {
    const chats = await bothList([
      row(A, 1, 'user'),
      row(A, 2, 'agent', done('the final answer')),
      row(B, 2, 'agent', done('never listed under b')),
      row(B, 3, 'user'),
    ]);

    expect(chats.map((chat) => chat.messages.map((m) => m.text))).toEqual([['m1', 'never listed under b'], ['m3']]);
  });

  it('rows that name no message URI are each listed and never completed or merged, even when one carries a stored transition; a row with no session is not listed', async () => {
    const noUri = (n: number, extra: Row = {}): Row => ({ session: A, author: `${CHAT}actor:agent`, text: JSON.stringify(`x${n}`), ts: `"${stamp(n)}"`, ...extra });
    const chats = await bothList([
      noUri(1),
      noUri(1),
      // Not a row the query can return (it joins a turn's transitions through the message URI), but the
      // reader has always left such a row as it is: a transition cannot be attributed to a message with no URI.
      noUri(2, done('a reply that must not complete a row with no URI')),
      row(A, 5, 'agent', done('ok')),
      { m: `${CHAT}msg:orphan`, author: `${CHAT}actor:agent`, text: '"orphan"', ts: `"${stamp(0)}"` },
      { m: `${CHAT}msg:orphan`, session: B, author: `${CHAT}actor:agent`, text: '"orphan again"', ts: `"${stamp(0)}"` },
    ]);

    expect(chats.find((chat) => chat.session === 's-a')!.messages.map((m) => m.text)).toEqual(['x1', 'x1', 'x2', 'ok']);
    // The orphan's first row named no session, so it was never listed and its later row does not list it either.
    expect(chats.find((chat) => chat.session === 's-b')!.messages).toEqual([]);
  });

  it('only a stored transition with a reply completes an agent message, and the latest one wins, wherever its row sits', async () => {
    const chats = await bothList([
      row(A, 1, 'agent', done('first', 'stored')),
      row(A, 1, 'agent', done('a failed retry', 'failed')),
      row(A, 1, 'agent', done('latest', 'stored')),
      row(A, 1, 'agent', done('ignored: not stored', 'pending')),
      row(A, 2, 'user', done('a user message is never rewritten')),
    ]);

    expect(chats[0].messages.map((m) => m.text)).toEqual(['latest', 'm2']);
  });
});
