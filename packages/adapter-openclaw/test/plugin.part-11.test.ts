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


  it('retries only disabled-channel cleanup when both memory and channel are disabled', async () => {
    // A disabled channel still retries the cleanup path so it can clear stale
    // bridge state after daemon cold-start races. It must not run startup
    // re-registration or reconnect the bridge while both integrations are off.
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
      // Advance a full minute. Disabled cleanup retries at 5s, 10s, then 20s;
      // the 40s follow-up lands after this window.
      await vi.advanceTimersByTimeAsync(60_000);

      const getCalls = fakeFetch.mock.calls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/openclaw') && call[1]?.method === 'GET',
      );
      const connectCalls = fakeFetch.mock.calls.filter((call) =>
        String(call[0]).includes('/api/local-agent-integrations/connect'),
      );
      expect(getCalls).toHaveLength(4);
      expect(connectCalls).toHaveLength(0);
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
});
