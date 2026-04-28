import { describe, it, expect, beforeEach } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';

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
  const mockQuery = overrides?.mockQuery ?? trackFn(undefined);
  const mockShare = overrides?.mockShare ?? trackFn({ shareOperationId: 'op-1' });
  const mockCreateContextGraph = overrides?.mockCreateContextGraph ?? trackFn(undefined);
  const mockListContextGraphs = overrides?.mockListContextGraphs ?? trackFn([{ id: 'agent-memory', name: 'Agent Memory' }]);
  const mockPublishFromSharedMemory = overrides?.mockPublishFromSharedMemory ?? trackFn({});

  return {
    mockQuery,
    mockShare,
    mockCreateContextGraph,
    mockListContextGraphs,
    mockPublishFromSharedMemory,
    tools: {
      query: mockQuery,
      share: mockShare,
      publishFromSharedMemory: mockPublishFromSharedMemory,
      createContextGraph: mockCreateContextGraph,
      listContextGraphs: mockListContextGraphs,
    },
  };
}

describe('ChatMemoryManager', () => {
  let manager: ChatMemoryManager;
  let mockQuery: TrackingFn;
  let mockShare: TrackingFn;
  let mockCreateAssertion: TrackingFn;
  let mockWriteAssertion: TrackingFn;
  let mockCreateContextGraph: TrackingFn;
  let mockListContextGraphs: TrackingFn;

  beforeEach(() => {
    mockQuery = trackFn(undefined);
    mockShare = trackFn({ shareOperationId: 'op-1' });
    mockCreateAssertion = trackFn({ assertionUri: 'urn:test:assertion', alreadyExists: false });
    mockWriteAssertion = trackFn({ written: 0 });
    mockCreateContextGraph = trackFn(undefined);
    mockListContextGraphs = trackFn([{ id: 'agent-context', name: 'Agent Context' }]);

    manager = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory: trackFn({}),
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

    expect(mockWriteAssertion.calls[0]).toEqual(['agent-context', 'chat-turns', expect.any(Array)]);
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
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory: trackFn({}),
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
    expect(queryText).toContain('SELECT ?m ?author ?text ?ts ?turnId ?persistenceState ?attachmentRefs ?failureReason');
    expect(queryText).toContain('ORDER BY DESC(?ts) LIMIT 3');
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
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory: trackFn({}),
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

  it('publishSession uses derived session root entities when none are provided', async () => {
    const publishFromSharedMemory = trackFn({
      status: 'confirmed',
      publicQuads: [{}, {}],
      kcId: 10n,
      ual: 'did:dkg:mock:123',
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );

    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-2' }, { s: 'urn:dkg:chat:msg:m-2' }] },
      { bindings: [{ c: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ c: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-2' }] },
    );

    const result = await managerWithPublish.publishSession('s-2');
    expect(publishFromSharedMemory.calls[0]).toEqual([
      'agent-context',
      { rootEntities: ['urn:dkg:chat:session:s-2', 'urn:dkg:chat:msg:m-2'] },
      { clearSharedMemoryAfter: false },
    ]);
    expect(result.sessionId).toBe('s-2');
    expect(result.rootEntityCount).toBe(2);
    expect(result.publication.scope).toBe('published');
  });

  it('publishSession restricts requested roots to entities belonging to the target session', async () => {
    const publishFromSharedMemory = trackFn({
      status: 'confirmed',
      publicQuads: [{}, {}],
      kcId: 11n,
      ual: 'did:dkg:mock:124',
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );

    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-3' }, { s: 'urn:dkg:chat:msg:m-3' }] },
      { bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-3' }, { s: 'urn:dkg:chat:msg:m-3' }] },
    );

    await managerWithPublish.publishSession('s-3', {
      rootEntities: ['urn:dkg:chat:msg:m-3', 'urn:dkg:chat:msg:not-in-session'],
    });

    expect(publishFromSharedMemory.calls[0]).toEqual([
      'agent-context',
      { rootEntities: ['urn:dkg:chat:msg:m-3'] },
      { clearSharedMemoryAfter: false },
    ]);
  });

  it('publishSession rejects requested roots that are not in session scope', async () => {
    const publishFromSharedMemory = trackFn({
      status: 'confirmed',
      publicQuads: [{}, {}],
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
      { agentAddress: 'did:dkg:agent:test' },
    );

    mockQuery.returns.push(
      { bindings: [] },
      { bindings: [{ s: 'urn:dkg:chat:session:s-4' }] },
    );

    await expect(
      managerWithPublish.publishSession('s-4', {
        rootEntities: ['urn:dkg:chat:msg:not-in-session'],
      }),
    ).rejects.toThrow('Selected root entities are not part of session s-4');
    expect(publishFromSharedMemory.calls).toHaveLength(0);
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
      {
        bindings: [
          { s: 'urn:dkg:chat:msg:user-2' },
          { s: 'urn:dkg:chat:msg:assistant-2' },
        ],
      },
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
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
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
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
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
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
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
    mockQuery = trackFn(undefined);
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
        share: mockShare,
        createAssertion: mockCreateAssertion,
        writeAssertion: mockWriteAssertion,
        publishFromSharedMemory: trackFn({}),
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
