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


  it('clears the stored local-agent bridge state when the channel is hot-disabled', async () => {
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
                bridgeUrl: 'http://127.0.0.1:9201',
                healthUrl: 'http://127.0.0.1:9201/health',
              },
              runtime: { status: 'ready', ready: true, lastError: null },
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
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      };

      plugin.register(mockApi);
      await vi.waitFor(() => {
        const connectCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/connect'),
        );
        expect(connectCall).toBeTruthy();
      });

      plugin.updateConfig({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      });
      plugin.register(mockApi);

      await vi.waitFor(() => {
        const clearCall = fetchCalls.find((call) =>
          String(call[0]).includes('/api/local-agent-integrations/openclaw') &&
          call[1]?.method === 'PUT',
        );
        expect(clearCall).toBeTruthy();
      });
      const clearCall = fetchCalls.find((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') &&
        call[1]?.method === 'PUT',
      );
      const clearBody = JSON.parse(String(clearCall?.[1]?.body));
      expect(clearBody).toMatchObject({
        enabled: false,
        transport: { kind: 'openclaw-channel' },
        capabilities: {
          localChat: false,
          chatAttachments: false,
          connectFromUi: false,
        },
        metadata: {
          channelId: 'dkg-ui',
          registrationMode: 'full',
          transportMode: 'disabled',
        },
        runtime: {
          status: 'configured',
          ready: false,
          lastError: 'DKG UI channel disabled by adapter config',
        },
      });
      expect(clearBody.transport.bridgeUrl).toBeUndefined();
      expect(clearBody.transport.healthUrl).toBeUndefined();
    } finally {
      await plugin?.stop();
      globalThis.fetch = originalFetch;
    }
  });
});
