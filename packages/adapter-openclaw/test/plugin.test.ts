import { describe, it, expect } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
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

  it('registers session_end hook and all 11 tools via register()', () => {
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

    expect(registeredHooks).toContainEqual({ event: 'session_end', name: 'dkg-node-stop' });

    const toolNames = registeredTools.map(t => t.name);
    expect(toolNames).toContain('dkg_status');
    expect(toolNames).toContain('dkg_wallet_balances');
    expect(toolNames).toContain('dkg_list_context_graphs');
    expect(toolNames).toContain('dkg_context_graph_create');
    expect(toolNames).toContain('dkg_subscribe');
    expect(toolNames).toContain('dkg_publish');
    expect(toolNames).toContain('dkg_query');
    expect(toolNames).toContain('dkg_find_agents');
    expect(toolNames).toContain('dkg_send_message');
    expect(toolNames).toContain('dkg_read_messages');
    expect(toolNames).toContain('dkg_invoke_skill');
    expect(toolNames).toContain('dkg_list_paranets');
    expect(toolNames).toContain('dkg_paranet_create');
    expect(registeredTools.length).toBe(13);
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
});
