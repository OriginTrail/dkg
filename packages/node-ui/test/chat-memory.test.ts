import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';

describe('ChatMemoryManager', () => {
  let manager: ChatMemoryManager;
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockWriteToWorkspace: ReturnType<typeof vi.fn>;
  let mockCreateParanet: ReturnType<typeof vi.fn>;
  let mockListParanets: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockWriteToWorkspace = vi.fn().mockResolvedValue({ workspaceOperationId: 'op-1' });
    mockCreateParanet = vi.fn().mockResolvedValue(undefined);
    mockListParanets = vi.fn().mockResolvedValue([{ id: 'agent-memory', name: 'Agent Memory' }]);

    manager = new ChatMemoryManager(
      {
        query: mockQuery,
        writeToWorkspace: mockWriteToWorkspace,
        enshrineFromWorkspace: vi.fn().mockResolvedValue({}),
        createParanet: mockCreateParanet,
        listParanets: mockListParanets,
      },
      { apiKey: 'test' },
    );
  });

  it('stores a chat exchange and writes quads to workspace', async () => {
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-1', 'Hello', 'Hi there!');

    expect(mockWriteToWorkspace).toHaveBeenCalledWith('agent-memory', expect.any(Array), { localOnly: true });
    const quads = mockWriteToWorkspace.mock.calls[0][1];
    expect(quads.length).toBeGreaterThanOrEqual(12);
    const sessionTriple = quads.find((q: any) => q.predicate?.includes('sessionId'));
    expect(sessionTriple).toBeDefined();
    expect(sessionTriple.object).toContain('session-1');
  });

  it('includes session triples only on first write for a session', async () => {
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-1', 'First message', 'First reply');
    await manager.storeChatExchange('session-1', 'Second message', 'Second reply');

    expect(mockWriteToWorkspace).toHaveBeenCalledTimes(2);
    const firstQuads = mockWriteToWorkspace.mock.calls[0][1];
    const secondQuads = mockWriteToWorkspace.mock.calls[1][1];
    const firstSessionTriple = firstQuads.find((q: any) => q.predicate?.includes('sessionId'));
    const secondSessionTriple = secondQuads.find((q: any) => q.predicate?.includes('sessionId'));
    expect(firstSessionTriple).toBeDefined();
    expect(secondSessionTriple).toBeUndefined();
    expect(secondQuads.length).toBe(10);
  });

  it('creates agent-memory paranet when not in list', async () => {
    mockListParanets.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    const m = new ChatMemoryManager(
      {
        query: mockQuery,
        writeToWorkspace: mockWriteToWorkspace,
        enshrineFromWorkspace: vi.fn().mockResolvedValue({}),
        createParanet: mockCreateParanet,
        listParanets: mockListParanets,
      },
      { apiKey: 'test' },
    );
    await m.storeChatExchange('s1', 'x', 'y');
    expect(mockCreateParanet).toHaveBeenCalledWith(
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
          { author: 'urn:dkg:chat:actor:user', text: '"Hi"', ts: '"2026-01-01T12:00:00Z"' },
          { author: 'urn:dkg:chat:actor:agent', text: '"Hello"', ts: '"2026-01-01T12:00:01Z"' },
        ],
      });

    const chats = await manager.getRecentChats(10);
    expect(chats).toHaveLength(1);
    expect(chats[0].session).toBe('uuid-1');
    expect(chats[0].messages).toHaveLength(2);
    expect(chats[0].messages[0].author).toBe('user');
    expect(chats[0].messages[1].author).toBe('agent');
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

  it('getStats returns session and triple counts', async () => {
    mockQuery
      .mockResolvedValueOnce({ bindings: [] })               // ensureInitialized: load known sessions
      .mockResolvedValueOnce({ bindings: [{ c: '10' }] })   // total triples
      .mockResolvedValueOnce({ bindings: [{ c: '3' }] })    // sessions
      .mockResolvedValueOnce({ bindings: [{ c: '6' }] })    // messages
      .mockResolvedValueOnce({ bindings: [{ c: '8' }] })    // chat-related triples
      .mockResolvedValueOnce({ bindings: [{ c: '1' }] });   // entities

    const stats = await manager.getStats();
    expect(stats.paranetId).toBe('agent-memory');
    expect(stats.initialized).toBe(true);
    expect(stats.sessionCount).toBe(3);
    expect(stats.totalTriples).toBe(10);
    expect(stats.messageCount).toBe(6);
  });
});

describe('ChatMemoryManager privacy guarantees', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockWriteToWorkspace: ReturnType<typeof vi.fn>;
  let mockCreateParanet: ReturnType<typeof vi.fn>;
  let mockListParanets: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockWriteToWorkspace = vi.fn().mockResolvedValue({ workspaceOperationId: 'op-1' });
    mockCreateParanet = vi.fn().mockResolvedValue(undefined);
    mockListParanets = vi.fn().mockResolvedValue([{ id: 'agent-memory', name: 'Agent Memory' }]);
  });

  function createManager() {
    return new ChatMemoryManager(
      {
        query: mockQuery,
        writeToWorkspace: mockWriteToWorkspace,
        enshrineFromWorkspace: vi.fn().mockResolvedValue({}),
        createParanet: mockCreateParanet,
        listParanets: mockListParanets,
      },
      { apiKey: 'test' },
    );
  }

  it('all workspace writes use localOnly: true', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s1', 'Hello', 'Hi');

    for (const call of mockWriteToWorkspace.mock.calls) {
      expect(call[2]).toEqual({ localOnly: true });
    }
  });

  it('storeChatExchange never writes without localOnly flag', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s2', 'msg', 'reply');
    await manager.storeChatExchange('s2', 'msg2', 'reply2');
    await manager.storeChatExchange('s3', 'new session', 'new reply');

    expect(mockWriteToWorkspace.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of mockWriteToWorkspace.mock.calls) {
      const opts = call[2];
      expect(opts).toBeDefined();
      expect(opts.localOnly).toBe(true);
    }
  });

  it('agent-memory paranet is created with private: true', async () => {
    mockListParanets.mockResolvedValueOnce([]);
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    const manager = createManager();
    await manager.storeChatExchange('s1', 'x', 'y');

    expect(mockCreateParanet).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateParanet.mock.calls[0][0];
    expect(createOpts.id).toBe('agent-memory');
    expect(createOpts.private).toBe(true);
  });

  it('paranet creation opts always include private: true even on subsequent initializations', async () => {
    mockListParanets.mockResolvedValue([]);
    mockQuery.mockResolvedValue({ bindings: [] });

    const m1 = createManager();
    await m1.storeChatExchange('s1', 'a', 'b');

    const m2 = createManager();
    await m2.storeChatExchange('s2', 'c', 'd');

    for (const call of mockCreateParanet.mock.calls) {
      expect(call[0].private).toBe(true);
    }
  });

  it('workspace writes target the agent-memory paranet exclusively', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('s1', 'secret', 'reply');

    for (const call of mockWriteToWorkspace.mock.calls) {
      expect(call[0]).toBe('agent-memory');
    }
  });

  it('second session also uses localOnly writes', async () => {
    const manager = createManager();
    mockQuery.mockResolvedValueOnce({ bindings: [] });
    await manager.storeChatExchange('session-A', 'First session msg', 'reply');
    await manager.storeChatExchange('session-B', 'Second session msg', 'reply');

    expect(mockWriteToWorkspace.mock.calls.length).toBe(2);
    for (const call of mockWriteToWorkspace.mock.calls) {
      expect(call[2]).toEqual({ localOnly: true });
    }
  });
});
