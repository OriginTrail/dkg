import { describe, it, expect, beforeEach } from 'vitest';
import { isSafeIri } from '@origintrail-official/dkg-core';
import { ChatMemoryManager, decodeRdfStringLiteral } from '../src/chat-memory.js';

interface TrackingFn {
  (...args: unknown[]): Promise<any>;
  calls: unknown[][];
  returns: unknown[];
  defaultReturn: unknown;
}

function trackFn(defaultReturn?: unknown): TrackingFn {
  const calls: unknown[][] = [];
  const returns: unknown[] = [];
  const fn = (async (...args: unknown[]) => {
    calls.push(args);
    if (returns.length > 0) return returns.shift();
    return defaultReturn;
  }) as TrackingFn;
  fn.calls = calls;
  fn.returns = returns;
  fn.defaultReturn = defaultReturn;
  return fn;
}

function createTools(overrides?: {
  mockQuery?: TrackingFn;
  mockShare?: TrackingFn;
  mockCreateContextGraph?: TrackingFn;
  mockListContextGraphs?: TrackingFn;
  mockPublishFromSharedMemory?: TrackingFn;
}) {
  const mockQuery = overrides?.mockQuery ?? trackFn({ bindings: [] });
  const mockShare = overrides?.mockShare ?? trackFn({ shareOperationId: 'op-1' });
  const mockCreateContextGraph = overrides?.mockCreateContextGraph ?? trackFn(undefined);
  const mockListContextGraphs = overrides?.mockListContextGraphs ?? trackFn([{ id: 'agent-memory', name: 'Agent Memory' }]);

  return {
    mockQuery,
    mockShare,
    mockCreateContextGraph,
    mockListContextGraphs,
    tools: {
      query: mockQuery,
      createContextGraph: mockCreateContextGraph,
      listContextGraphs: mockListContextGraphs,
    },
  };
}

describe('decodeRdfStringLiteral (history-text deserialization)', () => {
  // The write path stores chat text as `JSON.stringify(text)` inside an
  // RDF literal. `decodeRdfStringLiteral` must be the exact inverse so
  // history reload recovers the original string faithfully (the
  // markdown-broken-after-refresh regression). Each case constructs the
  // literal exactly as the write path would, then asserts a clean
  // round-trip.
  const asRdfLiteral = (s: string) => JSON.stringify(s); // e.g. "line1\nline2"

  it('round-trips multi-line markdown (real newlines survive)', () => {
    const original = '# Heading\n\nPara one\n\n- a\n- b\n\n```ts\nconst x = 1;\n```';
    expect(decodeRdfStringLiteral(asRdfLiteral(original))).toBe(original);
  });

  it('round-trips an intentional literal backslash-n inside JSON content', () => {
    // The encoder writes a literal backslash-n as `\\n`; the decoder must
    // give it back as a literal, NOT a real newline. This is the case
    // the four PR4 UI heuristics could not get right.
    const original = 'Here is JSON: {"text":"a\\nb"}';
    expect(decodeRdfStringLiteral(asRdfLiteral(original))).toBe(original);
  });

  it('round-trips a fenced block holding BOTH a real newline and a literal backslash-n', () => {
    // The single fixture that locks both halves of the inverse at once:
    // a regression to any heuristic decoder would either collapse the
    // literal `\n` token or fail to restore the real line break.
    const original = '```js\nconsole.log("a\\nb");\n```';
    expect(decodeRdfStringLiteral(asRdfLiteral(original))).toBe(original);
  });

  it('round-trips embedded quotes, tabs, CRLF, and unicode escapes', () => {
    const original = 'q="x"\ttab\r\nwin-newline\nημει — dash';
    expect(decodeRdfStringLiteral(asRdfLiteral(original))).toBe(original);
  });

  it('round-trips a lone single backslash and an astral/surrogate-pair char', () => {
    // Single backslash (not a `\n` token) — write stores `"a\\b"`,
    // decode must give back `a\b`. Pins single-backslash distinctly
    // from the literal-`\n` case above.
    expect(decodeRdfStringLiteral(asRdfLiteral('path a\\b end'))).toBe('path a\\b end');
    // Astral char (surrogate pair) must survive reload unmangled.
    expect(decodeRdfStringLiteral(asRdfLiteral('👍 done 𝕏'))).toBe('👍 done 𝕏');
  });

  it('strips an RDF type / language annotation before decoding', () => {
    expect(
      decodeRdfStringLiteral(`${asRdfLiteral('a\nb')}^^<http://www.w3.org/2001/XMLSchema#string>`),
    ).toBe('a\nb');
    expect(decodeRdfStringLiteral(`${asRdfLiteral('hola')}@es`)).toBe('hola');
  });

  // BCP-47 language tags allow ASCII letters, digits, and hyphens with a
  // leading letter — `@en-US`, `@zh-Hans-CN`, `@x-private1` are all valid.
  // The old `@[a-z-]+` regex rejected them, causing non-English / regional
  // labels to surface as raw `"Müller"@de-DE` text in the singleton shelf
  // (R1 finding from local PR review on 444e0e77).
  it('strips BCP-47 language tags with case, digits, and multiple subtags', () => {
    expect(decodeRdfStringLiteral(`${asRdfLiteral('Müller')}@de-DE`)).toBe('Müller');
    expect(decodeRdfStringLiteral(`${asRdfLiteral('hello')}@en-US`)).toBe('hello');
    expect(decodeRdfStringLiteral(`${asRdfLiteral('你好')}@zh-Hans-CN`)).toBe('你好');
    expect(decodeRdfStringLiteral(`${asRdfLiteral('private')}@x-private1`)).toBe('private');
  });

  it('passes a bare / unquoted value through unchanged (parity with stripRdfLiteral)', () => {
    expect(decodeRdfStringLiteral('not-a-literal')).toBe('not-a-literal');
    expect(decodeRdfStringLiteral('')).toBe('');
  });

  it('falls back to the raw inner body when the literal is not valid JSON-escaped', () => {
    // A lone trailing backslash is not a valid JSON string escape — the
    // decoder must not throw; it returns the inner body verbatim,
    // exactly as the old stripRdfLiteral did.
    expect(decodeRdfStringLiteral('"bad\\"')).toBe('bad\\');
  });
});

describe('ChatMemoryManager', () => {
  let manager: ChatMemoryManager;
  let mockQuery: TrackingFn;
  let mockShare: TrackingFn;
  let mockCreateAssertion: TrackingFn;
  let mockWriteAssertion: TrackingFn;
  let mockCreateContextGraph: TrackingFn;
  let mockListContextGraphs: TrackingFn;

  beforeEach(() => {
    mockQuery = trackFn({ bindings: [] });
    mockShare = trackFn({ shareOperationId: 'op-1' });
    mockCreateAssertion = trackFn({ assertionUri: 'urn:test:assertion', alreadyExists: false });
    mockWriteAssertion = trackFn({ written: 0 });
    mockCreateContextGraph = trackFn(undefined);
    mockListContextGraphs = trackFn([{ id: 'agent-context', name: 'Agent Context' }]);

    manager = new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );
  });

  it('stores a chat exchange via writeAssertion to agent-context / chat-turns', async () => {
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('session-1', 'Hello', 'Hi there!');

    expect(mockWriteAssertion.calls[0]).toEqual([
      'agent-context',
      'chat-turns',
      expect.any(Array),
      { agentAddress: 'did:dkg:agent:test' },
    ]);
    expect(mockShare.calls).toHaveLength(0);
    const quads = mockWriteAssertion.calls[0][2] as any[];
    expect(quads.length).toBeGreaterThanOrEqual(12);
    const sessionTriple = quads.find((q: any) => q.predicate?.includes('sessionId'));
    expect(sessionTriple).toBeDefined();
    expect(sessionTriple.object).toContain('session-1');
  });

  it('persists failureReason on failed chat turns', async () => {
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('session-1', 'Hello', 'Hi there!', undefined, {
      turnId: 'turn-1',
      persistenceState: 'failed',
      failureReason: 'timeout',
    });

    const quads = mockWriteAssertion.calls[0][2] as any[];
    const failureReasonQuad = quads.find((q: any) => q.predicate?.includes('failureReason'));
    expect(failureReasonQuad).toBeDefined();
    expect(failureReasonQuad.object).toBe('"timeout"');
  });

  it('checks a chat turn directly by turnId without scanning session history', async () => {
    mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: 'urn:dkg:chat:turn:turn-1' }] });

    await expect(manager.hasChatTurn('session-1', 'turn-1')).resolves.toBe(true);

    const turnQuery = mockQuery.calls.at(-1)?.[0] as string;
    expect(turnQuery).toContain('turnId> "turn-1"');
    expect(turnQuery).toContain('LIMIT 1');
  });

  it('records chat turn persistence transitions without appending messages', async () => {
    // The second answer is the lookup of the turn's subject: a turn stored
    // before session-scoped subjects sits under `turn:<turnId>` and keeps
    // receiving its transitions there.
    mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: 'urn:dkg:chat:turn:turn-1' }] });

    await manager.recordChatTurnPersistenceTransition('session-1', 'turn-1', 'stored', {
      assistantReply: 'Final reply',
      toolCalls: [{ name: 'lookup', args: { query: 'hello' }, result: { ok: true } }],
      attachmentRefs: [{
        id: 'att-1',
        fileName: 'notes.md',
        contextGraphId: 'project-1',
        assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
        fileHash: 'keccak256:abc123',
        extractionStatus: 'completed',
        tripleCount: 12,
      }],
    });

    const quads = mockWriteAssertion.calls[0][2] as any[];
    expect(quads.find((q: any) => q.object === 'http://dkg.io/ontology/ChatTurnPersistenceTransition')).toBeDefined();
    expect(quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/updatesTurn')?.object)
      .toBe('urn:dkg:chat:session-turn:%5B%22session-1%22%2C%22turn-1%22%5D');
    expect(quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/persistenceState')?.object)
      .toBe('"stored"');
    expect(quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/assistantReply')?.object)
      .toBe('"Final reply"');
    expect(quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/toolCalls')).toBeDefined();
    expect(quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/attachmentRefs')).toBeDefined();
    expect(quads.some((q: any) => q.object === 'http://schema.org/Message')).toBe(false);
    expect(quads.some((q: any) => q.predicate === 'http://dkg.io/ontology/hasUserMessage')).toBe(false);
    expect(quads.some((q: any) => q.predicate === 'http://dkg.io/ontology/hasAssistantMessage')).toBe(false);
  });

  it('stores attachment refs inline on the user message when provided', async () => {
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange(
      'session-attachments',
      'Summarize these',
      'Done',
      undefined,
      {
        attachmentRefs: [{
          id: 'att-1',
          fileName: 'notes.md',
          contextGraphId: 'project-1',
          assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
          fileHash: 'keccak256:abc123',
          detectedContentType: 'text/markdown',
          extractionStatus: 'completed',
          tripleCount: 12,
        }],
      },
    );

    const quads = mockWriteAssertion.calls[0][2] as any[];
    const attachmentQuad = quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/attachmentRefs');
    const usedToolQuad = quads.find((q: any) => q.predicate === 'http://dkg.io/ontology/usedTool');
    expect(attachmentQuad).toBeDefined();
    expect(usedToolQuad).toBeUndefined();
    const persistedRefs = JSON.parse(JSON.parse(String(attachmentQuad.object)));
    expect(persistedRefs).toEqual([
      expect.objectContaining({
        id: 'att-1',
        fileName: 'notes.md',
        contextGraphId: 'project-1',
        assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
        fileHash: 'keccak256:abc123',
        detectedContentType: 'text/markdown',
        extractionStatus: 'completed',
        tripleCount: 12,
      }),
    ]);
  });

  it('includes session triples only on first write for a session', async () => {
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('session-1', 'First message', 'First reply');
    await manager.storeChatExchange('session-1', 'Second message', 'Second reply');

    expect(mockWriteAssertion.calls).toHaveLength(2);
    const firstQuads = mockWriteAssertion.calls[0][2] as any[];
    const secondQuads = mockWriteAssertion.calls[1][2] as any[];
    const firstSessionTriple = firstQuads.find((q: any) => q.predicate?.includes('sessionId'));
    const secondSessionTriple = secondQuads.find((q: any) => q.predicate?.includes('sessionId'));
    const replyEdge = secondQuads.find((q: any) => q.predicate?.includes('replyTo'));
    expect(firstSessionTriple).toBeDefined();
    expect(secondSessionTriple).toBeUndefined();
    expect(replyEdge).toBeDefined();
    expect(secondQuads.length).toBe(11);
  });

  it('creates agent-context context graph when not in list', async () => {
    mockListContextGraphs.returns.push([]);
    mockQuery.returns.push({ bindings: [] });
    const m = new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );
    await m.storeChatExchange('s1', 'x', 'y');
    expect(mockCreateContextGraph.calls[0][0]).toEqual(
      expect.objectContaining({ id: 'agent-context', name: 'Agent Context', private: true }),
    );
  });

  it('getRecentChats returns sessions from query bindings', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1', sid: '"uuid-1"' },
        ],
      },
      {
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:user', text: '"Hi"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:agent', text: '"Hello"', ts: '"2026-01-01T12:00:01Z"' },
        ],
      },
    );

    const chats = await manager.getRecentChats(10);
    expect(chats).toHaveLength(1);
    expect(chats[0].session).toBe('uuid-1');
    expect(chats[0].messages).toHaveLength(2);
    expect(chats[0].messages[0].author).toBe('user');
    expect(chats[0].messages[1].author).toBe('agent');
  });

  it('getRecentChats batches message retrieval across sessions', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-2', sid: '"uuid-2"' },
        ],
      },
      {
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:user', text: '"Hi 1"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:agent', text: '"Hello 1"', ts: '"2026-01-01T12:00:01Z"' },
          { session: 'urn:dkg:chat:session:uuid-2', author: 'urn:dkg:chat:actor:user', text: '"Hi 2"', ts: '"2026-01-01T12:01:00Z"' },
        ],
      },
    );

    const chats = await manager.getRecentChats(10);
    expect(chats).toHaveLength(2);
    expect(chats[0].session).toBe('uuid-1');
    expect(chats[1].session).toBe('uuid-2');
    expect(mockQuery.calls).toHaveLength(3);
    expect(String(mockQuery.calls[2][0])).toContain('VALUES ?session');
  });

  it('getRecentChats de-duplicates session ids when multiple roots share the same sessionId', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1-data', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-1-shared-memory', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-2', sid: '"uuid-2"' },
        ],
      },
      {
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1-data', author: 'urn:dkg:chat:actor:user', text: '"Hi 1"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-2', author: 'urn:dkg:chat:actor:user', text: '"Hi 2"', ts: '"2026-01-01T12:01:00Z"' },
        ],
      },
    );

    const chats = await manager.getRecentChats(2);
    expect(chats).toHaveLength(2);
    expect(chats.map((chat) => chat.session)).toEqual(['uuid-1', 'uuid-2']);

    const valuesQuery = String(mockQuery.calls[2][0]);
    expect(valuesQuery).toContain('<urn:dkg:chat:session:uuid-1-data>');
    expect(valuesQuery).not.toContain('<urn:dkg:chat:session:uuid-1-shared-memory>');
  });

  it('getSession returns messages for a specific session', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { m: 'urn:dkg:chat:msg:user-1', author: 'urn:dkg:chat:actor:user', text: '"What is DKG?"', ts: '"2026-01-01T12:00:00Z"' },
          { m: 'urn:dkg:chat:msg:agent-1', author: 'urn:dkg:chat:actor:agent', text: '"DKG is the Decentralized Knowledge Graph"', ts: '"2026-01-01T12:00:01Z"' },
        ],
      },
    );

    const session = await manager.getSession('test-session-1');
    expect(session).not.toBeNull();
    expect(session!.session).toBe('test-session-1');
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].uri).toBe('urn:dkg:chat:msg:user-1');
    expect(session!.messages[0].author).toBe('user');
    expect(session!.messages[0].text).toBe('What is DKG?');
    expect(session!.messages[1].author).toBe('agent');
  });

  it('getSession returns attachment refs on the user turn when present', async () => {
    const attachmentRefsLiteral = JSON.stringify(JSON.stringify([{
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
      fileHash: 'keccak256:abc123',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed',
      tripleCount: 12,
    }]));

    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:user-1',
            author: 'urn:dkg:chat:actor:user',
            text: '"Summarize these"',
            ts: '"2026-01-01T12:00:00Z"',
            attachmentRefs: attachmentRefsLiteral,
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-attachments');
    expect(session).not.toBeNull();
    expect(session!.messages[0].attachmentRefs).toEqual([
      expect.objectContaining({
        id: 'att-1',
        fileName: 'notes.md',
        contextGraphId: 'project-1',
        assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
        fileHash: 'keccak256:abc123',
        detectedContentType: 'text/markdown',
        extractionStatus: 'completed',
        tripleCount: 12,
      }),
    ]);
  });

  it('getSession can request the latest session window in descending backend order', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { m: 'urn:dkg:chat:msg:agent-3', author: 'urn:dkg:chat:actor:agent', text: '"Newest"', ts: '"2026-01-01T12:00:02Z"', turnId: '"turn-3"' },
          { m: 'urn:dkg:chat:msg:user-2', author: 'urn:dkg:chat:actor:user', text: '"Middle"', ts: '"2026-01-01T12:00:01Z"', turnId: '"turn-2"' },
          { m: 'urn:dkg:chat:msg:user-1', author: 'urn:dkg:chat:actor:user', text: '"Oldest"', ts: '"2026-01-01T12:00:00Z"', turnId: '"turn-1"' },
        ],
      },
    );

    const session = await manager.getSession('test-session-latest', { limit: 3, order: 'desc' });

    expect(session).not.toBeNull();
    expect(session!.messages.map((message) => message.text)).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(session!.messages.map((message) => message.uri)).toEqual([
      'urn:dkg:chat:msg:agent-3',
      'urn:dkg:chat:msg:user-2',
      'urn:dkg:chat:msg:user-1',
    ]);
    const queryText = String(mockQuery.calls[1][0]);
    expect(queryText).toContain('SELECT ?m ?author ?text ?ts ?turnId ?persistenceState ?transitionState ?attachmentRefs ?failureReason ?transitionFailureReason ?transitionAssistantReply ?transitionAttachmentRefs ?transitionToolCalls');
    expect(queryText).toContain('SELECT ?m ?ts WHERE');
    expect(queryText).toContain('ORDER BY DESC(?ts) LIMIT 3');
    expect(queryText.match(/LIMIT 3/g)).toHaveLength(1);
  });

  it('getSession returns null when session has no messages', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [] },
    );
    const session = await manager.getSession('nonexistent');
    expect(session).toBeNull();
  });

  it('getSession includes turn metadata when present', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: '"Answer"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"stored"',
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-2');
    expect(session).not.toBeNull();
    expect(session!.messages[0].uri).toBe('urn:dkg:chat:msg:agent-1');
    expect(session!.messages[0].turnId).toBe('turn-1');
    expect(session!.messages[0].persistStatus).toBe('stored');
  });

  it('getSession includes failureReason for failed turns when present', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: '"Answer"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"failed"',
            failureReason: '"timeout"',
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-3');
    expect(session).not.toBeNull();
    expect(session!.messages[0].persistStatus).toBe('failed');
    expect(session!.messages[0].failureReason).toBe('timeout');
  });

  it('getSession collapses persistence transition rows into one message', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: '"Answer"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"pending"',
            transitionState: '"failed"',
            transitionFailureReason: '"temporary"',
          },
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: '"Answer"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"pending"',
            transitionState: '"stored"',
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-transition-rows');
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0].persistStatus).toBe('stored');
    expect(session!.messages[0].failureReason).toBeUndefined();
  });

  it('getSession applies stored transition payload updates to provisional turns', async () => {
    const transitionAttachmentRefs = JSON.stringify(JSON.stringify([{
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
      fileHash: 'keccak256:abc123',
      extractionStatus: 'completed',
      tripleCount: 12,
    }]));
    const transitionToolCalls = JSON.stringify(JSON.stringify([
      { name: 'lookup', args: { query: 'hello' }, result: { ok: true } },
    ]));
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:user-1',
            author: 'urn:dkg:chat:actor:user',
            text: '"Draft user"',
            ts: '"2026-01-01T12:00:00Z"',
            turnId: '"turn-1"',
            persistenceState: '"pending"',
            transitionState: '"stored"',
            transitionAttachmentRefs,
          },
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: '"Draft reply"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"pending"',
            transitionState: '"stored"',
            transitionAssistantReply: '"Final reply"',
            transitionToolCalls,
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-transition-payload');

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].attachmentRefs?.[0]).toEqual(expect.objectContaining({ id: 'att-1' }));
    expect(session!.messages[1].text).toBe('Final reply');
    expect(session!.messages[1].toolCalls?.[0]).toEqual(expect.objectContaining({ name: 'lookup' }));
    expect(session!.messages[1].persistStatus).toBe('stored');
  });

  it('getSession decodes a multi-line assistant reply from the stored transition path', async () => {
    // Regression for Codex round-6: the stored-transition overwrite at
    // chat-memory.ts must use decodeRdfStringLiteral, not the
    // wrapper-only stripRdfLiteral — otherwise a persisted (stored)
    // assistant turn (the dominant path on reload) comes back with
    // literal `\n` and markdown breaks after refresh again. The
    // transition `assistantReply` is written via JSON.stringify, so
    // the daemon literal carries escaped newlines.
    const richReply = '# Title\n\nPara one\n\n- item a\n- item b\n\n```ts\nconst x = 1;\n```';
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          {
            m: 'urn:dkg:chat:msg:agent-1',
            author: 'urn:dkg:chat:actor:agent',
            text: JSON.stringify('Draft reply'),
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"pending"',
            transitionState: '"stored"',
            transitionAssistantReply: JSON.stringify(richReply),
          },
        ],
      },
    );

    const session = await manager.getSession('test-session-transition-multiline');

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    // Real newlines recovered — NOT the literal two-char `\n` escape.
    expect(session!.messages[0].text).toBe(richReply);
    expect(session!.messages[0].text).not.toContain('\\n');
    expect(session!.messages[0].persistStatus).toBe('stored');
  });

  it('getStats returns session and triple counts', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ c: '10' }] },
      { bindings: [{ c: '3' }] },
      { bindings: [{ c: '6' }] },
      { bindings: [{ c: '8' }] },
      { bindings: [{ c: '1' }] },
    );

    const stats = await manager.getStats();
    expect(stats.contextGraphId).toBe('agent-context');
    expect(stats.initialized).toBe(true);
    expect(stats.sessionCount).toBe(3);
    expect(stats.totalTriples).toBe(10);
    expect(stats.messageCount).toBe(6);
  });

  it('omits temperature and max_tokens for gpt-5 mention extraction requests', async () => {
    const gpt5Manager = new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test', model: 'gpt-5-mini', baseURL: 'https://api.openai.com/v1' },
      { agentAddress: 'did:dkg:agent:test' },
    );

    const fetchCalls: unknown[][] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '[]' } }],
      }), { status: 200 });
    }) as any;

    try {
      const extracted = await (gpt5Manager as any).callMentionExtraction('User: hi\nAssistant: hello');
      expect(Array.isArray(extracted)).toBe(true);

      const reqInit = fetchCalls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(reqInit?.body ?? '{}'));
      expect(payload.temperature).toBeUndefined();
      expect(payload.max_tokens).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('getSessionPublicationStatus reports shared-memory-only scope when data graph is empty', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ c: '"12"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ c: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-1' }, { s: 'urn:dkg:chat:msg:m-1' }] },
    );

    const status = await manager.getSessionPublicationStatus('s-1');
    expect(status.scope).toBe('shared_memory_only');
    expect(status.sharedMemoryTripleCount).toBe(12);
    expect(status.dataTripleCount).toBe(0);
    expect(status.rootEntityCount).toBe(2);
  });

  it('getSessionPublicationStatus reports published-with-pending scope when shared memory has newer turns', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ c: '"15"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ c: '"12"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-1' }] },
    );

    const status = await manager.getSessionPublicationStatus('s-1');
    expect(status.scope).toBe('published_with_pending');
    expect(status.sharedMemoryTripleCount).toBe(15);
    expect(status.dataTripleCount).toBe(12);
  });

  // The 'getSessionRootEntities widens the openclaw local session to
  // imported memory roots' test was removed with the retirement of the
  // /api/memory/import endpoint and the ImportedMemory / MemoryImport
  // special-case branch inside buildSessionRootPattern.

  it('getSessionRootEntities keeps regular chat sessions scoped to their own graph roots', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [] },
    );

    await manager.getSessionRootEntities('session-regular');

    const query = String(mockQuery.calls[1][0]);
    expect(query).not.toContain('<http://dkg.io/ontology/ImportedMemory>');
    expect(query).not.toContain('<http://dkg.io/ontology/MemoryImport>');
  });

  it('publishSession is retired until chat turns are promoted through named KA lifecycle routes', async () => {
    await expect(manager.publishSession('s-2')).rejects.toThrow('Session publication is not implemented in v1');
  });

  it('publishFromSwm is retired as a raw SWM publish helper', async () => {
    await expect(manager.publishFromSwm('all')).rejects.toThrow('publishFromSwm is retired in v1');
  });

  it('getSessionGraphDelta returns turn-scoped triples when watermark matches', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      {
        bindings: [
          {
            turn: 'urn:dkg:chat:turn:t2',
            tid: '"t2"',
            ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
          },
        ],
      },
      {
        bindings: [
          {
            latestTurnId: '"t2"',
            latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
          },
        ],
      },
      {
        bindings: [
          { previousTurnId: '"t1"' },
        ],
      },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      {
        bindings: [
          {
            user: 'urn:dkg:chat:msg:user-2',
            assistant: 'urn:dkg:chat:msg:assistant-2',
          },
        ],
      },
      // The four related-subject relations: transitions, tools, mentions, memories.
      { bindings: [] },
      { bindings: [] },
      { bindings: [{ s: 'urn:dkg:chat:msg:user-2' }, { s: 'urn:dkg:chat:msg:assistant-2' }] },
      { bindings: [] },
      {
        quads: [
          {
            subject: 'urn:dkg:chat:turn:t2',
            predicate: 'http://dkg.io/ontology/turnId',
            object: '"t2"',
          },
          {
            subject: 'urn:dkg:chat:msg:m2',
            predicate: 'http://schema.org/text',
            object: '"hello"',
          },
        ],
      },
    );

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });
    expect(delta.mode).toBe('delta');
    expect(delta.turnId).toBe('t2');
    expect(delta.triples).toHaveLength(2);
    expect(delta.watermark.previousTurnId).toBe('t1');
    expect(delta.watermark.latestTurnId).toBe('t2');
  });

  it('getSessionGraphDelta falls back when turn message links are missing', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      {
        bindings: [{ turn: 'urn:dkg:chat:turn:t2', tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ previousTurnId: '"t1"' }],
      },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      { bindings: [] },
    );

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('turn_not_found');
    expect(delta.triples).toHaveLength(0);
  });

  it('getSessionGraphDelta requires full refresh when non-initial turn is requested without watermark', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      {
        bindings: [{ turn: 'urn:dkg:chat:turn:t2', tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ previousTurnId: '"t1"' }],
      },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
    );

    const delta = await manager.getSessionGraphDelta('s-graph', 't2');
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('missing_watermark');
    expect(delta.triples).toHaveLength(0);
    expect(mockQuery.calls).toHaveLength(6);
  });

  it('getSessionGraphDelta requires full refresh when watermark mismatches', async () => {
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
      {
        bindings: [{ turn: 'urn:dkg:chat:turn:t2', tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      },
      {
        bindings: [{ previousTurnId: '"t1"' }],
      },
      {
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      },
    );

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 'not-t1' });
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('watermark_mismatch');
    expect(delta.triples).toHaveLength(0);
    expect(mockQuery.calls).toHaveLength(6);
  });
});

describe('ChatMemoryManager WM write discipline', () => {
  let mockQuery: TrackingFn;
  let mockShare: TrackingFn;
  let mockCreateAssertion: TrackingFn;
  let mockWriteAssertion: TrackingFn;
  let mockCreateContextGraph: TrackingFn;
  let mockListContextGraphs: TrackingFn;

  beforeEach(() => {
    mockQuery = trackFn({ bindings: [] });
    mockShare = trackFn({ shareOperationId: 'op-1' });
    mockCreateAssertion = trackFn({ assertionUri: 'urn:test:assertion', alreadyExists: false });
    mockWriteAssertion = trackFn({ written: 0 });
    mockCreateContextGraph = trackFn(undefined);
    mockListContextGraphs = trackFn([{ id: 'agent-context', name: 'Agent Context' }]);
  });

  function createManager() {
    return new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );
  }

  it('chat-turn writes go through writeAssertion, not share', async () => {
    const manager = createManager();
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('s1', 'Hello', 'Hi');

    expect(mockWriteAssertion.calls.length).toBeGreaterThan(0);
    expect(mockShare.calls).toHaveLength(0);
  });

  it('ensureInitialized creates the assertion with the manager agentAddress before first write', async () => {
    const order: string[] = [];
    const manager = new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: async (...args) => {
          order.push('create');
          return mockCreateAssertion(...args);
        },
        writeAssertion: async (...args) => {
          order.push('write');
          return mockWriteAssertion(...args);
        },
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );
    mockQuery.returns.push({ bindings: [] });

    await manager.storeChatExchange('s-ensure', 'hello', 'reply');

    // The daemon-side createAssertion owns any legacy chat-WM migration
    // (#2149) — the manager's contract is only: ensure with the SAME agent
    // address every mutation uses, before the first write.
    expect(order.slice(0, 2)).toEqual(['create', 'write']);
    expect(mockCreateAssertion.calls).toEqual([[
      'agent-context',
      'chat-turns',
      { agentAddress: 'did:dkg:agent:test' },
    ]]);
    expect(mockWriteAssertion.calls[0]?.[3]).toEqual({ agentAddress: 'did:dkg:agent:test' });
  });

  it('recordChatTurnPersistenceTransition writes to chat-turns with the manager agentAddress', async () => {
    const manager = createManager();
    mockQuery.returns.push({ bindings: [] }, { bindings: [] });

    await manager.recordChatTurnPersistenceTransition('s-transition', 'turn-9', 'stored');

    expect(mockWriteAssertion.calls).toHaveLength(1);
    const call = mockWriteAssertion.calls[0]!;
    expect(call[0]).toBe('agent-context');
    expect(call[1]).toBe('chat-turns');
    expect(Array.isArray(call[2])).toBe(true);
    expect(call[3]).toEqual({ agentAddress: 'did:dkg:agent:test' });
  });

  it('mention-extraction writes to chat-turns with the manager agentAddress', async () => {
    const manager = createManager();
    (manager as any).callMentionExtraction = async () => [{ name: 'Alice', type: 'Person' }];

    await (manager as any).extractAndWriteMentions(
      'urn:dkg:chat:msg:u1',
      'Alice asked about the DKG',
      'urn:dkg:chat:msg:a1',
      'Explained it to Alice',
    );

    expect(mockWriteAssertion.calls).toHaveLength(1);
    const call = mockWriteAssertion.calls[0]!;
    expect(call[0]).toBe('agent-context');
    expect(call[1]).toBe('chat-turns');
    expect(Array.isArray(call[2])).toBe(true);
    expect(call[3]).toEqual({ agentAddress: 'did:dkg:agent:test' });
  });

  it('extractKnowledge writes to chat-turns with the manager agentAddress', async () => {
    const manager = createManager();
    (manager as any).llmClient = {
      complete: async () => ({
        message: { content: '<urn:test:s> <urn:test:p> <urn:test:o> .' },
      }),
    };
    mockQuery.returns.push({ bindings: [] });

    const written = await manager.extractKnowledge('s-extract', 'question', 'answer');

    expect(written).toBe(1);
    expect(mockWriteAssertion.calls).toHaveLength(1);
    const call = mockWriteAssertion.calls[0]!;
    expect(call[0]).toBe('agent-context');
    expect(call[1]).toBe('chat-turns');
    expect(Array.isArray(call[2])).toBe(true);
    expect(call[3]).toEqual({ agentAddress: 'did:dkg:agent:test' });
  });

  it('writeAssertion targets agent-context / chat-turns on every call', async () => {
    const manager = createManager();
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('s2', 'msg', 'reply');
    await manager.storeChatExchange('s2', 'msg2', 'reply2');
    await manager.storeChatExchange('s3', 'new session', 'new reply');

    expect(mockWriteAssertion.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of mockWriteAssertion.calls) {
      expect(call[0]).toBe('agent-context');
      expect(call[1]).toBe('chat-turns');
      expect(Array.isArray(call[2])).toBe(true);
      expect(call[3]).toEqual({ agentAddress: 'did:dkg:agent:test' });
    }
  });

  it('agent-context context graph is created with private: true when missing from the list', async () => {
    mockListContextGraphs.returns.push([]);
    mockQuery.returns.push({ bindings: [] });
    const manager = createManager();
    await manager.storeChatExchange('s1', 'x', 'y');

    expect(mockCreateContextGraph.calls).toHaveLength(1);
    const createOpts = mockCreateContextGraph.calls[0][0] as any;
    expect(createOpts.id).toBe('agent-context');
    expect(createOpts.private).toBe(true);
  });

  it('context graph creation opts always include private: true even on subsequent initializations', async () => {
    mockListContextGraphs.defaultReturn = [];
    const listReturns = mockListContextGraphs.returns;
    listReturns.push([], []);
    mockQuery.returns.push({ bindings: [] }, { bindings: [] });

    const m1 = createManager();
    await m1.storeChatExchange('s1', 'a', 'b');

    const m2 = createManager();
    await m2.storeChatExchange('s2', 'c', 'd');

    for (const call of mockCreateContextGraph.calls) {
      expect((call[0] as any).private).toBe(true);
    }
  });

  it('createAssertion is called once at ensureInitialized for the chat-turns assertion', async () => {
    const manager = createManager();
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('s1', 'secret', 'reply');
    await manager.storeChatExchange('s1', 'another', 'reply');

    const chatTurnsCreates = mockCreateAssertion.calls.filter(
      (c: any) => c[0] === 'agent-context' && c[1] === 'chat-turns',
    );
    expect(chatTurnsCreates.length).toBeGreaterThanOrEqual(1);
    expect(chatTurnsCreates.length).toBeLessThanOrEqual(1);
  });

  it('second session also writes through writeAssertion to the chat-turns assertion', async () => {
    const manager = createManager();
    mockQuery.returns.push({ bindings: [] });
    await manager.storeChatExchange('session-A', 'First session msg', 'reply');
    await manager.storeChatExchange('session-B', 'Second session msg', 'reply');

    expect(mockWriteAssertion.calls.length).toBe(2);
    expect(mockShare.calls).toHaveLength(0);
  });
});

// A turn id is only unique inside its session, and the durable state of a turn
// (persistence state, message links, transitions) hangs off the turn's subject.
// A new turn is therefore written under one subject per (sessionId, turnId)
// (`scopedChatTurnUri`), while turns stored before that
// (`urn:dkg:chat:turn:<turnId>`) stay where they are and are found through their
// session link (`chatTurnSubjectPattern`). Which subject wins, and that a subject
// two sessions share is excluded, is the store's work and is covered against a
// real store in chat-memory-subject-ownership.test.ts and packages/cli's
// openclaw-persist-turn e2e; the cases below pin what the manager asks and writes.
describe('ChatMemoryManager chat-turn identity: one subject per session and turn id', () => {
  const CHAT = 'urn:dkg:chat:';
  const DKG = 'http://dkg.io/ontology/';
  const SCHEMA_ORG = 'http://schema.org/';
  const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const LEGACY_TURN_PREFIX = `${CHAT}turn:`;
  const SCOPED_TURN_PREFIX = `${CHAT}session-turn:`;
  const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
  const XSD_DATETIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';

  let mockQuery: TrackingFn;
  let mockWriteAssertion: TrackingFn;

  beforeEach(() => {
    mockQuery = trackFn(undefined);
    mockWriteAssertion = trackFn({ written: 0 });
  });

  function createManager() {
    return new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: trackFn({ assertionUri: 'urn:test:assertion', alreadyExists: false }),
        writeAssertion: mockWriteAssertion,
        createContextGraph: trackFn(undefined),
        listContextGraphs: trackFn([{ id: 'agent-context', name: 'Agent Context' }]),
      },
      { apiKey: '' },
      { agentAddress: 'did:dkg:agent:test' },
    );
  }

  type Quad = { subject: string; predicate: string; object: string };
  const lastWrittenQuads = (): Quad[] => mockWriteAssertion.calls.at(-1)![2] as Quad[];

  /** Write one turn through the manager and hand back the quads it wrote. */
  async function storeTurn(sessionId: string, turnId: string): Promise<Quad[]> {
    // Known sessions, then the lookup of an existing subject for the turn.
    mockQuery.returns.push({ bindings: [] }, { bindings: [] });
    await createManager().storeChatExchange(sessionId, 'question', 'answer', undefined, { turnId });
    return lastWrittenQuads();
  }

  /** The subject the manager names the turn's ChatTurn resource. */
  const turnSubjectOf = (quads: Quad[]): string =>
    quads.find((quad) => quad.predicate === RDF_TYPE_IRI && quad.object === `${DKG}ChatTurn`)!.subject;

  describe('a new turn', () => {
    it('is named after its session and turn id, in a namespace no legacy turn subject can share', async () => {
      const quads = await storeTurn('session-1', 'turn-1');
      const subject = turnSubjectOf(quads);

      expect(subject.startsWith(SCOPED_TURN_PREFIX)).toBe(true);
      // The suffix is the URI-encoded JSON of the pair, so it is injective in it.
      expect(JSON.parse(decodeURIComponent(subject.slice(SCOPED_TURN_PREFIX.length)))).toEqual(['session-1', 'turn-1']);
      expect(subject.startsWith(LEGACY_TURN_PREFIX)).toBe(false);
    });

    it('carries every fact of the turn on that one subject, and keeps the caller-visible ids as literals', async () => {
      const quads = await storeTurn('session-1', 'turn-1');
      const subject = turnSubjectOf(quads);
      const onTurn = quads.filter((quad) => quad.subject === subject);

      expect(onTurn.map((quad) => quad.predicate).sort()).toEqual([
        `${DKG}hasAssistantMessage`,
        `${DKG}hasUserMessage`,
        `${DKG}persistenceState`,
        `${DKG}turnId`,
        RDF_TYPE_IRI,
        `${SCHEMA_ORG}dateCreated`,
        `${SCHEMA_ORG}isPartOf`,
      ].sort());
      expect(onTurn.find((quad) => quad.predicate === `${SCHEMA_ORG}isPartOf`)?.object).toBe(`${CHAT}session:session-1`);
      expect(onTurn.find((quad) => quad.predicate === `${DKG}turnId`)?.object).toBe('"turn-1"');
      // The messages keep the plain turn id, which is what getSession joins on.
      const messages = quads.filter((quad) => quad.predicate === RDF_TYPE_IRI && quad.object === `${SCHEMA_ORG}Message`);
      expect(messages).toHaveLength(2);
      for (const message of messages) {
        expect(quads.find((quad) => quad.subject === message.subject && quad.predicate === `${DKG}turnId`)?.object).toBe('"turn-1"');
      }
      // Nothing is left under a subject named after the bare turn id.
      expect(quads.some((quad) => quad.subject === `${LEGACY_TURN_PREFIX}turn-1`)).toBe(false);
    });

    it('gets the same subject for the same session and turn id, a different one for a different session or turn', async () => {
      const first = turnSubjectOf(await storeTurn('session-a', 'turn-1'));
      const again = turnSubjectOf(await storeTurn('session-a', 'turn-1'));
      const padded = turnSubjectOf(await storeTurn('session-a', '  turn-1 '));
      const otherSession = turnSubjectOf(await storeTurn('session-b', 'turn-1'));
      const otherTurn = turnSubjectOf(await storeTurn('session-a', 'turn-2'));

      expect(again).toBe(first);
      expect(padded).toBe(first);
      expect(otherSession).not.toBe(first);
      expect(otherTurn).not.toBe(first);
      expect(otherSession).not.toBe(otherTurn);
    });

    it('never shares a subject between two (sessionId, turnId) pairs, and is always a safe IRI', async () => {
      const pairs: Array<[string, string]> = [
        ['a:b', 'c'],
        ['a', 'b:c'],
        ['a\n', 'b'],
        ['a', '\nb'],
        ['s', 't"<>{}|^` \\'],
        ['s ', 't'],
        ['s', 't'],
        ['s\ud800', 't'],
        ['s\ud801', 't'],
        ['openclaw:dkg-ui', 'turn:1'],
        ['openclaw', 'dkg-ui:turn:1'],
        ['', 't'],
      ];
      const subjects = new Set<string>();
      for (const [sessionId, turnId] of pairs) {
        const subject = turnSubjectOf(await storeTurn(sessionId, turnId));
        expect(isSafeIri(subject), `${JSON.stringify([sessionId, turnId])}`).toBe(true);
        subjects.add(subject);
      }
      expect(subjects.size).toBe(pairs.length);
    });

    it('is found by the reads through the session link and turn id literal, never by a subject named after the id', async () => {
      const manager = createManager();
      mockQuery.returns.push({ bindings: [] }, { bindings: [] }, { bindings: [] });

      await manager.getChatTurnPersistenceState('session-1', ' turn-1 ');
      await manager.hasChatTurn('session-1', 'turn-1');
      const reads = mockQuery.calls.slice(-2).map((call) => String(call[0]));

      expect(reads).toHaveLength(2);
      for (const read of reads) {
        expect(read).toContain(`<${SCHEMA_ORG}isPartOf> <${CHAT}session:session-1>`);
        expect(read).toContain(`<${DKG}turnId> "turn-1"`);
        expect(read).not.toContain(LEGACY_TURN_PREFIX);
        // The scoped namespace appears only as a prefix test, never as a subject.
        expect(read).not.toContain(`<${SCOPED_TURN_PREFIX}`);
        expect(read).not.toContain('%5B');
      }
    });
  });

  describe('getChatTurnPersistenceState', () => {
    const SESSION = `${CHAT}session:session-1`;
    const LEGACY = `${LEGACY_TURN_PREFIX}turn-1`;
    const SCOPED = `${SCOPED_TURN_PREFIX}${'ab'.repeat(32)}`;

    /** The state the manager reports for `(session-1, turn-1)` when the store answers `rows`. */
    async function stateFor(rows: Array<Record<string, string>>) {
      mockQuery.returns.push({ bindings: [] }, { bindings: rows });
      return createManager().getChatTurnPersistenceState('session-1', 'turn-1');
    }

    it('asks only for the subject this session owns: one that no other session is linked to', async () => {
      await stateFor([]);
      const read = String(mockQuery.calls.at(-1)![0]);

      expect(read).toContain(`<${SCHEMA_ORG}isPartOf> <${SESSION}>`);
      expect(read).toContain('FILTER NOT EXISTS');
      expect(read).toContain('?otherTurnSession');
    });

    it('reports the state of the subject the store selected, legacy or session-scoped', async () => {
      expect(await stateFor([{ persistenceState: '"pending"' }])).toBe('pending');
      expect(await stateFor([{ persistenceState: '"failed"', transitionState: '"stored"' }])).toBe('stored');
      expect(await stateFor([{ turn: LEGACY, persistenceState: '"failed"' }, { turn: SCOPED, persistenceState: '"pending"' }])).toBe('failed');
    });

    it('reports nothing when the store selects no subject for the turn', async () => {
      expect(await stateFor([])).toBeNull();
    });
  });

  describe('recordChatTurnPersistenceTransition', () => {
    const transitionTarget = (): string =>
      lastWrittenQuads().find((quad) => quad.predicate === `${DKG}updatesTurn`)!.object;

    it('attaches the transition to the session-scoped subject a new turn was written under', async () => {
      const scoped = turnSubjectOf(await storeTurn('session-1', 'turn-1'));
      mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: scoped, tid: '"turn-1"' }] });

      await createManager().recordChatTurnPersistenceTransition('session-1', 'turn-1', 'stored', { assistantReply: 'done' });

      expect(transitionTarget()).toBe(scoped);
    });

    it('attaches the transition to the legacy subject a turn stored before the scheme sits under', async () => {
      mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: `${LEGACY_TURN_PREFIX}turn-1`, tid: '"turn-1"' }] });

      await createManager().recordChatTurnPersistenceTransition('session-1', 'turn-1', 'stored', { assistantReply: 'done' });

      expect(transitionTarget()).toBe(`${LEGACY_TURN_PREFIX}turn-1`);
    });

    it('looks the subject up through the session and the trimmed turn id, so another session that reuses the id is never targeted', async () => {
      mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: `${LEGACY_TURN_PREFIX}turn-1`, tid: '"turn-1"' }] });

      await createManager().recordChatTurnPersistenceTransition('session-1', ' turn-1 ', 'stored');
      const lookup = String(mockQuery.calls.at(-1)![0]);

      expect(lookup).toContain(`<${RDF_TYPE_IRI}> <${DKG}ChatTurn>`);
      expect(lookup).toContain(`<${SCHEMA_ORG}isPartOf> <${CHAT}session:session-1>`);
      expect(lookup).toContain(`<${DKG}turnId> "turn-1"`);
      expect(lookup).toContain('LIMIT 1');
      expect(mockQuery.calls.at(-1)![1]).toMatchObject({ view: 'working-memory', assertionName: 'chat-turns' });
    });

    it('falls back to the subject a new turn of that session would get when the turn does not exist', async () => {
      const wouldBe = turnSubjectOf(await storeTurn('session-1', 'turn-1'));
      mockQuery.returns.push({ bindings: [] }, { bindings: [] });

      await createManager().recordChatTurnPersistenceTransition('session-1', 'turn-1', 'stored');

      expect(transitionTarget()).toBe(wouldBe);
    });

    it('does not follow a lookup answer that is not a safe IRI', async () => {
      const wouldBe = turnSubjectOf(await storeTurn('session-1', 'turn-1'));
      mockQuery.returns.push({ bindings: [] }, { bindings: [{ turn: 'not an iri<', tid: '"turn-1"' }] });

      await createManager().recordChatTurnPersistenceTransition('session-1', 'turn-1', 'stored');

      expect(transitionTarget()).toBe(wouldBe);
    });

    it('writes nothing, and looks nothing up, for a blank turn id', async () => {
      mockQuery.returns.push({ bindings: [] });
      mockWriteAssertion.calls.length = 0;

      await createManager().recordChatTurnPersistenceTransition('session-1', '   ', 'stored');

      expect(mockWriteAssertion.calls).toHaveLength(0);
      expect(mockQuery.calls).toHaveLength(1);
    });
  });

  describe('getSessionGraphDelta', () => {
    const integer = (n: number) => `"${n}"^^<${XSD_INTEGER}>`;
    const dateTime = (iso: string) => `"${iso}"^^<${XSD_DATETIME_IRI}>`;

    const TRANSITION = `${CHAT}turn-transition:aaaa0000`;

    /**
     * The store's answers to a delta request for turn `t2`, whose subject the
     * first lookup names, in the order the manager asks: the session's turn count,
     * the turn, the latest and previous turn, the turn's index, its two messages,
     * one answer for each of the four related-subject relations (transitions,
     * tools, mentions, memories) and the CONSTRUCT.
     */
    function pushDeltaAnswers(turnSubject: string | undefined) {
      mockQuery.returns.push(
        { bindings: [] },
        { bindings: [{ c: integer(2) }] },
        { bindings: [{ ...(turnSubject ? { turn: turnSubject } : {}), tid: '"t2"', ts: dateTime('2026-03-08T10:00:10Z') }] },
        { bindings: [{ latestTurnId: '"t2"', latestTs: dateTime('2026-03-08T10:00:10Z') }] },
        { bindings: [{ previousTurnId: '"t1"' }] },
        { bindings: [{ c: integer(2) }] },
        { bindings: [{ user: `${CHAT}msg:user-2`, assistant: `${CHAT}msg:assistant-2` }] },
        { bindings: [{ s: TRANSITION }] },
        { bindings: [] },
        { bindings: [{ s: `${CHAT}msg:user-2` }] },
        { bindings: [] },
        { quads: [{ subject: turnSubject ?? '', predicate: `${DKG}turnId`, object: '"t2"' }] },
      );
    }

    it.each([
      ['a session-scoped subject', `${SCOPED_TURN_PREFIX}${'ab'.repeat(32)}`],
      ['a legacy subject', `${LEGACY_TURN_PREFIX}t2`],
    ])('follows the subject the turn is stored under: %s', async (_label, subject) => {
      pushDeltaAnswers(subject);

      const delta = await createManager().getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });
      const queries = mockQuery.calls.map((call) => String(call[0]));

      expect(delta.mode).toBe('delta');
      expect(delta.watermark.appliedTurnId).toBe('t2');
      // Found through the session link and the turn id, not built from the id.
      expect(queries[2]).toContain(`<${SCHEMA_ORG}isPartOf> <${CHAT}session:s-graph>`);
      expect(queries[2]).toContain(`<${DKG}turnId> "t2"`);
      expect(queries[2]).not.toContain(LEGACY_TURN_PREFIX);
      // ...and then used for everything that hangs off the turn.
      expect(queries[6]).toContain(`<${subject}> <${DKG}hasUserMessage> ?user`);
      expect(queries[6]).toContain(`<${subject}> <${DKG}hasAssistantMessage> ?assistant`);
      // The transitions are the ones that point at the subject the turn was found under, and are read with it.
      expect(queries[7]).toContain(`?s <${DKG}updatesTurn> <${subject}>`);
      expect(queries[11]).toMatch(/^CONSTRUCT/);
      expect(queries[11]).toContain(`VALUES ?s { <${CHAT}session:s-graph> <${subject}> <${CHAT}msg:user-2> <${CHAT}msg:assistant-2> <${TRANSITION}> }`);
    });

    // One case per test: `beforeEach` gives each a fresh mock, so the lookup a
    // case reads is the one it queued, not an answer an earlier case left over.
    it.each([
      ['no subject', undefined],
      ['a subject that is not an IRI', 'not an iri<'],
    ])('asks for a full refresh when the store names no usable subject for the turn: %s', async (_label, subject) => {
      pushDeltaAnswers(subject);

      const delta = await createManager().getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });

      expect(delta).toMatchObject({ mode: 'full_refresh_required', reason: 'turn_not_found', triples: [] });
      // The lookup did find turn t2, so the refresh comes from the subject it
      // named: nothing was read through that subject.
      expect(String(mockQuery.calls[2]![0])).toContain(`<${DKG}turnId> "t2"`);
      expect(mockQuery.calls).toHaveLength(4);
    });
  });
});

// A turn that reported `pending` or `failed` and completed later is recorded as a
// `stored` transition carrying the final reply, not as a second exchange, so the
// assistant Message keeps the reply of the first report. `getSession` resolves
// the reply from the transition; the session list (`getRecentChats`, behind
// GET /api/memory/sessions) has to as well, through the same resolver. The real
// store, and the two routes side by side, are covered in packages/cli's
// openclaw-persist-turn e2e.
describe('ChatMemoryManager.getRecentChats: replies of turns completed by transition', () => {
  const CHAT = 'urn:dkg:chat:';
  const DKG = 'http://dkg.io/ontology/';
  const SESSION_A = `${CHAT}session:s-a`;
  const SESSION_B = `${CHAT}session:s-b`;
  const stamp = (n: number) => `"2026-03-08T10:00:${String(n).padStart(2, '0')}Z"`;

  let mockQuery: TrackingFn;

  beforeEach(() => {
    mockQuery = trackFn(undefined);
  });

  function createManager() {
    return new ChatMemoryManager(
      {
        query: mockQuery,
        createAssertion: trackFn({ assertionUri: 'urn:test:assertion', alreadyExists: false }),
        writeAssertion: trackFn({ written: 0 }),
        createContextGraph: trackFn(undefined),
        listContextGraphs: trackFn([{ id: 'agent-context', name: 'Agent Context' }]),
      },
      { apiKey: '' },
      { agentAddress: 'did:dkg:agent:test' },
    );
  }

  /** The URI of the message `message(session, ..., n)` returns. */
  const uriOf = (session: string, n: number) => `${CHAT}msg:${session.slice(-1)}-${n}`;
  /** One row of the list query for a message; `n` orders it and names its URI. */
  const message = (session: string, author: 'user' | 'agent', text: string, n: number) => ({
    session,
    m: uriOf(session, n),
    author: `${CHAT}actor:${author}`,
    text: JSON.stringify(text),
    ts: stamp(n),
  });
  /** The same message joined to one transition of the turn it completes. */
  const completedBy = (row: ReturnType<typeof message>, state: string, reply: string) => ({
    ...row,
    transitionState: JSON.stringify(state),
    transitionAssistantReply: JSON.stringify(reply),
  });

  /** The store's answers: known sessions, the session list, then the one query for messages and completed turns. */
  function answers(sessions: string[], rows: unknown[]) {
    mockQuery.returns.push(
      { bindings: [] },
      { bindings: sessions.map((s) => ({ s, sid: JSON.stringify(s.slice(`${CHAT}session:`.length)) })) },
      { bindings: rows },
    );
  }

  it('shows the reply of the stored transition, and keeps one exchange per turn', async () => {
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'question', 1),
      completedBy(message(SESSION_A, 'agent', 'working on it', 2), 'stored', 'the final answer'),
      message(SESSION_A, 'user', 'and another', 3),
      message(SESSION_A, 'agent', 'stored at once', 4),
    ]);

    const chats = await createManager().getRecentChats(10);

    expect(chats).toEqual([{
      session: 's-a',
      messages: [
        { author: 'user', text: 'question', ts: '2026-03-08T10:00:01Z' },
        { author: 'agent', text: 'the final answer', ts: '2026-03-08T10:00:02Z' },
        { author: 'user', text: 'and another', ts: '2026-03-08T10:00:03Z' },
        { author: 'agent', text: 'stored at once', ts: '2026-03-08T10:00:04Z' },
      ],
    }]);
  });

  it('lists a message with several transitions once, and the stored one completes it wherever it sits', async () => {
    const agentMessage = message(SESSION_A, 'agent', 'working', 2);
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'q', 1),
      completedBy(agentMessage, 'failed', 'a failed retry'),
      completedBy(agentMessage, 'stored', 'the final answer'),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    expect(chat.messages.map((m) => m.text)).toEqual(['q', 'the final answer']);
  });

  it('decodes the transition reply like the message text, so markdown survives', async () => {
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'q', 1),
      completedBy(message(SESSION_A, 'agent', 'working', 2), 'stored', '# Title\n\n- a "quoted" item\n\n```ts\nconst a = 1;\n```'),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    expect(chat.messages[1].text).toBe('# Title\n\n- a "quoted" item\n\n```ts\nconst a = 1;\n```');
  });

  it('only a stored transition completes a turn: a failed or pending one leaves the first reply', async () => {
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'q1', 1),
      completedBy(message(SESSION_A, 'agent', 'first reply 1', 2), 'failed', 'a failed retry'),
      message(SESSION_A, 'user', 'q2', 3),
      completedBy(message(SESSION_A, 'agent', 'first reply 2', 4), 'pending', 'a pending retry'),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    expect(chat.messages.map((m) => m.text)).toEqual(['q1', 'first reply 1', 'q2', 'first reply 2']);
  });

  it('completes the agent message of a turn only, never a user message, and never another session\'s', async () => {
    answers([SESSION_A, SESSION_B], [
      message(SESSION_A, 'user', 'a asks', 1),
      completedBy(message(SESSION_A, 'agent', 'a working', 2), 'stored', 'a final'),
      // Even a row that names a user message (a malformed link) does not rewrite it.
      completedBy(message(SESSION_B, 'user', 'b asks', 3), 'stored', 'rewrites the question?'),
      message(SESSION_B, 'agent', 'b working', 4),
    ]);

    const chats = await createManager().getRecentChats(10);

    expect(chats.map((chat) => [chat.session, chat.messages.map((m) => m.text)])).toEqual([
      ['s-a', ['a asks', 'a final']],
      ['s-b', ['b asks', 'b working']],
    ]);
  });

  it('the latest stored transition of a turn wins', async () => {
    const agentMessage = message(SESSION_A, 'agent', 'working', 2);
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'the question', 1),
      completedBy(agentMessage, 'stored', 'earlier'),
      completedBy(agentMessage, 'stored', 'later'),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    expect(chat.messages.map((m) => m.text)).toEqual(['the question', 'later']);
  });

  it('counts each message once toward the 100 a session lists, however many transitions it comes back with', async () => {
    const first = message(SESSION_A, 'user', 'm0', 0);
    const messages = Array.from({ length: 101 }, (_, i) => message(SESSION_A, i % 2 === 0 ? 'user' : 'agent', `m${i}`, i));
    const agentMessage = messages[1];
    answers([SESSION_A], [
      first,
      ...Array.from({ length: 5 }, () => completedBy(agentMessage, 'failed', 'x')),
      completedBy(agentMessage, 'stored', 'final'),
      ...messages.slice(2),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    expect(chat.messages).toHaveLength(100);
    expect(chat.messages[1].text).toBe('final');
    expect(chat.messages[99].text).toBe('m99');
  });

  it('asks once for messages and completed turns together, without a UNION, for the listed sessions, through each turn\'s own session link', async () => {
    answers([SESSION_A, SESSION_B], [message(SESSION_A, 'user', 'a asks', 1), message(SESSION_B, 'user', 'b asks', 3)]);

    await createManager().getRecentChats(10);
    const queries = mockQuery.calls.map((call) => String(call[0]));

    // known sessions, the session list, and the one query for the rest
    expect(queries).toHaveLength(3);
    const list = queries[2];
    // A read of the working-memory view that spans several graphs refuses a
    // UNION combined with ORDER BY, which would leave the list empty.
    expect(list).not.toMatch(/\bUNION\b/i);
    expect(list.match(/VALUES \?session \{ <urn:dkg:chat:session:s-a> <urn:dkg:chat:session:s-b> \}/g)).toHaveLength(1);
    expect(list.match(/VALUES \?turnSession \{ <urn:dkg:chat:session:s-a> <urn:dkg:chat:session:s-b> \}/g)).toHaveLength(1);
    expect(list).toContain('?m <http://schema.org/isPartOf> ?session');
    expect(list).toContain('?turn <http://schema.org/isPartOf> ?turnSession');
    expect(list).toContain(`<${DKG}updatesTurn> ?turn`);
    expect(list).toContain(`<${DKG}hasAssistantMessage> ?m`);
    expect(list).toContain('OPTIONAL');
    expect(mockQuery.calls[2][1]).toMatchObject({ view: 'working-memory', assertionName: 'chat-turns' });
  });

  it('never leaks a message URI or a transition field into the listed messages', async () => {
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'q', 1),
      completedBy(message(SESSION_A, 'agent', 'a', 2), 'stored', 'final'),
    ]);

    const [chat] = await createManager().getRecentChats(10);

    for (const listed of chat.messages) expect(Object.keys(listed).sort()).toEqual(['author', 'text', 'ts']);
  });

  it('agrees with getSession on the reply of the same completed turn', async () => {
    const finalReply = 'Line one\n\n**Line two**';
    answers([SESSION_A], [
      message(SESSION_A, 'user', 'q', 1),
      completedBy(message(SESSION_A, 'agent', 'working', 2), 'stored', finalReply),
    ]);
    const fromList = (await createManager().getRecentChats(10))[0].messages[1].text;

    mockQuery = trackFn(undefined);
    mockQuery.returns.push(
      { bindings: [] },
      {
        bindings: [
          { m: `${CHAT}msg:u`, author: `${CHAT}actor:user`, text: JSON.stringify('q'), ts: stamp(1), turnId: '"t1"', persistenceState: '"pending"', transitionState: '"stored"', transitionAssistantReply: JSON.stringify(finalReply) },
          { m: `${CHAT}msg:a`, author: `${CHAT}actor:agent`, text: JSON.stringify('working'), ts: stamp(2), turnId: '"t1"', persistenceState: '"pending"', transitionState: '"stored"', transitionAssistantReply: JSON.stringify(finalReply) },
        ],
      },
    );
    const fromSession = (await createManager().getSession('s-a'))!.messages.find((m) => m.author === 'agent')!.text;

    expect(fromList).toBe(finalReply);
    expect(fromSession).toBe(finalReply);
  });
});
