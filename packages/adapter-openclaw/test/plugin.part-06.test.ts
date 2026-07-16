import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { toEip55Checksum } from '@origintrail-official/dkg-core';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { DkgChannelPlugin } from '../src/DkgChannelPlugin.js';
import { ChatTurnWriter } from '../src/ChatTurnWriter.js';
import { INTERNAL_HOOK_SYMBOL } from '../src/HookSurface.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

describe("DkgNodePlugin", () => {


  it('updates gateway status when refreshed config disables the channel module', async () => {
    const registerSpy = vi.spyOn(DkgChannelPlugin.prototype, 'register').mockImplementation(() => {});
    const stopSpy = vi.spyOn(DkgChannelPlugin.prototype, 'stop').mockResolvedValue(undefined);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: true, port: 9201 },
        memory: { enabled: false },
      });
      (plugin as any).client = {};
      (plugin as any).chatTurnWriter = {} as any;
      const mockApi = {
        config: {},
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;

      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

      expect(stopSpy).toHaveBeenCalledWith({ updateGatewayStatus: true });
      await (plugin as any).channelPluginStopInFlight;
      expect((plugin as any).channelPlugin).toBeNull();
      expect(registerSpy).toHaveBeenCalledTimes(1);
    } finally {
      registerSpy.mockRestore();
      stopSpy.mockRestore();
    }
  });


  it('clears a registered memory capability when refreshed config disables memory', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
    const registerMemoryCapability = vi.fn();
    const mockApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const activeCapability = registerMemoryCapability.mock.calls[0][0];
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    const disabledCapability = registerMemoryCapability.mock.calls[1][0];
    expect(disabledCapability).not.toBe(activeCapability);
    expect(disabledCapability.promptBuilder?.({ availableTools: new Set(), citationsMode: undefined })).toEqual([]);
    const result = await disabledCapability.runtime.getMemorySearchManager({});
    expect(result.manager).toBeNull();
    expect(result.error).toContain('disabled');
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();

    oldMemoryPlugin.reAssertCapability();
    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
  });


  it('rebuilds a registered memory capability when updateConfig refreshes the daemon client', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
    const registerMemoryCapability = vi.fn();
    const mockApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const initialCapability = registerMemoryCapability.mock.calls[0][0];
    (plugin as any).initialized = true;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9300',
      memory: { enabled: true },
      channel: { enabled: false },
    });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(2);
    expect(registerMemoryCapability.mock.calls[1][0]).not.toBe(initialCapability);
  });


  it('clears previous memory registry without stamping a stale registered api when ownership is unknown', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
    const initialRegisterMemoryCapability = vi.fn();
    const currentRegisterMemoryCapability = vi.fn();
    const initialApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: initialRegisterMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;
    const currentDirectApi = {
      config: {
        memory: { enabled: false },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability: currentRegisterMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).registerIntegrationModules(initialApi, { enableFullRuntime: true });
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    plugin.updateConfig({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(currentDirectApi, { enableFullRuntime: true });

    // T364 — Pre-fix this test asserted `currentRegisterMemoryCapability`
    // NOT to be called when the prior registration was merged-config. That
    // was the bug Codex flagged: the user explicitly disabling memory in
    // direct config saw local bookkeeping cleared but the gateway slot
    // kept the stale DKG capability live. Post-fix, the disabled capability
    // is stamped on the CURRENT api (`currentDirectApi`, NOT the stale
    // `initialApi`) so the gateway slot stops routing memory through DKG.
    expect(currentRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();
    oldMemoryPlugin.reAssertCapability();
    expect(initialRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(currentRegisterMemoryCapability).toHaveBeenCalledTimes(1);
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
  });


  it('does not clear another plugin memory slot when refreshed config disables memory', () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    (plugin as any).client = {};
    (plugin as any).refreshMemoryResolverState = vi.fn(() => Promise.resolve());
    const registerMemoryCapability = vi.fn();
    const mockApi = {
      config: {
        plugins: {
          slots: {
            memory: 'adapter-openclaw',
          },
        },
      },
      registerTool: () => {},
      registerHook: () => {},
      registerMemoryCapability,
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });
    const oldMemoryPlugin = (plugin as any).memoryPlugin;

    (mockApi.config as any).plugins.slots.memory = 'some-other-memory-plugin';
    (plugin as any).initialized = true;
    plugin.updateConfig({
      daemonUrl: 'http://localhost:9300',
      memory: { enabled: false },
      channel: { enabled: false },
    });
    (plugin as any).registerIntegrationModules(mockApi, { enableFullRuntime: true });

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    expect((plugin as any).memoryPlugin).toBeNull();
    expect((plugin as any).memoryResolverApi).toBeNull();
    expect(oldMemoryPlugin.isRegistered()).toBe(false);
    oldMemoryPlugin.reAssertCapability();
    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
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
    expect(toolNames).toContain('dkg_query');
    expect(toolNames).toContain('dkg_find_agents');
    expect(toolNames).toContain('dkg_send_message');
    expect(toolNames).toContain('dkg_read_messages');
    expect(toolNames).toContain('dkg_invoke_skill');
    // rc.17 knowledge-asset lifecycle family (CONTRACT §2): the 10 renamed
    // dkg_assertion_*/import_artifact_*/semantic_enrichment_* tools plus the 3
    // new lifecycle verbs (finalize / publish / pull_from). No dkg_assertion_*
    // back-compat aliases (clean cut, CONTRACT §2).
    expect(toolNames).toContain('dkg_knowledge_asset_create');
    expect(toolNames).toContain('dkg_knowledge_asset_write');
    expect(toolNames).toContain('dkg_knowledge_asset_finalize');
    expect(toolNames).toContain('dkg_knowledge_asset_share');
    expect(toolNames).toContain('dkg_knowledge_asset_publish');
    expect(toolNames).toContain('dkg_knowledge_asset_pull_from');
    expect(toolNames).toContain('dkg_knowledge_asset_discard');
    expect(toolNames).toContain('dkg_knowledge_asset_import_file');
    expect(toolNames).toContain('dkg_knowledge_asset_query');
    expect(toolNames).toContain('dkg_knowledge_asset_history');
    expect(toolNames).toContain('dkg_knowledge_asset_import_artifact_resolve');
    expect(toolNames).toContain('dkg_knowledge_asset_import_artifact_read_markdown');
    expect(toolNames).toContain('dkg_knowledge_asset_semantic_enrichment_write');
    // The legacy dkg_assertion_* / dkg_import_artifact_* / dkg_semantic_enrichment_*
    // names are gone (no back-compat aliases — CONTRACT §2).
    expect(toolNames).not.toContain('dkg_assertion_create');
    expect(toolNames).not.toContain('dkg_assertion_promote');
    expect(toolNames).not.toContain('dkg_import_artifact_resolve');
    expect(toolNames).not.toContain('dkg_semantic_enrichment_write');
    expect(toolNames).toContain('dkg_sub_graph_create');
    expect(toolNames).toContain('dkg_sub_graph_list');
    // The legacy publish-bridge + loose-SWM tools were removed (#1087 cleanup):
    // dkg_publish (direct-publish bypass), dkg_shared_memory_publish (SWM-bridge),
    // and dkg_share (loose-SWM write). The canonical per-KA publish survives and the
    // one-shot lives on the EXTENDED dkg_knowledge_asset_create (quads + also_share_swm) [D3].
    expect(toolNames).not.toContain('dkg_publish');
    expect(toolNames).not.toContain('dkg_shared_memory_publish');
    expect(toolNames).not.toContain('dkg_share');
    expect(toolNames).toContain('dkg_knowledge_asset_publish');
    expect(toolNames).toContain('dkg_knowledge_asset_create');
    // Legacy V9 contextGraph aliases are removed as of v10-rc.
    expect(toolNames).not.toContain('dkg_list_contextGraphs');
    expect(toolNames).not.toContain('dkg_contextGraph_create');
    // memory_search added by this feature branch (W2 — agent-callable recall button).
    expect(toolNames).toContain('memory_search');
    // Keep this resilient as main adds new exported tools; this test already
    // asserts presence of the critical tool set above. The #1087 cleanup removed
    // 3 tools (dkg_publish / dkg_shared_memory_publish / dkg_share) and added none
    // (the one-shot extends dkg_knowledge_asset_create), lowering the floor by 3.
    expect(registeredTools.length).toBeGreaterThanOrEqual(32);
  });


  it('new dkg_knowledge_asset_* and dkg_sub_graph_* tools have the expected schema shape', () => {
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

    expectRequired('dkg_knowledge_asset_create', ['context_graph_id', 'name']);
    expectRequired('dkg_context_graph_invite', ['context_graph_id', 'peer_id']);
    expectRequired('dkg_participant_add', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_remove', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_participant_list', ['context_graph_id']);
    expectRequired('dkg_join_request_list', ['context_graph_id']);
    expectRequired('dkg_join_request_approve', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_join_request_reject', ['context_graph_id', 'agent_address']);
    expectRequired('dkg_knowledge_asset_write', ['context_graph_id', 'name', 'quads']);
    expectRequired('dkg_knowledge_asset_finalize', ['context_graph_id', 'name']);
    expectRequired('dkg_knowledge_asset_share', ['context_graph_id', 'name']);
    expectRequired('dkg_knowledge_asset_publish', ['context_graph_id', 'name']);
    expectRequired('dkg_knowledge_asset_pull_from', ['context_graph_id', 'name', 'layer']);
    expectRequired('dkg_knowledge_asset_discard', ['context_graph_id', 'name']);
    expectRequired('dkg_knowledge_asset_import_file', ['context_graph_id', 'name', 'file_path']);
    expectRequired('dkg_knowledge_asset_query', ['context_graph_id', 'name']);
    expectRequired('dkg_knowledge_asset_import_artifact_resolve', ['context_graph_id', 'assertion_uri']);
    expectRequired('dkg_knowledge_asset_import_artifact_read_markdown', ['context_graph_id', 'assertion_uri']);
    expectRequired('dkg_knowledge_asset_semantic_enrichment_write', ['context_graph_id', 'assertion_uri', 'semantic_quads']);
    expect(byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.parameters.properties).not.toHaveProperty('name');
    expect(byName.get('dkg_knowledge_asset_import_artifact_resolve')!.description).toMatch(/Optional validation\/debug helper/);
    expect(byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.description).toMatch(/Append model-derived semantic triples/);
    expect(byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.description).not.toMatch(/separate Working Memory assertion/);
    expect(byName.get('dkg_knowledge_asset_import_artifact_read_markdown')!.parameters.properties.max_bytes).toMatchObject({
      type: 'integer',
    });
    expect(byName.get('dkg_knowledge_asset_import_artifact_read_markdown')!.parameters.properties.max_bytes.description).toMatch(/positive integer/);
    expectRequired('dkg_knowledge_asset_history', ['context_graph_id', 'name']);

    // pull-from `layer` is constrained to swm|vm (CONTRACT §1 side-verbs).
    const pullFromLayer = byName.get('dkg_knowledge_asset_pull_from')!.parameters.properties.layer;
    expect(pullFromLayer.enum).toEqual(['swm', 'vm']);
    // publish must NOT expose author/selection overrides — the seal selects them
    // (CONTRACT §1 Stage5 / §3). It exposes only the finalized-publish options.
    const publishKaProps = byName.get('dkg_knowledge_asset_publish')!.parameters.properties;
    expect(publishKaProps).not.toHaveProperty('author_agent_address');
    expect(publishKaProps).not.toHaveProperty('pre_signed_author_attestation');
    expect(publishKaProps).not.toHaveProperty('entities');
    expect(publishKaProps).not.toHaveProperty('selection');
    expect(publishKaProps).toHaveProperty('publish_epochs');
    expect(publishKaProps).toHaveProperty('publisher_node_identity_id_override');
    // CONTRACT §D: clear-after is DROPPED from the per-asset publish tool — on
    // vm/publish it is graph-wide destructive (wipes other agents' SWM).
    expect(publishKaProps).not.toHaveProperty('clear_shared_memory_after');
    expect(publishKaProps).not.toHaveProperty('clear_after');
    // CONTRACT §G: per-KA publish can register the CG on-chain first —
    // vm/publish requires a registered CG.
    expect(publishKaProps).toHaveProperty('register_if_needed');
    // finalize surfaces the token-resolved author but NOT the raw pre-signed
    // attestation (colocated-agent attribution — CONTRACT §1 Stage3, by design).
    const finalizeProps = byName.get('dkg_knowledge_asset_finalize')!.parameters.properties;
    expect(finalizeProps).toHaveProperty('author_agent_address');
    expect(finalizeProps).not.toHaveProperty('pre_signed_author_attestation');
    expectRequired('dkg_sub_graph_create', ['context_graph_id', 'sub_graph_name']);
    expectRequired('dkg_sub_graph_list', ['context_graph_id']);

    for (const name of [
      'dkg_knowledge_asset_create',
      'dkg_knowledge_asset_write',
      'dkg_knowledge_asset_finalize',
      'dkg_knowledge_asset_share',
      'dkg_knowledge_asset_publish',
      'dkg_knowledge_asset_pull_from',
      'dkg_knowledge_asset_discard',
      'dkg_knowledge_asset_import_file',
      'dkg_knowledge_asset_query',
      'dkg_sub_graph_create',
    ]) {
      const description = byName.get(name)!.parameters.properties.context_graph_id.description;
      expect(description).toContain('dkg_list_context_graphs');
      expect(description).toContain('local-notes');
      expect(description).toContain('<curatorAddress>/<slug>');
      expect(description).toContain('Do not guess');
    }

    // dkg_knowledge_asset_write.quads is an array of {subject,predicate,object}
    // with NO per-quad `graph` (CONTRACT §0 invariant 2).
    const writeTool = byName.get('dkg_knowledge_asset_write')!;
    expect(writeTool.parameters.properties.quads.type).toBe('array');
    expect(writeTool.parameters.properties.quads.items).toBeDefined();
    expect(writeTool.parameters.properties.quads.items.properties).not.toHaveProperty('graph');

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
    expect(queryProps.view.description).toContain('verifiable-memory');
    // agent_address is exposed as an optional tool param for WM targeting.
    expect(queryProps.agent_address.type).toBe('string');
    expect(queryProps.agent_address.description).toMatch(/working-memory/i);

    const inviteTool = byName.get('dkg_context_graph_invite')!;
    expect(inviteTool.description).toMatch(/primary user-facing deliverable/i);
    expect(inviteTool.description).toMatch(/paste into Join/i);

    const addParticipantTool = byName.get('dkg_participant_add')!;
    expect(addParticipantTool.description).toMatch(/allowlisting alone is not the full UI join flow/i);

    const createIdDescription = byName.get('dkg_context_graph_create')!.parameters.properties.id.description;
    expect(createIdDescription).toContain('create-only');
    expect(createIdDescription).toContain('returned id');
  });


  // FIX X (#1076:2396 / Option A): the explicit-register route registers with the
  // daemon's DEFAULT publishPolicy and does NOT preserve a CG's stored custom
  // publishPolicy (daemon-side rehydration tracked in dkg#1085). After the #1087
  // cleanup the only publish tool with a `register_if_needed` knob is the canonical
  // per-KA `dkg_knowledge_asset_publish`, so the caveat must live there.
  it('register_if_needed publishPolicy caveat is present on the canonical per-KA publish tool', () => {
    const plugin = new DkgNodePlugin();
    const registeredTools: OpenClawTool[] = [];
    plugin.register({ config: {}, registerTool: (t) => registeredTools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
    const byName = new Map(registeredTools.map((t) => [t.name, t] as const));

    const desc = byName.get('dkg_knowledge_asset_publish')!.parameters.properties.register_if_needed.description as string;
    expect(desc).toContain('DEFAULT publishPolicy');
    expect(desc).toContain('OriginTrail/dkg#1085');
    // The legacy publish-bridge tools that used to carry / omit this caveat are gone.
    expect(byName.has('dkg_publish')).toBe(false);
    expect(byName.has('dkg_shared_memory_publish')).toBe(false);
  });


  // ---------------------------------------------------------------------------
  // No v9 back-compat: v10-rc is the first product release. Any v9-era field
  // (`contextGraph_id`, stringified `include_shared_memory`, etc.) is out of scope
  // for the public tool surface. Handlers and schemas only accept the V10
  // shape. Strict JSON-schema validators and permissive hosts behave the
  // same: a stray legacy field is simply ignored (not a special-cased error),
  // and `context_graph_id` is the single source of truth on every tool that
  // needs it.
  // ---------------------------------------------------------------------------

  it('dkg_subscribe / dkg_knowledge_asset_publish / dkg_query do not advertise or honor the v9 contextGraph_id alias', () => {
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
    for (const name of ['dkg_subscribe', 'dkg_knowledge_asset_publish', 'dkg_query'] as const) {
      const props = byName.get(name)!.parameters.properties;
      expect(props).not.toHaveProperty('contextGraph_id');
    }
  });
});
