import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';

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

  it('returns zero counts for empty input after trimming', async () => {
    const result = await manager.importMemories('\n\n  \n', 'claude');
    expect(result.memoryCount).toBe(0);
    expect(result.tripleCount).toBe(0);
    expect(mocks.mockWriteToWorkspace).not.toHaveBeenCalled();
  });

  it('defaults source to "other" for unknown values', async () => {
    const result = await manager.importMemories('- A memory', 'other');
    expect(result.source).toBe('other');
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
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme', 'claude');

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

    const manager = new ChatMemoryManager(mocks.tools, {
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseURL: 'https://api.openai.com/v1',
    });
    const result = await manager.importMemories('- Likes coffee\n- Has a cat', 'chatgpt');

    expect(result.memoryCount).toBe(2);
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const catTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/category',
    );
    expect(catTriples.every((q: any) => q.object === '"fact"')).toBe(true);
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
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme Corp', 'claude');

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
    const result = await manager.importMemories('- Prefers dark mode\n- Works at Acme Corp', 'claude');

    expect(result.memoryCount).toBe(2);
    const quads = mocks.mockWriteToWorkspace.mock.calls[0][1];
    const catTriples = quads.filter(
      (q: any) => q.predicate === 'http://dkg.io/ontology/category',
    );
    expect(catTriples.every((q: any) => q.object === '"fact"')).toBe(true);
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
    const result = await manager.importMemories('Works at Acme Corp as an engineer', 'claude');

    expect(result.entityCount).toBe(1);
    expect(mocks.mockWriteToWorkspace).toHaveBeenCalledTimes(2);

    const entityQuads = mocks.mockWriteToWorkspace.mock.calls[1][1];
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
});
