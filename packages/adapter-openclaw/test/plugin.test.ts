import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { homedir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { toEip55Checksum } from '@origintrail-official/dkg-core';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { DkgChannelPlugin } from '../src/DkgChannelPlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

describe('DkgNodePlugin', () => {
  it('can be instantiated with default config', () => {
    const plugin = new DkgNodePlugin();
    expect(plugin).toBeDefined();
  });

  it('can be instantiated with custom config', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9999',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(plugin).toBeDefined();
  });

  it('bootstraps resolver state even when slot is owned by another plugin (R10.2)', async () => {
    // Pre-fix: when memory slot was owned by a different plugin, the
    // resolver bootstrap (`memoryResolverApi = api` + `refreshMemoryResolverState`)
    // was inside the slot-registered branch and got skipped. The
    // memory_search tool was still exposed but stuck in a permanent
    // "backend not ready" response forever (no peer ID, no CG cache).
    // Fix moves bootstrap OUT, runs whenever memory module is enabled.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    const mockApi = {
      config: { plugins: { slots: { memory: 'some-other-memory-plugin' } } },
      registrationMode: 'full' as const,
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/status')) return { ok: true, status: 200, json: async () => ({ peerId: 'p-r102' }) } as Response;
      if (url.includes('/api/context-graph/list')) return { ok: true, status: 200, json: async () => ({ contextGraphs: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as any;
    try {
      plugin.register(mockApi);
      // Slot owned by another plugin → registerMemoryCapability never called.
      expect(mockApi.registerMemoryCapability).not.toHaveBeenCalled();
      // But resolver bootstrap MUST still happen so memory_search works
      // against the daemon directly. Wait for the async refresh to settle.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect((plugin as any).memoryResolverApi).toBe(mockApi);
      expect((plugin as any).nodePeerId).toBe('p-r102');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('registers session_end hook and all exported tools via register()', () => {
    const plugin = new DkgNodePlugin();
    const registeredHooks: Array<{ event: string; name?: string }> = [];
    const registeredTools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: (event, _handler, opts) => registeredHooks.push({ event, name: opts?.name }),
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    // T7 — `session_end` is now routed through `HookSurface.install('legacy', ...)`
    // which uses the canonical `dkg-${event}` naming convention.
    expect(registeredHooks).toContainEqual({ event: 'session_end', name: 'dkg-session_end' });

    const toolNames = registeredTools.map(t => t.name);
    // Existing active tools
    expect(toolNames).toContain('dkg_status');
    expect(toolNames).toContain('dkg_wallet_balances');
    expect(toolNames).toContain('dkg_list_context_graphs');
    expect(toolNames).toContain('dkg_context_graph_create');
    expect(toolNames).toContain('dkg_context_graph_invite');
    expect(toolNames).toContain('dkg_participant_add');
    expect(toolNames).toContain('dkg_participant_remove');
    expect(toolNames).toContain('dkg_participant_list');
    expect(toolNames).toContain('dkg_join_request_list');
    expect(toolNames).toContain('dkg_join_request_approve');
    expect(toolNames).toContain('dkg_join_request_reject');
    expect(toolNames).toContain('dkg_subscribe');
    expect(toolNames).toContain('dkg_publish');
    expect(toolNames).toContain('dkg_query');
    expect(toolNames).toContain('dkg_find_agents');
    expect(toolNames).toContain('dkg_send_message');
    expect(toolNames).toContain('dkg_read_messages');
    expect(toolNames).toContain('dkg_invoke_skill');
    // 10 new tools from PR #254 (assertion lifecycle + sub-graph management + SWM→VM publish)
    expect(toolNames).toContain('dkg_assertion_create');
    expect(toolNames).toContain('dkg_assertion_write');
    expect(toolNames).toContain('dkg_assertion_promote');
    expect(toolNames).toContain('dkg_assertion_discard');
    expect(toolNames).toContain('dkg_assertion_import_file');
    expect(toolNames).toContain('dkg_assertion_query');
    expect(toolNames).toContain('dkg_assertion_history');
    expect(toolNames).toContain('dkg_sub_graph_create');
    expect(toolNames).toContain('dkg_sub_graph_list');
    expect(toolNames).toContain('dkg_shared_memory_publish');
    // Legacy V9 paranet aliases are removed as of v10-rc.
    expect(toolNames).not.toContain('dkg_list_paranets');
    expect(toolNames).not.toContain('dkg_paranet_create');
    // memory_search added by this feature branch (W2 — agent-callable recall button).
    expect(toolNames).toContain('memory_search');
    // 28 from main (originals + assertion/subgraph/SWM/CG-registration tools) + 1 memory_search = 29
    expect(registeredTools.length).toBe(29);
  });

  it('new dkg_assertion_* and dkg_sub_graph_* tools have the expected schema shape', () => {
    const plugin = new DkgNodePlugin();
    const registeredTools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    const byName = new Map(registeredTools.map(t => [t.name, t] as const));

    const expectRequired = (name: string, required: string[]) => {
      const tool = byName.get(name);
      expect(tool, `${name} should be registered`).toBeTruthy();
      const props = tool!.parameters.properties;
      for (const key of required) {
        expect(props, `${name}.${key} should be declared in parameters.properties`).toHaveProperty(key);
      }
      expect(tool!.parameters.required).toEqual(expect.arrayContaining(required));
    };

    expectRequired('dkg_assertion_create', ['context_graph_id', 'name']);
    expectRequired('dkg_context_graph_invite', ['context_graph_id', 'peer_id']);
    expectRequired('dkg_participant_add', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_remove', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_list', ['context_graph_id']);
    expectRequired('dkg_join_request_list', ['context_graph_id']);
    expectRequired('dkg_join_request_approve', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_join_request_reject', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_assertion_write', ['context_graph_id', 'name', 'quads']);
    expectRequired('dkg_assertion_promote', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_discard', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_import_file', ['context_graph_id', 'name', 'file_path']);
    expectRequired('dkg_assertion_query', ['context_graph_id', 'name']);
    expectRequired('dkg_assertion_history', ['context_graph_id', 'name']);
    expectRequired('dkg_sub_graph_create', ['context_graph_id', 'sub_graph_name']);
    expectRequired('dkg_sub_graph_list', ['context_graph_id']);
    expectRequired('dkg_shared_memory_publish', ['context_graph_id']);

    // dkg_shared_memory_publish must declare `sub_graph_name` so agents that
    // create/write/promote into a sub-graph can publish the promoted data
    // through the same sub-graph instead of hitting the root SWM graph.
    const publishProps = byName.get('dkg_shared_memory_publish')!.parameters.properties;
    expect(publishProps).toHaveProperty('sub_graph_name');
    expect(publishProps.sub_graph_name.type).toBe('string');
    expect(publishProps).toHaveProperty('register_if_needed');
    expect(publishProps.register_if_needed.type).toBe('boolean');
    expect(publishProps).toHaveProperty('reveal_on_chain');
    expect(publishProps.reveal_on_chain.type).toBe('boolean');
    expect(publishProps).toHaveProperty('access_policy');
    expect(publishProps.access_policy.type).toBe('number');

    // dkg_assertion_write.quads is an array of {subject,predicate,object}
    const writeTool = byName.get('dkg_assertion_write')!;
    expect(writeTool.parameters.properties.quads.type).toBe('array');
    expect(writeTool.parameters.properties.quads.items).toBeDefined();

    // dkg_subscribe: `include_shared_memory` is boolean-only (subscribe is a
    // catch-up/sync flag, not a memory-layer selector).
    const subSchema = byName.get('dkg_subscribe')!.parameters.properties.include_shared_memory.type;
    expect(subSchema).toBe('boolean');

    // dkg_query: `view` is a plain string — validation lives in the
    // handler, not as a JSON-schema enum. Rationale: strict-schema
    // hosts would otherwise reject typos at the boundary before the
    // handler can surface the valid-list error. Description
    // enumerates accepted values for discoverability; handler
    // enforces them.
    //
    // WM reads are supported: the handler defaults `agent_address` to
    // this node's peerId (matches the memory plugin's default from
    // `memorySessionResolver.getDefaultAgentAddress`). Callers in
    // multi-agent deployments can override with an explicit
    // `agent_address`.
    //
    // The legacy `include_shared_memory` boolean is removed — there
    // is no exact replacement because the old `true` path queried
    // the data graph ∪ SWM (union), which no single `view` reproduces.
    const queryProps = byName.get('dkg_query')!.parameters.properties;
    expect(queryProps).not.toHaveProperty('include_shared_memory');
    expect(queryProps.view.type).toBe('string');
    expect(queryProps.view).not.toHaveProperty('enum');
    // Description advertises all three layers.
    expect(queryProps.view.description).toContain('working-memory');
    expect(queryProps.view.description).toContain('shared-working-memory');
    expect(queryProps.view.description).toContain('verified-memory');
    // agent_address is exposed as an optional tool param for WM targeting.
    expect(queryProps.agent_address.type).toBe('string');
    expect(queryProps.agent_address.description).toMatch(/working-memory/i);

    const inviteTool = byName.get('dkg_context_graph_invite')!;
    expect(inviteTool.description).toMatch(/primary user-facing deliverable/i);
    expect(inviteTool.description).toMatch(/paste into Join/i);

    const addParticipantTool = byName.get('dkg_participant_add')!;
    expect(addParticipantTool.description).toMatch(/allowlisting alone is not the full UI join flow/i);
  });

  // ---------------------------------------------------------------------------
  // Handler-level parameter drift guards: for each new tool, invoke
  // `tool.execute(snakeCaseArgs)` with a mocked fetch and assert the daemon
  // receives the exact camelCase body / query-string keys the route handlers
  // in packages/cli/src/daemon.ts destructure. This catches
  // snake_case → camelCase drift at the handler boundary — the same class of
  // bug that cost PR A multiple review rounds.
  // ---------------------------------------------------------------------------

  describe('handler-level drift guards: snake_case args → camelCase daemon body', () => {
    const setupPluginWithFetch = (response: unknown = {}) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      return { fetchMock, plugin, byName };
    };

    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('dkg_assertion_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      await byName.get('dkg_assertion_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'chat-turns',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        name: 'chat-turns',
        subGraphName: 'protocols',
      });
    });

    it('dkg_context_graph_invite forwards snake_case → camelCase body', async () => {
      const statusResponse = {
        peerId: '12D3Kooself',
        multiaddrs: [
          '/ip4/127.0.0.1/tcp/9201/p2p/12D3Kooself',
          '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself',
        ],
      };
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/status') {
          return new Response(JSON.stringify(statusResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ invited: '12D3KooWfriend', contextGraphId: 'ctx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_context_graph_invite')!.execute('tc', {
        context_graph_id: 'ctx',
        peer_id: '12D3KooWfriend',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/invite');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        peerId: '12D3KooWfriend',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.peerId).toBe('12D3KooWfriend');
      expect(body.curatorMultiaddr).toBe('/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
      expect(body.inviteCode).toBe('ctx\n/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
    });

    it('dkg_participant_add forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_add')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/add-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_participant_remove forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_remove')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/remove-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_participant_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', allowedAgents: ['0xabc'] });
      await byName.get('dkg_participant_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/participants');
      expect(init.method).toBe('GET');
    });

    it('dkg_join_request_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', requests: [] });
      await byName.get('dkg_join_request_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/join-requests');
      expect(init.method).toBe('GET');
    });

    it('dkg_join_request_approve forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'approved', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_approve')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/approve-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_join_request_reject forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'rejected', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_reject')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/reject-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });

    it('dkg_assertion_write forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_assertion_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [{ subject: 'urn:a', predicate: 'urn:b', object: 'urn:c' }],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/write');
      const body = JSON.parse(init.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.subGraphName).toBe('protocols');
      expect(body.quads).toHaveLength(1);
    });

    it('dkg_assertion_promote forwards snake_case → camelCase body and rejects stray string "all"', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: ['urn:root-1', 'urn:root-2'],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/promote');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        entities: ['urn:root-1', 'urn:root-2'],
        subGraphName: 'protocols',
      });

      // Blocker guard: the previous string-"all" shortcut is gone from the public
      // tool surface. The handler now returns an error result instead of sending.
      fetchMock.mockClear();
      const bad = await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: 'all',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });

    it('dkg_assertion_promote omits entities when not supplied (daemon default kicks in)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.entities).toBeUndefined();
    });

    it('dkg_assertion_discard forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ discarded: true });
      await byName.get('dkg_assertion_discard')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'draft',
        sub_graph_name: 'scratch',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/draft/discard');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'scratch',
      });
    });

    it('dkg_assertion_query forwards snake_case → camelCase body (no sparql)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ quads: [], count: 0 });
      await byName.get('dkg_assertion_query')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/query');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', subGraphName: 'protocols' });
      expect(body).not.toHaveProperty('sparql');
    });

    it('dkg_assertion_history forwards snake_case → camelCase query params (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ createdAt: 't' });
      await byName.get('dkg_assertion_history')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        agent_address: '0xabc',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/assertion/notes/history');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(parsed.searchParams.get('agentAddress')).toBe('0xabc');
      expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
      expect(init.body).toBeUndefined();
    });

    it('dkg_assertion_import_file reads the file and forwards camelCase multipart fields (.md → text/markdown)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-test-'));
      const filePath = join(tmpDir, 'doc.md');
      writeFileSync(filePath, '# Hello\n');

      await byName.get('dkg_assertion_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
        ontology_ref: 'urn:onto',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/import-file');
      expect(init.method).toBe('POST');
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('contextGraphId')).toBe('ctx');
      // content_type was omitted but file has .md extension — handler should infer text/markdown
      expect(form.get('contentType')).toBe('text/markdown');
      expect(form.get('ontologyRef')).toBe('urn:onto');
      expect(form.get('subGraphName')).toBe('protocols');
      expect((form.get('file') as File).name).toBe('doc.md');
    });

    it('dkg_assertion_import_file infers content-type for common formats (kept in sync with CLI UPLOAD_CONTENT_TYPES)', async () => {
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const cases: Array<[string, string]> = [
        ['doc.pdf', 'application/pdf'],
        ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
        ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['page.html', 'text/html'],
        ['page.htm', 'text/html'],
        ['feed.xml', 'application/xml'],
        ['book.epub', 'application/epub+zip'],
        ['notes.txt', 'text/plain'],
        ['data.csv', 'text/csv'],
        ['config.json', 'application/json'],
      ];

      for (const [fileName, expectedMime] of cases) {
        const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
        const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-mime-'));
        const filePath = join(tmpDir, fileName);
        writeFileSync(filePath, 'dummy');
        await byName.get('dkg_assertion_import_file')!.execute('tc', {
          context_graph_id: 'ctx',
          name: 'notes',
          file_path: filePath,
        });
        const form = fetchMock.mock.calls[0][1]?.body as FormData;
        expect(form.get('contentType'), `${fileName} should infer ${expectedMime}`).toBe(expectedMime);
      }
    });

    it('dkg_assertion_import_file falls through to octet-stream for unknown extensions (no contentType form field)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-unknown-'));
      const filePath = join(tmpDir, 'blob.xyz');
      writeFileSync(filePath, 'dummy');
      await byName.get('dkg_assertion_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
      });
      const form = fetchMock.mock.calls[0][1]?.body as FormData;
      // Handler left contentType undefined → client does NOT append the form field,
      // daemon falls through to the Blob's default 'application/octet-stream' type.
      expect(form.has('contentType')).toBe(false);
    });

    it('dkg_sub_graph_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ created: 'protocols', contextGraphId: 'ctx' });
      await byName.get('dkg_sub_graph_create')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/sub-graph/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'protocols',
      });
    });

    it('dkg_sub_graph_list forwards snake_case → camelCase query param (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', subGraphs: [] });
      await byName.get('dkg_sub_graph_list')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/sub-graph/list');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(init.body).toBeUndefined();
    });

    it('dkg_shared_memory_publish forwards snake_case → camelCase body with selection="all" when omitted', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-1', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/shared-memory/publish');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', selection: 'all', clearAfter: true });
    });

    it('dkg_shared_memory_publish forwards explicit root_entities as selection array with clearAfter=false (subset safety default)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-2', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: ['urn:a', 'urn:b'],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Subset publishes default to clearAfter=false so roots NOT in `selection`
      // aren't clobbered as a side-effect of publishing a subset.
      expect(body).toEqual({ contextGraphId: 'ctx', selection: ['urn:a', 'urn:b'], clearAfter: false });
    });

    it('dkg_shared_memory_publish plumbs sub_graph_name through to subGraphName for sub-graph-scoped publishes', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kcId: 'kc-5', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Without this, an agent that created/wrote/promoted into a sub-graph
      // would publish to the root shared-memory graph instead of the sub-graph.
      expect(body.subGraphName).toBe('protocols');
      expect(body.contextGraphId).toBe('ctx');
    });

    it('dkg_shared_memory_publish can register the context graph before publish when requested', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ registered: 'ctx', onChainId: '42', txHash: '0xabc' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kcId: 'kc-7', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
        reveal_on_chain: true,
        access_policy: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:9200/api/context-graph/register');
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        id: 'ctx',
        accessPolicy: 1,
      });
      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:9200/api/shared-memory/publish');
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toEqual({ registered: 'ctx', onChainId: '42', txHash: '0xabc' });
      expect(body.kcId).toBe('kc-7');
    });

    it('dkg_shared_memory_publish ignores already-registered conflicts and still publishes', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ error: 'Context graph "ctx" is already registered on-chain (42)' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kcId: 'kc-8', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toBeUndefined();
      expect(body.kcId).toBe('kc-8');
    });

    it('dkg_shared_memory_publish validates register_if_needed and registration options locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: 'yes',
        reveal_on_chain: 'yes',
        access_policy: 3,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('register_if_needed');

      const badReveal = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        reveal_on_chain: 'yes',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(badReveal.content[0].text).toContain('reveal_on_chain');
    });

    it('dkg_shared_memory_publish rejects non-array / empty / non-string root_entities locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: 'all', // Agents must send an array, never a bare string.
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('root_entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });

    it('dkg_query explicitly rejects the v9 paranet_id field with a clear error', async () => {
      // V10-rc is the first product release; there is no v9 back-compat on the
      // public tool surface. Silently ignoring `paranet_id` would let stale v9
      // agent code run unscoped queries thinking it was scoping them — a
      // dangerous failure mode. The handler rejects the field explicitly so
      // the caller's wrong assumption surfaces instead of producing garbage.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        paranet_id: 'my-cg',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('paranet_id');
      expect(result.content[0].text).toContain('context_graph_id');
    });

    it('dkg_query rejects the legacy include_shared_memory field with a hint that names the union-semantics break', async () => {
      // The boolean was removed in favor of `view`. There is NO
      // one-line replacement: legacy `true` unioned the data graph with
      // SWM (engine wraps sparql in both and merges), which no single
      // `view` reproduces. `view: "shared-working-memory"` reads only
      // SWM and silently drops data-graph triples for `true` callers.
      // The hint must surface this break explicitly and name the HTTP
      // escape hatch for callers who need the exact union.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        include_shared_memory: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('include_shared_memory');
      expect(msg).toContain('view');
      // Surface the non-equivalence.
      expect(msg).toMatch(/no exact|no single `view`/i);
      // Name the HTTP escape hatch for callers who need the original
      // union semantics — otherwise they have no migration path at all.
      expect(msg).toContain('/api/query');
      expect(msg).toContain('includeSharedMemory');
      // Also name the SWM closest-intent replacement + the omit path.
      expect(msg).toContain('shared-working-memory');
      expect(msg).toMatch(/omit/i);
    });

    it('dkg_query forwards an explicit agent_address to the daemon body for WM reads', async () => {
      // WM reads are agent-scoped; the daemon requires an agentAddress.
      // The tool exposes `agent_address` so multi-agent callers can
      // target another agent's WM namespace.
      // T48 — Post-PR-264 the address must be a syntactically valid
      // 0x-prefixed eth address; legacy peerId / short-prefix forms
      // are rejected up front (see "dkg_query rejects non-eth WM
      // agent_address" test below).
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const eth = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: eth,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe(eth);
    });

    it('dkg_query rejects a whitespace-only agent_address (same silent-namespace-swap risk as non-string)', async () => {
      // An explicitly-supplied whitespace string is still "caller meant
      // something here" — treating `"   "` as "missing" and defaulting
      // to `this.nodePeerId` would silently swap a cross-agent read for
      // a self-read, same failure mode as the non-string case.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '   ',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toMatch(/non-empty|empty/i);
    });

    it('dkg_query `view` validation uses the shared GET_VIEWS from dkg-core (no local mirror)', async () => {
      // Guard against the local VALID_VIEWS mirror being reintroduced.
      // When a view is added to core's GET_VIEWS but the adapter
      // maintains its own list, the tool silently rejects the new
      // view before the daemon can serve it. The handler must use
      // the shared constant so this class of drift can't happen.
      //
      // We verify behavior (not import graph): the error message lists
      // exactly the three views core publishes today, and a v9-removed
      // view is rejected.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'authoritative', // a REMOVED_VIEWS entry from core
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });

    it('dkg_query rejects a non-string agent_address instead of silently falling back to the node peerId', async () => {
      // Permissive hosts can pass through non-string values. If the
      // handler treated those as "missing", `view: "working-memory"`
      // would default to this node's peerId — a caller intending a
      // cross-agent WM read with a malformed value would silently get
      // the node's own WM back. Surface the bug instead: reject with
      // a clear type-error, don't leak namespaces.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 12345,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toContain('string');
    });

    it('dkg_query normalizes DID-prefixed eth agent_address for WM reads (T31/T48)', async () => {
      // T48 — Post-PR-264 WM is scoped by the daemon's eth address
      // (T31). The handler still strips the legacy `did:dkg:agent:`
      // prefix for backwards-compatibility, but the post-strip value
      // must be eth-shaped or the call is rejected (see next test).
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const eth = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: `did:dkg:agent:${eth}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe(eth);
      // Bare eth addresses must pass through unchanged.
      expect(body.agentAddress).not.toContain('did:dkg:agent:');
    });

    it('dkg_query falls back to nodePeerId when agent_address is omitted on no-keystore nodes (T57/T60)', async () => {
      // T57 — handler default for omitted agent_address must mirror
      // the resolver's `nodeAgentAddress ?? nodePeerId` priority.
      // T60 — fallback gates on `localKeystoreCheckedAndAbsent` so
      // remote-daemon (probe-skipped) doesn't silently route to
      // gateway's local peerId.
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = '12D3KooWNoKeystorePeer';
      // T60 — explicitly mark the local-keystore-confirmed-absent
      // state. Without this the resolver returns undefined on
      // remote-daemon paths.
      (plugin as any).localKeystoreCheckedAndAbsent = true;
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        // agent_address intentionally omitted
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe('12D3KooWNoKeystorePeer');
    });

    it('dkg_query refuses to fall back to nodePeerId on remote-daemon (probe-skipped) — T60', async () => {
      // T60 — On remote daemonUrl, `probeNodeAgentAddressOnce()`
      // intentionally skips the keystore read (T38), so
      // `nodeAgentAddress` stays undefined AND
      // `localKeystoreCheckedAndAbsent` stays false. The fallback
      // to gateway's local peerId would silently scope WM to a
      // namespace the remote daemon has never heard of. Handler
      // MUST error in that case so the operator sees the
      // recovery knobs surfaced.
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = '12D3KooWGatewayLocal';
      (plugin as any).localKeystoreCheckedAndAbsent = false;  // remote-daemon: probe skipped
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('agent identity');
      // Error names the recovery knobs operators should reach for.
      expect(text).toContain('DKG_AGENT_ADDRESS');
      expect(text).toContain('dkgHome');
    });

    it('dkg_query forwards peerId-form WM agent_address verbatim (T48/T53 — daemon accepts as self-alias on no-keystore nodes)', async () => {
      // T53 supersedes T48's hard-rejection. The daemon's `/api/query`
      // accepts peerId as a valid self-alias for the default agent
      // when no keystore identity exists (writes go to peerId in that
      // case via `defaultAgentAddress ?? peerId`). Adapter-side hard-
      // rejection broke a legitimate read path. Forward the value
      // verbatim and let the daemon's scope rules decide.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      // DID-wrapped peerId: legacy DID prefix stripped, peerId forwarded.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      let body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');

      // Bare peerId: passes through unchanged.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');
    });

    it('dkg_query does NOT normalize agent_address on non-WM views (it only matters for WM routing)', async () => {
      // Non-WM views don't use `agentAddress` for graph resolution —
      // leave the value untouched so other downstream uses (e.g. audit
      // logging at the daemon) see the caller's original input.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'shared-working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('did:dkg:agent:12D3KooWExamplePeerId');
    });

    it('dkg_query rejects an invalid `view` string with the list of valid layers', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'long-term-memory', // a v9 view name, removed in v10
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('view');
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });

    it('dkg_query rejects a `view` without `context_graph_id` locally (no daemon round-trip)', async () => {
      // Engine throws "view '…' requires a contextGraphId" — catch it at
      // the tool boundary so callers see a clean, tool-shaped error
      // instead of a cryptic 500 from a round-trip.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'shared-working-memory',
        // context_graph_id intentionally omitted
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('context_graph_id');
      expect(msg).toContain('shared-working-memory');
    });

    it('dkg_query description accurately describes the no-`view` routing (legacy path, not WM)', () => {
      // Documented-vs-actual: when `view` is omitted, the daemon +
      // DKGQueryEngine route through the legacy V9 data-graph path
      // (`DKGQueryEngine.query` → the `if (options?.view)` branch is
      // SKIPPED and falls through to "Legacy routing (V9 compat)"). It
      // is NOT implicit working-memory semantics, despite some stale
      // comments in the daemon hinting otherwise. This test guards the
      // tool description against re-introducing the misleading "omit
      // for WM" claim.
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      // Positive: description must call out the legacy routing for the omit case.
      expect(query.description).toMatch(/legacy/i);
      // Negative: specifically guard against re-introducing the misleading
      // "omit → WM default" phrasing. Use targeted substrings that would
      // only appear in the wrong claim, not the correct HTTP escape-hatch
      // sentence that mentions working-memory by name.
      expect(query.description).not.toMatch(/omit[^.]*default[^.]*working-memory/i);
      expect(query.description).not.toMatch(/default[^.]*WM semantics/i);
      expect(query.description).not.toMatch(/Omit `?view`? for the default/i);
    });

    it('dkg_query description steers WM reads toward current_agent_address and retries identity variants', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      const agentAddress = query.parameters.properties.agent_address as { description?: string };

      expect(query.description).toContain('current_agent_address');
      expect(query.description).toMatch(/retry alternate identity forms/i);
      expect(agentAddress.description).toContain('current_agent_address');
      // T48/T49/T53 — schema names eth-address shape as the recommended
      // form, accepts peerId as self-alias on no-keystore nodes,
      // documents the legacy `did:dkg:agent:` strip.
      expect(agentAddress.description).toMatch(/0x-prefixed eth address/i);
      expect(agentAddress.description).toMatch(/peer ID/i);
      expect(agentAddress.description).toMatch(/did:dkg:agent:/);
    });

    it('share-flow tool descriptions prefer invite code output for friend-sharing requests', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      expect(byName.get('dkg_context_graph_invite')!.description).toContain('ready-to-share invite code');
      expect(byName.get('dkg_context_graph_invite')!.description).toContain('paste into Join');
      expect(byName.get('dkg_participant_add')!.description).toContain('allowlisting alone is not the full UI join flow');
    });

    it('dkg_query forwards the `view` field to the daemon body verbatim', async () => {
      // Handler-level drift guard: the daemon's /api/query route destructures
      // `view` from the body. If we renamed the field in the handler, this
      // test catches the drift.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'verified-memory',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('verified-memory');
      expect(body.contextGraphId).toBe('my-cg');
      expect(body).not.toHaveProperty('includeSharedMemory');
    });

    it('dkg_subscribe rejects a stringified include_shared_memory (same rationale as dkg_query)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_subscribe')!.execute('tc', {
        context_graph_id: 'ctx',
        include_shared_memory: 'true',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('include_shared_memory');
      expect(result.content[0].text).toContain('boolean');
    });

    it('dkg_assertion_promote description points to dkg_shared_memory_publish as the next step', () => {
      // dkg_publish is a one-shot write-AND-publish helper. After promote the
      // data is already in SWM, so the correct finalizer is
      // dkg_shared_memory_publish — calling dkg_publish would append
      // duplicates. The promote description must steer agents correctly.
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const promote = tools.find((t) => t.name === 'dkg_assertion_promote')!;
      expect(promote.description).toContain('dkg_shared_memory_publish');
      expect(promote.description).toMatch(/NOT dkg_publish/);
    });

    it('dkg_assertion_write escapes every N-Triples ECHAR control character in literal objects', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_assertion_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [
          {
            subject: 'https://example.org/a',
            predicate: 'https://schema.org/text',
            // Includes: \n, \t, \r, ", \, \f (form-feed), \b (backspace).
            // Missing \f / \b escapes would leave raw 0x0C / 0x08 bytes in
            // the JSON body and cause strict triple-store parsers to reject
            // the literal.
            object: 'line1\nline2\tcol\rend"with quote\\and backslash\fff\bbb',
          },
        ],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe(
        '"line1\\nline2\\tcol\\rend\\"with quote\\\\and backslash\\fff\\bbb"',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // No v9 back-compat: v10-rc is the first product release. Any v9-era field
  // (`paranet_id`, stringified `include_shared_memory`, etc.) is out of scope
  // for the public tool surface. Handlers and schemas only accept the V10
  // shape. Strict JSON-schema validators and permissive hosts behave the
  // same: a stray legacy field is simply ignored (not a special-cased error),
  // and `context_graph_id` is the single source of truth on every tool that
  // needs it.
  // ---------------------------------------------------------------------------

  it('dkg_subscribe / dkg_publish / dkg_query do not advertise or honor the v9 paranet_id alias', () => {
    const plugin = new DkgNodePlugin();
    const tools: OpenClawTool[] = [];
    plugin.register({
      config: {},
      registerTool: (t) => tools.push(t),
      registerHook: () => {},
      on: () => {},
      logger: {},
    });
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    for (const name of ['dkg_subscribe', 'dkg_publish', 'dkg_query'] as const) {
      const props = byName.get(name)!.parameters.properties;
      expect(props).not.toHaveProperty('paranet_id');
    }
  });

  it('all tools have name, description, parameters, and execute', () => {
    const plugin = new DkgNodePlugin();
    const tools: OpenClawTool[] = [];

    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: (tool) => tools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('stop() is safe to call without register()', async () => {
    const plugin = new DkgNodePlugin();
    await expect(plugin.stop()).resolves.toBeUndefined();
  });

  it('T30 — capabilities.dkgPrimaryMemory / wmImportPipeline mirror actual memory-slot registration state', async () => {
    // Regression for T30: pre-fix the local-agent connect payload
    // statically advertised `dkgPrimaryMemory: true` and
    // `wmImportPipeline: true` from a frozen constant — even when
    // memory was config-disabled, or another plugin owned the slot.
    // Daemon/UI consumers would then offer DKG-backed memory actions
    // that the slot's actual owner couldn't honour. Post-fix the
    // flags are derived from `this.memoryPlugin?.isRegistered()`.
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;
    try {
      // Memory enabled → registration succeeds → flags should be true.
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: true },
      });
      const mockApi: OpenClawPluginApi = {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: vi.fn(),
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });
      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const body = JSON.parse(String(connectCall?.[1]?.body));
      expect(body.capabilities.dkgPrimaryMemory).toBe(true);
      expect(body.capabilities.wmImportPipeline).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('getClient() returns the DkgDaemonClient after register()', () => {
    const plugin = new DkgNodePlugin({ daemonUrl: 'http://example.com:9200' });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: {},
    };
    plugin.register(mockApi);
    const client = plugin.getClient();
    expect(client).toBeDefined();
    expect(client.baseUrl).toBe('http://example.com:9200');
  });

  it('registers OpenClaw through the generic local-agent endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      // Post-pivot, connect publishes the ready/bound transport upfront
      // (no follow-up PUT). syncLocalAgentIntegrationState awaits start()
      // before firing connect, so isListening is already true and
      // bridgeUrl/healthUrl/runtime.ready are all populated in this call.
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody).toMatchObject({
        id: 'openclaw',
        enabled: true,
        manifest: {
          packageName: '@origintrail-official/dkg-adapter-openclaw',
          setupEntry: './setup-entry.mjs',
        },
        metadata: {
          channelId: 'dkg-ui',
          registrationMode: 'full',
        },
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      });
      // T30 — `dkgPrimaryMemory` and `wmImportPipeline` are derived
      // from the actual memory-slot registration state. This test
      // configured `memory.enabled: false`, so the slot is NOT
      // registered and these flags MUST be false.
      expect(connectBody.capabilities).toMatchObject({
        localChat: true,
        connectFromUi: true,
        dkgPrimaryMemory: false,
        wmImportPipeline: false,
      });
      expect(connectBody.manifest).toEqual({
        packageName: '@origintrail-official/dkg-adapter-openclaw',
        setupEntry: './setup-entry.mjs',
      });
      expect(connectBody.setupEntry).toBe('./setup-entry.mjs');
      expect(connectBody.transport.kind).toBe('openclaw-channel');
      expect(connectBody.transport.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  // Issue #272: when the gateway hosts the channel routes via registerHttpRoute,
  // start() still binds the standalone bridge — but on a fallback OS-allocated
  // port if the configured one is held by the gateway. To eliminate the
  // ready-but-not-yet-bound window the daemon would otherwise see, we await
  // start() BEFORE firing the connect call. The connect publishes ready:true
  // with the actually-bound bridgeUrl/healthUrl in one shot — there is no
  // separate post-start PUT.
  it('awaits channelPlugin.start() before firing connect (gateway routes active)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;
    // Patch start() on the prototype so the spy is in place BEFORE the
    // DkgChannelPlugin instance is constructed by DkgNodePlugin.register().
    // Patching the instance after register() is too late — start() has
    // already been invoked through the await in syncLocalAgentIntegrationState.
    let resolveStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const startSpy = vi.spyOn(DkgChannelPlugin.prototype, 'start').mockImplementation(() => startGate);

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: { gateway: { port: 19789 } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);

      // Wait until start() has been invoked — proves the registration path
      // reached the await. Connect must NOT fire while start is pending.
      await vi.waitFor(() => {
        expect(startSpy).toHaveBeenCalled();
      });

      // Settle pending microtasks before the negative assertion so we don't
      // race a connect call queued after start was observed.
      await Promise.resolve();
      await Promise.resolve();
      const connectBeforeResolve = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(connectBeforeResolve).toBeUndefined();

      // Release start() — the await resolves and the connect call fires.
      resolveStart();

      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      // start() is stubbed (never actually binds), so isListening stays false.
      // The connect call fires with status:'connecting' / ready:false in this
      // case. What matters for the round-2 review is the ORDERING (start
      // awaited before connect), not the bound-port shape — the bridge-mode
      // test below exercises the real-bind path against a port:0 server and
      // asserts the ready/bridgeUrl shape.
      expect(connectBody).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:19789',
        },
        metadata: {
          transportMode: 'gateway+bridge',
        },
      });
      // No follow-up PUT — connect publishes the bound transport upfront.
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      resolveStart();
      startSpy.mockRestore();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  // Bridge-mode (fallback) path — older gateways or runtimes where
  // api.registerHttpRoute is not available. The standalone bridge binds on
  // an OS-allocated port (channel.port: 0), then connect publishes ready:true
  // with the actually-bound bridgeUrl/healthUrl. There is no follow-up PUT.
  it('publishes ready:true with the bound bridgeUrl in bridge mode (no registerHttpRoute)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: { gateway: { port: 19789 } },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        // No registerHttpRoute — fallback to standalone bridge mode.
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);

      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        metadata: {
          transportMode: 'bridge',
        },
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          healthUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/),
        },
      });

      // Confirm there's NO follow-up PUT — connect now publishes the bound
      // transport upfront. This locks the round-2 simplification: the daemon
      // never sees a transient ready:true integration whose bridgeUrl can't
      // serve traffic yet.
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('drops a stale stored gatewayUrl when the current runtime is bridge-only', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://127.0.0.1:9200',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      // Post-pivot: connect publishes ready/bound transport upfront. The
      // stale stored gatewayUrl from the GET above must be dropped because
      // the current runtime (no registerHttpRoute → bridge-only) does not
      // serve gateway routes. bridgeUrl/healthUrl reflect the actually
      // bound port from the awaited start().
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody).toMatchObject({
        id: 'openclaw',
        enabled: true,
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          healthUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/),
        },
        metadata: expect.objectContaining({
          channelId: 'dkg-ui',
          registrationMode: 'full',
          transportMode: 'bridge',
        }),
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      });
      expect(connectBody.transport.gatewayUrl).toBeUndefined();

      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(readyCall).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('recomputes gatewayUrl from current gateway config even when the port stays at the default', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://127.0.0.1:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            customBindHost: 'localhost',
            tls: { enabled: true },
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'https://localhost:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('derives the current local gatewayUrl when gateway routing is active and the current gateway object has no URL-affecting settings', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: true,
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://10.0.0.5:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            announceBonjour: true,
          },
        } as any,
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('derives the current local gatewayUrl when gateway tls config only sets enabled=false', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                gatewayUrl: 'http://10.0.0.5:18789',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            tls: { enabled: false },
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('formats IPv6 gateway hosts as valid URLs', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {
          gateway: {
            customBindHost: '::1',
            port: 18789,
          },
        },
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerHttpRoute: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://[::1]:18789',
        },
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('does not re-enable a stored OpenClaw integration when the user explicitly disconnected it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const infoCalls: unknown[][] = [];
    const info = (...args: unknown[]) => { infoCalls.push(args); };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: false,
              runtime: { status: 'disconnected', ready: false },
              metadata: { userDisabled: true },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(infoCalls.some(args => String(args[0]).includes('explicitly disconnected by the user'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('does not re-enable a legacy pre-flag disconnected OpenClaw integration on startup', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const infoCalls: unknown[][] = [];
    const info = (...args: unknown[]) => { infoCalls.push(args); };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              enabled: false,
              connectedAt: '2026-04-13T09:00:00.000Z',
              runtime: { status: 'disconnected', ready: false },
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(infoCalls.some(args => String(args[0]).includes('explicitly disconnected by the user'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('re-registers a transport-only OpenClaw record on startup', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('overwrites a stored bridgeUrl with the freshly bound port (post-pivot await-before-connect)', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            integration: {
              id: 'openclaw',
              transport: {
                kind: 'openclaw-channel',
                bridgeUrl: 'http://127.0.0.1:9201',
                healthUrl: 'http://127.0.0.1:9201/health',
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: {},
      };

      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      // Post-pivot: syncLocalAgentIntegrationState awaits start() before
      // building the connect payload, so bridgePort > 0 by the time
      // buildOpenClawTransport runs and the stored stale bridgeUrl is
      // overwritten with the freshly bound port. The stored values from the
      // GET above (port 9201) are intentionally NOT preserved on this path —
      // they would be wrong (the gateway holds 9201 in 2026.3.31).
      const connectBody = JSON.parse(String(connectCall?.[1]?.body));
      expect(connectBody.transport.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(connectBody.transport.bridgeUrl).not.toBe('http://127.0.0.1:9201');
      expect(connectBody.transport.healthUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts startup re-registration when stored OpenClaw integration state cannot be loaded', async () => {
    const originalFetch = globalThis.fetch;
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('temporary daemon outage');
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn },
      };

      plugin.register(mockApi);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      )).toBe(false);
      expect(warnCalls.some(args => String(args[0]).includes('aborting startup re-registration'))).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('reason: temporary daemon outage'))).toBe(true);
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retries startup re-registration in-process after a transient stored-state load failure', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        if (fetchCalls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length === 1) {
          throw new Error('temporary daemon outage');
        }
        return {
          ok: true,
          json: async () => ({ integration: null }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      expect(fetchCalls.some(call =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'GET',
      )).toBe(true);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(false);

      // Retry-backoff follow-up: first retry delay is now 5s (not 1s),
      // so advance by the new base delay before asserting the retry
      // fired.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchCalls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
      )).toHaveLength(2);
      expect(fetchCalls.some((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      )).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('aborting startup re-registration'))).toBe(true);
      expect(warnCalls.some(args => String(args[0]).includes('reason: temporary daemon outage'))).toBe(true);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retry backoff grows exponentially and warns only once per distinct failure reason', async () => {
    // Live-validation follow-up: prior to this change the retry loop
    // fired every 1 s with a warn-level log on every attempt, which
    // flooded the gateway log when the daemon was not yet up on cold
    // start. The fix: 5 s base delay, 2x exponential growth capped at
    // 60 s, and log dedup that emits one warn per distinct failure
    // reason with subsequent repeats at debug level.
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const warn = vi.fn();
    const debug = vi.fn();
    const info = vi.fn();
    const fakeFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('daemon cold start');
      }
      return { ok: true, json: async () => ({ ok: true, integration: { id: 'openclaw' } }) };
    });
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn, debug, info },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      const getCallCount = () =>
        fakeFetch.mock.calls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length;

      // Initial register fires one sync call.
      expect(getCallCount()).toBe(1);
      // Attempt 1 scheduled for base delay (5s). Advance 4s — still no retry.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(getCallCount()).toBe(1);
      // Cross the 5s boundary — retry #1 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(2);
      // Attempt 2 delay is 10s. Advance 9s — still no new retry.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(getCallCount()).toBe(2);
      // Cross the 10s boundary — retry #2 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(3);
      // Attempt 3 delay is 20s. Advance 19s — still no new retry.
      await vi.advanceTimersByTimeAsync(19_000);
      expect(getCallCount()).toBe(3);
      // Cross the 20s boundary — retry #3 lands.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getCallCount()).toBe(4);

      // Dedup: exactly ONE warn with this reason across all four attempts,
      // even though the sync function was called four times. The repeated
      // sync calls see the same reason and drop to debug level.
      const warnCallsWithReason = warn.mock.calls.filter((call) =>
        String(call[0]).includes('reason: daemon cold start'),
      );
      expect(warnCallsWithReason).toHaveLength(1);
      // Debug is called on every subsequent attempt from both the
      // dedup path (syncLocalAgentIntegrationState) and the catch site
      // in loadStoredOpenClawIntegration — we only assert at least 3
      // debug hits (one per extra attempt beyond the first) to keep the
      // test resilient to future log-site refactors.
      const debugCallsWithReason = debug.mock.calls.filter((call) =>
        String(call[0]).includes('daemon cold start'),
      );
      expect(debugCallsWithReason.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('retry delay caps at 60s after enough failed attempts', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/local-agent-integrations/openclaw') && init?.method === 'GET') {
        throw new Error('daemon unreachable');
      }
      return { ok: true, json: async () => ({}) };
    });
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 0 },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
      };

      plugin.register(mockApi);
      await Promise.resolve();

      const getCallCount = () =>
        fakeFetch.mock.calls.filter((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
        ).length;

      // Chew through the ramp (5s → 10s → 20s → 40s → 60s) and then
      // verify the next two attempts both fire on the 60s cap rather
      // than growing further (80s, 160s would both push past the cap).
      expect(getCallCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000); // attempt 2 lands
      await vi.advanceTimersByTimeAsync(10_000); // attempt 3 lands
      await vi.advanceTimersByTimeAsync(20_000); // attempt 4 lands
      await vi.advanceTimersByTimeAsync(40_000); // attempt 5 lands
      expect(getCallCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(60_000); // attempt 6 lands at the cap
      expect(getCallCount()).toBe(6);
      await vi.advanceTimersByTimeAsync(60_000); // attempt 7 also lands at the cap
      expect(getCallCount()).toBe(7);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('skips the stored-integration retry loop entirely when both memory and channel are disabled', async () => {
    // Live-validation follow-up: when the adapter has nothing runtime
    // to sync (both integrations disabled), the daemon fetch is pure
    // overhead and used to loop at 1 Hz. With the fix it short-circuits
    // before the first load call so cold daemons do not burn CPU or
    // log spam on metadata-only plugin loads.
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const fakeFetch = vi.fn();
    globalThis.fetch = fakeFetch;
    let plugin: DkgNodePlugin | null = null;

    try {
      plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);
      await Promise.resolve();
      // Advance a full minute — if the retry loop were active we'd see
      // multiple GETs by now.
      await vi.advanceTimersByTimeAsync(60_000);

      const getCalls = fakeFetch.mock.calls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
      );
      expect(getCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('registers the memory slot capability in setup-runtime mode on a slot-owning gateway', () => {
    // Live-validation follow-up: prior code classified setup-runtime as
    // lightweight and skipped memory-module registration entirely. That
    // left `registerMemoryCapability` unregistered on any gateway that
    // stayed in setup-runtime mode, silently disabling slot-backed
    // recall. With the fix, setup-runtime is a runtime mode — memory
    // slot registers as long as plugins.slots.memory names this adapter.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    const registerMemoryCapability = vi.fn();
    const info = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {
        plugins: {
          slots: { memory: 'adapter-openclaw' },
        },
      } as any,
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    };

    plugin.register(mockApi);

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    // Log line must include the registration mode so operators can tell
    // which pass of the gateway multi-phase init actually wired up the
    // slot.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('registerMemoryCapability called (registrationMode=setup-runtime)'),
    );
  });

  it('does NOT register the memory slot capability in setup-only or cli-metadata modes (regression guard)', () => {
    // Negative counterpart of the setup-runtime test above. Widening
    // the runtime gate was an explicit decision for setup-runtime only;
    // setup-only and cli-metadata must still skip memory registration
    // because those modes have no runtime at all and the gateway does
    // not expect tool dispatch on them.
    for (const mode of ['setup-only', 'cli-metadata'] as const) {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      const registerMemoryCapability = vi.fn();
      const mockApi: OpenClawPluginApi = {
        config: {
          plugins: { slots: { memory: 'adapter-openclaw' } },
        } as any,
        registrationMode: mode,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability,
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);

      expect(registerMemoryCapability, `mode=${mode}`).not.toHaveBeenCalled();
    }
  });

  it('setup-only registration skips tool registration but keeps the plugin bootable', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const registeredTools: OpenClawTool[] = [];
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: (tool) => registeredTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
    };

    plugin.register(mockApi);

    expect(registeredTools).toHaveLength(0);
    expect(plugin.getClient().baseUrl).toBe('http://localhost:9200');
  });

  it('R17.2 — setup-only registration must NOT construct ChatTurnWriter (no filesystem side effects)', () => {
    // Regression for R17.2: previously `ChatTurnWriter` was constructed
    // unconditionally before the `runtimeEnabled` gate, so setup-only
    // metadata-only loads still ran `mkdirSync` and read the watermark
    // file. In read-only workspaces that emitted warnings or errors
    // during what should be a side-effect-free scan. The writer must
    // now be created lazily inside the runtime-enabled branch.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(mockApi);
    expect((plugin as any).chatTurnWriter).toBeNull();
  });

  it('R24.2 — DKG-Memory prompt section is NOT installed in setup-runtime mode (tools not registered there)', () => {
    // Regression for R24.2: pre-fix, the "Prefer memory_search" prompt
    // guidance was installed on every runtime-enabled registration
    // including `setup-runtime`. But `memory_search` / `dkg_query` are
    // registered only in `full` mode (the tool-registration loop in
    // register() is `fullRuntime`-gated). So in setup-runtime the model
    // would be told to use a tool that does not exist on this phase.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('R24.2 — DKG-Memory prompt section is NOT installed when memory.enabled is false (tool would error)', () => {
    // Regression for R24.2: when memory is config-disabled, `memory_search`
    // returns "memory unavailable" and the prompt guidance is misleading.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('R24.2 — DKG-Memory prompt section IS installed in full mode with memory enabled', () => {
    // Positive control: confirms the gate is not too tight.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const call = promptSpy.mock.calls[0][0];
    expect(call.title).toBe('DKG Memory');
    expect(call.body).toContain('memory_search');
  });

  it('T6 — same-api setup-runtime → full upgrade retries previously-failed typed installs', () => {
    // Regression for T6: pre-fix, the same-api fast path in
    // `installHooksIfNeeded` only retried INTERNAL installs whose
    // previous `installedVia === 'none'`. If the gateway upgraded an
    // existing registry in place (`api.on` becomes a function on the
    // SAME api object after a setup-runtime → full transition), the
    // typed installs that recorded `installedVia: 'none'` at first
    // call stayed permanently uninstalled. W3 / W4a hooks would never
    // wire up.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    // Mutable api object — `on` is undefined initially, becomes a
    // function on the second register() call.
    const onSpy = vi.fn();
    const api: any = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'setup-runtime',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      // No `on` initially — typed installs will record 'none'.
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(api);
    // Tick 1 — typed installs failed (no api.on). onSpy not called.
    expect(onSpy).not.toHaveBeenCalled();
    const stats1 = (plugin as any).hookSurface.getDispatchStats();
    expect(stats1['typed:before_prompt_build']?.installedVia).toBe('none');
    expect(stats1['typed:agent_end']?.installedVia).toBe('none');

    // Tick 2 — same api object, but now `api.on` is available
    // (gateway upgraded the registry in place). registrationMode also
    // flipped to 'full'.
    api.on = onSpy;
    api.registrationMode = 'full';
    plugin.register(api);
    // Typed installs MUST have been retried this time.
    const events = onSpy.mock.calls.map((c: any) => c[0]);
    expect(events).toContain('before_prompt_build');
    expect(events).toContain('agent_end');
  });

  it('T31 — multi-phase init re-bind: typed hooks installed on EVERY api so emit-against-old-api still fires', async () => {
    // Regression for T31 Bug B: pre-fix, the apiChanged branch destroyed
    // the old hook surface and rebuilt against the new api. The gateway
    // re-registers our plugin on each inbound turn against fresh api
    // objects but doesn't always dispatch against the latest one — orphan
    // handlers had `installedVia=on, fireCount=0` after multiple chats.
    // Post-fix, every surface stays live; whichever api the gateway emits
    // against has a bound handler.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);

    // Two distinct api objects, each with its own `on` registry.
    const onSpy1 = vi.fn();
    const api1 = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy1,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    const onSpy2 = vi.fn();
    const api2 = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy2,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    plugin.register(api1);
    // api1 received typed-hook installs.
    const events1 = onSpy1.mock.calls.map((c: any) => c[0]);
    expect(events1).toContain('before_prompt_build');
    expect(events1).toContain('agent_end');

    // Multi-phase init: gateway hands a NEW api on the next register.
    plugin.register(api2);
    // api2 ALSO received typed-hook installs (not just the latest — both
    // are now live so whichever api the gateway dispatches against has
    // a bound wrapper).
    const events2 = onSpy2.mock.calls.map((c: any) => c[0]);
    expect(events2).toContain('before_prompt_build');
    expect(events2).toContain('agent_end');

    // Critically: api1's handlers were NOT torn down. The `allHookSurfaces`
    // set tracks both surfaces; a future emit against api1 would still
    // reach a live handler. We don't have an emit primitive in the mock
    // here, but the surface count is the load-bearing invariant.
    expect((plugin as any).allHookSurfaces.size).toBe(2);
  });

  it('T7 — session_end goes through HookSurface so stop() → register() does NOT accumulate handlers', async () => {
    // Regression for T7: pre-fix, `session_end` was registered via
    // direct `api.registerHook(...)` on every install. After
    // `stop() → register()` cycles, handlers accumulated in the
    // upstream registry (no unsubscribe primitive) and one shutdown
    // event would call `stop()` once per accumulated handler.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const registerHookSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: registerHookSpy,
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    plugin.register(mockApi);
    const sessionEndAfter1 = registerHookSpy.mock.calls.filter(
      (c: any) => c[0] === 'session_end',
    ).length;
    expect(sessionEndAfter1).toBe(1);

    // After stop() — the previously-registered session_end wrapper
    // is still in the upstream registry (no real unsubscribe), but
    // its destroyed-flag will short-circuit on fire (R21.1).
    await plugin.stop();
    plugin.register(mockApi);
    const sessionEndAfter2 = registerHookSpy.mock.calls.filter(
      (c: any) => c[0] === 'session_end',
    ).length;
    // Each register() call DOES make one new registerHook call (we
    // can't avoid that without an unsubscribe primitive), but the
    // OLD wrapper now short-circuits via its destroyed flag — so a
    // single shutdown event won't call this.stop() twice. The
    // important invariant: each register() makes exactly ONE new
    // registration, and prior wrappers are no-ops post-destroy.
    expect(sessionEndAfter2).toBe(2); // one per register, not unbounded
  });

  it('T12 — stop() resets promptSectionInstalled so a later register() reinstalls the section', async () => {
    // Regression for T12: pre-fix, `promptSectionInstalled` was a global
    // boolean on the plugin instance. After `stop() -> register()` (or
    // any api swap), the flag stayed `true` and the new gateway api
    // never received the DKG Memory prompt guidance.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const promptSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy,
    } as unknown as OpenClawPluginApi;

    plugin.register(mockApi);
    expect(promptSpy).toHaveBeenCalledTimes(1);

    await plugin.stop();
    plugin.register(mockApi);
    // Post-stop, the second register MUST install the section again
    // because the api registry was effectively reset by the stop+restart
    // cycle (and in production a different api object would be passed).
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it('T12 — apiChanged path resets promptSectionInstalled so the new api gets the section', () => {
    // Regression for T12: api swap (different api object on second
    // register) destroys the surface and rebuilds it, but pre-fix left
    // `promptSectionInstalled = true`, so the prompt section was
    // registered against the OLD api registry and never against the new.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const promptSpy1 = vi.fn();
    const api1: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy1,
    } as unknown as OpenClawPluginApi;
    plugin.register(api1);
    expect(promptSpy1).toHaveBeenCalledTimes(1);

    // Second register with a DIFFERENT api object (gateway swapped registry).
    const promptSpy2 = vi.fn();
    const api2: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: promptSpy2,
    } as unknown as OpenClawPluginApi;
    plugin.register(api2);
    // The new api MUST get the section installed against its own registry.
    expect(promptSpy2).toHaveBeenCalledTimes(1);
  });

  it('T13 — auto-recall single-flight: a second turn fired while the first is in flight skips recall', async () => {
    // Regression for T13: pre-fix, the 250ms `Promise.race` timeout in
    // `handleBeforePromptBuild` only stopped *waiting*; the underlying
    // SPARQL fan-out kept running. Successive turns fired during a slow
    // daemon would all start their own searches, amplifying load.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    // Stub the daemon so searchNarrow's underlying queries hang until
    // we explicitly release them. Track ALL pending resolvers so a
    // single release call clears every in-flight query (the searchNarrow
    // fan-out issues multiple queries per call).
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    const releaseQueries = () => { while (pendingResolvers.length) pendingResolvers.shift()!(); };
    // Give the manager a peer ID so the recall preflight doesn't early-return.
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    const event = { messages: [{ role: 'user', content: 'find something interesting' }] };
    const ctx = { sessionKey: 'test-session-1' };

    // Turn 1: hangs in searchNarrow, returns undefined after 250ms timeout.
    const turn1 = (plugin as any).handleBeforePromptBuild(event, ctx);
    // Wait for the timeout race to settle (~300ms).
    await new Promise((r) => setTimeout(r, 300));
    const result1 = await turn1;
    expect(result1).toBeUndefined();
    const queriesAfterTurn1 = queryCalls;
    expect(queriesAfterTurn1).toBeGreaterThan(0); // some queries fired

    // Turn 2: fires while turn 1's underlying queries still hang. The
    // single-flight guard MUST short-circuit before manager.searchNarrow
    // runs again, so queryCalls does NOT increase.
    const result2 = await (plugin as any).handleBeforePromptBuild(event, ctx);
    expect(result2).toBeUndefined();
    expect(queryCalls).toBe(queriesAfterTurn1); // no new queries

    // Release turn 1's hanging queries so the in-flight set clears.
    releaseQueries();
    // Wait for the underlying promise's finally hook to clear the
    // single-flight reservation. Two macrotask hops are enough — first
    // resolves the inner queries, second runs the .finally cleanup.
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50));

    // Turn 3: fires AFTER turn 1 settled. Single-flight has cleared; new
    // queries fire as normal.
    const result3 = await (plugin as any).handleBeforePromptBuild(event, ctx);
    expect(queryCalls).toBeGreaterThan(queriesAfterTurn1);

    await plugin.stop();
  });

  it('T20 — single-flight key includes projectContextGraphId; switching projects mid-conversation does NOT block recall under the old key', async () => {
    // Regression for T20: pre-fix, the single-flight key only included
    // the conversation tuple. searchNarrow's fan-out scopes through
    // the resolver's projectContextGraphId, so two recalls in the same
    // conversation but for DIFFERENT projects are semantically distinct
    // queries. If a slow recall for project A hung and the user
    // switched to project B in the same conversation, project B's
    // recall would be falsely suppressed under A's key.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    // Stub the resolver so we can flip the resolved project mid-test.
    let currentProject = 'project-A';
    (plugin as any).memorySessionResolver = {
      getSession: () => ({ projectContextGraphId: currentProject, agentAddress: '12D3KooWTestT20' }),
      getDefaultAgentAddress: () => '12D3KooWTestT20',
      listAvailableContextGraphs: () => [],
    };

    const event = { messages: [{ role: 'user', content: 'find x' }] };
    const ctx = { channelId: 'tg', accountId: 'a', conversationId: 'c', sessionKey: 'sk' };

    // Turn 1: project A — recall hangs.
    const turn1 = (plugin as any).handleBeforePromptBuild(event, ctx);
    await new Promise((r) => setTimeout(r, 300));
    await turn1;
    const queriesAfterA = queryCalls;
    expect(queriesAfterA).toBeGreaterThan(0);

    // User switches to project B in the SAME conversation.
    currentProject = 'project-B';

    // Turn 2: same ctx, different project. Pre-fix, the in-flight key
    // ignored project, so this would be suppressed. Post-fix, the
    // key includes projectCG, so B issues fresh queries.
    const turn2 = (plugin as any).handleBeforePromptBuild(event, ctx);
    await new Promise((r) => setTimeout(r, 300));
    await turn2;
    expect(queryCalls).toBeGreaterThan(queriesAfterA);

    // Cleanup.
    while (pendingResolvers.length) pendingResolvers.shift()!();
    await new Promise((r) => setTimeout(r, 50));
    await plugin.stop();
  });

  it('T24 — chatTurnWriterStateDir is updated ONLY on successful migration; failure leaves state at fallback so future register() retries', async () => {
    // Regression for T24: pre-fix, `chatTurnWriterStateDir = stateDir`
    // was set BEFORE the async migration completed. If `setStateDir`
    // failed (e.g., transient FS error), the field was already updated
    // and the next register() with the same target stateDir
    // short-circuited under the "same path" guard — never retrying.
    // Post-fix the field flips ONLY on success; failure clears the
    // separate `chatTurnWriterMigrationTarget` flag and leaves
    // `chatTurnWriterStateDir` at the old value.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t24-workspace-${Date.now()}`);
    const homeDir = `${require('os').homedir()}/.openclaw`;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiFallback: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiFallback);
      expect((plugin as any).chatTurnWriterStateDir).toBe(homeDir);

      // Force setStateDir to fail.
      const writer = (plugin as any).chatTurnWriter;
      const originalSetStateDir = writer.setStateDir.bind(writer);
      writer.setStateDir = vi.fn().mockRejectedValue(new Error('simulated migration failure'));

      const apiBetter: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiBetter);

      // Wait for the fire-and-forget setStateDir to reject.
      await new Promise((r) => setTimeout(r, 50));

      // Failure: migration target cleared, but stateDir stays at fallback.
      expect((plugin as any).chatTurnWriterStateDir).toBe(homeDir);
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);

      // A second register() with the SAME apiBetter MUST re-trigger the
      // migration (proves the failure didn't poison the retry path).
      writer.setStateDir = vi.fn().mockImplementation(originalSetStateDir);
      plugin.register(apiBetter);
      // The migration was triggered again — `chatTurnWriterMigrationTarget`
      // should be set during the in-flight async work.
      const target = (plugin as any).chatTurnWriterMigrationTarget;
      expect(target?.replace(/\\/g, '/')).toBe(workspaceDir.replace(/\\/g, '/') + '/.openclaw');
      // Wait for retry to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.openclaw',
      );
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T18/T21 — ensureChatTurnWriter migrates writer in-place via setStateDir when a better stateDir becomes available', async () => {
    // Regression for T18: pre-fix, once `chatTurnWriter` was constructed
    // with the home-dir fallback (because setup-runtime register had
    // no workspaceDir / resolveStateDir wired yet), it stayed pinned
    // forever.
    // Regression for T21: an earlier T18 fix REBUILT the writer and
    // used `flushSync()` which doesn't await in-flight persists/resets
    // — losing or duplicating turns mid-rebuild. Post-fix, the writer
    // is migrated IN-PLACE via `setStateDir` which `await flush()`s
    // before swapping paths.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t18-workspace-${Date.now()}`);
    const homeDir = `${require('os').homedir()}/.openclaw`;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiFallback: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiFallback);
      const writer1 = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir).toBe(homeDir);

      // Second register with workspaceDir → triggers in-place migration.
      const apiBetter: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiBetter);
      const writer2 = (plugin as any).chatTurnWriter;
      // SAME instance — migration is in-place (preserves in-flight state).
      expect(writer2).toBe(writer1);
      // T24 — `chatTurnWriterStateDir` is updated ONLY on successful
      // migration. While the async `setStateDir` is in flight,
      // `chatTurnWriterMigrationTarget` reflects the target.
      expect((plugin as any).chatTurnWriterMigrationTarget?.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.openclaw',
      );
      // Wait for the fire-and-forget setStateDir to complete.
      await new Promise((r) => setTimeout(r, 100));
      // After success, chatTurnWriterStateDir flips and migration
      // target clears.
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.openclaw',
      );
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);
      const path2 = (writer2 as any).watermarkFilePath as string;
      expect(path2.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.openclaw/dkg-adapter/chat-turn-watermarks.json',
      );
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('T14 — single-flight key is per-conversation; a slow recall in one conversation does NOT block recall in a sibling conversation under the same sessionKey', async () => {
    // Regression for T14: pre-fix, single-flight was keyed on raw
    // `ctx.sessionKey`. Channels can multiplex several conversations
    // under one sessionKey (the same composition that ChatTurnWriter
    // uses for its FIFO queues), so a slow recall in conversation A
    // would suppress recall in unrelated conversation B. Post-fix,
    // the key is composed of channelId + accountId + conversationId +
    // sessionKey so siblings stay independent.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      registerMemoryPromptSection: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    const client = (plugin as any).client;
    let queryCalls = 0;
    const pendingResolvers: Array<() => void> = [];
    client.query = vi.fn().mockImplementation(async () => {
      queryCalls++;
      await new Promise<void>((resolve) => { pendingResolvers.push(resolve); });
      return { results: { bindings: [] } };
    });
    // T31 — Resolver returns `nodeAgentAddress` (eth) instead of `nodePeerId`.
    (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

    const event = { messages: [{ role: 'user', content: 'find something' }] };
    // Two ctx values share the SAME sessionKey but differ on
    // conversationId — exactly the scenario T14 flags.
    const ctxA = { channelId: 'tg', accountId: 'bot', conversationId: 'chat-A', sessionKey: 'shared-sk' };
    const ctxB = { channelId: 'tg', accountId: 'bot', conversationId: 'chat-B', sessionKey: 'shared-sk' };

    // Conversation A: hangs in searchNarrow.
    const turnA = (plugin as any).handleBeforePromptBuild(event, ctxA);
    await new Promise((r) => setTimeout(r, 300));
    await turnA;
    const queriesAfterA = queryCalls;
    expect(queriesAfterA).toBeGreaterThan(0);

    // Conversation B fires while A still has queries in flight. With
    // the per-conversation key, B MUST issue its own queries (not be
    // blocked by A's reservation under the shared sessionKey).
    const turnB = (plugin as any).handleBeforePromptBuild(event, ctxB);
    await new Promise((r) => setTimeout(r, 300));
    await turnB;
    expect(queryCalls).toBeGreaterThan(queriesAfterA);

    // Cleanup.
    while (pendingResolvers.length) pendingResolvers.shift()!();
    await new Promise((r) => setTimeout(r, 50));
    await plugin.stop();
  });

  it('R23.2 — stop() nulls out hookSurface refs so a later register() rebuilds the surface', async () => {
    // Regression for R23.2: pre-fix, stop() called hookSurface.destroy()
    // but left this.hookSurface and this.hookSurfaceApi populated.
    // A later register() on the same plugin instance with the same api
    // hit the existing-surface fast path in installHooksIfNeeded() and
    // skipped reinstalling hooks. The old surface is permanently inert
    // (destroyed=true), so W3 / W4a / W4b would silently never re-install.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const onSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);
    // Initial register installed hooks.
    expect((plugin as any).hookSurface).not.toBeNull();
    const onCallCountAfterInitial = onSpy.mock.calls.length;
    expect(onCallCountAfterInitial).toBeGreaterThan(0);

    // Shutdown.
    await plugin.stop();
    // The hookSurface refs MUST be cleared by stop().
    expect((plugin as any).hookSurface).toBeNull();
    expect((plugin as any).hookSurfaceApi).toBeNull();

    // Re-register on the same plugin instance.
    plugin.register(mockApi);
    // Hooks must have been reinstalled — api.on count goes up.
    expect(onSpy.mock.calls.length).toBeGreaterThan(onCallCountAfterInitial);
    expect((plugin as any).hookSurface).not.toBeNull();
  });

  it('R17.2 — setup-only → full re-entry constructs ChatTurnWriter and installs hooks', () => {
    // Regression for the qa-engineer-flagged R17.2 follow-up: the
    // first `setup-only` call correctly skips ChatTurnWriter construction
    // (no FS work in metadata-only mode), but the SECOND call (full)
    // must then construct it before installHooksIfNeeded runs —
    // otherwise installHooksIfNeeded's `if (!this.chatTurnWriter) return`
    // guard silently no-ops and W3 / W4a / W4b never wire up.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const setupOnlyApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(setupOnlyApi);
    // Tick 1: setup-only — no ChatTurnWriter, no hooks.
    expect((plugin as any).chatTurnWriter).toBeNull();
    expect(onSpy).not.toHaveBeenCalled();

    // Tick 2: full — must construct ChatTurnWriter AND install hooks.
    const fullApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(fullApi);
    expect((plugin as any).chatTurnWriter).not.toBeNull();
    // At least one typed hook (`before_prompt_build` or `agent_end`)
    // must have been registered against the now-full api.
    const typedHookEvents = onSpy.mock.calls.map((c: any[]) => c[0]);
    expect(typedHookEvents).toContain('before_prompt_build');
    expect(typedHookEvents).toContain('agent_end');
  });

  it('R14.3 / T52 / T58 — setup-only registers only session_end (no channel server, no typed/internal hooks)', () => {
    // R14.3: setup-only must NOT wire prompt-injection / turn-
    // persistence handlers (`before_prompt_build`, `agent_end`,
    // `message:received`, `message:sent`).
    //
    // T52: `session_end` legacy cleanup STILL installs so that any
    // future runtime upgrade has a deterministic shutdown path.
    //
    // T58: `registerIntegrationModules` no longer brings up the
    // channel HTTP server in setup-only — the documented
    // metadata-only contract is honored. Channel registration is
    // deferred to the runtime-enabled re-entry.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const registerHookSpy = vi.fn();
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: registerHookSpy,
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    plugin.register(mockApi);
    // T52 — Surface MUST exist (session_end is the cleanup anchor).
    expect((plugin as any).hookSurface).not.toBeNull();
    // R14.3 — No typed-hook installs may have called api.on.
    expect(onSpy).not.toHaveBeenCalled();
    // T52 — `session_end` MUST be the only legacy registerHook call.
    expect(registerHookSpy).toHaveBeenCalledTimes(1);
    expect(registerHookSpy.mock.calls[0][0]).toBe('session_end');
    // T58 — Channel must NOT have started in setup-only mode.
    expect((plugin as any).channelPlugin).toBeFalsy();
  });

  it('T59 — setup-only → full upgrade on the same api installs runtime hooks (W3/W4) on re-entry', () => {
    // T59: pre-fix the same-api retry path required `installedVia ===
    // 'none'` (an explicit failure record) to fire a re-install. In
    // setup-only the runtime hooks were never attempted, so their
    // stats keys were absent — the retry predicate evaluated
    // `undefined?.installedVia === 'none'` as false and the
    // setup-only → full upgrade left W3/W4/internal permanently
    // uninstalled. Post-fix the predicate treats `stats[key] ===
    // undefined` as a first-time install when the dispatch primitive
    // is now available.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const onSpy = vi.fn();
    const registerHookSpy = vi.fn();
    const mockApi: any = {
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'setup-only',
      registerTool: () => {},
      registerHook: registerHookSpy,
      registerMemoryCapability: () => {},
      on: onSpy,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    // First register: setup-only — no W3/W4/internal installs.
    plugin.register(mockApi);
    expect(onSpy).not.toHaveBeenCalled();
    expect(registerHookSpy).toHaveBeenCalledTimes(1);
    expect(registerHookSpy.mock.calls[0][0]).toBe('session_end');

    // Re-register on the SAME api with mode flipped to full. T59
    // guarantees this path installs the typed hooks even though
    // their stats keys are absent (never attempted in setup-only).
    mockApi.registrationMode = 'full';
    plugin.register(mockApi);

    // api.on MUST have been called for each typed hook now.
    const typedEvents = onSpy.mock.calls.map((c: any[]) => c[0]);
    expect(typedEvents).toContain('before_prompt_build');
    expect(typedEvents).toContain('agent_end');
    expect(typedEvents).toContain('before_compaction');
    expect(typedEvents).toContain('before_reset');
  });

  it('R14.2 — handleBeforePromptBuild returns undefined when memoryPlugin exists but is not registered (slot owned by another plugin)', async () => {
    // Regression for R14.2: when `plugins.slots.memory` points at a
    // different plugin, `DkgMemoryPlugin.register()` returns false and
    // `registeredCapability` stays null. The before_prompt_build hook
    // must short-circuit instead of injecting DKG recall on top of the
    // elected provider's prompt.
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    } as any);
    const mockApi: OpenClawPluginApi = {
      // No `plugins.slots.memory` set → registerCapability returns false
      // → isRegistered() === false.
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: vi.fn(),
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    plugin.register(mockApi);

    // memoryPlugin must exist — module is enabled — but it must NOT be
    // registered, because the slot points elsewhere.
    expect((plugin as any).memoryPlugin).not.toBeNull();
    expect((plugin as any).memoryPlugin.isRegistered()).toBe(false);

    const result = await (plugin as any).handleBeforePromptBuild(
      { messages: [{ role: 'user', content: 'tatooine suns' }] },
      { sessionKey: 'sk' },
    );
    expect(result).toBeUndefined();
  });

  it('T26 — empty / whitespace-only OPENCLAW_STATE_DIR does NOT short-circuit the fallback chain', () => {
    // Regression for T26: pre-fix the `??` chain treated empty strings
    // as real values, so `OPENCLAW_STATE_DIR=''` (or whitespace-only)
    // bypassed `api.workspaceDir` and `~/.openclaw` and the writer
    // ended up writing `./dkg-adapter/chat-turn-watermarks.json` from
    // the process CWD — silent state leak across workspaces.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = '';   // empty
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-t26-workspace',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const ctw = (plugin as any).chatTurnWriter;
      const watermarkPath: string = (ctw as any).watermarkFilePath;
      const normalized = watermarkPath.replace(/\\/g, '/');
      // Must have fallen through empty env to workspaceDir-derived path.
      expect(normalized).toContain('/tmp/dkg-t26-workspace/.openclaw/dkg-adapter/chat-turn-watermarks.json');
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }

    // Whitespace-only also normalizes to "missing".
    process.env.OPENCLAW_STATE_DIR = '   ';
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-t26-workspace-ws',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        '/tmp/dkg-t26-workspace-ws/.openclaw/dkg-adapter/chat-turn-watermarks.json',
      );
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('R16.2 — chat-turn watermark stateDir prefers api.workspaceDir over ~/.openclaw fallback', () => {
    // Regression for R16.2: previously the stateDir fallback chain went
    // straight to `~/.openclaw` when `runtime.state.resolveStateDir()` and
    // `OPENCLAW_STATE_DIR` were both absent, so two workspaces on the
    // same machine would share `chat-turn-watermarks.json`. The new
    // fallback prefers `api.workspaceDir + '/.openclaw'` when present.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: '/tmp/dkg-r162-workspace',
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const ctw = (plugin as any).chatTurnWriter;
      expect(ctw).toBeDefined();
      // ChatTurnWriter stores the resolved stateDir privately and writes
      // `<stateDir>/dkg-adapter/chat-turn-watermarks.json`. Inspecting
      // `watermarkFilePath` confirms the workspace-derived path won.
      const watermarkPath: string = (ctw as any).watermarkFilePath;
      // Normalize separators for cross-platform path comparison (Windows
      // path.join produces backslashes from a forward-slash workspaceDir).
      const normalized = watermarkPath.replace(/\\/g, '/');
      expect(normalized).toContain('/tmp/dkg-r162-workspace/.openclaw/dkg-adapter/chat-turn-watermarks.json');
      // Must NOT have fallen back to the home dir.
      expect(normalized).not.toContain(homedir().replace(/\\/g, '/') + '/.openclaw/dkg-adapter');
      // The home-dir fallback warn must NOT have fired.
      const warnSpy = mockApi.logger.warn as any;
      const homeFallbackWarn = warnSpy.mock.calls.find((c: any[]) =>
        String(c[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      );
      expect(homeFallbackWarn).toBeUndefined();
    } finally {
      if (prevEnv !== undefined) process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });

  it('warns once when legacy OriginTrail Game config is still present', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
      game: { enabled: true } as any,
    } as any);
    const warnCalls: unknown[][] = [];
    const warn = (...args: unknown[]) => { warnCalls.push(args); };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { warn },
    };

    plugin.register(mockApi);
    plugin.register(mockApi);

    // R16.2 introduced a separate warn when the state dir falls back to
    // `~/.openclaw` because `workspaceDir` and `OPENCLAW_STATE_DIR` are
    // both absent in this fixture. Filter to the game-config warn so the
    // assertion remains scoped to the legacy-detection invariant.
    const gameWarns = warnCalls.filter((args) =>
      String(args?.[0] ?? '').includes('dkg-node.game.enabled'),
    );
    expect(gameWarns).toHaveLength(1);
    expect(String(gameWarns[0]?.[0])).toContain('dkg-node.game.enabled');
  });

  it('upgrades from setup-runtime to full runtime and registers the memory slot capability', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });

    const setupRuntimeTools: OpenClawTool[] = [];
    const setupRuntimeApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'setup-runtime',
      registerTool: (tool) => setupRuntimeTools.push(tool),
      registerHook: () => {},
      on: () => {},
      logger: {},
      workspaceDir: 'C:/tmp/openclaw-upgrade-test',
    };
    plugin.register(setupRuntimeApi);
    expect(setupRuntimeTools).toHaveLength(0);

    const fullRuntimeTools: OpenClawTool[] = [];
    const registerMemoryCapability = vi.fn();
    const fullRuntimeApi: OpenClawPluginApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      } as any,
      registrationMode: 'full',
      registerTool: (tool) => fullRuntimeTools.push(tool),
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: {},
      workspaceDir: 'C:/tmp/openclaw-upgrade-test',
    };
    plugin.register(fullRuntimeApi);

    // The adapter no longer registers dkg_memory_import or
    // dkg_memory_search as conventional tools — both reads and writes
    // flow through the memory slot via registerMemoryCapability.
    const fullToolNames = fullRuntimeTools.map((tool) => tool.name);
    expect(fullToolNames).not.toContain('dkg_memory_search');
    expect(fullToolNames).not.toContain('dkg_memory_import');
    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
  });

  it('does not re-register the OpenClaw channel routes when the same plugin instance upgrades to full runtime', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return {
        ok: true,
        json: async () => ({ ok: true, integration: { id: 'openclaw' } }),
      };
    }) as typeof fetch;
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
      memory: { enabled: false },
    });
    const registerChannelCalls: unknown[][] = [];
    const registerChannel = (...args: unknown[]) => { registerChannelCalls.push(args); };
    const registerHttpRouteCalls: unknown[][] = [];
    const registerHttpRoute = (...args: unknown[]) => { registerHttpRouteCalls.push(args); };

    try {
      const setupRuntimeApi = {
        config: {},
        registrationMode: 'setup-runtime',
        registerTool: () => {},
        registerHook: () => {},
        registerChannel,
        registerHttpRoute,
        on: () => {},
        logger: {},
      } as OpenClawPluginApi & {
        registerChannel: typeof registerChannel;
        registerHttpRoute: typeof registerHttpRoute;
      };
      plugin.register(setupRuntimeApi);

      const fullRuntimeApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        registerChannel,
        registerHttpRoute,
        on: () => {},
        logger: {},
      } as OpenClawPluginApi & {
        registerChannel: typeof registerChannel;
        registerHttpRoute: typeof registerHttpRoute;
      };
      plugin.register(fullRuntimeApi);

      expect(registerChannelCalls).toHaveLength(1);
      expect(registerHttpRouteCalls).toHaveLength(2);
    } finally {
      await plugin.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('memory resolver reads the UI-selected CG stashed on the channel plugin session state', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 0 },
    });

    let registeredCapability: any = null;
    const mockApi = {
      // Codex B58: slot-ownership gate requires plugins.slots.memory to
      // name adapter-openclaw before DkgMemoryPlugin.register will claim
      // the slot. Stamp it here so this dispatch-context test exercises
      // the full registration path.
      config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
      registrationMode: 'full' as const,
      registerTool: () => {},
      registerHook: () => {},
      registerChannel: () => {},
      registerHttpRoute: () => {},
      registerMemoryCapability: (capability: any) => {
        registeredCapability = capability;
      },
      on: () => {},
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as unknown as OpenClawPluginApi;

    // Stub fetch so the plugin's best-effort getStatus + listContextGraphs
    // probes during register() resolve cleanly. /api/status returns a real
    // peer ID so DkgNodePlugin.nodePeerId populates and the runtime can
    // hand back an actual DkgMemorySearchManager (not the null-manager
    // fallback that fires when peer ID is still undefined — Codex B12).
    // /api/context-graph/list returns an empty array so the subscribed-CG
    // preflight terminates cleanly. Any other call returns an empty 200.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('/api/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, peerId: 'peer-dispatch-test' }),
        } as Response;
      }
      if (url.includes('/api/context-graph/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ contextGraphs: [] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as any;

    try {
      plugin.register(mockApi);
      expect(registeredCapability).not.toBeNull();

      // T31 — The resolver now returns `nodeAgentAddress` (eth address from
      // keystore) instead of `nodePeerId`. This dispatch-context test
      // doesn't care about how the address is sourced, just that the
      // resolver hands back A non-undefined address so getMemorySearchManager
      // hits the manager-construction path (Codex B12 null-manager
      // fallback otherwise). Directly seed the field; the keystore-load
      // mechanics are tested in the dedicated B9-style tests below.
      (plugin as any).nodeAgentAddress = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcd';

      // Let the best-effort probes kicked off inside register() flush.
      await new Promise((resolve) => setImmediate(resolve));

      // Before any dispatch: resolver returns no projectContextGraphId for
      // any sessionKey — the ALS store is empty outside of an active
      // dispatch. The runtime still hands back a real manager because the
      // peer-ID probe succeeded above; null-manager fallback only fires
      // when the resolver cannot produce an agent address.
      const runtime = registeredCapability.runtime;
      const resultBefore = await runtime.getMemorySearchManager({ sessionKey: 'session-xyz' });
      expect(resultBefore.manager).not.toBeNull();
      expect(resultBefore.error).toBeUndefined();

      const channelPlugin = (plugin as any).channelPlugin as any;
      expect(channelPlugin).toBeDefined();

      // Simulate a dispatch scope by running the memorySessionResolver
      // lookup inside `channelPlugin.dispatchContext.run`, the same
      // AsyncLocalStorage the real dispatch uses. Inside the scope the
      // resolver sees the stashed CG; outside the scope it returns
      // undefined. This mirrors what a real slot-backed tool call does
      // during a live dispatch. Codex Bug B6.
      const dispatchStore = {
        uiContextGraphId: 'research-x',
        sessionKey: 'session-xyz',
        correlationId: 'corr-test',
      };
      const insideScope = channelPlugin.dispatchContext.run(dispatchStore, () => {
        return (plugin as any).memorySessionResolver.getSession('session-xyz');
      });
      expect(insideScope?.projectContextGraphId).toBe('research-x');

      // Outside the scope: resolver returns a session with NO project CG.
      const outsideScope = (plugin as any).memorySessionResolver.getSession('session-xyz');
      expect(outsideScope?.projectContextGraphId).toBeUndefined();

      // And the channel plugin's own getter is scope-aware too.
      expect(channelPlugin.getSessionProjectContextGraphId('session-xyz')).toBeUndefined();
      const insideScopeGetter = channelPlugin.dispatchContext.run(dispatchStore, () => {
        return channelPlugin.getSessionProjectContextGraphId('session-xyz');
      });
      expect(insideScopeGetter).toBe('research-x');
    } finally {
      await plugin.stop();
      globalThis.fetch = originalFetch;
    }
  });

  describe('node peer ID lazy re-probe (Codex B9)', () => {
    // Helper: makes a fetch stub that routes /api/status calls through a
    // user-supplied handler and counts them. /api/context-graph/list (fired
    // by listContextGraphs in the same refresh) always resolves empty so
    // we don't have to care about its shape in these tests.
    function makeFetchStub(statusHandler: (callIndex: number) => Response | Promise<Response>) {
      const statusCalls: Array<{ url: string }> = [];
      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          const idx = statusCalls.length;
          statusCalls.push({ url });
          return statusHandler(idx);
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });
      return { fetchFn, statusCalls };
    }

    function makeMockApi(): OpenClawPluginApi {
      return {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full' as const,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: () => {},
        on: () => {},
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
      } as unknown as OpenClawPluginApi;
    }

    // Drain enough event-loop turns for a fire-and-forget fetch chain
    // (`ensureNodePeerId` → `probeNodePeerIdOnce` → `getStatus` → `fetch`
    // → response.json → state assignment → `.finally` cleanup) to
    // actually settle. Real-world fetch chains are ~15-20 microtask
    // hops; a generous count here is cheaper than a wall-clock wait.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
    };

    // T31 — These four tests exercise `ensureNodePeerId` directly. They
    // used to drive the lazy re-probe via `resolver.getDefaultAgentAddress()`,
    // which now feeds `nodeAgentAddress` (keystore-driven) instead. The
    // peerId machinery itself still exists for libp2p uses (relay/transport
    // metadata) and the lazy-recovery semantic is still worth pinning, so
    // these tests now drive `ensureNodePeerId()` directly. A separate
    // `node agent address keystore (T31)` describe-block below covers the
    // keystore-based equivalent that feeds the resolver.

    it('lazily re-probes peer ID when the register-time probe failed', async () => {
      const { fetchFn, statusCalls } = makeFetchStub((idx) => {
        if (idx === 0) {
          return new Response('daemon starting', { status: 503 });
        }
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:test-peer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBeUndefined();
        // Direct lazy re-probe — the resolver no longer triggers this
        // (it now feeds `nodeAgentAddress`) but the recovery contract
        // remains relevant for libp2p uses.
        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:test-peer');
        const statusCallsBefore = statusCalls.length;
        // Subsequent calls are no-ops once cached.
        await (plugin as any).ensureNodePeerId();
        expect(statusCalls.length).toBe(statusCallsBefore);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('debounces concurrent ensureNodePeerId fires to a single in-flight probe', async () => {
      let resolveStatus: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        resolveStatus = resolve;
      });
      const { fetchFn, statusCalls } = makeFetchStub(async () => {
        await gate;
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:debounced' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        // 10 concurrent direct calls — must collapse to one in-flight probe.
        for (let i = 0; i < 10; i++) {
          void (plugin as any).ensureNodePeerId();
        }
        expect(statusCalls.length).toBe(1);
        resolveStatus!();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:debounced');
        expect(statusCalls.length).toBe(1);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('recovers on every subsequent call when /api/status keeps failing', async () => {
      const { fetchFn, statusCalls } = makeFetchStub(() => {
        return new Response('daemon down', { status: 503 });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        const initialCalls = statusCalls.length;
        expect(initialCalls).toBeGreaterThanOrEqual(1);

        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBeUndefined();
        const afterFirstLazy = statusCalls.length;
        expect(afterFirstLazy).toBe(initialCalls + 1);

        await (plugin as any).ensureNodePeerId();
        await flushMicrotasks();
        const afterSecondLazy = statusCalls.length;
        expect(afterSecondLazy).toBe(initialCalls + 2);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('does NOT re-probe when the register-time probe already succeeded', async () => {
      const { fetchFn, statusCalls } = makeFetchStub(() => {
        return new Response(JSON.stringify({ peerId: 'did:dkg:agent:happy-path' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await flushMicrotasks();
        expect((plugin as any).nodePeerId).toBe('did:dkg:agent:happy-path');
        const baselineCalls = statusCalls.length;
        for (let i = 0; i < 20; i++) {
          await (plugin as any).ensureNodePeerId();
        }
        expect(statusCalls.length).toBe(baselineCalls);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('node agent address keystore (T31)', () => {
    // T31 — The resolver returns `nodeAgentAddress` (eth address from
    // `<DKG_HOME>/agent-keystore.json`) instead of `nodePeerId` (libp2p
    // from `/api/status`). These tests exercise the new lazy-read pattern
    // by setting DKG_HOME to a tmpdir and writing/mutating the keystore
    // file mid-test. Mirrors the previous B9 lazy re-probe semantics for
    // the keystore source.
    // T63 — Adapter HTTP-probes `/api/agent/identity` to get the canonical
    // eth (already EIP-55 from the daemon). Tests stub `client.getAgentIdentity`
    // and assert resolver returns whatever the stub responded with.
    // Test fixtures: keystore JSON keys are LOWERCASE (the form the daemon
    // writes). Stubs return EIP-55 checksum form (what the daemon's HTTP
    // response gives). Both forms are derived at runtime.
    const ETH_PRIMARY_LC = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
    const ETH_SECONDARY_LC = '0x949ec97ab4ed1c9fb4c9a70c2dd368065d817b0c';
    const ETH_PRIMARY = toEip55Checksum(ETH_PRIMARY_LC);
    const ETH_SECONDARY = toEip55Checksum(ETH_SECONDARY_LC);

    function makeMockApi(): OpenClawPluginApi {
      return {
        config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
        registrationMode: 'full' as const,
        registerTool: () => {},
        registerHook: () => {},
        registerMemoryCapability: () => {},
        on: () => {},
        logger: { info: () => {}, warn: vi.fn(), debug: () => {} },
      } as unknown as OpenClawPluginApi;
    }

    let tempHome: string;
    let prevDkgHome: string | undefined;
    let prevAgentEnv: string | undefined;

    beforeEach(() => {
      tempHome = path.join(require('os').tmpdir(), `dkg-node-keystore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(tempHome, { recursive: true });
      prevDkgHome = process.env.DKG_HOME;
      prevAgentEnv = process.env.DKG_AGENT_ADDRESS;
      process.env.DKG_HOME = tempHome;
      delete process.env.DKG_AGENT_ADDRESS;
    });

    afterEach(() => {
      if (prevDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = prevDkgHome;
      if (prevAgentEnv === undefined) delete process.env.DKG_AGENT_ADDRESS;
      else process.env.DKG_AGENT_ADDRESS = prevAgentEnv;
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function writeKeystore(addresses: string[]): void {
      const payload: Record<string, unknown> = {};
      for (const addr of addresses) payload[addr] = { authToken: `tok-${addr.toLowerCase()}` };
      fs.writeFileSync(path.join(tempHome, 'agent-keystore.json'), JSON.stringify(payload));
    }

    /**
     * T63 — Stub `client.getAgentIdentity` to return a canned response.
     * Tests that exercise the local-keystore-with-agent path need this so
     * the probe doesn't try a real HTTP fetch. Returns the spy so callers
     * can assert the auth token forwarded matches the keystore entry.
     */
    function stubAgentIdentity(plugin: DkgNodePlugin, ethAddress: string): ReturnType<typeof vi.fn> {
      const spy = vi.fn().mockResolvedValue({
        ok: true,
        identity: {
          agentAddress: ethAddress,
          agentDid: `did:dkg:agent:${ethAddress}`,
          name: 'test-agent',
          peerId: '12D3KooWDaemonPeerFromIdentity',
          nodeIdentityId: '0',
        },
      });
      (plugin as any).client.getAgentIdentity = spy;
      return spy;
    }

    it('resolver.getDefaultAgentAddress returns the eth address from the daemon HTTP probe (T31/T63)', async () => {
      // T63 — Adapter now reads agent token from keystore and HTTP-probes
      // `/api/agent/identity` to get the canonical eth (already EIP-55).
      writeKeystore([ETH_PRIMARY_LC]);
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        const spy = stubAgentIdentity(plugin, ETH_PRIMARY);
        await (plugin as any).ensureNodeAgentAddress();
        const resolver = (plugin as any).memorySessionResolver;
        expect(resolver.getDefaultAgentAddress()).toBe(ETH_PRIMARY);
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        // T63 regression — probe forwards the AGENT auth token from the
        // keystore (NOT the constructor's node-level token).
        expect(spy).toHaveBeenCalledWith({ authToken: `tok-${ETH_PRIMARY_LC}` });
      } finally {
        await plugin.stop();
      }
    });

    it('lazily re-reads keystore when the register-time read found no file', async () => {
      // Keystore absent at register; appears later (e.g. daemon provisions
      // identity after gateway start).
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        // Stub from the start so the eventual probe doesn't try real HTTP.
        stubAgentIdentity(plugin, ETH_PRIMARY);
        // Drive the register-time probe to completion explicitly. With no
        // keystore, the probe sets `localKeystoreCheckedAndAbsent = true`
        // and never reaches getAgentIdentity.
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect((plugin as any).localKeystoreCheckedAndAbsent).toBe(true);
        // Drain the .finally microtask so the in-flight promise clears.
        await new Promise((r) => setImmediate(r));

        // Keystore appears.
        writeKeystore([ETH_PRIMARY_LC]);
        // Lazy re-read — fires a fresh probe; keystore now present, so
        // probe reaches the HTTP stub and sets nodeAgentAddress.
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
      } finally {
        await plugin.stop();
      }
    });

    it('multi-agent keystore without DKG_AGENT_ADDRESS fails loud (refuses to guess)', async () => {
      writeKeystore([ETH_PRIMARY, ETH_SECONDARY]);
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(api);
        // Drive the probe directly — `refreshMemoryResolverState` is
        // fire-and-forget at register-time and the keystore read may
        // not have landed by the time the test reaches this point.
        await (plugin as any).ensureNodeAgentAddress();
        // Refused — `nodeAgentAddress` stays undefined, NOT silently
        // picked from one of the two keys.
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        // Operator-visible warn fired.
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('Multi-agent keystore detected'))).toBe(true);
      } finally {
        await plugin.stop();
      }
    });

    it('DKG_AGENT_ADDRESS env disambiguates a multi-agent keystore', async () => {
      writeKeystore([ETH_PRIMARY_LC, ETH_SECONDARY_LC]);
      process.env.DKG_AGENT_ADDRESS = ETH_SECONDARY;
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        const spy = stubAgentIdentity(plugin, ETH_SECONDARY);
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBe(ETH_SECONDARY);
        // T63 — env disambiguates which keystore entry's authToken to forward.
        expect(spy).toHaveBeenCalledWith({ authToken: `tok-${ETH_SECONDARY_LC}` });
      } finally {
        await plugin.stop();
      }
    });

    it('falls back to nodePeerId when nodeAgentAddress is unresolved on confirmed-local-no-keystore (T56/T60)', async () => {
      // T56 — On fresh / auth-disabled / no-keystore nodes, the
      // daemon's writer-side falls back to peerId via
      // `defaultAgentAddress ?? peerId`. Adapter resolver mirrors
      // that priority. T60 — fallback gates on
      // `localKeystoreCheckedAndAbsent`, set by `probeNodeAgentAddressOnce`
      // when a localhost-gated probe legitimately found no keystore.
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        // Drive the probe — empty tempDir yields no keystore →
        // probe sets `localKeystoreCheckedAndAbsent = true`.
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect((plugin as any).localKeystoreCheckedAndAbsent).toBe(true);
        (plugin as any).nodePeerId = '12D3KooWNoKeystorePeer';
        const resolver = (plugin as any).memorySessionResolver;
        expect(resolver.getDefaultAgentAddress()).toBe('12D3KooWNoKeystorePeer');
        expect(resolver.getSession(undefined)?.agentAddress).toBe('12D3KooWNoKeystorePeer');
      } finally {
        await plugin.stop();
      }
    });

    it('does NOT fall back to nodePeerId on remote-daemon (probe-skipped) — T60', async () => {
      // T60 — `probeNodeAgentAddressOnce` skips the keystore read
      // for non-localhost daemonUrl. `localKeystoreCheckedAndAbsent`
      // stays false → resolver returns undefined even though
      // nodePeerId is populated. Without the gate, remote-daemon
      // recall would silently scope WM to gateway's local peerId
      // (which the remote daemon has never heard of) instead of
      // surfacing the actual misconfiguration via the "backend
      // not ready" path.
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect((plugin as any).localKeystoreCheckedAndAbsent).toBe(false);
        (plugin as any).nodePeerId = '12D3KooWGatewayLocalPeer';
        const resolver = (plugin as any).memorySessionResolver;
        expect(resolver.getDefaultAgentAddress()).toBeUndefined();
        expect(resolver.getSession(undefined)?.agentAddress).toBeUndefined();
      } finally {
        await plugin.stop();
      }
    });

    it('keystore eth wins over peerId when both are available (T56 — keystore-present deployments)', async () => {
      // T56 — Keystore-present deployments must keep using eth
      // (the original Bug A / T31 fix). Fallback only kicks in when
      // nodeAgentAddress is undefined.
      writeKeystore([ETH_PRIMARY_LC]);
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        stubAgentIdentity(plugin, ETH_PRIMARY);
        await (plugin as any).ensureNodeAgentAddress();
        (plugin as any).nodePeerId = '12D3KooWShouldNotBeReturned';
        const resolver = (plugin as any).memorySessionResolver;
        expect(resolver.getDefaultAgentAddress()).toBe(ETH_PRIMARY);
        expect(resolver.getSession(undefined)?.agentAddress).toBe(ETH_PRIMARY);
      } finally {
        await plugin.stop();
      }
    });

    it('skips keystore read for remote daemonUrl + warns operator (T38)', async () => {
      // T38 — Remote/custom-daemon setup: gateway's local keystore is
      // either absent or belongs to a different identity. Reading it
      // would silently scope WM queries to the wrong agent. Adapter
      // must skip the read, leave nodeAgentAddress undefined, and
      // surface an operator-actionable warn.
      writeKeystore([ETH_PRIMARY]);
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(api);
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('Daemon URL is non-local'))).toBe(true);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects invalid DKG_AGENT_ADDRESS for the localhost gate, warns, falls through to remote-skip (T44)', async () => {
      // T44 — `DKG_AGENT_ADDRESS=foo` (typo) must NOT bypass the
      // localhost gate. Pre-fix: truthy-string check passed → gate
      // skipped → keystore read with no env override → scoped WM
      // to the gateway's local identity for a remote-daemon setup.
      writeKeystore([ETH_PRIMARY]);
      process.env.DKG_AGENT_ADDRESS = 'foo';
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(api);
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('not a valid 0x-prefixed eth address'))).toBe(true);
        expect(warnCalls.some((m: string) => m.includes('Daemon URL is non-local'))).toBe(true);
      } finally {
        await plugin.stop();
      }
    });

    it('treats IPv6 loopback (`http://[::1]:…`) as localhost (T40)', async () => {
      // T40 — `new URL('http://[::1]:9200').hostname` returns `[::1]`
      // (with brackets) per WHATWG URL. Without bracket-stripping,
      // the heuristic misclassifies a local IPv6 daemon as remote
      // and skips the keystore read, leaving recall/search broken
      // for an entirely valid local-only deployment.
      writeKeystore([ETH_PRIMARY_LC]);
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://[::1]:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        stubAgentIdentity(plugin, ETH_PRIMARY);
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
      } finally {
        await plugin.stop();
      }
    });

    it('config.dkgHome overrides DKG_HOME for the keystore read (T42)', async () => {
      // T42 — Operator runs `dkg start --home /custom/path` (or daemon
      // is service-unit-managed with its own home). Gateway process's
      // DKG_HOME points elsewhere (or default). Explicit `dkgHome`
      // config field must reach the keystore read so the adapter
      // resolves the right identity without env-level coordination.
      const otherHome = path.join(require('os').tmpdir(), `dkg-other-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(otherHome, { recursive: true });
      try {
        // Write keystore at OTHER home; leave the env-DKG_HOME tempHome empty.
        fs.writeFileSync(
          path.join(otherHome, 'agent-keystore.json'),
          JSON.stringify({ [ETH_PRIMARY_LC]: { authToken: 'other-home-tok' } }),
        );
        const plugin = new DkgNodePlugin({
          daemonUrl: 'http://localhost:9200',
          dkgHome: otherHome,
          memory: { enabled: true },
          channel: { enabled: false },
        });
        try {
          plugin.register(makeMockApi());
          stubAgentIdentity(plugin, ETH_PRIMARY);
          await (plugin as any).ensureNodeAgentAddress();
          expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        } finally {
          await plugin.stop();
        }
      } finally {
        try { fs.rmSync(otherHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    it('HTTP probe failure leaves nodeAgentAddress undefined and localKeystoreCheckedAndAbsent false (T63)', async () => {
      // T63 — A transient HTTP failure (daemon down, 401, 5xx) is NOT a
      // signal that the keystore is missing. The probe must keep the
      // door open for retry: nodeAgentAddress stays undefined AND
      // localKeystoreCheckedAndAbsent stays false (so the resolver
      // returns undefined → "backend not ready" surfaces, NOT the
      // peerId fallback which is only correct when keystore is genuinely
      // absent).
      writeKeystore([ETH_PRIMARY_LC]);
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(api);
        const failingSpy = vi.fn().mockResolvedValue({ ok: false, error: 'ECONNREFUSED' });
        (plugin as any).client.getAgentIdentity = failingSpy;
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect((plugin as any).localKeystoreCheckedAndAbsent).toBe(false);
        // Forwarded the agent token from the keystore (regression).
        expect(failingSpy).toHaveBeenCalledWith({ authToken: `tok-${ETH_PRIMARY_LC}` });
        // Operator-visible warn fired.
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('/api/agent/identity probe failed'))).toBe(true);
      } finally {
        await plugin.stop();
      }
    });

    it('honors DKG_AGENT_ADDRESS even when daemonUrl is remote (T38)', async () => {
      // T38 — Operator escape hatch: setting DKG_AGENT_ADDRESS lets
      // remote-daemon deployments scope WM correctly without waiting
      // for the daemon-side endpoint to ship.
      process.env.DKG_AGENT_ADDRESS = ETH_PRIMARY;
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        await (plugin as any).ensureNodeAgentAddress();
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('context-graph cache filter on synced + non-system (Codex B51 + B54)', () => {
    it('caches only entries with synced=true AND isSystem=false (includes local private CGs per B54)', async () => {
      // B51: `agent.listContextGraphs()` returns every known CG —
      // including system paranets (ontology, agents registry) and
      // discovered-but-not-synced ontology entries. The cache is the
      // needs_clarification availability list AND the B42 / B46 / B48
      // subscribed-project allowlist for `dkg_memory_import`, so
      // including non-locally-usable or system entries would advertise
      // targets the node cannot actually write to.
      //
      // B54: local private CGs are legitimately recorded as
      // `subscribed: false, synced: true` by `createContextGraph({
      // private: true })` (agent/src/dkg-agent.ts:2041-2045). B51's
      // original strict `subscribed === true` filter dropped these
      // and broke `dkg_memory_import` writes against legitimate
      // private targets. The relaxed filter uses `synced === true`
      // to accept both public-subscribed AND local-private while
      // still excluding system paranets and discovered-but-not-
      // synced entries.
      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: 'peer-b51' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(
            JSON.stringify({
              contextGraphs: [
                // Valid: public subscribed, synced, non-system → cached
                { id: 'research-public', subscribed: true, synced: true, isSystem: false },
                // System paranet → filtered out (isSystem)
                { id: 'ontology', subscribed: true, synced: true, isSystem: true },
                // Subscribed but not yet synced (gossip subscribe lag) → filtered out
                { id: 'research-syncing', subscribed: true, synced: false, isSystem: false },
                // Reserved graph name → filtered out (pre-existing guard)
                { id: 'agent-context', subscribed: true, synced: true, isSystem: false },
                // B54 case: local PRIVATE CG, subscribed=false, synced=true → cached
                { id: 'research-private', subscribed: false, synced: true, isSystem: false },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });

      try {
        plugin.register({
          config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
          registrationMode: 'full' as const,
          registerTool: () => {},
          registerHook: () => {},
          registerMemoryCapability: () => {},
          on: () => {},
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
        } as unknown as OpenClawPluginApi);

        // Drain the register-time refresh.
        for (let i = 0; i < 50; i++) await Promise.resolve();

        const resolver = (plugin as any).memorySessionResolver;
        const cached = resolver.listAvailableContextGraphs();
        // Only the two synced + non-system + non-reserved entries:
        // public subscribed and local private. Ontology (system),
        // subscribed-but-unsynced, and agent-context (reserved) are
        // all filtered.
        expect(cached).toEqual(['research-public', 'research-private']);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('context-graph cache refresh in-flight promise sharing (Codex B49)', () => {
    // B49: `refreshMemoryResolverState` used to gate concurrent calls
    // with a boolean that returned immediately while a background
    // refresh was in flight. That broke
    // `refreshAvailableContextGraphs` awaiters — they would resolve
    // against the still-stale cache instead of awaiting the in-flight
    // refresh. The fix tracks the refresh promise and returns it to
    // concurrent callers so all awaiters observe the populated cache.

    it('concurrent refreshAvailableContextGraphs calls share a single daemon fetch and all observe the populated cache', async () => {
      // Gate the context-graph listing so we can start a second
      // concurrent refresh while the first is in flight.
      let releaseListGate!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseListGate = resolve;
      });
      let listCallCount = 0;

      const fetchFn = vi.fn(async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: 'peer-b49' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          listCallCount++;
          await listGate;
          // B51 + B54: the refresh now filters on `synced: true` and
          // `!isSystem`, so the mock entry has to carry both flags to
          // end up in the cache.
          return new Response(
            JSON.stringify({
              contextGraphs: [
                { id: 'research-b49-fresh', subscribed: true, synced: true, isSystem: false },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchFn as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });

      try {
        plugin.register({
          config: { plugins: { slots: { memory: 'adapter-openclaw' } } },
          registrationMode: 'full' as const,
          registerTool: () => {},
          registerHook: () => {},
          registerMemoryCapability: () => {},
          on: () => {},
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
        } as unknown as OpenClawPluginApi);

        // Register-time fire-and-forget refresh is in flight and blocked
        // on the gate. Drain enough microtasks to let the
        // /api/context-graph/list call reach the gate.
        for (let i = 0; i < 50; i++) await Promise.resolve();
        expect(listCallCount).toBe(1);

        const resolver = (plugin as any).memorySessionResolver;
        // Cache is still empty because the in-flight refresh is parked.
        expect(resolver.listAvailableContextGraphs()).toEqual([]);

        // Start a second concurrent refresh via the resolver. This is
        // the B49 regression path: previously this call would return
        // immediately with the stale (empty) cache because the boolean
        // guard short-circuited the duplicate call.
        const secondRefreshPromise = resolver.refreshAvailableContextGraphs();

        // Release the gate so the in-flight daemon fetch completes.
        releaseListGate();

        // Await the second refresh — it MUST observe the populated
        // cache, not the stale one. And the daemon fetch must have
        // only fired once (both callers share the promise).
        const secondResult = await secondRefreshPromise;
        expect(secondResult).toEqual(['research-b49-fresh']);
        expect(listCallCount).toBe(1);
        expect(resolver.listAvailableContextGraphs()).toEqual(['research-b49-fresh']);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });
  });
});
