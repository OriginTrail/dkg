import { describe, it, expect, beforeEach } from 'vitest';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('dkg_memory_search — multi-layer fan-out + trust-tier dedup', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerMemorySearchTool(server.asMcpServer(), client.asDkgClient(), makeConfig({ defaultProject: null }));
  });

  it('registers the dkg_memory_search tool', () => {
    expect(server.tools.has('dkg_memory_search')).toBe(true);
  });

  it('fan-out covers 3 layers without projectId (agent-context only)', async () => {
    // Same matching text written to both WM and SWM of agent-context. The
    // SWM hit's trust tier is higher and must win the dedup.
    const text = 'tree-sitter parses python files incrementally for ide tooling';
    client.memoryFixtures.set('agent-context::working-memory', [
      { uri: { value: 'urn:doc:1' }, text: { value: text } },
    ]);
    client.memoryFixtures.set('agent-context::shared-working-memory', [
      { uri: { value: 'urn:doc:1' }, text: { value: text } },
    ]);
    // VM has no hit — confirms that a layer with zero rows still gets
    // queried (and reported in the breakdown).

    const result = await server.call('dkg_memory_search', { query: 'tree-sitter parses' });
    expect(result.isError).toBeFalsy();

    const text0 = result.content[0].text;
    // Layer breakdown must mention all three agent-context layers.
    expect(text0).toMatch(/agent-context-wm:1/);
    expect(text0).toMatch(/agent-context-swm:1/);
    expect(text0).toMatch(/agent-context-vm:0/);
    // Query was fanned out 3 times.
    expect(client.queryCalls).toHaveLength(3);
    // Exactly one hit after dedup (SWM ranks above WM for the same uri).
    expect(text0).toMatch(/1 hit\(s\)/);
    expect(text0).toMatch(/SWM/);
  });

  it('fan-out covers 6 layers when projectId is supplied', async () => {
    client.memoryFixtures.set('proj-x::verified-memory', [
      { uri: { value: 'urn:doc:vm' }, text: { value: 'highly verified content about tree-sitter parsers' } },
    ]);
    const result = await server.call('dkg_memory_search', { query: 'tree-sitter parsers', projectId: 'proj-x' });
    expect(result.isError).toBeFalsy();
    expect(client.queryCalls).toHaveLength(6);
    expect(result.content[0].text).toMatch(/project-vm:1/);
    expect(result.content[0].text).toMatch(/proj-x · VM/);
  });

  it('fan-out covers project layers when a default project is pinned', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient();
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: 'pinned-cg' }));

    const result = await localServer.call('dkg_memory_search', { query: 'tree-sitter parsers' });

    expect(result.isError).toBeFalsy();
    expect(localClient.queryCalls).toHaveLength(6);
    expect(localClient.queryCalls.filter((call) => call.contextGraphId === 'pinned-cg')).toHaveLength(3);
  });

  it('applies subGraphName only to project context graph fan-out', async () => {
    const result = await server.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      projectId: 'proj-x',
      subGraphName: 'imports',
    });
    expect(result.isError).toBeFalsy();
    expect(client.queryCalls).toHaveLength(6);

    const agentCalls = client.queryCalls.filter((call) => call.contextGraphId === 'agent-context');
    const projectCalls = client.queryCalls.filter((call) => call.contextGraphId === 'proj-x');
    expect(agentCalls).toHaveLength(3);
    expect(projectCalls).toHaveLength(3);
    for (const call of agentCalls) {
      expect(call.subGraphName).toBeUndefined();
    }
    for (const call of projectCalls) {
      expect(call.subGraphName).toBe('imports');
    }
  });

  it('returns a tool error when a project-scoped subGraphName query fails', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient({
      query: async function (this: FakeClient, args: Record<string, unknown>) {
        if (args.subGraphName) {
          throw new Error('Unknown sub-graph: imports');
        }
        const cgId = String(args.contextGraphId ?? '');
        const view = String(args.view ?? 'working-memory');
        return { bindings: this.memoryFixtures.get(`${cgId}::${view}`) ?? [] };
      } as never,
    });
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: null }));

    const result = await localServer.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      projectId: 'proj-x',
      subGraphName: 'imports',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/subGraphName "imports".*Unknown sub-graph: imports/i);
    expect(localClient.queryCalls.filter((call) => call.subGraphName === 'imports').length).toBeGreaterThan(0);
  });

  it('returns a tool error for camel-case subGraphName daemon validation failures', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient({
      query: async function (this: FakeClient, args: Record<string, unknown>) {
        if (args.subGraphName) {
          throw new Error('subGraphName requires contextGraphId');
        }
        const cgId = String(args.contextGraphId ?? '');
        const view = String(args.view ?? 'working-memory');
        return { bindings: this.memoryFixtures.get(`${cgId}::${view}`) ?? [] };
      } as never,
    });
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: null }));

    const result = await localServer.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      projectId: 'proj-x',
      subGraphName: 'imports',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/subGraphName "imports".*subGraphName requires contextGraphId/i);
  });

  it('keeps partial-success behavior for generic project-scoped subGraphName failures', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient({
      query: async function (this: FakeClient, args: Record<string, unknown>) {
        if (args.subGraphName) {
          throw new Error('fetch failed');
        }
        const cgId = String(args.contextGraphId ?? '');
        const view = String(args.view ?? 'working-memory');
        return { bindings: this.memoryFixtures.get(`${cgId}::${view}`) ?? [] };
      } as never,
    });
    localClient.memoryFixtures.set('agent-context::shared-working-memory', [
      { uri: { value: 'urn:agent:note' }, text: { value: 'tree-sitter parsers from agent memory' } },
    ]);
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: null }));

    const result = await localServer.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      projectId: 'proj-x',
      subGraphName: 'imports',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/1 hit\(s\)/);
    expect(result.content[0].text).toMatch(/agent-context/);
  });

  it('applies subGraphName to the pinned default project when projectId is omitted', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient();
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: 'pinned-cg' }));

    const result = await localServer.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      subGraphName: 'imports',
    });

    expect(result.isError).toBeFalsy();
    const agentCalls = localClient.queryCalls.filter((call) => call.contextGraphId === 'agent-context');
    const projectCalls = localClient.queryCalls.filter((call) => call.contextGraphId === 'pinned-cg');
    expect(agentCalls).toHaveLength(3);
    expect(projectCalls).toHaveLength(3);
    for (const call of agentCalls) {
      expect(call.subGraphName).toBeUndefined();
    }
    for (const call of projectCalls) {
      expect(call.subGraphName).toBe('imports');
    }
  });

  it('returns a tool error when subGraphName is supplied without any project scope', async () => {
    const result = await server.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      subGraphName: 'imports',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/subGraphName.*projectId.*default project/i);
    expect(client.queryCalls).toHaveLength(0);
  });

  it('returns a tool error when subGraphName is supplied with an agent-context project URI', async () => {
    const result = await server.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      projectId: 'did:dkg:context-graph:agent-context',
      subGraphName: 'imports',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/subGraphName.*projectId/i);
    expect(client.queryCalls).toHaveLength(0);

    const localServer = new FakeServer();
    const localClient = new FakeClient();
    registerMemorySearchTool(
      localServer.asMcpServer(),
      localClient.asDkgClient(),
      makeConfig({ defaultProject: 'did:dkg:context-graph:agent-context' }),
    );
    const pinned = await localServer.call('dkg_memory_search', {
      query: 'tree-sitter parsers',
      subGraphName: 'imports',
    });
    expect(pinned.isError).toBe(true);
    expect(localClient.queryCalls).toHaveLength(0);
  });

  it('VM hit collapses an SWM hit on the same entity URI (trust tier ordering: VM > SWM > WM)', async () => {
    const text = 'agreed-on architectural decision about staking adapter v2';
    client.memoryFixtures.set('agent-context::working-memory', [
      { uri: { value: 'urn:dec:1' }, text: { value: text } },
    ]);
    client.memoryFixtures.set('agent-context::shared-working-memory', [
      { uri: { value: 'urn:dec:1' }, text: { value: text } },
    ]);
    client.memoryFixtures.set('agent-context::verified-memory', [
      { uri: { value: 'urn:dec:1' }, text: { value: text } },
    ]);

    const result = await server.call('dkg_memory_search', { query: 'staking adapter' });
    expect(result.isError).toBeFalsy();
    const text0 = result.content[0].text;
    // Three raw hits across layers, but only ONE survives dedup.
    expect(text0).toMatch(/agent-context-wm:1, agent-context-swm:1, agent-context-vm:1/);
    expect(text0).toMatch(/1 hit\(s\)/);
    // The single survivor is the VM tier with weight 1.30 — the
    // canonical signal that the trust ranker stayed coherent.
    expect(text0).toMatch(/VM · weight=1\.30/);
    // No SWM/WM tier marker should leak into the surviving hit line.
    const hitBlock = text0.split('### 1.')[1] ?? '';
    expect(hitBlock).not.toMatch(/SWM · weight=1\.15/);
    expect(hitBlock).not.toMatch(/WM · weight=1\.00/);
  });

  it('rejects a query shorter than 2 characters at the schema layer', async () => {
    await expect(server.call('dkg_memory_search', { query: 'a' })).rejects.toThrow();
  });

  it('returns a backend-not-ready error when the daemon cannot resolve agent identity', async () => {
    const localServer = new FakeServer();
    const localClient = new FakeClient({
      getAgentIdentity: async () => ({}),
    });
    registerMemorySearchTool(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig({ defaultProject: null }));

    const result = await localServer.call('dkg_memory_search', { query: 'anything goes here' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/backend not ready/);
  });

  it('passes the raw peerId (not DID form) to the daemon for WM-view routing', async () => {
    client.agentIdentity = {
      peerId: 'peer-raw-abc',
      agentAddress: 'did:dkg:agent:peer-raw-abc',
    };
    client.memoryFixtures.set('agent-context::working-memory', [
      { uri: { value: 'urn:x' }, text: { value: 'this snippet is plenty long to clear the 20-char floor for matching' } },
    ]);
    await server.call('dkg_memory_search', { query: 'snippet plenty' });
    // Every fan-out call must carry the raw peerId, not the DID form —
    // the DID prefix routes WM into a non-existent namespace and
    // silently zeroes out hits (the regression this guards).
    for (const call of client.queryCalls) {
      expect(call.agentAddress).toBe('peer-raw-abc');
      expect(String(call.agentAddress)).not.toMatch(/^did:/);
    }
  });

  it('respects the SKILL.md §6.3 6-element combined-string layer contract', async () => {
    client.memoryFixtures.set('agent-context::working-memory', [
      { uri: { value: 'urn:wm-only' }, text: { value: 'only working-memory hit, no other layers see this snippet' } },
    ]);
    const result = await server.call('dkg_memory_search', { query: 'working-memory snippet' });
    expect(result.isError).toBeFalsy();
    // Render-time projection: contextGraphId · TIER (CG separated from
    // tier in the rendered text, but the underlying Hit.layer field is
    // still the 6-element combined string per SKILL §6.3).
    expect(result.content[0].text).toMatch(/agent-context · WM/);
  });
});
