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


  it('T75 - setup-owned configured stateDir migrates when api.workspaceDir appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const staleInstalledWorkspace = path.join(require('os').tmpdir(), `dkg-t75-stale-first-${Date.now()}`);
    const staleConfigStateDir = path.join(staleInstalledWorkspace, '.openclaw');
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: staleInstalledWorkspace,
        stateDir: staleConfigStateDir,
        stateDirSource: 'setup-default',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithoutWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithoutWorkspace);
      const writer = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        path.join(staleInstalledWorkspace, '.dkg-adapter').replace(/\\/g, '/'),
      );

      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');
      const apiWithWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithWorkspace);
      const targetStateDir = path.join(workspaceDir, '.dkg-adapter');
      expect(setStateDirSpy).toHaveBeenCalledWith(targetStateDir, expect.objectContaining({ stateLayout: 'direct' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        targetStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(staleInstalledWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - in-flight stateDir migration guard canonicalizes target aliases', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const realWorkspace = path.join(require('os').tmpdir(), `dkg-t75-real-migration-${Date.now()}`);
    const aliasWorkspace = path.join(require('os').tmpdir(), `dkg-t75-alias-migration-${Date.now()}`);
    fs.mkdirSync(realWorkspace, { recursive: true });
    try {
      fs.symlinkSync(realWorkspace, aliasWorkspace, 'dir');
    } catch {
      return;
    }
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
      const writer = (plugin as any).chatTurnWriter;
      let resolveMigration: (() => void) | undefined;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir').mockImplementation(
        () => new Promise<void>((resolve) => { resolveMigration = resolve; }),
      );

      const apiWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir: realWorkspace,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWorkspace);
      expect(setStateDirSpy).toHaveBeenCalledTimes(1);

      const apiRuntimeAlias: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => path.join(aliasWorkspace, '.dkg-adapter') } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiRuntimeAlias);
      expect(setStateDirSpy).toHaveBeenCalledTimes(1);

      resolveMigration?.();
      await new Promise((r) => setTimeout(r, 50));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(aliasWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(realWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - setup-owned stateDir detection handles symlink aliases at runtime', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const realWorkspace = path.join(require('os').tmpdir(), `dkg-t75-real-workspace-${Date.now()}`);
    const aliasWorkspace = path.join(require('os').tmpdir(), `dkg-t75-alias-workspace-${Date.now()}`);
    const currentWorkspace = path.join(require('os').tmpdir(), `dkg-t75-current-after-alias-${Date.now()}`);
    fs.mkdirSync(realWorkspace, { recursive: true });
    fs.mkdirSync(currentWorkspace, { recursive: true });
    try {
      fs.symlinkSync(realWorkspace, aliasWorkspace, 'dir');
    } catch {
      return;
    }
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: realWorkspace,
        stateDir: path.join(aliasWorkspace, '.openclaw'),
        stateDirSource: 'setup-default',
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
        workspaceDir: currentWorkspace,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        currentWorkspace.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(aliasWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(realWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(currentWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - OPENCLAW_STATE_DIR still overrides configured stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-state-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-lower-${Date.now()}`);
    process.env.OPENCLAW_STATE_DIR = envStateDir;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
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
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        envStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - gateway runtime state API overrides env and configured stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const runtimeStateDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-state-${Date.now()}`);
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-lower-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-lowest-${Date.now()}`);
    process.env.OPENCLAW_STATE_DIR = envStateDir;
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
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
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        runtimeStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(runtimeStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - runtime state API .dkg-adapter root uses direct layout without workspaceDir metadata', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-direct-${Date.now()}`);
    const runtimeStateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::runtime-direct': { w: 11, b: 5 },
      }));
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
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(runtimeStateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(runtimeStateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::runtime-direct']).toEqual({ w: 11, b: 5 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - runtime state API returning the active .dkg-adapter root does not downgrade direct layout', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-same-direct-${Date.now()}`);
    const runtimeStateDir = path.join(workspaceDir, '.dkg-adapter');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithWorkspace: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithWorkspace);
      const writer = (plugin as any).chatTurnWriter;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');

      const apiRuntimeOnly: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiRuntimeOnly);

      expect(setStateDirSpy).not.toHaveBeenCalled();
      expect(((plugin as any).chatTurnWriter as any).watermarkFilePath.replace(/\\/g, '/')).toBe(
        path.join(runtimeStateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - writer migrates from configured stateDir when runtime state API appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-first-${Date.now()}`);
    const runtimeStateDir = path.join(require('os').tmpdir(), `dkg-t75-runtime-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const apiWithoutRuntime: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithoutRuntime);
      const writer = (plugin as any).chatTurnWriter;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        configStateDir.replace(/\\/g, '/'),
      );

      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');
      const apiWithRuntime: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        runtime: { state: { resolveStateDir: () => runtimeStateDir } },
      } as unknown as OpenClawPluginApi;
      plugin.register(apiWithRuntime);
      expect(setStateDirSpy).toHaveBeenCalledWith(runtimeStateDir, expect.objectContaining({ stateLayout: 'nested' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        runtimeStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(runtimeStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - writer migrates from configured stateDir when OPENCLAW_STATE_DIR appears later', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-config-first-env-${Date.now()}`);
    const envStateDir = path.join(require('os').tmpdir(), `dkg-t75-env-later-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: configStateDir,
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
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const writer = (plugin as any).chatTurnWriter;
      const setStateDirSpy = vi.spyOn(writer, 'setStateDir');

      process.env.OPENCLAW_STATE_DIR = envStateDir;
      plugin.register(mockApi);
      expect(setStateDirSpy).toHaveBeenCalledWith(envStateDir, expect.objectContaining({ stateLayout: 'nested' }));
      expect((plugin as any).chatTurnWriter).toBe(writer);

      await new Promise((r) => setTimeout(r, 100));
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        envStateDir.replace(/\\/g, '/'),
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(envStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - explicit config.stateDir equal to home fallback does not emit fallback warning', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const homeStateDir = path.join(require('os').homedir(), '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: homeStateDir,
        channel: { enabled: false },
        memory: { enabled: false },
      } as any);
      const warn = vi.fn();
      const mockApi: OpenClawPluginApi = {
        config: {},
        registrationMode: 'full',
        registerTool: () => {},
        registerHook: () => {},
        on: () => {},
        logger: { info: vi.fn(), warn, debug: vi.fn() },
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      expect(warn.mock.calls.some((args) =>
        String(args?.[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      )).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
    }
  });
});
