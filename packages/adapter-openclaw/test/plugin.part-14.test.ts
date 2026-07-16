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


  it('T359 - only supported typed agent_end plus internal message hooks are wired to ChatTurnWriter', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = new Map<string, any[]>([
      ['message:received', []],
      ['message:sent', []],
    ]);
    const workspaceDir = fs.mkdtempSync(path.join(tmpdir(), 'dkg-node-t359-typed-'));
    const typedHandlers = new Map<string, (...args: any[]) => unknown>();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        typedHandlers.set(event, handler);
      }) as any,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      workspaceDir,
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      const client = (plugin as any).client;
      client.storeChatTurn = vi.fn().mockResolvedValue(undefined);

      expect(typedHandlers.has('agent_end')).toBe(true);
      expect(typedHandlers.has('agent.end')).toBe(false);
      expect(typedHandlers.has('message_received')).toBe(false);
      expect(typedHandlers.has('message_sent')).toBe(false);
      expect(typedHandlers.has('message.received')).toBe(false);
      expect(typedHandlers.has('message.sent')).toBe(false);

      typedHandlers.get('agent_end')!(
        { messages: [{ role: 'user', content: 'healthy q' }, { role: 'assistant', content: 'healthy a' }] },
        { channelId: 'telegram', sessionKey: 'healthy-sk' },
      );
      await (plugin as any).chatTurnWriter.flush();
      expect(client.storeChatTurn).toHaveBeenCalledTimes(1);

      const hookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL] as Map<string, any[]>;
      hookMap.get('message:received')![0]({
        sessionKey: 'internal-sk',
        context: { channelId: 'telegram', conversationId: 'chat-1', content: 'internal q' },
      });
      await hookMap.get('message:sent')![0]({
        sessionKey: 'internal-sk',
        context: { channelId: 'telegram', conversationId: 'chat-1', content: 'internal a', success: true },
      });
      await (plugin as any).chatTurnWriter.flush();
      expect(client.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(client.storeChatTurn.mock.calls[1][1]).toBe('internal q');
      expect(client.storeChatTurn.mock.calls[1][2]).toBe('internal a');
    } finally {
      await plugin.stop();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
  });


  it('T359 - gateway-preloaded internal handlers do not suppress adapter handlers', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    const hookMap = new Map<string, any[]>([
      ['message:received', [vi.fn()]],
      ['message:sent', [vi.fn()]],
    ]);
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = hookMap;
    const plugin = new DkgNodePlugin({
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
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      expect(hookMap.get('message:received')).toHaveLength(2);
      expect(hookMap.get('message:sent')).toHaveLength(2);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
  });


  it('T359 - replacing the internal hook map triggers same-api reinstall', async () => {
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    const firstMap = new Map<string, any[]>([
      ['message:received', []],
      ['message:sent', []],
    ]);
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = firstMap;
    const plugin = new DkgNodePlugin({
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
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register(mockApi);
      expect(firstMap.get('message:received')).toHaveLength(1);
      expect(firstMap.get('message:sent')).toHaveLength(1);

      const replacementMap = new Map<string, any[]>([
        ['message:received', []],
        ['message:sent', []],
      ]);
      (globalThis as any)[INTERNAL_HOOK_SYMBOL] = replacementMap;
      plugin.register(mockApi);
      expect(replacementMap.get('message:received')).toHaveLength(1);
      expect(replacementMap.get('message:sent')).toHaveLength(1);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      else (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
    }
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


  it('marks session_end and internal message hooks as rare-fire so startup timeout diagnostics stay quiet', async () => {
    vi.useFakeTimers();
    const previousHookMap = (globalThis as any)[INTERNAL_HOOK_SYMBOL];
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = new Map();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: vi.fn(),
      on: vi.fn(),
      logger,
    };

    try {
      plugin.register(mockApi);
      await vi.advanceTimersByTimeAsync(30_000);

      const debugMessages = logger.debug.mock.calls.map((args) => String(args[0]));
      const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
      expect(debugMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:received"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("typed:before_compaction"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("typed:before_reset"))).toBe(true);
      expect(warnMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:received"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:before_compaction"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:before_reset"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("typed:agent_end"))).toBe(false);
      expect(debugMessages.some((msg) => msg.includes("typed:agent_end"))).toBe(true);
    } finally {
      await plugin.stop();
      if (previousHookMap === undefined) {
        delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      } else {
        (globalThis as any)[INTERNAL_HOOK_SYMBOL] = previousHookMap;
      }
      vi.useRealTimers();
    }
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
      expect(normalized).toContain('/tmp/dkg-t26-workspace/.dkg-adapter/chat-turn-watermarks.json');
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
        '/tmp/dkg-t26-workspace-ws/.dkg-adapter/chat-turn-watermarks.json',
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
    // fallback prefers the workspace-local `.dkg-adapter` default when present.
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
      // ChatTurnWriter stores setup/workspace default watermarks directly
      // under `.dkg-adapter`, without the legacy nested subdirectory.
      const watermarkPath: string = (ctw as any).watermarkFilePath;
      // Normalize separators for cross-platform path comparison (Windows
      // path.join produces backslashes from a forward-slash workspaceDir).
      const normalized = watermarkPath.replace(/\\/g, '/');
      expect(normalized).toContain('/tmp/dkg-r162-workspace/.dkg-adapter/chat-turn-watermarks.json');
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
});
