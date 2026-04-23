import { describe, it, expect, vi } from 'vitest';
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
    expect(toolNames).toContain('memory_search');
    expect(registeredTools.length).toBe(14);
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
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );
      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        id: 'openclaw',
        enabled: true,
        transport: { kind: 'openclaw-channel' },
        manifest: {
          packageName: '@origintrail-official/dkg-adapter-openclaw',
          setupEntry: './setup-entry.mjs',
        },
        metadata: {
          channelId: 'dkg-ui',
          registrationMode: 'full',
        },
      });
      expect(readyCall).toBeTruthy();
      const readyBody = JSON.parse(String(readyCall?.[1]?.body));
      expect(readyBody.enabled).toBe(true);
      expect(readyBody.capabilities).toMatchObject({
        localChat: true,
        connectFromUi: true,
        dkgPrimaryMemory: true,
      });
      expect(readyBody.manifest).toEqual({
        packageName: '@origintrail-official/dkg-adapter-openclaw',
        setupEntry: './setup-entry.mjs',
      });
      expect(readyBody.setupEntry).toBe('./setup-entry.mjs');
      expect(readyBody.transport.kind).toBe('openclaw-channel');
      expect(readyBody.transport.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(readyBody.runtime).toMatchObject({
        status: 'ready',
        ready: true,
        lastError: null,
      });
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });

  it('persists gatewayUrl on first registration when gateway routing is available', async () => {
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
            port: 19789,
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
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:19789',
        },
        metadata: {
          transportMode: 'gateway+bridge',
        },
      });
      expect(readyCall).toBeTruthy();
      expect(JSON.parse(String(readyCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          gatewayUrl: 'http://127.0.0.1:19789',
        },
      });
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
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      const readyCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw')
        && call[1]?.method === 'PUT',
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toEqual({
        id: 'openclaw',
        enabled: true,
        description: 'Connect a local OpenClaw agent through the DKG node.',
        transport: {
          kind: 'openclaw-channel',
        },
        capabilities: expect.objectContaining({
          localChat: true,
          connectFromUi: true,
          dkgPrimaryMemory: true,
          wmImportPipeline: true,
          nodeServedSkill: true,
        }),
        manifest: {
          packageName: '@origintrail-official/dkg-adapter-openclaw',
          setupEntry: './setup-entry.mjs',
        },
        setupEntry: './setup-entry.mjs',
        metadata: expect.objectContaining({
          channelId: 'dkg-ui',
          registrationMode: 'full',
          transportMode: 'bridge',
        }),
        runtime: expect.objectContaining({
          status: 'connecting',
          ready: false,
          lastError: null,
        }),
      });
      expect(readyCall).toBeTruthy();
      expect(JSON.parse(String(readyCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          healthUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/health$/),
        },
      });
      expect(JSON.parse(String(readyCall?.[1]?.body)).transport.gatewayUrl).toBeUndefined();
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

  it('preserves a stored bridgeUrl and healthUrl when the current bridge has not bound a port yet', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 25));

      const connectCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );

      expect(connectCall).toBeTruthy();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toMatchObject({
        transport: {
          kind: 'openclaw-channel',
          bridgeUrl: 'http://127.0.0.1:9201',
          healthUrl: 'http://127.0.0.1:9201/health',
        },
      });
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

    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]?.[0])).toContain('dkg-node.game.enabled');
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

      // Let the best-effort probes kicked off inside register() flush so
      // nodePeerId is populated before we exercise the runtime path below.
      // Codex B59: without this, the peer-ID probe is still pending and
      // getMemorySearchManager returns { manager: null, error } — and the
      // original `toBeDefined()` assertion passed only because `null` is
      // "defined" in vitest's loose sense, silently masking the real
      // B12 null-manager fallback path.
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

    it('lazily re-probes peer ID when the register-time probe failed', async () => {
      // First /api/status fire rejects (daemon not ready). Second fire
      // (triggered lazily by a resolver call) succeeds.
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
        // Drain the register-time probe (it fires-and-forgets).
        await flushMicrotasks();
        // Register-time probe saw a 503, so peerId is still undefined and
        // any call to getDefaultAgentAddress reflects that.
        expect((plugin as any).nodePeerId).toBeUndefined();
        const resolver = (plugin as any).memorySessionResolver;
        const firstCall = resolver.getDefaultAgentAddress();
        expect(firstCall).toBeUndefined();
        // That call triggered a lazy re-probe. Let it complete.
        await flushMicrotasks();
        // Now the cached peer ID is populated; subsequent resolver calls
        // see it immediately, no further fetch fire.
        const statusCallsBefore = statusCalls.length;
        const secondCall = resolver.getDefaultAgentAddress();
        expect(secondCall).toBe('did:dkg:agent:test-peer');
        expect(statusCalls.length).toBe(statusCallsBefore);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('debounces concurrent resolver fires to a single in-flight probe', async () => {
      // All /api/status fires succeed. But a single burst of 10 resolver
      // calls before any drain must produce exactly ONE fetch to
      // /api/status (1 from register + 0 from the burst, since the
      // register-time probe is in flight and the burst should await it).
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
        // The register-time probe has already started and is parked on
        // the gate. 10 resolver calls in a burst must NOT each fire a
        // new /api/status because the in-flight probe guard collapses
        // them onto the same pending promise.
        const resolver = (plugin as any).memorySessionResolver;
        for (let i = 0; i < 10; i++) {
          resolver.getDefaultAgentAddress();
        }
        // Only one /api/status call fired (the register-time one).
        expect(statusCalls.length).toBe(1);
        // Release the gate; drain; probe completes.
        resolveStatus!();
        await flushMicrotasks();
        // After drain, the cache is populated; a new resolver call returns
        // the peerId without firing a third /api/status.
        const finalCall = resolver.getDefaultAgentAddress();
        expect(finalCall).toBe('did:dkg:agent:debounced');
        expect(statusCalls.length).toBe(1);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('recovers on every subsequent call when /api/status keeps failing', async () => {
      // Permanent failure. Every resolver call returns undefined (so B2's
      // retryable clarification surfaces to the caller), and every call
      // triggers a re-probe attempt — but the in-flight debounce means
      // bursts within a single drain window collapse to one fetch fire.
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
        // One call from register-time probe (that saw the 503).
        const initialCalls = statusCalls.length;
        expect(initialCalls).toBeGreaterThanOrEqual(1);

        const resolver = (plugin as any).memorySessionResolver;

        // Call the resolver, let its probe resolve (to 503), call again.
        // Each cycle should trigger ONE new /api/status call — not
        // zero (previous "soft-brick" behavior), not ten.
        expect(resolver.getDefaultAgentAddress()).toBeUndefined();
        await flushMicrotasks();
        const afterFirstLazy = statusCalls.length;
        expect(afterFirstLazy).toBe(initialCalls + 1);

        expect(resolver.getDefaultAgentAddress()).toBeUndefined();
        await flushMicrotasks();
        const afterSecondLazy = statusCalls.length;
        expect(afterSecondLazy).toBe(initialCalls + 2);

        // Never throws, never loops forever. Just keeps returning
        // undefined and keeps re-probing on demand.
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
      }
    });

    it('does NOT re-probe when the register-time probe already succeeded', async () => {
      // Register-time probe hits /api/status once and resolves. Burst of
      // resolver calls afterwards hits exactly ZERO additional /api/status
      // fires, because `nodePeerId` is cached.
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
        const resolver = (plugin as any).memorySessionResolver;
        for (let i = 0; i < 20; i++) {
          expect(resolver.getDefaultAgentAddress()).toBe('did:dkg:agent:happy-path');
        }
        expect(statusCalls.length).toBe(baselineCalls);
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
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
