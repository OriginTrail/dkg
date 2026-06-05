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


  it('T29 — runtime.state.resolveStateDir() returning the gateway homedir root is rejected; resolver falls through to workspace-derived branches', async () => {
    // Regression for an OpenClaw 2026.4.15 misbehavior observed in
    // production: the gateway's `runtime.state.resolveStateDir()`
    // returns the gateway's own `~/.openclaw` config root, which is
    // NOT workspace-scoped. Pre-fix the resolver trusted that value
    // (highest-priority branch) and wrote per-workspace chat-turn
    // watermarks into the shared homedir, conflating workspaces. The
    // T29 filter rejects values canonicalizing to the gateway homedir
    // and falls through to workspace-derived branches.
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const tmpRoot = require('os').tmpdir();
    const workspaceDir = path.join(tmpRoot, `dkg-t29-workspace-${Date.now()}`);
    const homeDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
        // Setup-default path pointing at the legacy `<workspace>/.openclaw`
        // location — exercises the redirect-to-`.dkg-adapter` branch
        // so we can verify the workspace-derived path wins after
        // T29 ignores the gateway's homedir runtime stateDir.
        stateDir: path.join(workspaceDir, '.openclaw'),
        stateDirSource: 'setup-default',
        installedWorkspace: workspaceDir,
      } as any);
      const api: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        workspaceDir,
        runtime: {
          state: {
            // Gateway homedir — must NOT be honored as the chat-turn
            // state dir even though it's the highest-priority branch.
            resolveStateDir: () => homeDir,
          },
        },
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(api);
      // Resolver must NOT pick the homedir; it should fall through to
      // the workspace branch (api.workspaceDir + .dkg-adapter).
      const resolved = (plugin as any).chatTurnWriterStateDir as string;
      expect(resolved.replace(/\\/g, '/')).toBe(
        path.join(workspaceDir, '.dkg-adapter').replace(/\\/g, '/'),
      );
      expect((plugin as any).chatTurnWriterStateDirSource).toBe('workspace');
      // No homedir-fallback warning emitted (the resolver picked a
      // proper workspace-scoped branch).
      const homedirWarnCall = (api.logger.warn as any).mock.calls.find((args: any[]) =>
        typeof args[0] === 'string' && args[0].includes('Could not resolve a workspace-scoped state dir'),
      );
      expect(homedirWarnCall).toBeUndefined();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
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
    const homeDir = path.join(require('os').homedir(), '.openclaw');
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
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));

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
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);

      // A second register() with the SAME apiBetter MUST re-trigger the
      // migration (proves the failure didn't poison the retry path).
      writer.setStateDir = vi.fn().mockImplementation(originalSetStateDir);
      plugin.register(apiBetter);
      // The migration was triggered again — `chatTurnWriterMigrationTarget`
      // should be set during the in-flight async work.
      const target = (plugin as any).chatTurnWriterMigrationTarget;
      expect(target?.replace(/\\/g, '/')).toBe(workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter');
      // Wait for retry to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
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
    const homeDir = path.join(require('os').homedir(), '.openclaw');
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
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(homeDir.replace(/\\/g, '/'));

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
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
      );
      // Wait for the fire-and-forget setStateDir to complete.
      await new Promise((r) => setTimeout(r, 100));
      // After success, chatTurnWriterStateDir flips and migration
      // target clears.
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter',
      );
      expect((plugin as any).chatTurnWriterMigrationTarget).toBe(null);
      const path2 = (writer2 as any).watermarkFilePath as string;
      expect(path2.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
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
});
