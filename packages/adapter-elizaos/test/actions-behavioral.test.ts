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
import { persistChatTurnImpl, dkgPersistChatTurn } from '../src/actions.js';
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
      { mode: 'assistant-reply', userMessageId: 'mem-1' },
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
    const turnUri = 'urn:dkg:chat:turn:r:asst-only-mem';
    const userMsgUri = 'urn:dkg:chat:msg:user:r:asst-only-mem';
    const assistantMsgUri = 'urn:dkg:chat:msg:agent:r:asst-only-mem';

    // Full envelope with BOTH edges — what the node-ui reader wants.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: userMsgUri,
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
      subject: userMsgUri, predicate: `${DKG_ONT}headlessUserMessage`, object: '"true"',
    }));
    // Stub user message: empty text + system author, NOT the regular
    // CHAT_USER_ACTOR — so UIs don't render an empty user bubble.
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userMsgUri, predicate: `${SCHEMA}text`, object: '""',
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      subject: userMsgUri, predicate: `${SCHEMA}author`, object: `${DKG_ONT}agent:system`,
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
      (q) => q.predicate === `${SCHEMA}dateCreated` && q.subject.startsWith('urn:dkg:chat:turn:'),
    )!;
    // Bot review (PR #229 follow-up, actions.ts:539): re-firing the same
    // hook must not mint a fresh `schema:dateCreated`, otherwise downstream
    // readers see conflicting timestamps for the "same" turn.
    expect(tsQuad(0).object).toBe(tsQuad(1).object);
  });

  it('targets the SAME turnUri as the matching user-turn call when userMessageId is supplied', async () => {
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
      { mode: 'assistant-reply', userMessageId: 'mem-1' },
    );
    const linkQuad = publishes[1].quads.find((q) => q.predicate === `${DKG_ONT}hasAssistantMessage`)!;
    expect(linkQuad.subject).toBe(userOut.turnUri);
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
    expect(ts.object).toMatch(new RegExp(`\\^\\^<${XSD_DATETIME}>$`));
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
