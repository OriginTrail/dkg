import { describe, it, expect, beforeEach } from 'vitest';
import { DkgMemoryPlugin } from '../src/DkgMemoryPlugin.js';
import { DkgDaemonClient } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeApi() {
  const registeredTools: unknown[] = [];
  const registeredHooks: unknown[][] = [];
  const onCalls: unknown[][] = [];
  const logCalls = {
    info: [] as unknown[][],
    warn: [] as unknown[][],
    debug: [] as unknown[][],
  };

  const api: OpenClawPluginApi = {
    config: {},
    registerTool: (tool: unknown) => { registeredTools.push(tool); },
    registerHook: (...args: unknown[]) => { registeredHooks.push(args); },
    on: (...args: unknown[]) => { onCalls.push(args); },
    logger: {
      info: (...args: unknown[]) => { logCalls.info.push(args); },
      warn: (...args: unknown[]) => { logCalls.warn.push(args); },
      debug: (...args: unknown[]) => { logCalls.debug.push(args); },
    },
  };

  return { api, registeredTools, registeredHooks, onCalls, logCalls };
}

describe('DkgMemoryPlugin', () => {
  let client: DkgDaemonClient;
  let plugin: DkgMemoryPlugin;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    plugin = new DkgMemoryPlugin(client, { enabled: true });
  });

  it('should register dkg_memory_search and dkg_memory_import tools', () => {
    const { api, registeredTools } = makeApi();
    plugin.register(api);

    const toolNames = (registeredTools as any[]).map((t: any) => t.name);
    expect(toolNames).toContain('dkg_memory_search');
    expect(toolNames).toContain('dkg_memory_import');
  });

  it('search should return formatted results from SPARQL', async () => {
    client.query = (async () => ({
      results: {
        bindings: [
          { uri: { value: 'urn:dkg:memory:1' }, text: { value: 'TypeScript patterns' }, type: { value: 'memory' } },
          { uri: { value: 'urn:dkg:memory:2' }, text: { value: 'TypeScript testing guide' }, type: { value: 'memory' } },
        ],
      },
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const results = await plugin.search('TypeScript');

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('TypeScript patterns');
    expect(results[0].path).toContain('memory');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('search should return empty array on error', async () => {
    client.query = (async () => { throw new Error('daemon offline'); }) as any;

    const { api } = makeApi();
    plugin.register(api);
    const results = await plugin.search('anything');

    expect(results).toEqual([]);
  });

  it('readFile should return text from SPARQL result', async () => {
    client.query = (async () => ({
      results: {
        bindings: [
          { text: { value: '# MEMORY\n\nSome content here' } },
        ],
      },
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('MEMORY.md');

    expect(content).toBe('# MEMORY\n\nSome content here');
  });

  it('readFile should return null when not found', async () => {
    client.query = (async () => ({
      results: { bindings: [] },
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('nonexistent.md');

    expect(content).toBeNull();
  });

  it('status should report ready from daemon stats', async () => {
    client.getMemoryStats = (async () => ({
      initialized: true,
      messageCount: 42,
      totalTriples: 500,
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const s = await plugin.status();

    expect(s.ready).toBe(true);
    expect(s.indexedFiles).toBe(500);
  });

  it('status should report not ready on error', async () => {
    client.getMemoryStats = (async () => { throw new Error('offline'); }) as any;

    const { api } = makeApi();
    plugin.register(api);
    const s = await plugin.status();

    expect(s.ready).toBe(false);
  });

  it('dkg_memory_search tool should delegate to search()', async () => {
    client.query = (async () => ({
      results: {
        bindings: [
          { uri: { value: 'urn:1' }, text: { value: 'found it' }, type: { value: 'memory' } },
        ],
      },
    })) as any;

    const { api, registeredTools } = makeApi();
    plugin.register(api);

    const tool = (registeredTools as any[]).find((t: any) => t.name === 'dkg_memory_search');
    expect(tool).toBeTruthy();

    const result = await tool.execute('call-1', { query: 'test query' });
    expect(result.content[0].text).toContain('found it');
  });

  it('search should include short keywords like "UI" and "AI"', async () => {
    const queryCalls: unknown[][] = [];
    client.query = (async (...args: unknown[]) => {
      queryCalls.push(args);
      return {
        results: {
          bindings: [
            { uri: { value: 'urn:1' }, text: { value: 'UI patterns' }, type: { value: 'memory' } },
          ],
        },
      };
    }) as any;

    const { api } = makeApi();
    plugin.register(api);
    const results = await plugin.search('UI');

    expect(results).toHaveLength(1);
    const sparql = queryCalls[0][0] as string;
    expect(sparql).toContain('ui');
  });

  it('search should generate SPARQL matching dkg:ImportedMemory', async () => {
    const queryCalls: unknown[][] = [];
    client.query = (async (...args: unknown[]) => {
      queryCalls.push(args);
      return { results: { bindings: [] } };
    }) as any;

    const { api } = makeApi();
    plugin.register(api);
    await plugin.search('test search');

    const sparql = queryCalls[0][0] as string;
    expect(sparql).toContain('ImportedMemory');
  });

  it('search should query shared memory graph with includeSharedMemory: true', async () => {
    const queryCalls: unknown[][] = [];
    client.query = (async (...args: unknown[]) => {
      queryCalls.push(args);
      return { results: { bindings: [] } };
    }) as any;

    const { api } = makeApi();
    plugin.register(api);
    await plugin.search('test');

    const opts = queryCalls[0][1];
    expect(opts).toEqual(
      expect.objectContaining({
        contextGraphId: 'agent-memory',
        includeSharedMemory: true,
      }),
    );
  });

  it('readFile should query shared memory graph with includeSharedMemory: true', async () => {
    const queryCalls: unknown[][] = [];
    client.query = (async (...args: unknown[]) => {
      queryCalls.push(args);
      return { results: { bindings: [] } };
    }) as any;

    const { api } = makeApi();
    plugin.register(api);
    await plugin.readFile('MEMORY.md');

    const opts = queryCalls[0][1];
    expect(opts).toEqual(
      expect.objectContaining({
        contextGraphId: 'agent-memory',
        includeSharedMemory: true,
      }),
    );
  });

  it('search should handle DKG daemon N-Triples binding format', async () => {
    client.query = (async () => ({
      result: {
        bindings: [
          { uri: 'urn:dkg:memory:file:MEMORY.md', text: '"PostgreSQL is the preferred database"', type: '"memory"' },
        ],
      },
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const results = await plugin.search('database');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('PostgreSQL is the preferred database');
    expect(results[0].path).toContain('memory');
    expect(results[0].path).toContain('urn:dkg:memory:file:MEMORY.md');
    expect(results[0].score).toBe(1);
  });

  it('readFile should handle DKG daemon N-Triples binding format', async () => {
    client.query = (async () => ({
      result: {
        bindings: [
          { text: '"# MEMORY\\nContent here"' },
        ],
      },
    })) as any;

    const { api } = makeApi();
    plugin.register(api);
    const content = await plugin.readFile('MEMORY.md');

    expect(content).toBe('# MEMORY\nContent here');
  });

  it('search should escape special characters in keywords', async () => {
    const queryCalls: unknown[][] = [];
    client.query = (async (...args: unknown[]) => {
      queryCalls.push(args);
      return { results: { bindings: [] } };
    }) as any;

    const { api } = makeApi();
    plugin.register(api);
    await plugin.search('test "injection');

    const sparql = queryCalls[0][0] as string;
    expect(sparql).toContain('\\"injection');
  });
});
