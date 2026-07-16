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
    expect(events).toContain('before_compaction');
    expect(events).toContain('before_reset');
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


  it('T338 - typed fires on one multi-phase surface suppress sibling timeout warnings', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    } as any);

    const makeApi = () => {
      const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
      const api = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: vi.fn(),
        registerMemoryCapability: vi.fn(),
        on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
        }),
        logger,
      } as unknown as OpenClawPluginApi;
      return { api, handlers };
    };

    const api1 = makeApi();
    const api2 = makeApi();
    const api3 = makeApi();

    try {
      plugin.register(api1.api);
      plugin.register(api2.api);
      plugin.register(api3.api);

      const writer = (plugin as any).chatTurnWriter;
      writer.onAgentEnd = vi.fn().mockResolvedValue(undefined);

      await api2.handlers.get('before_prompt_build')![0](
        { messages: [{ role: 'user', content: 'hello dkg' }] },
        { sessionKey: 's1' },
      );
      await api2.handlers.get('agent_end')![0](
        { messages: [{ role: 'user', content: 'hello dkg' }, { role: 'assistant', content: 'hi' }] },
        { sessionKey: 's1' },
      );

      await vi.advanceTimersByTimeAsync(30_000);

      const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
      expect(warnMessages.filter((msg) => msg.includes('typed:before_prompt_build'))).toHaveLength(0);
      expect(warnMessages.filter((msg) => msg.includes('typed:agent_end'))).toHaveLength(0);
      expect(writer.onAgentEnd).toHaveBeenCalledTimes(1);

      const peerCommittedSurfaces = Array.from((plugin as any).allHookSurfaces).filter((surface: any) => {
        const stats = surface.getDispatchStats();
        return stats['typed:agent_end']?.commitState === 'committed-by-peer-fire';
      });
      expect(peerCommittedSurfaces.length).toBeGreaterThan(0);
    } finally {
      await plugin.stop();
      vi.useRealTimers();
    }
  });


  it('T338 - full-mode typed install failures still warn loudly', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    } as any);
    const api: any = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: vi.fn(),
      logger,
    };

    plugin.register(api);

    const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('install FAILED: typed hook before_prompt_build'))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes('install FAILED: typed hook agent_end'))).toBe(true);
    const stats = (plugin as any).hookSurface.getDispatchStats();
    expect(stats['typed:before_prompt_build']?.installedVia).toBe('none');
    expect(stats['typed:agent_end']?.installedVia).toBe('none');
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
});
