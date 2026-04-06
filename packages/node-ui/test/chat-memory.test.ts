import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';

describe('ChatMemoryManager', () => {
  let manager: ChatMemoryManager;
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockShare: ReturnType<typeof vi.fn>;
  let mockCreateContextGraph: ReturnType<typeof vi.fn>;
  let mockListContextGraphs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockShare = vi.fn().mockResolvedValue({ shareOperationId: 'op-1' });
    mockCreateContextGraph = vi.fn().mockResolvedValue(undefined);
    mockListContextGraphs = vi.fn().mockResolvedValue([{ id: 'agent-memory', name: 'Agent Memory' }]);

    manager = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory: vi.fn().mockResolvedValue({}),
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );
  });

  it('stores a chat exchange and writes quads to shared memory', async () => {
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-1', 'Hello', 'Hi there!');

    expect(mockShare).toHaveBeenCalledWith('agent-memory', expect.any(Array), { localOnly: true });
    const quads = mockShare.mock.calls[0][1];
    expect(quads.length).toBeGreaterThanOrEqual(12);
    const sessionTriple = quads.find((q: any) => q.predicate?.includes('sessionId'));
    expect(sessionTriple).toBeDefined();
    expect(sessionTriple.object).toContain('session-1');
  });

  it('includes session triples only on first write for a session', async () => {
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-1', 'First message', 'First reply');
    await manager.storeChatExchange('session-1', 'Second message', 'Second reply');

    expect(mockShare).toHaveBeenCalledTimes(2);
    const firstQuads = mockShare.mock.calls[0][1];
    const secondQuads = mockShare.mock.calls[1][1];
    const firstSessionTriple = firstQuads.find((q: any) => q.predicate?.includes('sessionId'));
    const secondSessionTriple = secondQuads.find((q: any) => q.predicate?.includes('sessionId'));
    const replyEdge = secondQuads.find((q: any) => q.predicate?.includes('replyTo'));
    expect(firstSessionTriple).toBeDefined();
    expect(secondSessionTriple).toBeUndefined();
    expect(replyEdge).toBeDefined();
    expect(secondQuads.length).toBe(11);
  });

  it('creates agent-memory context graph when not in list', async () => {
    mockListContextGraphs.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    const m = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory: vi.fn().mockResolvedValue({}),
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );
    await m.storeChatExchange('s1', 'x', 'y');
    expect(mockCreateContextGraph).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-memory', name: 'Agent Memory' }),
    );
  });

  it('getRecentChats returns sessions from query bindings', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1', sid: '"uuid-1"' },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:user', text: '"Hi"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:agent', text: '"Hello"', ts: '"2026-01-01T12:00:01Z"' },
        ],
      });

    const chats = await manager.getRecentChats(10);
    expect(chats).toHaveLength(1);
    expect(chats[0].session).toBe('uuid-1');
    expect(chats[0].messages).toHaveLength(2);
    expect(chats[0].messages[0].author).toBe('user');
    expect(chats[0].messages[1].author).toBe('agent');
  });

  it('getRecentChats batches message retrieval across sessions', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-2', sid: '"uuid-2"' },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:user', text: '"Hi 1"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-1', author: 'urn:dkg:chat:actor:agent', text: '"Hello 1"', ts: '"2026-01-01T12:00:01Z"' },
          { session: 'urn:dkg:chat:session:uuid-2', author: 'urn:dkg:chat:actor:user', text: '"Hi 2"', ts: '"2026-01-01T12:01:00Z"' },
        ],
      });

    const chats = await manager.getRecentChats(10);
    expect(chats).toHaveLength(2);
    expect(chats[0].session).toBe('uuid-1');
    expect(chats[1].session).toBe('uuid-2');
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(String(mockQuery.mock.calls[2][0])).toContain('VALUES ?session');
  });

  it('getRecentChats de-duplicates session ids when multiple roots share the same sessionId', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [
          { s: 'urn:dkg:chat:session:uuid-1-data', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-1-shared-memory', sid: '"uuid-1"' },
          { s: 'urn:dkg:chat:session:uuid-2', sid: '"uuid-2"' },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          { session: 'urn:dkg:chat:session:uuid-1-data', author: 'urn:dkg:chat:actor:user', text: '"Hi 1"', ts: '"2026-01-01T12:00:00Z"' },
          { session: 'urn:dkg:chat:session:uuid-2', author: 'urn:dkg:chat:actor:user', text: '"Hi 2"', ts: '"2026-01-01T12:01:00Z"' },
        ],
      });

    const chats = await manager.getRecentChats(2);
    expect(chats).toHaveLength(2);
    expect(chats.map((chat) => chat.session)).toEqual(['uuid-1', 'uuid-2']);

    const valuesQuery = String(mockQuery.mock.calls[2][0]);
    expect(valuesQuery).toContain('<urn:dkg:chat:session:uuid-1-data>');
    expect(valuesQuery).not.toContain('<urn:dkg:chat:session:uuid-1-shared-memory>');
  });

  it('getSession returns messages for a specific session', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({
        bindings: [
          { author: 'urn:dkg:chat:actor:user', text: '"What is DKG?"', ts: '"2026-01-01T12:00:00Z"' },
          { author: 'urn:dkg:chat:actor:agent', text: '"DKG is the Decentralized Knowledge Graph"', ts: '"2026-01-01T12:00:01Z"' },
        ],
      });

    const session = await manager.getSession('test-session-1');
    expect(session).not.toBeNull();
    expect(session!.session).toBe('test-session-1');
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].author).toBe('user');
    expect(session!.messages[0].text).toBe('What is DKG?');
    expect(session!.messages[1].author).toBe('agent');
  });

  it('getSession returns null when session has no messages', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({ bindings: [] });
    const session = await manager.getSession('nonexistent');
    expect(session).toBeNull();
  });

  it('getSession includes turn metadata when present', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })
      .mockResolvedValueOnce({
        bindings: [
          {
            author: 'urn:dkg:chat:actor:agent',
            text: '"Answer"',
            ts: '"2026-01-01T12:00:01Z"',
            turnId: '"turn-1"',
            persistenceState: '"stored"',
          },
        ],
      });

    const session = await manager.getSession('test-session-2');
    expect(session).not.toBeNull();
    expect(session!.messages[0].turnId).toBe('turn-1');
    expect(session!.messages[0].persistStatus).toBe('stored');
  });

  it('getStats returns session and triple counts', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })               // ensureInitialized: load known sessions
      .mockResolvedValueOnce({ bindings: [{ c: '10' }] })   // total triples
      .mockResolvedValueOnce({ bindings: [{ c: '3' }] })    // sessions
      .mockResolvedValueOnce({ bindings: [{ c: '6' }] })    // messages
      .mockResolvedValueOnce({ bindings: [{ c: '8' }] })    // chat-related triples
      .mockResolvedValueOnce({ bindings: [{ c: '1' }] });   // entities

    const stats = await manager.getStats();
    expect(stats.contextGraphId).toBe('agent-memory');
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
        publishFromSharedMemory: vi.fn().mockResolvedValue({}),
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test', model: 'gpt-5-mini', baseURL: 'https://api.openai.com/v1' },
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: '[]' } }],
      }), { status: 200 }),
    );

    const extracted = await (gpt5Manager as any).callMentionExtraction('User: hi\nAssistant: hello');
    expect(Array.isArray(extracted)).toBe(true);

    const reqInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(reqInit?.body ?? '{}'));
    expect(payload.temperature).toBeUndefined();
    expect(payload.max_tokens).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('getSessionPublicationStatus reports shared-memory-only scope when data graph is empty', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [{ c: '"12"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // shared memory
      .mockResolvedValueOnce({ bindings: [{ c: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // data
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-1' }, { s: 'urn:dkg:chat:msg:m-1' }] }); // roots

    const status = await manager.getSessionPublicationStatus('s-1');
    expect(status.scope).toBe('shared_memory_only');
    expect(status.sharedMemoryTripleCount).toBe(12);
    expect(status.dataTripleCount).toBe(0);
    expect(status.rootEntityCount).toBe(2);
  });

  it('getSessionPublicationStatus reports published-with-pending scope when shared memory has newer turns', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [{ c: '"15"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // shared memory
      .mockResolvedValueOnce({ bindings: [{ c: '"12"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // data
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-1' }] }); // roots

    const status = await manager.getSessionPublicationStatus('s-1');
    expect(status.scope).toBe('published_with_pending');
    expect(status.sharedMemoryTripleCount).toBe(15);
    expect(status.dataTripleCount).toBe(12);
  });

  it('getSessionRootEntities widens the openclaw local session to imported memory roots', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [] }); // root query

    await manager.getSessionRootEntities('openclaw:dkg-ui');

    const query = String(mockQuery.mock.calls[1][0]);
    expect(query).toContain('?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/ImportedMemory>');
    expect(query).toContain('?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/MemoryImport>');
    expect(query).toContain('?s <http://dkg.io/ontology/extractedFrom> ?batch');
  });

  it('getSessionRootEntities keeps regular chat sessions scoped to their own graph roots', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [] }); // root query

    await manager.getSessionRootEntities('session-regular');

    const query = String(mockQuery.mock.calls[1][0]);
    expect(query).not.toContain('<http://dkg.io/ontology/ImportedMemory>');
    expect(query).not.toContain('<http://dkg.io/ontology/MemoryImport>');
  });

  it('publishSession uses derived session root entities when none are provided', async () => {
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      status: 'confirmed',
      publicQuads: [{}, {}],
      kcId: 10n,
      ual: 'did:dkg:mock:123',
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );

    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-2' }, { s: 'urn:dkg:chat:msg:m-2' }] }) // roots
      .mockResolvedValueOnce({ bindings: [{ c: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // shared memory count
      .mockResolvedValueOnce({ bindings: [{ c: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // data count
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-2' }] }); // root count for status

    const result = await managerWithPublish.publishSession('s-2');
    expect(publishFromSharedMemory).toHaveBeenCalledWith(
      'agent-memory',
      { rootEntities: ['urn:dkg:chat:session:s-2', 'urn:dkg:chat:msg:m-2'] },
      { clearSharedMemoryAfter: false },
    );
    expect(result.sessionId).toBe('s-2');
    expect(result.rootEntityCount).toBe(2);
    expect(result.publication.scope).toBe('published');
  });

  it('publishSession restricts requested roots to entities belonging to the target session', async () => {
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      status: 'confirmed',
      publicQuads: [{}, {}],
      kcId: 11n,
      ual: 'did:dkg:mock:124',
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );

    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-3' }, { s: 'urn:dkg:chat:msg:m-3' }] }) // session roots
      .mockResolvedValueOnce({ bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // shared memory count
      .mockResolvedValueOnce({ bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }) // data count
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-3' }, { s: 'urn:dkg:chat:msg:m-3' }] }); // root count

    await managerWithPublish.publishSession('s-3', {
      rootEntities: ['urn:dkg:chat:msg:m-3', 'urn:dkg:chat:msg:not-in-session'],
    });

    expect(publishFromSharedMemory).toHaveBeenCalledWith(
      'agent-memory',
      { rootEntities: ['urn:dkg:chat:msg:m-3'] },
      { clearSharedMemoryAfter: false },
    );
  });

  it('publishSession rejects requested roots that are not in session scope', async () => {
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      status: 'confirmed',
      publicQuads: [{}, {}],
    });
    const managerWithPublish = new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory,
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );

    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({ bindings: [{ s: 'urn:dkg:chat:session:s-4' }] }); // session roots

    await expect(
      managerWithPublish.publishSession('s-4', {
        rootEntities: ['urn:dkg:chat:msg:not-in-session'],
      }),
    ).rejects.toThrow('Selected root entities are not part of session s-4');
    expect(publishFromSharedMemory).not.toHaveBeenCalled();
  });

  it('getSessionGraphDelta returns turn-scoped triples when watermark matches', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({
        bindings: [
          {
            tid: '"t2"',
            ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
          },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          {
            latestTurnId: '"t2"',
            latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
          },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          { previousTurnId: '"t1"' },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({
        bindings: [
          {
            user: 'urn:dkg:chat:msg:user-2',
            assistant: 'urn:dkg:chat:msg:assistant-2',
          },
        ],
      })
      .mockResolvedValueOnce({
        bindings: [
          { s: 'urn:dkg:chat:msg:user-2' },
          { s: 'urn:dkg:chat:msg:assistant-2' },
        ],
      })
      .mockResolvedValueOnce({
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
      });

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });
    expect(delta.mode).toBe('delta');
    expect(delta.turnId).toBe('t2');
    expect(delta.triples).toHaveLength(2);
    expect(delta.watermark.previousTurnId).toBe('t1');
    expect(delta.watermark.latestTurnId).toBe('t2');
  });

  it('getSessionGraphDelta falls back when turn message links are missing', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ previousTurnId: '"t1"' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({ bindings: [] }); // missing user/assistant for turn

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 't1' });
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('turn_not_found');
    expect(delta.triples).toHaveLength(0);
  });

  it('getSessionGraphDelta requires full refresh when non-initial turn is requested without watermark', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ previousTurnId: '"t1"' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      });

    const delta = await manager.getSessionGraphDelta('s-graph', 't2');
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('missing_watermark');
    expect(delta.triples).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it('getSessionGraphDelta requires full refresh when watermark mismatches', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] }) // ensureInitialized
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ tid: '"t2"', ts: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ latestTurnId: '"t2"', latestTs: '"2026-03-08T10:00:10Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ previousTurnId: '"t1"' }],
      })
      .mockResolvedValueOnce({
        bindings: [{ c: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }],
      });

    const delta = await manager.getSessionGraphDelta('s-graph', 't2', { baseTurnId: 'not-t1' });
    expect(delta.mode).toBe('full_refresh_required');
    expect(delta.reason).toBe('watermark_mismatch');
    expect(delta.triples).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });
});

describe('ChatMemoryManager privacy guarantees', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockShare: ReturnType<typeof vi.fn>;
  let mockCreateContextGraph: ReturnType<typeof vi.fn>;
  let mockListContextGraphs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockShare = vi.fn().mockResolvedValue({ shareOperationId: 'op-1' });
    mockCreateContextGraph = vi.fn().mockResolvedValue(undefined);
    mockListContextGraphs = vi.fn().mockResolvedValue([{ id: 'agent-memory', name: 'Agent Memory' }]);
  });

  function createManager() {
    return new ChatMemoryManager(
      {
        query: mockQuery,
        share: mockShare,
        publishFromSharedMemory: vi.fn().mockResolvedValue({}),
        createContextGraph: mockCreateContextGraph,
        listContextGraphs: mockListContextGraphs,
      },
      { apiKey: 'test' },
    );
  }

  it('all shared memory writes use localOnly: true', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s1', 'Hello', 'Hi');

    for (const call of mockShare.mock.calls) {
      expect(call[2]).toEqual({ localOnly: true });
    }
  });

  it('storeChatExchange never writes without localOnly flag', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s2', 'msg', 'reply');
    await manager.storeChatExchange('s2', 'msg2', 'reply2');
    await manager.storeChatExchange('s3', 'new session', 'new reply');

    expect(mockShare.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of mockShare.mock.calls) {
      const opts = call[2];
      expect(opts).toBeDefined();
      expect(opts.localOnly).toBe(true);
    }
  });

  it('agent-memory context graph is created with private: true', async () => {
    mockListContextGraphs.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    const manager = createManager();
    await manager.storeChatExchange('s1', 'x', 'y');

    expect(mockCreateContextGraph).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContextGraph.mock.calls[0][0];
    expect(createOpts.id).toBe('agent-memory');
    expect(createOpts.private).toBe(true);
  });

  it('context graph creation opts always include private: true even on subsequent initializations', async () => {
    mockListContextGraphs.mockResolvedValue([]);
    mockQuery.mockResolvedValue({ bindings: [] });

    const m1 = createManager();
    await m1.storeChatExchange('s1', 'a', 'b');

    const m2 = createManager();
    await m2.storeChatExchange('s2', 'c', 'd');

    for (const call of mockCreateContextGraph.mock.calls) {
      expect(call[0].private).toBe(true);
    }
  });

  it('shared memory writes target the agent-memory context graph exclusively', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s1', 'secret', 'reply');

    for (const call of mockShare.mock.calls) {
      expect(call[0]).toBe('agent-memory');
    }
  });

  it('second session also uses localOnly writes', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-A', 'First session msg', 'reply');
    await manager.storeChatExchange('session-B', 'Second session msg', 'reply');

    expect(mockShare.mock.calls.length).toBe(2);
    for (const call of mockShare.mock.calls) {
      expect(call[2]).toEqual({ localOnly: true });
    }
  });
});
