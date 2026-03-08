import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import { ChatAssistant } from '../src/chat-assistant.js';
import type { MemoryToolContext } from '../src/chat-memory.js';

let db: DashboardDB;
let dir: string;
let assistant: ChatAssistant;
let mockQuery: ReturnType<typeof vi.fn>;

function seedMetrics() {
  db.insertSnapshot({
    ts: Date.now(),
    cpu_percent: 23.5,
    mem_used_bytes: 512_000_000,
    mem_total_bytes: 8_000_000_000,
    disk_used_bytes: 50_000_000_000,
    disk_total_bytes: 256_000_000_000,
    heap_used_bytes: 200_000_000,
    uptime_seconds: 3661,
    peer_count: 4,
    direct_peers: 2,
    relayed_peers: 2,
    mesh_peers: 3,
    paranet_count: 2,
    total_triples: 1500,
    total_kcs: 10,
    total_kas: 25,
    store_bytes: 2_000_000,
    confirmed_kcs: 8,
    tentative_kcs: 2,
    rpc_latency_ms: 15,
    rpc_healthy: 1,
  });
}

function seedOperations() {
  db.insertOperation({
    operation_id: 'op-1',
    operation_name: 'publish',
    started_at: Date.now() - 60_000,
    paranet_id: 'testing',
  });
  db.completeOperation({ operation_id: 'op-1', duration_ms: 350, triple_count: 50 });

  db.insertOperation({
    operation_id: 'op-2',
    operation_name: 'query',
    started_at: Date.now() - 30_000,
  });
  db.failOperation({ operation_id: 'op-2', duration_ms: 120, error_message: 'SPARQL syntax error' });

  db.insertOperation({
    operation_id: 'op-3',
    operation_name: 'sync',
    started_at: Date.now() - 10_000,
    paranet_id: 'agents',
  });
  db.completeOperation({ operation_id: 'op-3', duration_ms: 800, triple_count: 200 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-chat-test-'));
  db = new DashboardDB({ dataDir: dir });
  mockQuery = vi.fn().mockResolvedValue({ bindings: [] });
  assistant = new ChatAssistant(db, mockQuery);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ChatAssistant', () => {
  describe('LLM compatibility payload guards', () => {
    it('omits max_tokens for gpt-5 models', async () => {
      const llmAssistant = new ChatAssistant(
        db,
        mockQuery,
        { apiKey: 'test-key', model: 'gpt-5-mini', baseURL: 'https://api.openai.com/v1' },
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'Hello from gpt-5-mini' } }],
        }), { status: 200 }),
      );

      const res = await llmAssistant.answer({ message: 'Tell me something interesting' });
      expect(res.reply).toContain('Hello from gpt-5-mini');

      const reqInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(reqInit?.body ?? '{}'));
      expect(payload.max_tokens).toBeUndefined();

      fetchSpy.mockRestore();
    });
  });

  describe('streaming responses', () => {
    it('streams text deltas and final response for non-rule chat turns', async () => {
      const llmAssistant = new ChatAssistant(
        db,
        mockQuery,
        { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      );
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const events: any[] = [];
      for await (const ev of llmAssistant.answerStream({ message: 'Tell me a joke' })) {
        events.push(ev);
      }

      expect(events.some(e => e.type === 'text_delta' && e.delta === 'Hel')).toBe(true);
      const final = events.find(e => e.type === 'final');
      expect(final?.responseMode).toBe('streaming');
      expect(final?.response.reply).toBe('Hello');
      fetchSpy.mockRestore();
    });

    it('uses rule-based final mode for deterministic node metrics answers', async () => {
      seedMetrics();
      const llmAssistant = new ChatAssistant(
        db,
        mockQuery,
        { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const events: any[] = [];
      for await (const ev of llmAssistant.answerStream({ message: 'What is the uptime?' })) {
        events.push(ev);
      }

      const final = events.find(e => e.type === 'final');
      expect(final?.responseMode).toBe('rule-based');
      expect(final?.response.reply).toContain('1h 1m');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns compatibility diagnostics when provider rejects stream request', async () => {
      const llmAssistant = new ChatAssistant(
        db,
        mockQuery,
        { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unsupported parameter: temperature' } }), { status: 400 }),
      );

      const events: any[] = [];
      for await (const ev of llmAssistant.answerStream({ message: 'Tell me a story' })) {
        events.push(ev);
      }

      const final = events.find(e => e.type === 'final');
      expect(final?.response.llmDiagnostics).toBeTruthy();
      expect(final?.response.llmDiagnostics?.status).toBe(400);
      expect(final?.response.llmDiagnostics?.compatibilityHint).toMatch(/temperature/i);
      fetchSpy.mockRestore();
    });

    it('falls back to blocking tool loop when streamed response requests tool calls', async () => {
      const mockTools: MemoryToolContext = {
        query: vi.fn().mockResolvedValue({ bindings: [] }),
        writeToWorkspace: vi.fn().mockResolvedValue({ workspaceOperationId: 'ws-test' }),
        enshrineFromWorkspace: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        createParanet: vi.fn().mockResolvedValue(undefined),
        listParanets: vi.fn().mockResolvedValue([{ id: 'testing', name: 'Testing' }]),
      };
      const toolAssistant = new ChatAssistant(
        db,
        mockQuery,
        { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' },
        mockTools,
      );
      const toolCallResponse = {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'dkg_list_paranets', arguments: '{}' },
            }],
          },
        }],
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // Stream attempt response (JSON fallback with tool call)
        .mockResolvedValueOnce(new Response(JSON.stringify(toolCallResponse), { status: 200 }))
        // Blocking tool loop first round response (tool call)
        .mockResolvedValueOnce(new Response(JSON.stringify(toolCallResponse), { status: 200 }))
        // Blocking tool loop second round response (final text)
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Found 1 paranet: Testing.' } }],
        }), { status: 200 }));

      const events: any[] = [];
      for await (const ev of toolAssistant.answerStream({ message: 'Please inspect my available knowledge spaces' })) {
        events.push(ev);
      }

      expect(mockTools.listParanets).toHaveBeenCalledTimes(1);
      const final = events.find(e => e.type === 'final');
      expect(final?.response.reply).toContain('Found 1 paranet');
      expect(final?.responseMode).toBe('blocking');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      fetchSpy.mockRestore();
    });
  });

  describe('uptime', () => {
    it('reports uptime when metrics exist', async () => {
      seedMetrics();
      const res = await assistant.answer({ message: 'What is the uptime?' });
      expect(res.reply).toContain('1h 1m');
      expect(res.data).toHaveProperty('uptimeSeconds', 3661);
    });

    it('reports no metrics when DB is empty', async () => {
      const res = await assistant.answer({ message: 'How long has the node been running?' });
      expect(res.reply).toContain('No metrics');
    });
  });

  describe('peer count', () => {
    it('reports peer counts', async () => {
      seedMetrics();
      const res = await assistant.answer({ message: 'How many peers am I connected to?' });
      expect(res.reply).toContain('4');
      expect(res.reply).toContain('2 direct');
      expect(res.reply).toContain('2 relayed');
    });
  });

  describe('triple count', () => {
    it('reports triple, KC, and KA counts', async () => {
      seedMetrics();
      const res = await assistant.answer({ message: 'How many triples do I have?' });
      expect(res.reply).toContain('1500');
      expect(res.reply).toContain('10');
      expect(res.reply).toContain('25');
    });
  });

  describe('CPU / memory', () => {
    it('reports CPU and memory usage', async () => {
      seedMetrics();
      const res = await assistant.answer({ message: 'Show me CPU and memory' });
      expect(res.reply).toContain('23.5%');
      expect(res.reply).toContain('488'); // ~512MB in MB
    });
  });

  describe('failed operations', () => {
    it('reports failed operations', async () => {
      seedOperations();
      const res = await assistant.answer({ message: 'Are there any failures?' });
      expect(res.reply).toContain('1');
      expect(res.reply).toContain('SPARQL syntax error');
    });

    it('reports no failures when all operations succeed', async () => {
      db.insertOperation({
        operation_id: 'op-ok',
        operation_name: 'publish',
        started_at: Date.now(),
        paranet_id: 'testing',
      });
      db.completeOperation({ operation_id: 'op-ok', duration_ms: 100, triple_count: 10 });
      const res = await assistant.answer({ message: 'Any errors?' });
      expect(res.reply).toContain('No failed operations');
    });
  });

  describe('operations summary', () => {
    it('returns operation counts by type', async () => {
      seedOperations();
      const res = await assistant.answer({ message: 'How many operations were processed?' });
      expect(res.reply).toContain('3');
      expect(res.reply).toContain('1 publishes');
      expect(res.reply).toContain('1 queries');
      expect(res.reply).toContain('1 syncs');
    });
  });

  describe('agents', () => {
    it('queries the triple store for agents', async () => {
      mockQuery.mockResolvedValueOnce({
        bindings: [
          { name: '"TestAgent"', peerId: '12D3KooWTestAgent12345' },
        ],
      });
      const res = await assistant.answer({ message: 'Which agents are on the network?' });
      expect(mockQuery).toHaveBeenCalled();
      expect(res.reply).toContain('1');
      expect(res.reply).toContain('TestAgent');
    });

    it('handles empty agents list', async () => {
      const res = await assistant.answer({ message: 'Who is on the network?' });
      expect(res.reply).toContain('No agents discovered');
    });
  });

  describe('store/disk', () => {
    it('reports store and disk sizes', async () => {
      seedMetrics();
      const res = await assistant.answer({ message: 'How big is my store?' });
      expect(res.reply).toContain('1.91'); // 2MB in MB
      expect(res.reply).toContain('46.6'); // ~50GB in GB
    });
  });

  describe('SPARQL passthrough', () => {
    it('runs a query starting with SELECT', async () => {
      mockQuery.mockResolvedValueOnce({
        bindings: [{ s: 'test:a', p: 'test:b', o: 'test:c' }],
      });
      const res = await assistant.answer({ message: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1' });
      expect(mockQuery).toHaveBeenCalledWith('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1');
      expect(res.reply).toContain('1');
      expect(res.sparql).toBe('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1');
    });

    it('handles SPARQL errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('parse error'));
      const res = await assistant.answer({ message: 'SELECT broken query' });
      expect(res.reply).toContain('SPARQL error');
      expect(res.reply).toContain('parse error');
    });
  });

  describe('help / fallback', () => {
    it('returns help text for unrecognized messages', async () => {
      const res = await assistant.answer({ message: 'hello there' });
      expect(res.reply).toContain('assistant');
      expect(res.reply).toContain('uptime');
    });
  });

  describe('recent logs', () => {
    it('returns recent logs when available', async () => {
      db.insertLog({
        ts: Date.now(),
        level: 'info',
        module: 'agent',
        operation_name: 'publish',
        operation_id: 'op-log-1',
        message: 'Published 50 triples',
      });
      const res = await assistant.answer({ message: 'Show me the latest logs' });
      expect(res.reply).toContain('Published 50 triples');
      expect(res.reply).toContain('info');
    });
  });

  describe('action routing', () => {
    it('routes action messages to LLM when LLM + tools configured', async () => {
      const mockTools: MemoryToolContext = {
        query: vi.fn().mockResolvedValue({ bindings: [] }),
        writeToWorkspace: vi.fn().mockResolvedValue({ workspaceOperationId: 'ws-test-123' }),
        enshrineFromWorkspace: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        createParanet: vi.fn().mockResolvedValue(undefined),
        listParanets: vi.fn().mockResolvedValue([]),
      };
      const llmConfig = { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' };
      const toolAssistant = new ChatAssistant(db, mockQuery, llmConfig, mockTools);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'dkg_write_to_workspace',
                  arguments: JSON.stringify({
                    paranetId: 'testing',
                    quads: [
                      { subject: 'http://example.org/Tesla', predicate: 'http://schema.org/name', object: 'Tesla', graph: '' },
                      { subject: 'http://example.org/Tesla', predicate: 'http://schema.org/founder', object: 'http://example.org/ElonMusk', graph: '' },
                    ],
                  }),
                },
              }],
            },
          }],
        }), { status: 200 }),
      ).mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'Done! I wrote 2 triples about Tesla to the testing workspace.' } }],
        }), { status: 200 }),
      );

      const res = await toolAssistant.answer({ message: 'Create a knowledge asset about Tesla in the testing paranet' });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(mockTools.writeToWorkspace).toHaveBeenCalledWith('testing', [
        { subject: 'http://example.org/Tesla', predicate: 'http://schema.org/name', object: 'Tesla', graph: '' },
        { subject: 'http://example.org/Tesla', predicate: 'http://schema.org/founder', object: 'http://example.org/ElonMusk', graph: '' },
      ]);
      expect(res.reply).toContain('Tesla');
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls![0].name).toBe('dkg_write_to_workspace');
      expect(res.toolCalls![0].result).toHaveProperty('tripleCount', 2);

      fetchSpy.mockRestore();
    });

    it('does not route simple queries to LLM', async () => {
      seedMetrics();
      const mockTools: MemoryToolContext = {
        query: vi.fn().mockResolvedValue({ bindings: [] }),
        writeToWorkspace: vi.fn().mockResolvedValue({ workspaceOperationId: 'ws-test' }),
        enshrineFromWorkspace: vi.fn().mockResolvedValue({ status: 'confirmed' }),
        createParanet: vi.fn().mockResolvedValue(undefined),
        listParanets: vi.fn().mockResolvedValue([]),
      };
      const llmConfig = { apiKey: 'test-key' };
      const toolAssistant = new ChatAssistant(db, mockQuery, llmConfig, mockTools);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await toolAssistant.answer({ message: 'What is the uptime?' });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.reply).toContain('1h 1m');
      fetchSpy.mockRestore();
    });
  });

  describe('tool execution', () => {
    let mockTools: MemoryToolContext;
    let toolAssistant: ChatAssistant;

    beforeEach(() => {
      mockTools = {
        query: vi.fn().mockResolvedValue({ bindings: [{ s: 'x', p: 'y', o: 'z' }] }),
        writeToWorkspace: vi.fn().mockResolvedValue({ workspaceOperationId: 'ws-abc' }),
        enshrineFromWorkspace: vi.fn().mockResolvedValue({ status: 'confirmed', kcId: 42n }),
        createParanet: vi.fn().mockResolvedValue(undefined),
        listParanets: vi.fn().mockResolvedValue([{ id: 'testing', name: 'Testing' }]),
      };
      const llmConfig = { apiKey: 'test-key', model: 'gpt-4o-mini', baseURL: 'https://api.openai.com/v1' };
      toolAssistant = new ChatAssistant(db, mockQuery, llmConfig, mockTools);
    });

    it('executes dkg_query tool', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_query', arguments: JSON.stringify({ sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 5' }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Found 1 result.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Generate a SPARQL query to find all subjects' });
      expect(mockTools.query).toHaveBeenCalledWith('SELECT ?s WHERE { ?s ?p ?o } LIMIT 5', expect.objectContaining({ includeWorkspace: false }));
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls![0].name).toBe('dkg_query');
      fetchSpy.mockRestore();
    });

    it('executes dkg_list_paranets tool', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_list_paranets', arguments: '{}' },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Found 1 paranet: Testing.' } }],
        }), { status: 200 }));

      // "generate" is an action verb → bypasses rule-based matchers
      const res = await toolAssistant.answer({ message: 'Generate a list of my knowledge graphs' });
      expect(mockTools.listParanets).toHaveBeenCalled();
      expect(res.toolCalls![0].result).toEqual([{ id: 'testing', name: 'Testing' }]);
      fetchSpy.mockRestore();
    });

    it('executes dkg_create_paranet tool', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_create_paranet', arguments: JSON.stringify({ id: 'my-data', name: 'My Data', description: 'test' }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Created My Data.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Build a new knowledge graph called My Data' });
      expect(mockTools.createParanet).toHaveBeenCalledWith({ id: 'my-data', name: 'My Data', description: 'test' });
      expect(res.toolCalls![0].name).toBe('dkg_create_paranet');
      fetchSpy.mockRestore();
    });

    it('executes dkg_enshrine tool', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_enshrine', arguments: JSON.stringify({ paranetId: 'testing', selection: 'all' }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Enshrined workspace to chain.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Finalize everything on chain now' });
      expect(mockTools.enshrineFromWorkspace).toHaveBeenCalledWith('testing', 'all');
      expect(res.toolCalls![0].name).toBe('dkg_enshrine');
      fetchSpy.mockRestore();
    });

    it('handles tool execution errors gracefully', async () => {
      (mockTools.writeToWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Workspace validation failed'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_write_to_workspace', arguments: JSON.stringify({
              paranetId: 'testing',
              quads: [{ subject: 'http://x', predicate: 'http://y', object: 'z', graph: '' }],
            }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Sorry, the write failed.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Write some RDF data for me' });
      expect(res.toolCalls![0].result).toHaveProperty('error');
      expect((res.toolCalls![0].result as any).error).toContain('Workspace validation failed');
      fetchSpy.mockRestore();
    });

    it('handles quads passed as string (legacy format)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_write_to_workspace', arguments: JSON.stringify({
              paranetId: 'agent-memo',
              quads: '[{"subject":"http://example.org/A","predicate":"http://schema.org/name","object":"Alpha","graph":""}]',
            }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Saved!' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Save Alpha to my notes' });
      expect(mockTools.writeToWorkspace).toHaveBeenCalledWith('agent-memo', [
        { subject: 'http://example.org/A', predicate: 'http://schema.org/name', object: 'Alpha', graph: '' },
      ]);
      expect(res.toolCalls![0].result).toHaveProperty('tripleCount', 1);
      fetchSpy.mockRestore();
    });

    it('rejects empty quads with error message', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'dkg_write_to_workspace', arguments: JSON.stringify({
              paranetId: 'testing',
              quads: 'this is not valid json at all',
            }) },
          }] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Could not parse the quads.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Insert some broken data' });
      expect(mockTools.writeToWorkspace).not.toHaveBeenCalled();
      expect(res.toolCalls![0].result).toHaveProperty('error', 'No valid quads to write');
      fetchSpy.mockRestore();
    });

    it('executes multi-tool calls in a single LLM round', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [
            {
              id: 'c1', type: 'function',
              function: { name: 'dkg_create_paranet', arguments: JSON.stringify({ id: 'new-data', name: 'New Data' }) },
            },
            {
              id: 'c2', type: 'function',
              function: { name: 'dkg_write_to_workspace', arguments: JSON.stringify({
                paranetId: 'new-data',
                quads: [{ subject: 'http://example.org/X', predicate: 'http://schema.org/name', object: 'X', graph: '' }],
              }) },
            },
          ] } }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: 'Built new-data and added X.' } }],
        }), { status: 200 }));

      const res = await toolAssistant.answer({ message: 'Build a new-data graph and add X to it' });
      expect(mockTools.createParanet).toHaveBeenCalledWith({ id: 'new-data', name: 'New Data', description: undefined });
      expect(mockTools.writeToWorkspace).toHaveBeenCalled();
      expect(res.toolCalls).toHaveLength(2);
      expect(res.reply).toContain('new-data');
      fetchSpy.mockRestore();
    });
  });
});
