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


  describe('node agent address identity probe (#324)', () => {
    const ETH_PRIMARY_LC = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
    const ETH_SECONDARY_LC = '0x949ec97ab4ed1c9fb4c9a70c2dd368065d817b0c';
    const ETH_PRIMARY = toEip55Checksum(ETH_PRIMARY_LC);

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

    function identityResult(agentAddress: string) {
      return {
        ok: true,
        identity: {
          agentAddress,
          agentDid: `did:dkg:agent:${agentAddress}`,
          name: 'test-agent',
          peerId: '12D3KooWDaemonPeerFromIdentity',
          nodeIdentityId: '0',
        },
      };
    }

    let tempHome: string;
    let prevDkgHome: string | undefined;

    beforeEach(() => {
      tempHome = path.join(require('os').tmpdir(), `dkg-node-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(tempHome, { recursive: true });
      prevDkgHome = process.env.DKG_HOME;
      process.env.DKG_HOME = tempHome;
    });

    afterEach(() => {
      if (prevDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = prevDkgHome;
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function installIdentityClient(plugin: DkgNodePlugin, response: unknown): ReturnType<typeof vi.fn> {
      const spy = vi.fn().mockResolvedValue(response);
      (plugin as any).client = { getAgentIdentity: spy };
      return spy;
    }

    function attachResolverApi(plugin: DkgNodePlugin, api: OpenClawPluginApi): void {
      (plugin as any).memoryResolverApi = api;
      (plugin as any).dkgHome = tempHome;
    }

    function writePoisonKeystore(): void {
      fs.writeFileSync(
        path.join(tempHome, 'agent-keystore.json'),
        JSON.stringify({
          [ETH_PRIMARY_LC]: { authToken: 'agent-token-that-must-not-be-read' },
          [ETH_SECONDARY_LC]: { authToken: 'second-token-that-would-have-triggered-multi-agent-branch' },
        }),
      );
    }

    it('caches the daemon default agent from the HTTP identity probe and ignores local keystore content', async () => {
      writePoisonKeystore();
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        const spy = installIdentityClient(plugin, identityResult(ETH_PRIMARY));

        await (plugin as any).ensureNodeAgentAddress();

        const resolver = (plugin as any).memorySessionResolver;
        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(resolver.getDefaultAgentAddress()).toBe(ETH_PRIMARY);
        expect(resolver.getSession(undefined)?.agentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toEqual([]);
      } finally {
        await plugin.stop();
      }
    });

    it('probes daemon identity for non-local daemonUrl instead of skipping to local keystore logic', async () => {
      writePoisonKeystore();
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://daemon.example.com:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        const spy = installIdentityClient(plugin, identityResult(ETH_PRIMARY));

        await (plugin as any).ensureNodeAgentAddress();

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledWith();
      } finally {
        await plugin.stop();
      }
    });

    it('debounces concurrent daemon identity probes', async () => {
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      try {
        attachResolverApi(plugin, api);
        const spy = vi.fn(async () => {
          await gate;
          return identityResult(ETH_PRIMARY);
        });
        (plugin as any).client = { getAgentIdentity: spy };

        const first = (plugin as any).ensureNodeAgentAddress();
        const second = (plugin as any).ensureNodeAgentAddress();
        expect(spy).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await plugin.stop();
      }
    });

    it('warns on failed identity probe and keeps the nodePeerId fallback available', async () => {
      const api = makeMockApi();
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        attachResolverApi(plugin, api);
        (plugin as any).nodePeerId = '12D3KooWPeerFallback';
        installIdentityClient(plugin, { ok: false, error: '401 Unauthorized' });

        await (plugin as any).ensureNodeAgentAddress();

        const resolver = (plugin as any).memorySessionResolver;
        expect((plugin as any).nodeAgentAddress).toBeUndefined();
        expect(resolver.getDefaultAgentAddress()).toBe('12D3KooWPeerFallback');
        const warnCalls = (api.logger.warn as any).mock.calls.map((c: any) => String(c[0]));
        expect(warnCalls.some((m: string) => m.includes('/api/agent/identity probe failed'))).toBe(true);
        expect(warnCalls.some((m: string) => m.includes('node API token'))).toBe(true);
        expect(warnCalls.some((m: string) => m.includes('keystore'))).toBe(false);
      } finally {
        await plugin.stop();
      }
    });

    it('keeps resolved dkgHome scoped to node-level auth.token loading only', async () => {
      delete process.env.DKG_HOME;

      const isolatedHome = path.join(require('os').tmpdir(), `dkg-t70-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const dkg = path.join(isolatedHome, '.dkg');
      const dkgDev = path.join(isolatedHome, '.dkg-dev');
      fs.mkdirSync(dkg, { recursive: true });
      fs.mkdirSync(dkgDev, { recursive: true });

      const prevHome = process.env.HOME;
      const prevUserProfile = process.env.USERPROFILE;
      const originalFetch = globalThis.fetch;
      process.env.HOME = isolatedHome;
      process.env.USERPROFILE = isolatedHome;

      globalThis.fetch = vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: '12D3KooWResolvedHomePeer' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/agent/identity')) {
          return new Response(JSON.stringify(identityResult(ETH_PRIMARY).identity), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      try {
        fs.writeFileSync(path.join(dkg, 'auth.token'), 'STALE-NPM-TOKEN');
        fs.writeFileSync(path.join(dkgDev, 'daemon.pid'), String(process.pid));

        const plugin = new DkgNodePlugin({
          daemonUrl: 'http://127.0.0.1:9200',
          memory: { enabled: true },
          channel: { enabled: false },
        });
        try {
          plugin.register(makeMockApi());
          expect((plugin as any).dkgHome).toBe(dkgDev);
          expect((plugin as any).client.apiToken).toBeUndefined();
        } finally {
          await plugin.stop();
        }
      } finally {
        globalThis.fetch = originalFetch;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });

    it('honors config.dkgHome for node-level auth.token without using agent-keystore identity auth', async () => {
      const customHome = path.join(require('os').tmpdir(), `dkg-custom-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(customHome, { recursive: true });
      fs.writeFileSync(path.join(customHome, 'auth.token'), 'CUSTOM-NODE-TOKEN');
      fs.writeFileSync(
        path.join(customHome, 'agent-keystore.json'),
        JSON.stringify({
          [ETH_PRIMARY_LC]: { authToken: 'agent-token-that-must-not-be-forwarded' },
          [ETH_SECONDARY_LC]: { authToken: 'second-agent-token-that-must-not-matter' },
        }),
      );

      const originalFetch = globalThis.fetch;
      const identityRequests: RequestInit[] = [];
      globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/api/status')) {
          return new Response(JSON.stringify({ peerId: '12D3KooWCustomHomePeer' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/agent/identity')) {
          identityRequests.push(init ?? {});
          return new Response(JSON.stringify(identityResult(ETH_PRIMARY).identity), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/api/context-graph/list')) {
          return new Response(JSON.stringify({ contextGraphs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://127.0.0.1:9200',
        dkgHome: customHome,
        memory: { enabled: true },
        channel: { enabled: false },
      });
      try {
        plugin.register(makeMockApi());
        expect((plugin as any).dkgHome).toBe(customHome);
        expect((plugin as any).client.apiToken).toBe('CUSTOM-NODE-TOKEN');

        await (plugin as any).ensureNodeAgentAddress();

        expect((plugin as any).nodeAgentAddress).toBe(ETH_PRIMARY);
        expect(identityRequests.length).toBeGreaterThanOrEqual(1);
        const auth = new Headers(identityRequests.at(-1)?.headers as HeadersInit).get('authorization');
        expect(auth).toBe('Bearer CUSTOM-NODE-TOKEN');
      } finally {
        await plugin.stop();
        globalThis.fetch = originalFetch;
        try { fs.rmSync(customHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  });


  describe('context-graph cache filter on synced + non-system (Codex B51 + B54)', () => {
    it('caches only entries with synced=true AND isSystem=false (includes local private CGs per B54)', async () => {
      // B51: `agent.listContextGraphs()` returns every known CG —
      // including system contextGraphs (ontology, agents registry) and
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
      // still excluding system contextGraphs and discovered-but-not-
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
                // System contextGraph → filtered out (isSystem)
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
