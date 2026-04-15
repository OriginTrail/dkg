import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import { NS, Class, Prop, Status } from '../src/ontology.js';
import type { DkgClientLike } from '../src/types.js';

// ---------------------------------------------------------------------------
// Tracking function helper
// ---------------------------------------------------------------------------

interface TrackingFn<T> {
  (...args: unknown[]): Promise<T>;
  calls: unknown[][];
  resetCalls(): void;
}

function trackingAsyncFn<T>(impl: (...args: unknown[]) => T | Promise<T>): TrackingFn<T> {
  const calls: unknown[][] = [];
  const fn = (async (...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  }) as TrackingFn<T>;
  fn.calls = calls;
  fn.resetCalls = () => { calls.length = 0; };
  return fn;
}

// ---------------------------------------------------------------------------
// Mock DKG client
// ---------------------------------------------------------------------------

function createMockClient(overrides: Partial<DkgClientLike> = {}): DkgClientLike {
  return {
    query: trackingAsyncFn(async () => ({ result: { bindings: [] } })),
    publish: trackingAsyncFn(async () => ({ kcId: 'kc-test-001', status: 'confirmed' })),
    createContextGraph: trackingAsyncFn(async () => ({ created: 'autoresearch', uri: 'urn:context-graph:autoresearch' })),
    subscribe: trackingAsyncFn(async () => ({ subscribed: 'autoresearch' })),
    ...overrides,
  };
}

type TextContent = Array<{ type: string; text: string }>;

function getText(result: { content: unknown }): string {
  return (result.content as TextContent)[0].text;
}

// ---------------------------------------------------------------------------
// Test harness: McpServer + InMemoryTransport + adapter tools
// ---------------------------------------------------------------------------

async function createTestHarness(mockClient?: DkgClientLike) {
  const client = mockClient ?? createMockClient();
  const server = new McpServer({ name: 'autoresearch-test', version: '0.0.1' });
  registerTools(server, async () => client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  return { mcpClient, server, dkgClient: client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoresearch adapter — tool registration', () => {
  let mcpClient: Client;

  beforeEach(async () => {
    ({ mcpClient } = await createTestHarness());
  });

  it('registers all 6 tools', async () => {
    const { tools } = await mcpClient.listTools();
    expect(tools).toHaveLength(6);
  });

  it('registers tools with expected names', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'autoresearch_best_results',
      'autoresearch_experiment_history',
      'autoresearch_insights',
      'autoresearch_publish_experiment',
      'autoresearch_query',
      'autoresearch_setup',
    ]);
  });

  it('all tools have a description', async () => {
    const { tools } = await mcpClient.listTools();
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description!.length).toBeGreaterThan(0);
    }
  });
});

describe('autoresearch_setup', () => {
  it('creates context graph and subscribes', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    const text = getText(result);

    expect(text).toContain('autoresearch');
    expect(text).toContain('subscribed');
    expect((mock.createContextGraph as TrackingFn<unknown>).calls[0]).toEqual([
      'autoresearch',
      'Autoresearch',
      expect.any(String),
    ]);
    expect((mock.subscribe as TrackingFn<unknown>).calls[0]).toEqual(['autoresearch']);
  });

  it('handles context graph already existing gracefully', async () => {
    const mock = createMockClient({
      createContextGraph: trackingAsyncFn(async () => { throw new Error('already exists'); }),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    const text = getText(result);

    expect(text).toContain('ready');
    expect((mock.subscribe as TrackingFn<unknown>).calls.length).toBeGreaterThan(0);
  });

  it('returns error when subscribe fails', async () => {
    const mock = createMockClient({
      subscribe: trackingAsyncFn(async () => { throw new Error('network down'); }),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('network down');
  });
});

describe('autoresearch_publish_experiment', () => {
  const baseArgs = {
    val_bpb: 0.9834,
    peak_vram_mb: 44200,
    status: 'keep' as const,
    description: 'increase depth to 12 layers',
  };

  it('publishes with required fields and returns URI + KC', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });
    const text = getText(result);

    expect(text).toContain('Published experiment');
    expect(text).toContain('kc-test-001');
    expect(text).toContain('0.9834');
    expect(text).toContain('keep');
    expect(text).toContain('increase depth to 12 layers');
  });

  it('sends correct quads to the DKG client', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    const publishCalls = (mock.publish as TrackingFn<unknown>).calls;
    expect(publishCalls).toHaveLength(1);
    const [contextGraphId, quads] = publishCalls[0] as [string, any[]];
    expect(contextGraphId).toBe('autoresearch');

    const types = quads.filter((q: any) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    expect(types).toHaveLength(1);
    expect(types[0].object).toBe(Class.Experiment);

    const valBpb = quads.find((q: any) => q.predicate === Prop.valBpb);
    expect(valBpb.object).toContain('0.9834');

    const status = quads.find((q: any) => q.predicate === Prop.status);
    expect(status.object).toBe(Status.Keep);

    const desc = quads.find((q: any) => q.predicate === Prop.description);
    expect(desc.object).toContain('increase depth to 12 layers');

    const ts = quads.find((q: any) => q.predicate === Prop.timestamp);
    expect(ts).toBeDefined();
    expect(ts.object).toMatch(/dateTime/);
  });

  it('includes optional fields when provided', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: {
        ...baseArgs,
        commit_hash: 'a1b2c3d',
        platform: 'H100',
        run_tag: 'mar8',
        depth: 12,
        num_params_m: 75.2,
        training_seconds: 300.1,
        total_tokens_m: 499.6,
        mfu_percent: 39.8,
        num_steps: 953,
        code_diff: '--- a/train.py\n+++ b/train.py',
        agent_did: 'did:dkg:agent-7',
        parent_experiment: 'urn:autoresearch:exp:prev-123',
      },
    });

    const [, quads] = (mock.publish as TrackingFn<unknown>).calls[0] as [string, any[]];

    expect(quads.find((q: any) => q.predicate === Prop.commitHash)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.platform)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.runTag)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.depth)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.numParamsM)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.trainingSeconds)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.totalTokensM)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.mfuPercent)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.numSteps)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.codeDiff)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.agentDid)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.parentExperiment)).toBeDefined();
  });

  it('omits optional fields when not provided', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    const [, quads] = (mock.publish as TrackingFn<unknown>).calls[0] as [string, any[]];

    expect(quads.find((q: any) => q.predicate === Prop.commitHash)).toBeUndefined();
    expect(quads.find((q: any) => q.predicate === Prop.platform)).toBeUndefined();
    expect(quads.find((q: any) => q.predicate === Prop.codeDiff)).toBeUndefined();
  });

  it('maps status values to correct ontology URIs', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    for (const [statusStr, expectedUri] of [
      ['keep', Status.Keep],
      ['discard', Status.Discard],
      ['crash', Status.Crash],
    ] as const) {
      (mock.publish as TrackingFn<unknown>).resetCalls();

      await mcpClient.callTool({
        name: 'autoresearch_publish_experiment',
        arguments: { ...baseArgs, status: statusStr },
      });

      const [, quads] = (mock.publish as TrackingFn<unknown>).calls[0] as [string, any[]];
      const statusQuad = quads.find((q: any) => q.predicate === Prop.status);
      expect(statusQuad.object).toBe(expectedUri);
    }
  });

  it('returns error when publish fails', async () => {
    const mock = createMockClient({
      publish: trackingAsyncFn(async () => { throw new Error('DKG daemon not running'); }),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('DKG daemon not running');
  });
});

describe('autoresearch_best_results', () => {
  it('returns "no experiments" when context graph is empty', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: {},
    });

    expect(getText(result)).toContain('No experiments found');
  });

  it('formats results when experiments exist', async () => {
    const mock = createMockClient({
      query: trackingAsyncFn(async () => ({
        result: {
          bindings: [
            {
              exp: 'urn:autoresearch:exp:1',
              valBpb: '"0.9712"^^<http://www.w3.org/2001/XMLSchema#double>',
              peakVram: '"44000"^^<http://www.w3.org/2001/XMLSchema#double>',
              status: `${NS}keep`,
              desc: '"SwiGLU + depth 16"',
              ts: '"2026-03-08T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
              platform: '"H100"',
            },
          ],
        },
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: { limit: 10 },
    });
    const text = getText(result);

    expect(text).toContain('Top 1 experiments');
    expect(text).toContain('0.9712');
    expect(text).toContain('SwiGLU + depth 16');
    expect(text).toContain('H100');
  });

  it('passes SPARQL query to client with correct context graph', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: { limit: 5 },
    });

    const queryCalls = (mock.query as TrackingFn<unknown>).calls;
    expect(queryCalls).toHaveLength(1);
    const [sparql, contextGraphId] = queryCalls[0] as [string, string];
    expect(contextGraphId).toBe('autoresearch');
    expect(sparql).toContain(Class.Experiment);
    expect(sparql).toContain('ORDER BY ASC(?valBpb)');
    expect(sparql).toContain('LIMIT 5');
  });
});

describe('autoresearch_experiment_history', () => {
  it('returns "no experiments" when filter matches nothing', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { run_tag: 'nonexistent' },
    });

    expect(getText(result)).toContain('No experiments found');
  });

  it('includes run_tag filter in SPARQL when provided', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { run_tag: 'mar8' },
    });

    const [sparql] = (mock.query as TrackingFn<unknown>).calls[0] as [string];
    expect(sparql).toContain(Prop.runTag);
    expect(sparql).toContain('mar8');
  });

  it('includes agent_did filter in SPARQL when provided', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { agent_did: 'did:dkg:agent-7' },
    });

    const [sparql] = (mock.query as TrackingFn<unknown>).calls[0] as [string];
    expect(sparql).toContain(Prop.agentDid);
    expect(sparql).toContain('did:dkg:agent-7');
  });

  it('returns table-formatted results', async () => {
    const mock = createMockClient({
      query: trackingAsyncFn(async () => ({
        result: {
          bindings: [
            {
              exp: 'urn:autoresearch:exp:1',
              valBpb: '"0.9979"',
              peakVram: '"45060"',
              status: `${NS}keep`,
              desc: '"baseline"',
              ts: '"2026-03-08T08:00:00Z"',
              commitHash: '"a1b2c3d"',
            },
            {
              exp: 'urn:autoresearch:exp:2',
              valBpb: '"0.9834"',
              peakVram: '"44200"',
              status: `${NS}keep`,
              desc: '"increase depth"',
              ts: '"2026-03-08T08:06:00Z"',
              commitHash: '"b2c3d4e"',
            },
          ],
        },
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: {},
    });
    const text = getText(result);

    expect(text).toContain('2 results');
    expect(text).toContain('baseline');
    expect(text).toContain('increase depth');
    expect(text).toContain('a1b2c3d');
  });
});

describe('autoresearch_insights', () => {
  it('returns "no experiments" when keyword matches nothing', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'quantum' },
    });

    expect(getText(result)).toContain('No experiments found matching "quantum"');
  });

  it('includes keyword FILTER in SPARQL', async () => {
    const mock = createMockClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'learning rate' },
    });

    const [sparql] = (mock.query as TrackingFn<unknown>).calls[0] as [string];
    expect(sparql).toContain('FILTER(CONTAINS(LCASE(?desc)');
    expect(sparql).toContain('learning rate');
  });

  it('shows summary with keep/discard/crash counts', async () => {
    const mock = createMockClient({
      query: trackingAsyncFn(async () => ({
        result: {
          bindings: [
            { exp: 'urn:1', valBpb: '"0.98"', status: `${NS}keep`, desc: '"LR 0.06"' },
            { exp: 'urn:2', valBpb: '"1.01"', status: `${NS}discard`, desc: '"LR 0.2"' },
            { exp: 'urn:3', valBpb: '"0.00"', status: `${NS}crash`, desc: '"LR 1.0 OOM"' },
          ],
        },
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'LR' },
    });
    const text = getText(result);

    expect(text).toContain('3 experiments');
    expect(text).toContain('1 kept');
    expect(text).toContain('1 discarded');
    expect(text).toContain('1 crashed');
  });
});

describe('autoresearch_query', () => {
  it('passes raw SPARQL to client', async () => {
    const mock = createMockClient({
      query: trackingAsyncFn(async () => ({
        result: {
          bindings: [{ avg: '"0.9856"' }],
        },
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const sparql = `SELECT (AVG(?v) AS ?avg) WHERE { ?e a <${Class.Experiment}> ; <${Prop.valBpb}> ?v }`;
    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql },
    });

    expect((mock.query as TrackingFn<unknown>).calls[0]).toEqual([sparql, 'autoresearch']);
    expect(getText(result)).toContain('0.9856');
  });

  it('returns "(no results)" for empty bindings', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql: 'SELECT ?x WHERE { ?x a <Nothing> }' },
    });

    expect(getText(result)).toBe('(no results)');
  });

  it('returns error on query failure', async () => {
    const mock = createMockClient({
      query: trackingAsyncFn(async () => { throw new Error('SPARQL syntax error'); }),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql: 'BAD QUERY' },
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('SPARQL syntax error');
  });
});

describe('custom context graph', () => {
  it('uses custom context graph when registerTools is called with one', async () => {
    const mock = createMockClient();
    const server = new McpServer({ name: 'custom-test', version: '0.0.1' });
    registerTools(server, async () => mock, 'my-custom-paranet');

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });

    expect((mock.createContextGraph as TrackingFn<unknown>).calls[0]).toEqual([
      'my-custom-paranet',
      expect.any(String),
      expect.any(String),
    ]);
    expect((mock.subscribe as TrackingFn<unknown>).calls[0]).toEqual(['my-custom-paranet']);
  });
});
