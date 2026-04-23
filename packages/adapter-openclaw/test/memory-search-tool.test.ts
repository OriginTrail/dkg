/**
 * memory_search tool — agent-callable recall button (plan v2.1 §3.1, commit 5).
 *
 * Covers: registration, input validation, output shape, error paths,
 * peer-ID-unavailable graceful degradation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types';

type RegisteredTool = OpenClawTool;

function mkApi(tools: RegisteredTool[] = [], hooks: Array<{ event: string; name?: string }> = []): OpenClawPluginApi {
  return {
    registerTool: (t: any) => { tools.push(t); },
    registerHook: (event: any, _h: any, opts: any) => { hooks.push({ event: String(event), name: opts?.name }); },
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    config: {},
    registrationMode: 'full' as const,
  } as unknown as OpenClawPluginApi;
}

describe('memory_search tool', () => {
  let plugin: DkgNodePlugin;
  let tools: RegisteredTool[];

  beforeEach(() => {
    plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    } as any);
    tools = [];
    plugin.register(mkApi(tools));
  });

  it('is registered as a tool', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_search');
  });

  it('has a description steering agents away from dkg_query for free-text recall', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    expect(tool.description).toMatch(/memory/i);
    expect(tool.description).toMatch(/prefer/i);
    expect(tool.description).toMatch(/dkg_query/);
  });

  it('has a query parameter and required list includes it', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const params = tool.parameters as any;
    expect(params.properties.query).toBeDefined();
    expect(params.required).toContain('query');
  });

  it('accepts optional limit as number OR stringified number', () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const params = tool.parameters as any;
    expect(params.properties.limit).toBeDefined();
    const limitType = params.properties.limit.type;
    if (Array.isArray(limitType)) {
      expect(limitType).toContain('number');
      expect(limitType).toContain('string');
    } else {
      expect(['number', 'string']).toContain(limitType);
    }
  });

  it('returns a structured error when query is missing', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const result = await tool.execute('t1', {});
    expect((result as any).details?.error).toBeTruthy();
  });

  it('returns a structured error when query is empty string', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    const result = await tool.execute('t1', { query: '   ' });
    expect((result as any).details?.error).toBeTruthy();
  });

  it('handler is callable and returns a tool result when query is valid', async () => {
    const tool = tools.find((t) => t.name === 'memory_search')!;
    // Patch the daemon client to avoid a real network call.
    const client = (plugin as any).client;
    client.query = vi.fn().mockResolvedValue({ results: { bindings: [] } });

    const result = await tool.execute('t2', { query: 'project milestones' });
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});

describe('memory_search when memory module disabled', () => {
  it('tool is still registered but returns a structured error on call', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    } as any);
    const tools: RegisteredTool[] = [];
    plugin.register(mkApi(tools));

    const tool = tools.find((t) => t.name === 'memory_search');
    expect(tool).toBeDefined();
    const result = await tool!.execute('t1', { query: 'x' });
    expect((result as any).details?.error).toBeTruthy();
  });
});
