/**
 * Behavioral coverage for the adapter-elizaos action-handler internals
 * and the persistChatTurnImpl cross-surface implementation.
 *
 * SECOND-PASS BOT REVIEW (PR #229):
 *   - persistChatTurnImpl now emits the CANONICAL chat-turn shape used by
 *     `node-ui/src/chat-memory.ts` (`schema:Conversation` /
 *     `schema:Message` / `dkg:ChatTurn` + `urn:dkg:chat:` URIs) instead of
 *     the previous ad-hoc `https://schema.origintrail.io/dkg/v10/ChatTurn`
 *     vocabulary, so ChatMemoryManager / node-ui session views can read
 *     adapter-emitted turns immediately.
 *   - The default context graph is now `'agent-context'` (the same constant
 *     that ChatMemoryManager reads), not `'chat'`.
 *   - A new `mode: 'assistant-reply'` opt routes the call through an
 *     append-only assistant-message path so onAssistantReply does NOT
 *     duplicate the user-message + turn-envelope quads.
 *
 * Tests below assert all three contracts so any regression surfaces here
 * instead of in node-ui later.
 */
import { describe, it, expect } from 'vitest';
import { persistChatTurnImpl, dkgPersistChatTurn, __resetEmittedSessionRootsForTests } from '../src/actions.js';
import { dkgKnowledgeProvider } from '../src/provider.js';
import type { IAgentRuntime, Memory, State, HandlerCallback } from '../src/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

function makeRuntime(settings: Record<string, string> = {}, characterName?: string): IAgentRuntime {
  return {
    getSetting: (k: string) => settings[k],
    character: characterName !== undefined ? { name: characterName } : undefined,
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string, overrides: Partial<Memory> & { id?: string } = {}): Memory {
  return {
    content: { text },
    // Bot review PR #229 round 6 (actions.ts:635) — persistChatTurnImpl
    // now REQUIRES a stable `message.id` and will throw if it's missing
    // (instead of fabricating a Date.now() fallback that broke retry
    // idempotence). Keep a deterministic default here so existing tests
    // that don't care about the id still exercise the happy path; tests
    // that need to specifically probe the missing-id contract pass
    // `overrides.id` explicitly (and can `delete` it afterwards).
    id: overrides.id ?? 'mem-default',
    userId: overrides.userId ?? 'alice',
    roomId: overrides.roomId ?? 'room-1',
    agentId: overrides.agentId ?? 'agent-eliza',
    ...overrides,
  } as unknown as Memory;
}

interface CapturedPublish {
  cgId: string;
  name: string;
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>;
}

interface CapturedEnsure {
  id: string;
  name: string;
  curated?: boolean;
}

function makeCapturingAgent(_kcIdUnused?: bigint | string) {
  const publishes: CapturedPublish[] = [];
  const ensures: CapturedEnsure[] = [];
  const agent = {
    assertion: {
      async write(cgId: string, name: string, quads: any) {
        publishes.push({ cgId, name, quads: [...quads] });
      },
    },
    async ensureContextGraphLocal(opts: { id: string; name: string; curated?: boolean }) {
      ensures.push({ id: opts.id, name: opts.name, curated: opts.curated });
    },
  };
  return { agent, publishes, ensures };
}

// ===========================================================================
// persistChatTurnImpl — canonical user-turn shape (schema:Conversation /
// schema:Message / dkg:ChatTurn) — second-pass bot review
// ===========================================================================

describe('persistChatTurnImpl — canonical user-turn shape (matches node-ui ChatMemoryManager)', () => {
  it('defaults to the agent-context CG and chat-turns assertion (interop with rest of monorepo)', async () => {
    const { agent, publishes, ensures } = makeCapturingAgent();
    await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    // Second-pass bot review: ChatMemoryManager reads from `agent-context`
    // / `chat-turns`. Defaulting to anything else (the prior default was
    // `chat`) breaks out-of-the-box interop on every fresh install.
    expect(publishes[0].cgId).toBe('agent-context');
    expect(publishes[0].name).toBe('chat-turns');
    expect(ensures[0].id).toBe('agent-context');
  });

  it('respects DKG_CHAT_CG override when explicitly set', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(agent, makeRuntime({ DKG_CHAT_CG: 'custom-cg' }), makeMessage('hi'), {} as State, {});
    expect(publishes[0].cgId).toBe('custom-cg');
  });

  it('assistant message timestamp sorts strictly AFTER the user message timestamp on the same turn', async () => {
    // Bot review PR #229 round 6, actions.ts:662 — `schema:dateCreated`
    // on the assistant message MUST be > the user message timestamp so
    // downstream readers that order by timestamp always see user → agent.
    // The previous code reused the same `ts` for both, leaving the
    // ordering undefined when two messages shared a subject position.
    const { agent, publishes } = makeCapturingAgent();
    const fixedTs = '2026-01-02T03:04:05.000Z';
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'order-1', roomId: 'r' } as any),
      {} as State,
      { ts: fixedTs, assistantText: 'hello back' },
    );
    const quads = publishes[0].quads;
    const userTs = quads.find(
      (q) => q.subject === 'urn:dkg:chat:msg:user:r:order-1' && q.predicate === `${SCHEMA}dateCreated`,
    )!;
    const asstTs = quads.find(
      (q) => q.subject === 'urn:dkg:chat:msg:agent:r:order-1' && q.predicate === `${SCHEMA}dateCreated`,
    )!;
    expect(userTs.object).toBe(`"${fixedTs}"^^<${XSD_DATETIME}>`);
    expect(asstTs.object).toBe(`"2026-01-02T03:04:05.001Z"^^<${XSD_DATETIME}>`);
  });

  it('user + assistant message subjects both carry dkg:turnId so readers can join without walking the turn envelope', async () => {
    // Bot review PR #229 round 6 — the canonical `dkg:turnId` edge was
    // only on the turn envelope, which forced every join query to walk
    // `schema:isPartOf → ^dkg:hasUserMessage → dkg:turnId`. Emit it on
    // the message subjects too so `?msg dkg:turnId ?t` is a 1-hop join.
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('q', { id: 'turnId-msg', roomId: 'r' } as any),
      {} as State,
      { assistantText: 'a' },
    );
    const quads = publishes[0].quads;
    const userTurnIdQuad = quads.find(
      (q) => q.subject === 'urn:dkg:chat:msg:user:r:turnId-msg' && q.predicate === `${DKG_ONT}turnId`,
    );
    const asstTurnIdQuad = quads.find(
      (q) => q.subject === 'urn:dkg:chat:msg:agent:r:turnId-msg' && q.predicate === `${DKG_ONT}turnId`,
    );
    expect(userTurnIdQuad, 'user msg must carry dkg:turnId').toBeDefined();
    expect(asstTurnIdQuad, 'assistant msg must carry dkg:turnId').toBeDefined();
    expect(userTurnIdQuad!.object).toBe('"r:turnId-msg"');
    expect(asstTurnIdQuad!.object).toBe('"r:turnId-msg"');
  });

  it('keeps the canonical session URI unencoded (roomId drops in verbatim so node-ui reads match)', async () => {
    // Bot review PR #229 round 6, actions.ts:649 — the canonical
    // `${CHAT_NS}session:${sessionId}` URI must be byte-identical to
    // what `ChatMemoryManager` reads. Running roomId through
    // encodeURIComponent mangles common shapes (e.g. `room:alpha` →
    // `room%3Aalpha`) and silently forks the graph.
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'sess-1', roomId: 'room:alpha' } as any),
      {} as State, {},
    );
    const sessionTypeQuad = publishes[0].quads.find(
      (q) => q.predicate === RDF_TYPE && q.object === `${SCHEMA}Conversation`,
    )!;
    expect(sessionTypeQuad.subject).toBe('urn:dkg:chat:session:room:alpha');
  });

  it('REJECTS roomIds that would corrupt the N-Quads serializer (whitespace, angle brackets, quotes)', async () => {
    // Bot review PR #229 round 6, actions.ts:649 — because the
    // canonical session URI drops the raw roomId into an IRI position
    // verbatim, unsafe characters must be refused at the boundary.
    const { agent } = makeCapturingAgent();
    for (const bad of ['room a', 'room<a>', 'room"a"', 'room\\a']) {
      await expect(
        persistChatTurnImpl(
          agent, makeRuntime(),
          makeMessage('hi', { id: 'mem-x', roomId: bad } as any),
          {} as State, {},
        ),
      ).rejects.toThrow(/forbidden/i);
    }
  });

  it('respects opts.contextGraphId over DKG_CHAT_CG and the default', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent,
      makeRuntime({ DKG_CHAT_CG: 'settings-cg' }),
      makeMessage('hi'),
      {} as State,
      { contextGraphId: 'opts-cg' },
    );
    expect(publishes[0].cgId).toBe('opts-cg');
  });

  it('emits a schema:Conversation entity for the session (turnId roomId)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hello', { id: 'mem-1', roomId: 'room-A', userId: 'bob' } as any),
      {} as State, {},
    );
    const sessionTypeQuad = publishes[0].quads.find(
      (q) => q.predicate === RDF_TYPE && q.object === `${SCHEMA}Conversation`,
    );
    expect(sessionTypeQuad, 'must emit schema:Conversation type').toBeDefined();
    expect(sessionTypeQuad!.subject).toMatch(/^urn:dkg:chat:session:room-A$/);

    const sessionIdQuad = publishes[0].quads.find((q) => q.predicate === `${DKG_ONT}sessionId`);
    expect(sessionIdQuad).toBeDefined();
    expect(sessionIdQuad!.object).toBe('"room-A"');
  });

  it('emits a schema:Message subject for the user message wired to the session and user actor', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('what is dkg?', { id: 'mem-1', roomId: 'r', userId: 'u' } as any),
      {} as State, {},
    );
    const quads = publishes[0].quads;
    const userMsgUri = `urn:dkg:chat:msg:user:r:mem-1`;
    expect(quads).toContainEqual(expect.objectContaining({ subject: userMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message` }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: userMsgUri, predicate: `${SCHEMA}isPartOf`, object: 'urn:dkg:chat:session:r' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: userMsgUri, predicate: `${SCHEMA}author`, object: 'urn:dkg:chat:actor:user' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: userMsgUri, predicate: `${SCHEMA}text`, object: '"what is dkg?"' }));
  });

  it('emits a dkg:ChatTurn envelope linking to the user message subject', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const out = await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'mem-1', roomId: 'r', userId: 'u' } as any),
      {} as State, {},
    );
    const turnUri = out.turnUri;
    expect(turnUri).toBe('urn:dkg:chat:turn:r:mem-1');
    const quads = publishes[0].quads;
    expect(quads).toContainEqual(expect.objectContaining({ subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn` }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: turnUri, predicate: `${SCHEMA}isPartOf`, object: 'urn:dkg:chat:session:r' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: 'urn:dkg:chat:msg:user:r:mem-1' }));
    // No assistant message link when the user-turn fires alone.
    expect(quads.some((q) => q.predicate === `${DKG_ONT}hasAssistantMessage`)).toBe(false);
  });

  it('emits the assistant message + link when assistantText is supplied on the user-turn', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const out = await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'mem-1', roomId: 'r', userId: 'u' } as any),
      {} as State,
      { assistantText: 'hello back' },
    );
    const assistantMsgUri = 'urn:dkg:chat:msg:agent:r:mem-1';
    const quads = publishes[0].quads;
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message` }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: `${SCHEMA}author`, object: 'urn:dkg:chat:actor:agent' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: `${SCHEMA}text`, object: '"hello back"' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: `${DKG_ONT}replyTo`, object: 'urn:dkg:chat:msg:user:r:mem-1' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: out.turnUri, predicate: `${DKG_ONT}hasAssistantMessage`, object: assistantMsgUri }));
  });

  it('rdf:type objects are bare IRIs (publisher wraps in <...> at serialization)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    for (const q of publishes[0].quads.filter((q) => q.predicate === RDF_TYPE)) {
      expect(q.object.startsWith('<')).toBe(false);
    }
  });

  it('every emitted quad carries `graph: ""` (publisher rewrites to the assertion graph)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    for (const q of publishes[0].quads) {
      expect(q).toHaveProperty('graph');
      expect(q.graph).toBe('');
    }
  });
});

// ===========================================================================
// persistChatTurnImpl — assistant-reply MERGE path (second-pass bot review)
// ===========================================================================

describe('persistChatTurnImpl — assistant-reply mode is append-only (no user-text corruption, no duplicate envelope)', () => {
  it('emits ONLY assistant-message quads and a single hasAssistantMessage link', async () => {
    const { agent, publishes } = makeCapturingAgent();
    // Note: the assistant memory carries the assistant TEXT in
    // `message.content.text`. Previously this was incorrectly persisted as
    // `userMessage`. With `mode: 'assistant-reply'` it must NOT be.
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('the answer is 42', { id: 'asst-mem', roomId: 'r', userId: 'agent-eliza' } as any),
      {} as State,
      // PR #229 bot review round 20 (r20-1): append-only path now
      // requires the EXPLICIT `userTurnPersisted: true` opt-in.
      // Pre-r20 we relied on legacy inference (presence of
      // userMessageId), but that conflated addressing with
      // durability. Callers that genuinely know the user-turn write
      // succeeded (the in-process `onAssistantReplyHandler` after
      // r16-2) plumb `true` here; the public catch-all overload now
      // fails closed to the safe full envelope when ambiguous.
      { mode: 'assistant-reply', userMessageId: 'mem-1', userTurnPersisted: true },
    );
    const quads = publishes[0].quads;
    const assistantMsgUri = 'urn:dkg:chat:msg:agent:r:mem-1';
    const turnUri = 'urn:dkg:chat:turn:r:mem-1';
    const userMsgUri = 'urn:dkg:chat:msg:user:r:mem-1';

    // Assistant-message subject is present with the correct text.
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: `${SCHEMA}text`, object: '"the answer is 42"' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: assistantMsgUri, predicate: `${DKG_ONT}replyTo`, object: userMsgUri }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: turnUri, predicate: `${DKG_ONT}hasAssistantMessage`, object: assistantMsgUri }));

    // Critically: NO user-message subject is re-emitted (would cause
    // duplicate-data and would mark the assistant text as user text).
    expect(quads.some((q) => q.subject === userMsgUri)).toBe(false);
    // And NO turn-envelope quads (those came from the user-turn call).
    expect(quads.some((q) => q.subject === turnUri && q.predicate === RDF_TYPE)).toBe(false);
    expect(quads.some((q) => q.subject === turnUri && q.predicate === `${DKG_ONT}turnId`)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Bot review (PR #229 round 8, actions.ts:746): the original round-7
  // headless-assistant fix emitted a dkg:ChatTurn envelope WITHOUT a
  // `dkg:hasUserMessage` edge. That shape is technically valid RDF but
  // the chat reader contract in `packages/node-ui/src/chat-memory.ts`
  // resolves a turn via a single
  //   SELECT ?user ?assistant WHERE {
  //     ?turn dkg:hasUserMessage ?user . ?turn dkg:hasAssistantMessage ?a .
  //   }
  // — so a turn that only has the assistant side is still reported as
  // `turn_not_found`. Round 8 emits a stub user Message so BOTH edges
  // exist; the stub carries `dkg:headlessUserMessage "true"` + empty
  // text + a `dkg:agent:system` author so UIs don't render a blank
  // user bubble. The turn itself carries `dkg:headlessTurn "true"` so
  // consumers that care about the distinction can filter on it. We
  // also strip the misleading `dkg:replyTo` edge from the assistant
  // Message (no real user message to reply to).
  // ---------------------------------------------------------------------
  it('HEADLESS assistant-reply emits both hasUserMessage + hasAssistantMessage edges (reader contract compliance)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('unsolicited reply', { id: 'asst-only-mem', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply' }, // deliberately omit userMessageId
    );
    const quads = publishes[0].quads;
    // PR #229 round 21 (r21-1): the headless envelope now lands on a
    // DEDICATED `headless-turn:` URI so it cannot overwrite a
    // canonical `turn:` URI that a real `onChatTurn` write may have
    // already populated (the prior revision wrote onto
    // `urn:dkg:chat:turn:…` and resurrected the blank-turn regression
    // r15-2 had paid down). The reader finds the headless turn via
    // `?turn rdf:type dkg:ChatTurn`, so the URI namespace change is
    // transparent to consumers — but the test must follow the new
    // subject so the assertions are real (otherwise the assertion
    // would silently pass on an absent canonical-turn quad).
    const turnUri = 'urn:dkg:chat:headless-turn:r:asst-only-mem';
    // r15-2: stub lives in `msg:user-stub:` namespace keyed on the
    // assistant memory id.
    const userStubUri = 'urn:dkg:chat:msg:user-stub:r:asst-only-mem';
    // r21-1: the headless assistant message also gets a dedicated
    // `msg:agent-headless:` URI keyed on the stub turn key so it
    // cannot collide with a canonical `msg:agent:` URI written by
    // a real user-first onChatTurn → onAssistantReply pair.
    const assistantMsgUri = 'urn:dkg:chat:msg:agent-headless:r:asst-only-mem';

    // Full envelope with BOTH edges — what the node-ui reader wants.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: userStubUri,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}hasAssistantMessage`, object: assistantMsgUri,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}turnId`,
    }));
    // Headless markers so downstream consumers can distinguish.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}headlessTurn`, object: '"true"',
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userStubUri, predicate: `${DKG_ONT}headlessUserMessage`, object: '"true"',
    }));
    // Stub user message: empty text + system author, NOT the regular
    // CHAT_USER_ACTOR — so UIs don't render an empty user bubble.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userStubUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userStubUri, predicate: `${SCHEMA}text`, object: '""',
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userStubUri, predicate: `${SCHEMA}author`, object: `${DKG_ONT}agent:system`,
    }));
    // Assistant text is still emitted normally.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: assistantMsgUri, predicate: `${SCHEMA}text`, object: '"unsolicited reply"',
    }));
    // No misleading `replyTo` edge when the user side is a stub — there
    // is no real user message to reply to.
    expect(quads.some((q) =>
      q.subject === assistantMsgUri && q.predicate === `${DKG_ONT}replyTo`,
    )).toBe(false);
  });

  it('HEADLESS assistant-reply writes the same bytes on re-fire (idempotent: stable timestamp)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('same reply', { id: 'stable-id', roomId: 'r' } as any);
    await persistChatTurnImpl(
      agent, makeRuntime(), msg, {} as State,
      { mode: 'assistant-reply' },
    );
    await persistChatTurnImpl(
      agent, makeRuntime(), msg, {} as State,
      { mode: 'assistant-reply' },
    );
    const tsQuad = (i: number) => publishes[i].quads.find(
      // r21-1: headless turn lives under `headless-turn:` now, NOT
      // `turn:`. Match the new prefix so this idempotence test
      // exercises the actual headless envelope — matching `turn:`
      // would silently return undefined on every call and the
      // .object equality below would compare undefined === undefined
      // (false-positive green).
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:headless-turn:'),
    )!;
    // Bot review (PR #229 follow-up, actions.ts:539): re-firing the same
    // hook must not mint a fresh `schema:dateCreated`, otherwise downstream
    // readers see conflicting timestamps for the "same" turn.
    expect(tsQuad(0).object).toBe(tsQuad(1).object);
  });

  it('targets the SAME turnUri as the matching user-turn call when both userMessageId and userTurnPersisted are supplied (append-only)', async () => {
    // PR #229 round 21 (r21-2): the append-only path requires BOTH
    // `userMessageId` AND `userTurnPersisted: true`. Anything less
    // (the previous test shape `{ userMessageId: 'mem-1' }` alone)
    // takes the safe headless path and lands the assistant link on
    // a `headless-turn:` URI instead of the canonical `turn:` URI
    // the user-turn write produced — that would actually FAIL the
    // intent of this assertion ("assistant-reply joins the same
    // turn as its user-turn"). Pin the explicit contract here so
    // the append-only path stays correct under r21-2's stricter
    // gating.
    const { agent, publishes } = makeCapturingAgent();
    const userOut = await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('what?', { id: 'mem-1', roomId: 'r', userId: 'u' } as any),
      {} as State, {},
    );
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('the answer is 42', { id: 'asst-mem-2', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'mem-1', userTurnPersisted: true },
    );
    const linkQuad = publishes[1].quads.find((q) => q.predicate === `${DKG_ONT}hasAssistantMessage`)!;
    expect(linkQuad.subject).toBe(userOut.turnUri);
    // And the user-turn URI is the canonical (NOT headless) one — sanity
    // check so a future drift of `persistChatTurnImpl`'s return value
    // toward `headless-turn:` for the user-turn call would also flip
    // this test red.
    expect(userOut.turnUri).toBe('urn:dkg:chat:turn:r:mem-1');
  });

  // ---------------------------------------------------------------------
  // Bot review (PR #229 follow-up, actions.ts:539): stable timestamp on
  // retries for user-turn mode as well. Readers that dedupe by
  // schema:dateCreated must see byte-identical values across re-fires.
  // ---------------------------------------------------------------------
  it('user-turn mode uses a STABLE timestamp so two calls with the same message produce identical dateCreated quads', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hello', { id: 'stable-u', roomId: 'r' } as any);
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    // Wait long enough that `new Date().toISOString()` would differ if we
    // regressed — 5ms is enough for millisecond-resolution diffs.
    await new Promise((r) => setTimeout(r, 5));
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const turnTs = (i: number) => publishes[i].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    expect(turnTs(0).object).toBe(turnTs(1).object);
  });

  it('user-turn mode honors an explicit `ts` override when supplied (payload-provided stable timestamp)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const fixed = '2026-01-02T03:04:05.678Z';
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hello', { id: 'ts-override', roomId: 'r' } as any),
      {} as State,
      { ts: fixed },
    );
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    expect(turnTs.object).toBe(`"${fixed}"^^<${XSD_DATETIME}>`);
  });

  it('prefers message.createdAt (numeric ms) over the deterministic fallback', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hello', { id: 'with-createdAt', roomId: 'r' } as any);
    (msg as any).createdAt = Date.UTC(2026, 5, 10, 12, 0, 0);
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    expect(turnTs.object).toBe(`"2026-06-10T12:00:00.000Z"^^<${XSD_DATETIME}>`);
  });

  // PR #229 bot review round 11 (actions.ts:550). Prior revisions
  // returned string-valued timestamp fields verbatim and then emitted
  // the result under `^^xsd:dateTime`. ElizaOS frequently serializes
  // `createdAt` / `timestamp` as epoch-ms strings (`"1718049600000"`),
  // so the quad became an invalid literal that breaks SPARQL ORDER BY
  // and FILTER arithmetic. The new contract coerces every incoming
  // shape to a real ISO-8601 string before emitting the quad.
  it('coerces a string epoch-ms timestamp to ISO-8601 before emitting xsd:dateTime (bot review r11-4)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hi', { id: 'ms-string', roomId: 'r' } as any);
    // Matches ElizaOS serializers that stringify epoch ms.
    (msg as any).createdAt = '1718049600000';
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    // Epoch-ms 1718049600000 == 2024-06-10T20:00:00.000Z
    expect(turnTs.object).toBe(`"2024-06-10T20:00:00.000Z"^^<${XSD_DATETIME}>`);
    // Must NOT be the raw epoch-ms string — that would be an invalid
    // xsd:dateTime literal.
    expect(turnTs.object).not.toContain('"1718049600000"');
  });

  it('normalises an already-ISO string timestamp via Date (no verbatim passthrough) (bot review r11-4)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hi', { id: 'iso-string', roomId: 'r' } as any);
    // Missing-millisecond ISO form — MUST be normalised to the
    // canonical `.000Z` rendering so readers see a single shape.
    (msg as any).createdAt = '2026-01-02T03:04:05Z';
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    expect(turnTs.object).toBe(`"2026-01-02T03:04:05.000Z"^^<${XSD_DATETIME}>`);
  });

  it('falls through to the deterministic synthetic stamp when a string timestamp is unparseable (bot review r11-4)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hi', { id: 'bogus-string', roomId: 'r' } as any);
    (msg as any).createdAt = 'not-a-date-at-all';
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    // MUST be a well-formed ISO-8601 literal (the synthetic fallback),
    // NEVER the raw garbage string.
    expect(turnTs.object).not.toContain('"not-a-date-at-all"');
    const body = turnTs.object.match(/^"([^"]+)"\^\^/)?.[1];
    expect(body).toBeDefined();
    expect(new Date(body!).toISOString()).toBe(body);
  });

  it('also coerces an `opts.ts` override when it is a string epoch-ms value (bot review r11-4)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'opts-ts-ms', roomId: 'r' } as any),
      {} as State,
      { ts: '1718049600000' },
    );
    const turnTs = publishes[0].quads.find(
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    expect(turnTs.object).toBe(`"2024-06-10T20:00:00.000Z"^^<${XSD_DATETIME}>`);
  });
});

// ===========================================================================
// persistChatTurnImpl — turnUri encoding (still bot review A5: reversible)
// ===========================================================================

describe('persistChatTurnImpl — turnUri reversible encoding (bot review A5)', () => {
  it('uses encodeURIComponent so different chars produce different turnUris (no collision)', async () => {
    const { agent } = makeCapturingAgent();
    const out1 = await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'mem/1', roomId: 'room@A' } as any),
      {} as State, {},
    );
    const out2 = await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hi', { id: 'mem:1', roomId: 'room@A' } as any),
      {} as State, {},
    );
    expect(out1.turnUri).not.toBe(out2.turnUri);
    expect(out1.turnUri).toContain(encodeURIComponent('mem/1'));
    expect(out2.turnUri).toContain(encodeURIComponent('mem:1'));
  });

  it('REJECTS calls without a stable message.id instead of fabricating a timestamp fallback', async () => {
    // Bot review PR #229 round 6, actions.ts:635 — a `mem-${Date.now()}`
    // fallback silently broke idempotence across retries (every call
    // got a different turnUri). The new contract is: require a stable
    // id from the caller and throw loudly when it's missing, so the
    // upstream gap surfaces at the adapter boundary rather than
    // corrupting the chat graph.
    const { agent } = makeCapturingAgent();
    const msg = makeMessage('hi', { roomId: 'r' } as any);
    delete (msg as any).id;
    await expect(
      persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {}),
    ).rejects.toThrow(/missing stable message identifier/i);
  });

  it('uses "anonymous" / "default" fallbacks for userId / roomId in the turn envelope', async () => {
    const { agent, publishes } = makeCapturingAgent();
    const msg = makeMessage('hi', { id: 'm' } as any);
    delete (msg as any).userId;
    delete (msg as any).roomId;
    await persistChatTurnImpl(agent, makeRuntime(), msg, {} as State, {});
    const quads = publishes[0].quads;
    expect(quads.find((q) => q.predicate === `${DKG_ONT}elizaUserId`)!.object).toBe('"anonymous"');
    expect(quads.find((q) => q.predicate === `${DKG_ONT}elizaRoomId`)!.object).toBe('"default"');
  });
});

describe('persistChatTurnImpl — rdfString escaping + dateTime literal', () => {
  it('escapes backslashes, double quotes, newlines and carriage returns in user text', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('hello "world"\\n\nline2\r\nend'),
      {} as State, {},
    );
    const userText = publishes[0].quads.find((q) => q.predicate === `${SCHEMA}text`)!;
    expect(userText.object).toContain('\\"world\\"');
    expect(userText.object).toContain('\\n');
    expect(userText.object).toContain('\\r');
    expect(userText.object).not.toMatch(/[\n\r]/);
  });

  it('schema:dateCreated quad ends with the xsd:dateTime datatype', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    const ts = publishes[0].quads.find((q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:msg:'))!;
    // PR #229 CodeQL js/incomplete-hostname-regexp: the previous form
    //   new RegExp(`\\^\\^<${XSD_DATETIME}>$`)
    // interpolated the literal URL `http://www.w3.org/...` straight into a
    // regex without escaping the `.` chars, so the pattern matched
    // "wXwXorg" / "wAwAorg" / etc. The intent is a literal tail-match —
    // build the regex from the escaped URL string.
    const escaped = XSD_DATETIME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(ts.object).toMatch(new RegExp(`\\^\\^<${escaped}>$`));
  });
});

describe('persistChatTurnImpl — result shape + WM contract', () => {
  it('returns an empty kcId string — WM writes do not produce on-chain KC ids', async () => {
    const { agent } = makeCapturingAgent();
    const out = await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    expect(out.kcId).toBe('');
    expect(typeof out.turnUri).toBe('string');
    expect(typeof out.tripleCount).toBe('number');
  });

  it('honors a DKG_CHAT_ASSERTION setting override for the assertion name', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime({ DKG_CHAT_ASSERTION: 'custom-chat' }),
      makeMessage('hi'), {} as State, {},
    );
    expect(publishes[0].name).toBe('custom-chat');
  });

  it('works even when the agent does NOT expose ensureContextGraphLocal', async () => {
    const publishes: CapturedPublish[] = [];
    const agent: any = {
      assertion: {
        async write(cgId: string, name: string, quads: any) {
          publishes.push({ cgId, name, quads: [...quads] });
        },
      },
    };
    const out = await persistChatTurnImpl(agent, makeRuntime(), makeMessage('hi'), {} as State, {});
    expect(out.tripleCount).toBeGreaterThan(0);
    expect(publishes).toHaveLength(1);
  });
});

// ===========================================================================
// dkgPersistChatTurn ACTION — error routing only (no live agent)
// ===========================================================================

describe('dkgPersistChatTurn action — metadata + error routing', () => {
  it('has the expected name, similes, description', () => {
    expect(dkgPersistChatTurn.name).toBe('DKG_PERSIST_CHAT_TURN');
    expect(dkgPersistChatTurn.similes).toEqual(expect.arrayContaining([
      'STORE_CHAT_TURN', 'PERSIST_CHAT', 'STORE_CHAT', 'RECORD_TURN', 'SAVE_CHAT_TURN',
    ]));
    expect(dkgPersistChatTurn.description).toMatch(/chat turn/i);
  });

  it('validate() always returns true (no gating)', async () => {
    const ok = await dkgPersistChatTurn.validate!({} as IAgentRuntime, {} as Memory);
    expect(ok).toBe(true);
  });

  it('when no agent is running, routes the error through the callback and returns false', async () => {
    const calls: Array<{ text: string }> = [];
    const cb: HandlerCallback = ((r: { text: string }) => { calls.push(r); return Promise.resolve([]); }) as any;
    const ok = await dkgPersistChatTurn.handler(
      makeRuntime(), makeMessage('remember this'), {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/Chat turn persist failed:|DKG node not started/);
  });
});

// ===========================================================================
// dkgKnowledgeProvider — keyword extraction branches (unchanged)
// ===========================================================================

describe('dkgKnowledgeProvider — keyword extraction branches', () => {
  it('returns null when no agent is initialized', async () => {
    const out = await dkgKnowledgeProvider.get!(
      makeRuntime(), makeMessage('tell me about distributed systems'),
    );
    expect(out === null || typeof out === 'string').toBe(true);
  });

  it('returns null for messages with only stop words and sub-3-char tokens', async () => {
    const out = await dkgKnowledgeProvider.get!(
      makeRuntime(), makeMessage('a of in the is be or to an'),
    );
    expect(out).toBeNull();
  });

  it('returns null for a fully punctuation-only message', async () => {
    const out = await dkgKnowledgeProvider.get!(
      makeRuntime(), makeMessage('!!! ... ??? ,,,'),
    );
    expect(out).toBeNull();
  });

  it('does not throw on messages containing special-regex characters', async () => {
    const out = await dkgKnowledgeProvider.get!(
      makeRuntime(), makeMessage('alice() [brackets] {braces} "quotes" — em-dash'),
    );
    expect(out === null || typeof out === 'string').toBe(true);
  });
});

// ===========================================================================
// PR #229 bot review round 13 — r13-1 + r13-2 behavioral pins
// ===========================================================================

describe('persistChatTurnImpl — PR #229 round 13 (r13-1): userTurnPersisted explicit signal', () => {
  // -------------------------------------------------------------------
  // r13-1: the previous revision inferred `headlessAssistantReply` ONLY
  // from `!optsAny.userMessageId`. That conflated two different things
  // (do we know the parent id vs. did the user-turn write succeed) and
  // let the append-only path win when the user-turn envelope had never
  // been emitted — the assistant reply then dangled under a turnUri
  // that wasn't typed as `dkg:ChatTurn`, and the chat-memory reader
  // dropped it. The new contract takes `userTurnPersisted: boolean`
  // from the options bag and falls back to the full envelope when
  // ambiguous.
  // -------------------------------------------------------------------
  it('userTurnPersisted=false + userMessageId present → FULL envelope (even with parent id)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('belated reply', { id: 'asst-2', roomId: 'r' } as any),
      {} as State,
      // Caller KNOWS the parent id but explicitly signals the user-turn
      // was never persisted (e.g. onChatTurn hook was disabled / errored).
      { mode: 'assistant-reply', userMessageId: 'mem-1', userTurnPersisted: false },
    );
    const quads = publishes[0].quads;
    // r21-1: headless envelope subject MUST be the dedicated
    // `headless-turn:` URI so it cannot stomp on the canonical
    // `turn:r:mem-1` subject (which a real `onChatTurn` write may
    // have populated even though the caller passed
    // `userTurnPersisted: false`). The reader still discovers the
    // turn via `?turn rdf:type dkg:ChatTurn`, but the canonical
    // turn URI is left untouched.
    const turnUri = 'urn:dkg:chat:headless-turn:r:mem-1';
    // r15-2: the headless stub lives in the `msg:user-stub:` namespace
    // keyed on the ASSISTANT memory id (not the user message id) so it
    // can't collide with any canonical `msg:user:` URI the user-turn
    // hook wrote under the same turnKey.
    const userStubUri = 'urn:dkg:chat:msg:user-stub:r:asst-2';
    // Full envelope must be present so the reader resolves the turn.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: userStubUri,
    }));
    // Headless markers present so downstream can filter if desired.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}headlessTurn`, object: '"true"',
    }));
    // r15-2 collision guard: the real `msg:user:r:mem-1` subject MUST
    // NOT be written by the headless path — a concurrent onChatTurn
    // may have already written real author/text onto that subject.
    expect(quads.some((q) => q.subject === 'urn:dkg:chat:msg:user:r:mem-1')).toBe(false);
    // r21-1 partner guard: the canonical `turn:r:mem-1` subject MUST
    // also remain pristine. Stamping headless ChatTurn quads onto it
    // is the bug r21-1 paid down — assert that NOTHING in this
    // headless write touched the canonical turn URI, regardless of
    // predicate.
    expect(quads.some((q) => q.subject === 'urn:dkg:chat:turn:r:mem-1')).toBe(false);
  });

  it('userTurnPersisted=true → append-only even without userMessageId (well-known caller opt-in)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('cheap append', { id: 'asst-3', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userTurnPersisted: true },
    );
    const quads = publishes[0].quads;
    // No user Message subject re-emitted.
    const userMsgUri = 'urn:dkg:chat:msg:user:r:asst-3';
    expect(quads.some((q) => q.subject === userMsgUri)).toBe(false);
    // No ChatTurn type re-emitted.
    const turnUri = 'urn:dkg:chat:turn:r:asst-3';
    expect(quads.some((q) =>
      q.subject === turnUri && q.predicate === RDF_TYPE && q.object === `${DKG_ONT}ChatTurn`,
    )).toBe(false);
  });

  it('r20-1: caller passes userMessageId WITHOUT explicit userTurnPersisted → FULL safe envelope (legacy inference removed)', async () => {
    // PR #229 bot review round 20 (r20-1). The pre-r20 revision used
    // `presence-of-userMessageId` as a proxy for "user turn was
    // persisted", which conflates addressing (parent id known) with
    // durability (paired write succeeded). External callers using the
    // public catch-all `Record<string, unknown>` overload could omit
    // `userTurnPersisted`, hit the append-only branch, and produce
    // unreadable replies whenever the matching `onChatTurn` write had
    // failed. The fix requires `userTurnPersisted: true` literally;
    // anything else fails closed to the full headless envelope. This
    // test pins the new safe behaviour for exactly the call shape the
    // bot finding flagged: `userMessageId` set, `userTurnPersisted`
    // omitted → must NOT take the append-only branch.
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('legacy path', { id: 'asst-4', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'mem-1' },
    );
    const quads = publishes[0].quads;
    // Full envelope: a typed dkg:ChatTurn subject MUST exist, plus the
    // headless marker (the headless branch tags the turn so readers
    // can distinguish stub-backed envelopes from real onChatTurn
    // writes). Both edges (`hasUserMessage` ∧ `hasAssistantMessage`)
    // are also expected — without them the reader's two-edge join
    // would drop the reply, which is the exact unreadable-reply bug
    // r20-1 prevents.
    //
    // r21-1: the typed envelope now lives on the dedicated
    // `headless-turn:` URI (NOT canonical `turn:`), so the reader
    // contract is checked there instead.
    const turnUri = 'urn:dkg:chat:headless-turn:r:mem-1';
    // r21-1 guard: the canonical `turn:` subject MUST NOT be
    // touched — it would silently overwrite a real `onChatTurn`
    // write whose paired user-turn the caller failed to assert
    // durability for. Pin it.
    expect(quads.some((q) => q.subject === 'urn:dkg:chat:turn:r:mem-1')).toBe(false);
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}headlessTurn`, object: '"true"',
    }));
    expect(quads.some(
      (q) => q.subject === turnUri && q.predicate === `${DKG_ONT}hasUserMessage`,
    )).toBe(true);
    expect(quads.some(
      (q) => q.subject === turnUri && q.predicate === `${DKG_ONT}hasAssistantMessage`,
    )).toBe(true);
  });

  it('r20-1: omitted userTurnPersisted (any non-true value) takes the safe path — explicit false still works', async () => {
    // Defence-in-depth: the new rule is `optsAny.userTurnPersisted === true`,
    // so explicit `false` and any non-boolean (e.g. caller passes a
    // string or a typo'd key) MUST also fall to the safe headless
    // envelope. We exercise the two interesting non-true cases here so
    // any future flip back to `??` semantics flips this test red.
    const { agent, publishes } = makeCapturingAgent();
    // explicit false
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('explicit false', { id: 'asst-r20-a', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'mem-r20-a', userTurnPersisted: false },
    );
    // typo'd key (string truthy, not boolean true)
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('truthy non-bool', { id: 'asst-r20-b', roomId: 'r' } as any),
      {} as State,
      // deliberately wrong shape — must NOT short-circuit to append-only
      { mode: 'assistant-reply', userMessageId: 'mem-r20-b', userTurnPersisted: 'true' as unknown as boolean },
    );
    for (const [i, suffix] of [[0, 'mem-r20-a'], [1, 'mem-r20-b']] as const) {
      // r21-1: headless turn lives under `headless-turn:` now.
      const turnUri = `urn:dkg:chat:headless-turn:r:${suffix}`;
      expect(publishes[i].quads).toContainEqual(expect.objectContaining({
        subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
      }));
      expect(publishes[i].quads).toContainEqual(expect.objectContaining({
        subject: turnUri, predicate: `${DKG_ONT}headlessTurn`, object: '"true"',
      }));
      // r21-1 guard: canonical `turn:r:<suffix>` MUST stay pristine
      // so a paired user-turn write isn't clobbered.
      expect(publishes[i].quads.some((q) =>
        q.subject === `urn:dkg:chat:turn:r:${suffix}`,
      )).toBe(false);
    }
  });

  it('no userTurnPersisted, no userMessageId → FULL headless envelope (ambiguous → safe)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('unsolicited', { id: 'asst-5', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    const quads = publishes[0].quads;
    // r21-1: headless envelope landed on the dedicated subject.
    const turnUri = 'urn:dkg:chat:headless-turn:r:asst-5';
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}headlessTurn`, object: '"true"',
    }));
  });
});

describe('persistChatTurnImpl — PR #229 round 13 (r13-2): headless user stub does NOT leak into session', () => {
  // -------------------------------------------------------------------
  // r13-2: `ChatMemoryManager.getSession()` enumerates every
  // `?msg schema:isPartOf <session>` subject. Before this round the
  // headless user stub carried that edge, so it was listed alongside
  // real messages — and node-ui maps any non-`user` author to
  // "assistant", producing a blank assistant bubble in the UI. We
  // drop the edge on the stub (only); the reader contract still holds
  // because the `dkg:ChatTurn` envelope links to the stub via
  // `dkg:hasUserMessage`, which is what node-ui uses to resolve a turn.
  // -------------------------------------------------------------------
  it('headless user stub does NOT carry schema:isPartOf (prevents session enumeration)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('unsolicited', { id: 'asst-stub-1', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    const quads = publishes[0].quads;
    // r15-2: stub lives in `msg:user-stub:` namespace, keyed on the
    // assistant memory id.
    const userStubUri = 'urn:dkg:chat:msg:user-stub:r:asst-stub-1';
    // Stub exists and is typed as a Message so the envelope edge resolves…
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userStubUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`,
    }));
    // …but it is NOT partOf the session (no blank assistant in the UI).
    expect(quads.some((q) =>
      q.subject === userStubUri && q.predicate === `${SCHEMA}isPartOf`,
    )).toBe(false);
  });

  it('headless turn envelope still carries schema:isPartOf so the TURN itself is discoverable', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('unsolicited', { id: 'asst-stub-2', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    const quads = publishes[0].quads;
    // r21-1: headless turn landed on the dedicated subject.
    const turnUri = 'urn:dkg:chat:headless-turn:r:asst-stub-2';
    // The ChatTurn itself IS partOf the session (turn enumeration works).
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${SCHEMA}isPartOf`, object: 'urn:dkg:chat:session:r',
    }));
  });

  it('headless turn STILL exposes dkg:hasUserMessage so the reader contract holds', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('unsolicited', { id: 'asst-stub-3', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    const quads = publishes[0].quads;
    // r21-1: headless turn landed on the dedicated subject.
    const turnUri = 'urn:dkg:chat:headless-turn:r:asst-stub-3';
    // r15-2: reader contract is satisfied via the stub URI, not the
    // canonical user-message URI (so a concurrent real user-turn can
    // coexist without clobbering each other).
    const userStubUri = 'urn:dkg:chat:msg:user-stub:r:asst-stub-3';
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: userStubUri,
    }));
  });
});

// ===========================================================================
// PR #229 bot review round 15 — r15-2: headless stub URI MUST NOT collide
// with the real user-message URI, even when the caller provides a
// `userMessageId` that matches an earlier onChatTurn write.
// ===========================================================================
describe('persistChatTurnImpl — PR #229 round 15 (r15-2): headless stub URI namespace isolation', () => {
  // -------------------------------------------------------------------
  // r15-2: the r14-2 default (`userTurnPersisted=false` when the
  // caller doesn't assert otherwise) means the headless branch can
  // run even when onChatTurn ALREADY wrote the real user message. If
  // the stub shared `msg:user:${turnKey}` with the real user msg, we
  // would stack a second `schema:author = agent:system` + empty
  // `schema:text` onto the real subject (RDF predicates are
  // multi-valued), corrupting chat history. The fix keys the stub on
  // the assistant memory id under a dedicated `msg:user-stub:`
  // namespace so the two subjects can NEVER share an IRI.
  // -------------------------------------------------------------------
  it('stub uses msg:user-stub: namespace keyed on assistant message id (not msg:user:)', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('stub-ns', { id: 'asst-r15-1', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'user-r15-1', userTurnPersisted: false },
    );
    const quads = publishes[0].quads;
    // Stub subject under the dedicated namespace.
    const stubUri = 'urn:dkg:chat:msg:user-stub:r:asst-r15-1';
    expect(quads.some((q) =>
      q.subject === stubUri && q.predicate === RDF_TYPE && q.object === `${SCHEMA}Message`,
    )).toBe(true);
    // The canonical `msg:user:` URI for the user-turn MUST remain
    // untouched — no stub bytes written there.
    const canonicalUserMsgUri = 'urn:dkg:chat:msg:user:r:user-r15-1';
    expect(quads.some((q) => q.subject === canonicalUserMsgUri)).toBe(false);
  });

  it('stub URI is keyed on assistant memory id so two headless replies with the same userMessageId do NOT collide', async () => {
    const { agent: a1, publishes: p1 } = makeCapturingAgent();
    await persistChatTurnImpl(
      a1, makeRuntime(),
      makeMessage('reply one', { id: 'asst-r15-a', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'same-parent', userTurnPersisted: false },
    );
    const { agent: a2, publishes: p2 } = makeCapturingAgent();
    await persistChatTurnImpl(
      a2, makeRuntime(),
      makeMessage('reply two', { id: 'asst-r15-b', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'same-parent', userTurnPersisted: false },
    );
    const stubSubjects1 = p1[0].quads.filter((q) =>
      q.subject.startsWith('urn:dkg:chat:msg:user-stub:'),
    ).map((q) => q.subject);
    const stubSubjects2 = p2[0].quads.filter((q) =>
      q.subject.startsWith('urn:dkg:chat:msg:user-stub:'),
    ).map((q) => q.subject);
    // Stubs are tied to the assistant memory id (asst-r15-a vs
    // asst-r15-b) so they get distinct URIs even though both replies
    // reference the same userMessageId.
    expect(stubSubjects1).toContain('urn:dkg:chat:msg:user-stub:r:asst-r15-a');
    expect(stubSubjects2).toContain('urn:dkg:chat:msg:user-stub:r:asst-r15-b');
    expect(stubSubjects1[0]).not.toBe(stubSubjects2[0]);
  });

  it('headless turn envelope points dkg:hasUserMessage at the stub, NOT at the canonical user msg URI', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('belated', { id: 'asst-r15-c', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'parent-msg', userTurnPersisted: false },
    );
    const quads = publishes[0].quads;
    // r21-1: headless envelope landed on the dedicated subject so it
    // cannot stomp on the canonical `turn:r:parent-msg` URI which a
    // real `onChatTurn` write may have populated.
    const turnUri = 'urn:dkg:chat:headless-turn:r:parent-msg';
    const hasUserEdges = quads.filter((q) =>
      q.subject === turnUri && q.predicate === `${DKG_ONT}hasUserMessage`,
    );
    // Exactly one hasUserMessage edge, pointing at the stub.
    expect(hasUserEdges).toHaveLength(1);
    expect(hasUserEdges[0].object).toBe('urn:dkg:chat:msg:user-stub:r:asst-r15-c');
    // Must NOT also point at the canonical user URI (no double edge).
    expect(hasUserEdges[0].object).not.toBe('urn:dkg:chat:msg:user:r:parent-msg');
  });

  it('append-only path (userTurnPersisted=true) still uses the canonical userMessageId — r15-2 only touches the headless branch', async () => {
    const { agent, publishes } = makeCapturingAgent();
    await persistChatTurnImpl(
      agent, makeRuntime(),
      makeMessage('append-only', { id: 'asst-r15-d', roomId: 'r' } as any),
      {} as State,
      { mode: 'assistant-reply', userMessageId: 'canonical-user', userTurnPersisted: true },
    );
    const quads = publishes[0].quads;
    // Append-only path writes ONLY the assistant message + the single
    // hasAssistantMessage edge. It must NOT emit any stub subject.
    expect(quads.some((q) => q.subject.startsWith('urn:dkg:chat:msg:user-stub:'))).toBe(false);
    // The user-turn hook's canonical subject is untouched (we never
    // re-emit author/text on it from this path).
    expect(quads.some((q) => q.subject === 'urn:dkg:chat:msg:user:r:canonical-user')).toBe(false);
  });
});

describe('types — PR #229 round 13 (r13-3): Memory includes runtime-required fields', () => {
  // -------------------------------------------------------------------
  // r13-3: the public `Memory` type previously exposed only
  // `{ userId, agentId, roomId, content }` — `persistChatTurnImpl`
  // relied on `id`, `createdAt`, `timestamp`, etc. at runtime, so
  // downstream TypeScript consumers could satisfy the contract at
  // compile time and still throw at runtime. The new type exposes
  // every field actually consulted. This compile-time check doubles
  // as a behavioral pin: if any listed field is ever removed, TS will
  // fail the build here long before callers hit a runtime surprise.
  // -------------------------------------------------------------------
  it('exported Memory type accepts id / createdAt / timestamp / date / ts / inReplyTo', () => {
    const m: Memory = {
      userId: 'u',
      agentId: 'a',
      roomId: 'r',
      content: { text: 'x' },
      id: 'mem-1',
      createdAt: 1700000000000,
      timestamp: 1700000000000,
      date: '2023-11-14T00:00:00.000Z',
      ts: '2023-11-14T00:00:00.000Z',
      inReplyTo: 'mem-0',
    };
    expect(m.id).toBe('mem-1');
  });
});

// ===========================================================================
// PR #229 round 21 — r21-3: schema:Conversation session root is emitted at
// MOST ONCE per (runtime, session) per process. Emitting it on every turn
// trips DKG Working-Memory Rule 4 (entity exclusivity) and rejects the
// second persisted turn in the same room — see node-ui/src/chat-memory.ts
// (search `isNewSession`) for the canonical writer that does the same
// guard for the same reason.
// ===========================================================================
describe('persistChatTurnImpl — r21-3: schema:Conversation session root emitted once per (runtime, session)', () => {
  it('user-turn path emits the schema:Conversation triple on the FIRST call but skips it on subsequent calls in the same room', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('first', { id: 'r21-3-u1', roomId: 'room-once' } as any),
      {} as State, {},
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('second', { id: 'r21-3-u2', roomId: 'room-once' } as any),
      {} as State, {},
    );
    const sessionUri = 'urn:dkg:chat:session:room-once';
    const conversationQuad = (i: number) => publishes[i].quads.filter(
      (q) => q.subject === sessionUri
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(conversationQuad(0)).toHaveLength(1);
    // r21-3: second turn must NOT re-declare `?session a schema:Conversation`.
    // Storage already has the triple from turn 1; re-emitting it forces
    // the WM Rule-4 entity-exclusivity guard to reject the whole write.
    expect(conversationQuad(1)).toHaveLength(0);
  });

  it('headless assistant-reply path is gated by the SAME per-(runtime, session) cache as the user-turn path', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('headless 1', { id: 'r21-3-a1', roomId: 'room-h' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('headless 2', { id: 'r21-3-a2', roomId: 'room-h' } as any),
      {} as State,
      { mode: 'assistant-reply' },
    );
    const sessionUri = 'urn:dkg:chat:session:room-h';
    const conversationQuad = (i: number) => publishes[i].quads.filter(
      (q) => q.subject === sessionUri
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(conversationQuad(0)).toHaveLength(1);
    expect(conversationQuad(1)).toHaveLength(0);
  });

  it('two DIFFERENT runtimes pipelining the same session id BOTH emit the session root (cache is per-runtime, not global)', async () => {
    // Defence-in-depth: a single global cache would silently suppress
    // the second runtime's session declaration, leaving its
    // assertion graph WITHOUT the `?session a schema:Conversation`
    // triple — the reader would then drop every turn that runtime
    // wrote because `getSession` traversal starts at that subject.
    // The cache is keyed on the runtime object so two parallel
    // agents in the same process each get one session-root write.
    __resetEmittedSessionRootsForTests();
    const { agent: a1, publishes: p1 } = makeCapturingAgent();
    const { agent: a2, publishes: p2 } = makeCapturingAgent();
    const runtime1 = makeRuntime();
    const runtime2 = makeRuntime();
    await persistChatTurnImpl(
      a1, runtime1,
      makeMessage('rt1', { id: 'r21-3-rt1', roomId: 'shared-room' } as any),
      {} as State, {},
    );
    await persistChatTurnImpl(
      a2, runtime2,
      makeMessage('rt2', { id: 'r21-3-rt2', roomId: 'shared-room' } as any),
      {} as State, {},
    );
    const sessionUri = 'urn:dkg:chat:session:shared-room';
    const conv = (qs: any[]) => qs.filter(
      (q) => q.subject === sessionUri
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(conv(p1[0].quads)).toHaveLength(1);
    expect(conv(p2[0].quads)).toHaveLength(1);
  });

  it('different sessions on the same runtime each get one session-root write', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('a', { id: 'r21-3-sa-1', roomId: 'session-A' } as any),
      {} as State, {},
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('b', { id: 'r21-3-sb-1', roomId: 'session-B' } as any),
      {} as State, {},
    );
    const conv = (qs: any[], session: string) => qs.filter(
      (q) => q.subject === `urn:dkg:chat:session:${session}`
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(conv(publishes[0].quads, 'session-A')).toHaveLength(1);
    expect(conv(publishes[1].quads, 'session-B')).toHaveLength(1);
  });

  // ===========================================================================
  // PR #229 round 24 — r24-1: the per-runtime session-root cache MUST include
  // the destination assertion graph. A runtime that writes the same session
  // into two different `(contextGraphId, assertionName)` targets MUST emit
  // `?session rdf:type schema:Conversation` in BOTH destinations, otherwise
  // the second store has no `schema:Conversation` root and readers like
  // `ChatMemoryManager` enumerating by type triple surface zero sessions.
  // ===========================================================================
  it('r24-1: same (runtime, session) routed into TWO different context graphs emits a session root in BOTH', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('to CG A', { id: 'r24-1-a1', roomId: 'room-r24-1' } as any),
      {} as State,
      { contextGraphId: 'graph-a', assertionName: 'chat-turns' },
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('to CG B', { id: 'r24-1-b1', roomId: 'room-r24-1' } as any),
      {} as State,
      { contextGraphId: 'graph-b', assertionName: 'chat-turns' },
    );
    expect(publishes[0].cgId).toBe('graph-a');
    expect(publishes[1].cgId).toBe('graph-b');
    const convRoot = (qs: any[]) => qs.filter(
      (q) => q.subject === 'urn:dkg:chat:session:room-r24-1'
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    // Before r24-1 this second publish would have ZERO session-root
    // quads because the cache was keyed only by (runtime, sessionUri).
    expect(convRoot(publishes[0].quads)).toHaveLength(1);
    expect(convRoot(publishes[1].quads)).toHaveLength(1);
  });

  it('r24-1: same (runtime, session, contextGraphId) but DIFFERENT assertionName still emits in both assertions', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('to assertion-1', { id: 'r24-1-an1', roomId: 'room-r24-1-an' } as any),
      {} as State,
      { contextGraphId: 'agent-context', assertionName: 'assertion-1' },
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('to assertion-2', { id: 'r24-1-an2', roomId: 'room-r24-1-an' } as any),
      {} as State,
      { contextGraphId: 'agent-context', assertionName: 'assertion-2' },
    );
    const convRoot = (qs: any[]) => qs.filter(
      (q) => q.subject === 'urn:dkg:chat:session:room-r24-1-an'
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(convRoot(publishes[0].quads)).toHaveLength(1);
    expect(convRoot(publishes[1].quads)).toHaveLength(1);
  });

  it('r24-1: second turn into the SAME destination still de-dupes the session root (the WM-Rule-4 invariant survives)', async () => {
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('first', { id: 'r24-1-dedup-1', roomId: 'room-r24-1-dedup' } as any),
      {} as State,
      { contextGraphId: 'agent-context', assertionName: 'chat-turns' },
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('second', { id: 'r24-1-dedup-2', roomId: 'room-r24-1-dedup' } as any),
      {} as State,
      { contextGraphId: 'agent-context', assertionName: 'chat-turns' },
    );
    const convRoot = (qs: any[]) => qs.filter(
      (q) => q.subject === 'urn:dkg:chat:session:room-r24-1-dedup'
        && q.predicate === RDF_TYPE
        && q.object === `${SCHEMA}Conversation`,
    );
    expect(convRoot(publishes[0].quads)).toHaveLength(1);
    expect(convRoot(publishes[1].quads)).toHaveLength(0);
  });

  it('non-session quads (user message, turn envelope) STILL get emitted on every turn — only the session-root quad is gated', async () => {
    // Regression guard: the gate must NOT accidentally short-circuit
    // the rest of the user-turn quads. We assert the second turn
    // still writes its `msg:user:` subject + `turn:` envelope,
    // because dropping those would make the second turn invisible.
    __resetEmittedSessionRootsForTests();
    const { agent, publishes } = makeCapturingAgent();
    const runtime = makeRuntime();
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('first', { id: 'r21-3-c1', roomId: 'room-c' } as any),
      {} as State, {},
    );
    await persistChatTurnImpl(
      agent, runtime,
      makeMessage('second', { id: 'r21-3-c2', roomId: 'room-c' } as any),
      {} as State, {},
    );
    const turn2 = publishes[1].quads;
    expect(turn2.some((q) =>
      q.subject === 'urn:dkg:chat:msg:user:room-c:r21-3-c2'
      && q.predicate === `${SCHEMA}text`
      && q.object === '"second"',
    )).toBe(true);
    expect(turn2.some((q) =>
      q.subject === 'urn:dkg:chat:turn:room-c:r21-3-c2'
      && q.predicate === RDF_TYPE
      && q.object === `${DKG_ONT}ChatTurn`,
    )).toBe(true);
  });
});
