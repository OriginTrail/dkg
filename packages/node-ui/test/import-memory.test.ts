import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { type ServerResponse, type IncomingMessage } from 'node:http';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { handleNodeUIRequest } from '../src/api.js';

function createMocks() {
  const mockQuery = vi.fn();
  const mockWriteToWorkspace = vi.fn().mockResolvedValue({ workspaceOperationId: 'op-1' });
  const mockCreateParanet = vi.fn().mockResolvedValue(undefined);
  const mockListParanets = vi.fn().mockResolvedValue([{ id: 'agent-memory', name: 'Agent Memory' }]);
  const mockEnshrineFromWorkspace = vi.fn().mockResolvedValue({});

  return {
    mockQuery,
    mockWriteToWorkspace,
    mockCreateParanet,
    mockListParanets,
    mockEnshrineFromWorkspace,
    tools: {
      query: mockQuery,
      writeToWorkspace: mockWriteToWorkspace,
      enshrineFromWorkspace: mockEnshrineFromWorkspace,
      createParanet: mockCreateParanet,
      listParanets: mockListParanets,
    },
  };
}

describe('Import Memory — heuristic parsing', () => {
  let manager: ChatMemoryManager;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    manager = new ChatMemoryManager(mocks.tools, { apiKey: '' });
  });

  it('parses simple bullet list into memory items', () => {
    const input = `- Prefers dark mode
- Works at Acme Corp
- Has a dog named Max`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items).toHaveLength(3);
    expect(items[0].text).toBe('Prefers dark mode');
    expect(items[1].text).toBe('Works at Acme Corp');
    expect(items[2].text).toBe('Has a dog named Max');
    expect(items.every(i => i.category === 'fact')).toBe(true);
  });

  it('handles numbered lists', () => {
    const input = `1. Uses TypeScript for all projects
2. Prefers vim keybindings
3. Located in San Francisco`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items).toHaveLength(3);
    expect(items[0].text).toBe('Uses TypeScript for all projects');
    expect(items[1].text).toBe('Prefers vim keybindings');
  });

  it('filters out short lines and headers', () => {
    const input = `Here are your memories:
---
- Works at Acme
- Hi
- Enjoys hiking on weekends
Last updated: 2026`;

    const items = manager.parseMemoriesHeuristic(input);
    const texts = items.map(i => i.text);
    expect(texts).not.toContain('Hi');
    expect(texts).not.toContain('---');
    expect(texts).toContain('Works at Acme');
    expect(texts).toContain('Enjoys hiking on weekends');
  });

  it('strips asterisk and dot-bullet markers', () => {
    const input = `* Likes coffee
• Uses dark theme
  - Prefers monospace fonts`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items[0].text).toBe('Likes coffee');
    expect(items[1].text).toBe('Uses dark theme');
    expect(items[2].text).toBe('Prefers monospace fonts');
  });

  it('returns empty array for blank input', () => {
    expect(manager.parseMemoriesHeuristic('')).toHaveLength(0);
    expect(manager.parseMemoriesHeuristic('   \n  \n  ')).toHaveLength(0);
  });

  it('preserves leading numbers that are not list markers', () => {
    const input = `- Born in 1990 in Berlin
- Uses Node 22 for development
- 3D printing is a hobby`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items[0].text).toBe('Born in 1990 in Berlin');
    expect(items[1].text).toBe('Uses Node 22 for development');
    expect(items[2].text).toBe('3D printing is a hobby');
  });

  it('does not strip bare numbers that are not list markers', () => {
    const input = `2025 was the year we launched v2
192.168.1.1 is the home router IP
42 is the answer to everything`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items[0].text).toBe('2025 was the year we launched v2');
    expect(items[1].text).toBe('192.168.1.1 is the home router IP');
    expect(items[2].text).toBe('42 is the answer to everything');
  });

  it('preserves leading dash when not followed by whitespace', () => {
    const input = `-42 is my lucky number
-verbose is a CLI flag
- actual bullet item`;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items[0].text).toBe('-42 is my lucky number');
    expect(items[1].text).toBe('-verbose is a CLI flag');
    expect(items[2].text).toBe('actual bullet item');
  });

  it('filters out code-fence markers', () => {
    const input = `\`\`\`
- Prefers dark mode
- Works at Acme Corp
\`\`\``;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('Prefers dark mode');
    expect(items[1].text).toBe('Works at Acme Corp');
  });

  it('filters out code-fence markers with language tags', () => {
    const input = `\`\`\`json
- Likes TypeScript
\`\`\``;

    const items = manager.parseMemoriesHeuristic(input);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Likes TypeScript');
  });
});

describe('Import Memory — importMemories integration', () => {
  let manager: ChatMemoryManager;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    mocks.mockQuery.mockResolvedValue({ bindings: [] });
    manager = new ChatMemoryManager(mocks.tools, { apiKey: '' });
  });

  it('creates batch and memory item triples', async () => {
    const result = await manager.importMemories(
      '- Prefers dark mode\n- Works at Acme Corp',
      'claude',
    );

    expect(result.memoryCount).toBe(2);
    expect(result.source).toBe('claude');
    expect(result.batchId).toBeTruthy();
    expect(result.tripleCount).toBeGreaterThan(0);

    expect(mocks.mockWriteToWorkspace).toHaveBeenCalled();
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];

    const batchTriple = quads.find(
      (q: any) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
        q.object === 'http://dkg.io/ontology/MemoryImport',
    );
    expect(batchTriple).toBeDefined();
    expect(batchTriple.subject).toMatch(/^urn:dkg:memory:import:/);

    const memoryTriples = quads.filter(
      (q: any) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
        q.object === 'http://dkg.io/ontology/ImportedMemory',
    );
    expect(memoryTriples).toHaveLength(2);
  });

  it('tags memory items with correct source', async () => {
    await manager.importMemories('- My preference', 'chatgpt');

    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const sourceTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/importSource',
    );
    expect(sourceTriples.length).toBeGreaterThan(0);
    expect(sourceTriples.every((q: any) => q.object === '"chatgpt"')).toBe(true);
  });

  it('links memory items to their batch', async () => {
    const result = await manager.importMemories('- First item\n- Second item', 'gemini');

    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const batchLinks = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/importBatch',
    );
    expect(batchLinks).toHaveLength(2);
    const batchUri = `urn:dkg:memory:import:${result.batchId}`;
    expect(batchLinks.every((q: any) => q.object === batchUri)).toBe(true);
  });

  it('stores text content in schema:text', async () => {
    await manager.importMemories('- Prefers dark mode', 'other');

    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const textTriple = quads.find(
      (q: any) => q.predicate === 'http://schema.org/text',
    );
    expect(textTriple).toBeDefined();
    expect(textTriple.object).toBe('"Prefers dark mode"');
  });

  it('stores dateCreated on both batch and items', async () => {
    await manager.importMemories('- Something to remember', 'claude');

    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const dateTriples = quads.filter(
      (q: any) => q.predicate === 'http://schema.org/dateCreated',
    );
    expect(dateTriples.length).toBeGreaterThanOrEqual(2);
  });

  it('returns zero counts and null batchId for empty input', async () => {
    const result = await manager.importMemories('\n\n  \n', 'claude');
    expect(result.memoryCount).toBe(0);
    expect(result.tripleCount).toBe(0);
    expect(result.batchId).toBeNull();
    expect(mocks.mockWriteToWorkspace).not.toHaveBeenCalled();
  });

  it('defaults source to "other" for unknown values', async () => {
    const result = await manager.importMemories('- A memory', 'other');
    expect(result.source).toBe('other');
  });

  it('truncates to 5000 items and adds a warning when input is very large', async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `- Memory item number ${i + 1}`).join('\n');
    const result = await manager.importMemories(lines, 'claude');
    expect(result.memoryCount).toBe(5000);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(1);
    expect(result.warnings![0]).toContain('truncated to 5000');
  });

  it('returns quads array matching the written triples', async () => {
    const result = await manager.importMemories('- Dark mode preference', 'claude');

    expect(result.quads).toBeDefined();
    expect(Array.isArray(result.quads)).toBe(true);
    expect(result.quads.length).toBe(result.tripleCount);

    const batchQuad = result.quads.find(
      q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
        q.object === 'http://dkg.io/ontology/MemoryImport',
    );
    expect(batchQuad).toBeDefined();

    const memoryQuad = result.quads.find(
      q => q.predicate === 'http://schema.org/text',
    );
    expect(memoryQuad).toBeDefined();
    expect(memoryQuad!.object).toBe('"Dark mode preference"');

    for (const q of result.quads) {
      expect(q).toHaveProperty('subject');
      expect(q).toHaveProperty('predicate');
      expect(q).toHaveProperty('object');
      expect(q).not.toHaveProperty('graph');
    }
  });

  it('returns empty quads array when input is blank', async () => {
    const result = await manager.importMemories('  \n  ', 'claude');
    expect(result.quads).toEqual([]);
    expect(result.batchId).toBeNull();
  });
});

describe('Import Memory — privacy guarantees', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    mocks.mockQuery.mockResolvedValue({ bindings: [] });
  });

  it('all import writes use localOnly: true', async () => {
    const manager = new ChatMemoryManager(mocks.tools, { apiKey: '' });
    await manager.importMemories('- Secret preference\n- Another secret', 'claude');

    expect(mocks.mockWriteToWorkspace).toHaveBeenCalled();
    for (const call of mocks.mockWriteToWorkspace.mock.calls) {
      expect(call[2]).toEqual({ localOnly: true });
    }
  });

  it('all writes target the agent-memory paranet', async () => {
    const manager = new ChatMemoryManager(mocks.tools, { apiKey: '' });
    await manager.importMemories('- My data', 'chatgpt');

    for (const call of mocks.mockWriteToWorkspace.mock.calls) {
      expect(call[0]).toBe('agent-memory');
    }
  });

  it('creates agent-memory paranet with private: true if missing', async () => {
    mocks.mockListParanets.mockResolvedValueOnce([]);
    const manager = new ChatMemoryManager(mocks.tools, { apiKey: '' });
    await manager.importMemories('- My data', 'claude');

    expect(mocks.mockCreateParanet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-memory', private: true }),
    );
  });
});

describe('Import Memory — LLM-assisted parsing', () => {
  let mocks: ReturnType<typeof createMocks>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mocks = createMocks();
    mocks.mockQuery.mockResolvedValue({ bindings: [] });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not send data to LLM when useLlm opt-in is not set', async () => {
    globalThis.fetch = vi.fn();

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Private thought', 'claude');

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.memoryCount).toBe(1);
    expect(result.entityCount).toBe(0);
  });

  it('uses LLM to parse memories when API key is configured', async () => {
    const llmResponse = JSON.stringify([
      { text: 'Prefers dark mode', category: 'preference' },
      { text: 'Works at Acme Corp', category: 'fact' },
    ]);

    globalThis.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: llmResponse } }],
        }),
      } as any);

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme', 'claude', { useLlm: true });

    expect(result.memoryCount).toBe(2);
    // First call: parse memories, second call: knowledge extraction
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const catTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/category',
    );
    expect(catTriples.some((q: any) => q.object === '"preference"')).toBe(true);
    expect(catTriples.some((q: any) => q.object === '"fact"')).toBe(true);
  });

  it('falls back to heuristic when LLM call fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false } as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Likes coffee\n- Has a cat', 'chatgpt', { useLlm: true });

    expect(result.memoryCount).toBe(2);
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const catTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/category',
    );
    expect(catTriples.every((q: any) => q.object === '"fact"')).toBe(true);
    warnSpy.mockRestore();
  });

  it('handles LLM using alternate key names like "memory" instead of "text"', async () => {
    const llmResponse = JSON.stringify([
      { memory: 'Prefers dark mode', category: 'preference' },
      { memory: 'Works at Acme Corp', category: 'fact' },
    ]);

    globalThis.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: llmResponse } }],
        }),
      } as any);

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme Corp', 'claude', { useLlm: true });

    expect(result.memoryCount).toBe(2);
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const textTriple = quads.find(
      (q: any) => q.predicate === 'http://schema.org/text' && q.object === '"Prefers dark mode"',
    );
    expect(textTriple).toBeDefined();
  });

  it('falls back to heuristic when LLM returns unrecognized item shapes', async () => {
    const llmResponse = JSON.stringify([
      { description: 'Prefers dark mode', type: 'preference' },
      { description: 'Works at Acme Corp', type: 'fact' },
    ]);

    globalThis.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: llmResponse } }],
        }),
      } as any);

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme Corp', 'claude', { useLlm: true });

    expect(result.memoryCount).toBe(2);
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const catTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/category',
    );
    expect(catTriples.every((q: any) => q.object === '"fact"')).toBe(true);
  });

  it('falls back to heuristic in importMemories when LLM returns empty array', async () => {
    const llmResponse = '[]';

    globalThis.fetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: llmResponse } }],
        }),
      } as any);

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Should still parse\n- Via heuristic fallback', 'claude', { useLlm: true });

    expect(result.memoryCount).toBe(2);
    expect(result.source).toBe('claude');
    expect(mocks.mockWriteToWorkspace).toHaveBeenCalled();
  });

  it('extracts knowledge entities when LLM returns N-Triples', async () => {
    const parseResponse = JSON.stringify([
      { text: 'Works at Acme Corp as an engineer', category: 'fact' },
    ]);
    const kgResponse = `<urn:dkg:entity:acme-corp> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Organization> .
<urn:dkg:entity:acme-corp> <http://schema.org/name> "Acme Corp" .`;

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: parseResponse } }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: kgResponse } }],
        }),
      });
    });

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('Works at Acme Corp as an engineer', 'claude', { useLlm: true });

    expect(result.entityCount).toBe(1);
    expect(mocks.mockWriteToWorkspace).toHaveBeenCalledTimes(2);

    const importQuads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const entityQuads = mocks.mockWriteToWorkspace.mock.calls[1][1];
    expect(result.tripleCount).toBe(importQuads.length + entityQuads.length);

    expect(result.quads.length).toBe(result.tripleCount);
    const extractedQuad = result.quads.find(
      (q: any) => q.subject === 'urn:dkg:entity:acme-corp' &&
        q.object === 'http://schema.org/Organization',
    );
    expect(extractedQuad).toBeDefined();

    const orgType = entityQuads.find(
      (q: any) => q.subject === 'urn:dkg:entity:acme-corp' &&
        q.object === 'http://schema.org/Organization',
    );
    expect(orgType).toBeDefined();

    for (const call of mocks.mockWriteToWorkspace.mock.calls) {
      expect(call[0]).toBe('agent-memory');
      expect(call[2]).toEqual({ localOnly: true });
    }
  });

  it('surfaces warnings when entity extraction fails', async () => {
    const parseResponse = JSON.stringify([
      { text: 'Works at Acme Corp', category: 'fact' },
    ]);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: parseResponse } }],
          }),
        });
      }
      return Promise.reject(new Error('LLM service unavailable'));
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('Works at Acme Corp', 'claude', { useLlm: true });

    expect(result.memoryCount).toBe(1);
    expect(result.entityCount).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(1);
    expect(result.warnings![0]).toContain('Knowledge extraction failed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Knowledge extraction failed'));
    warnSpy.mockRestore();
  });
});

// ── API handler tests ────────────────────────────────────────────────────────

function mockReq(method: string, path: string, body?: string): IncomingMessage {
  const readable = new Readable();
  readable.push(body ?? null);
  readable.push(null);
  Object.assign(readable, { method, url: path, headers: {} });
  return readable as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res: any = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { res._body = data ?? ''; },
  };
  return res;
}

function createMemoryManager() {
  const mocks = createMocks();
  mocks.mockQuery.mockResolvedValue({ bindings: [] });
  return new ChatMemoryManager(mocks.tools, { apiKey: '' });
}

describe('POST /api/memory/import — route handler', () => {
  it('returns 400 for malformed JSON body', async () => {
    const req = mockReq('POST', '/api/memory/import', 'not json');
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 for non-object JSON body (null)', async () => {
    const req = mockReq('POST', '/api/memory/import', 'null');
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for non-object JSON body (array)', async () => {
    const req = mockReq('POST', '/api/memory/import', '[1, 2, 3]');
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for non-object JSON body (string)', async () => {
    const req = mockReq('POST', '/api/memory/import', '"hello"');
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for missing text field', async () => {
    const req = mockReq('POST', '/api/memory/import', JSON.stringify({ source: 'claude' }));
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Missing or empty "text" field' });
  });

  it('returns 400 for empty text field', async () => {
    const req = mockReq('POST', '/api/memory/import', JSON.stringify({ text: '   \n  ', source: 'claude' }));
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Missing or empty "text" field' });
  });

  it('normalizes unknown source to "other"', async () => {
    const req = mockReq('POST', '/api/memory/import', JSON.stringify({ text: '- A memory item', source: 'unknown-ai' }));
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.source).toBe('other');
    expect(body.memoryCount).toBeGreaterThan(0);
  });

  it('accepts valid known sources', async () => {
    for (const source of ['claude', 'chatgpt', 'gemini', 'other']) {
      const req = mockReq('POST', '/api/memory/import', JSON.stringify({ text: '- Test memory', source }));
      const res = mockRes();
      const url = new URL('http://localhost/api/memory/import');

      await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).source).toBe(source);
    }
  });

  it('returns 413 for oversized payload', async () => {
    const oversized = 'x'.repeat(3 * 1024 * 1024);
    const req = mockReq('POST', '/api/memory/import', oversized);
    const res = mockRes();
    const url = new URL('http://localhost/api/memory/import');

    const handled = await handleNodeUIRequest(req, res, url, {} as any, '', undefined, undefined, undefined, createMemoryManager());

    expect(handled).toBe(true);
    expect(res._status).toBe(413);
    expect(JSON.parse(res._body)).toEqual({ error: 'Payload too large' });
  });
});
