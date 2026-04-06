import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgMemoryPlugin } from '../src/DkgMemoryPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeApi(): OpenClawPluginApi {
  return {
    config: {},
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
}

describe('DkgMemoryPlugin', () => {
  let client: DkgDaemonClient;
  let plugin: DkgMemoryPlugin;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    plugin = new DkgMemoryPlugin(client, { enabled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register dkg_memory_search and dkg_memory_import tools', () => {
    const api = makeApi();
    plugin.register(api);

    const calls = (api.registerTool as any).mock.calls;
    const toolNames = calls.map((c: any) => c[0].name);
    expect(toolNames).toContain('dkg_memory_search');
    expect(toolNames).toContain('dkg_memory_import');
  });

  it('search should return formatted results from SPARQL', async () => {
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: {
        bindings: [
          { uri: { value: 'urn:dkg:memory:1' }, text: { value: 'TypeScript patterns' }, type: { value: 'memory' } },
          { uri: { value: 'urn:dkg:memory:2' }, text: { value: 'TypeScript testing guide' }, type: { value: 'memory' } },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);
    const results = await plugin.search('TypeScript');

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('TypeScript patterns');
    expect(results[0].path).toContain('memory');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('search should return empty array on error', async () => {
    vi.spyOn(client, 'query').mockRejectedValueOnce(new Error('daemon offline'));

    const api = makeApi();
    plugin.register(api);
    const results = await plugin.search('anything');

    expect(results).toEqual([]);
  });

  it('readFile should return text from SPARQL result', async () => {
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: {
        bindings: [
          { text: { value: '# MEMORY\n\nSome content here' } },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('MEMORY.md');

    expect(content).toBe('# MEMORY\n\nSome content here');
  });

  it('readFile should return null when not found', async () => {
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: { bindings: [] },
    });

    const api = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('nonexistent.md');

    expect(content).toBeNull();
  });

  it('status should report ready from daemon stats', async () => {
    vi.spyOn(client, 'getMemoryStats').mockResolvedValueOnce({
      initialized: true,
      messageCount: 42,
      totalTriples: 500,
    });

    const api = makeApi();
    plugin.register(api);
    const s = await plugin.status();

    expect(s.ready).toBe(true);
    expect(s.indexedFiles).toBe(500);
  });

  it('status should report not ready on error', async () => {
    vi.spyOn(client, 'getMemoryStats').mockRejectedValueOnce(new Error('offline'));

    const api = makeApi();
    plugin.register(api);
    const s = await plugin.status();

    expect(s.ready).toBe(false);
  });

  it('dkg_memory_search tool should delegate to search()', async () => {
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: {
        bindings: [
          { uri: { value: 'urn:1' }, text: { value: 'found it' }, type: { value: 'memory' } },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);

    const toolCall = (api.registerTool as any).mock.calls.find((c: any) => c[0].name === 'dkg_memory_search');
    expect(toolCall).toBeTruthy();

    const tool = toolCall[0];
    const result = await tool.execute('call-1', { query: 'test query' });
    expect(result.content[0].text).toContain('found it');
  });

  it('search should include short keywords like "UI" and "AI"', async () => {
    const querySpy = vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: {
        bindings: [
          { uri: { value: 'urn:1' }, text: { value: 'UI patterns' }, type: { value: 'memory' } },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);
    const results = await plugin.search('UI');

    expect(results).toHaveLength(1);
    // Verify the SPARQL query includes the short keyword
    const sparql = querySpy.mock.calls[0][0];
    expect(sparql).toContain('ui');
  });

  it('search should generate SPARQL matching dkg:ImportedMemory', async () => {
    const querySpy = vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: { bindings: [] },
    });

    const api = makeApi();
    plugin.register(api);
    await plugin.search('test search');

    const sparql = querySpy.mock.calls[0][0];
    expect(sparql).toContain('ImportedMemory');
  });

  it('search should query shared memory graph with includeSharedMemory: true', async () => {
    const querySpy = vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: { bindings: [] },
    });

    const api = makeApi();
    plugin.register(api);
    await plugin.search('test');

    const opts = querySpy.mock.calls[0][1];
    expect(opts).toEqual(
      expect.objectContaining({
        contextGraphId: 'agent-memory',
        includeSharedMemory: true,
      }),
    );
  });

  it('readFile should query shared memory graph with includeSharedMemory: true', async () => {
    const querySpy = vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: { bindings: [] },
    });

    const api = makeApi();
    plugin.register(api);
    await plugin.readFile('MEMORY.md');

    const opts = querySpy.mock.calls[0][1];
    expect(opts).toEqual(
      expect.objectContaining({
        contextGraphId: 'agent-memory',
        includeSharedMemory: true,
      }),
    );
  });

  it('search should handle DKG daemon N-Triples binding format', async () => {
    // DKG daemon returns raw N-Triples literals, not { value: "..." } objects
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      result: {
        bindings: [
          { uri: 'urn:dkg:memory:file:MEMORY.md', text: '"PostgreSQL is the preferred database"', type: '"memory"' },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);
    const results = await plugin.search('database');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('PostgreSQL is the preferred database');
    expect(results[0].path).toContain('memory');
    expect(results[0].path).toContain('urn:dkg:memory:file:MEMORY.md');
    expect(results[0].score).toBe(1);
  });

  it('readFile should handle DKG daemon N-Triples binding format', async () => {
    vi.spyOn(client, 'query').mockResolvedValueOnce({
      result: {
        bindings: [
          { text: '"# MEMORY\\nContent here"' },
        ],
      },
    });

    const api = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('MEMORY.md');

    expect(content).toBe('# MEMORY\nContent here');
  });

  it('search should escape special characters in keywords', async () => {
    const querySpy = vi.spyOn(client, 'query').mockResolvedValueOnce({
      results: { bindings: [] },
    });

    const api = makeApi();
    plugin.register(api);
    await plugin.search('test "injection');

    const sparql = querySpy.mock.calls[0][0];
    // The double-quote in the keyword should be escaped with backslash
    expect(sparql).toContain('\\"injection');
  });
});
