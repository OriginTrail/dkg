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


  it('T75 - configured stateDir is used and suppresses the home-fallback warning', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const stateDir = path.join(require('os').tmpdir(), `dkg-t75-config-state-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir,
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
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        stateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      expect(warn.mock.calls.some((c: any[]) =>
        String(c[0] ?? '').includes('Could not resolve a workspace-scoped state dir'),
      )).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - blank configured stateDir is ignored and falls through to api.workspaceDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-workspace-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir: '   ',
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
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - explicit configured stateDir overrides api.workspaceDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-workspace-${Date.now()}`);
    const configStateDir = path.join(require('os').tmpdir(), `dkg-t75-custom-config-${Date.now()}`);
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
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        configStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - api.workspaceDir overrides setup-owned configured stateDir to avoid stale defaults', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-workspace-${Date.now()}`);
    const staleInstalledWorkspace = path.join(require('os').tmpdir(), `dkg-t75-stale-workspace-${Date.now()}`);
    const staleConfigStateDir = path.join(staleInstalledWorkspace, '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: staleInstalledWorkspace,
        stateDir: staleConfigStateDir,
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
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        workspaceDir.replace(/\\/g, '/') + '/.dkg-adapter/chat-turn-watermarks.json',
      );
      expect(watermarkPath.replace(/\\/g, '/')).not.toContain(staleConfigStateDir.replace(/\\/g, '/'));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(staleInstalledWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - stale setup-owned marker does not override a configured custom stateDir', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const installedWorkspace = path.join(require('os').tmpdir(), `dkg-t75-installed-workspace-${Date.now()}`);
    const configuredStateDir = path.join(require('os').tmpdir(), `dkg-t75-custom-with-stale-marker-${Date.now()}`);
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace,
        stateDir: configuredStateDir,
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
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const targetStateDir = path.join(installedWorkspace, '.dkg-adapter');
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect((plugin as any).chatTurnWriterStateDir.replace(/\\/g, '/')).toBe(
        configuredStateDir.replace(/\\/g, '/'),
      );
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(configuredStateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(watermarkPath.replace(/\\/g, '/')).not.toContain(targetStateDir.replace(/\\/g, '/'));
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(installedWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configuredStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - stale setup-owned marker does not make custom .dkg-adapter config direct', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const installedWorkspace = path.join(require('os').tmpdir(), `dkg-t75-installed-marker-${Date.now()}`);
    const customWorkspace = path.join(require('os').tmpdir(), `dkg-t75-custom-marker-${Date.now()}`);
    const configuredStateDir = path.join(customWorkspace, '.dkg-adapter');
    const legacyFile = path.join(customWorkspace, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::stale-marker': { w: 8, b: 2 },
      }));
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace,
        stateDir: configuredStateDir,
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
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(configuredStateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(configuredStateDir, 'chat-turn-watermarks.json'))).toBe(false);
      expect(fs.existsSync(legacyFile)).toBe(true);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(installedWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(customWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - config stateDir matching installedWorkspace default is explicit without setup marker', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-current-explicit-default-${Date.now()}`);
    const configuredWorkspace = path.join(require('os').tmpdir(), `dkg-t75-explicit-default-${Date.now()}`);
    const configuredStateDir = path.join(configuredWorkspace, '.openclaw');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: configuredWorkspace,
        stateDir: configuredStateDir,
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
        workspaceDir,
      } as unknown as OpenClawPluginApi;
      plugin.register(mockApi);
      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toContain(
        configuredStateDir.replace(/\\/g, '/') + '/dkg-adapter/chat-turn-watermarks.json',
      );
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(configuredWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - OPENCLAW_STATE_DIR pointing at .dkg-adapter uses direct layout and migrates sibling legacy state', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-env-direct-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::env-direct': { w: 7, b: 3 },
      }));
      process.env.OPENCLAW_STATE_DIR = stateDir;
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
        workspaceDir,
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::env-direct']).toEqual({ w: 7, b: 3 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - user-owned config.stateDir matching installedWorkspace .dkg-adapter keeps nested layout', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-config-direct-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    try {
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        installedWorkspace: workspaceDir,
        stateDir,
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
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'chat-turn-watermarks.json'))).toBe(false);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - OPENCLAW_STATE_DIR ending .dkg-adapter migrates sibling legacy state from env-derived workspace', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-env-no-workspace-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::env-untrusted': { w: 9, b: 4 },
      }));
      process.env.OPENCLAW_STATE_DIR = stateDir;
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
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const watermarkPath: string = ((plugin as any).chatTurnWriter as any).watermarkFilePath;
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json'))).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(watermarkPath, 'utf8'));
      expect(persisted['openclaw:tg:::env-untrusted']).toEqual({ w: 9, b: 4 });
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });


  it('T75 - user-owned config.stateDir ending .dkg-adapter does not migrate sibling legacy state', async () => {
    const prevEnv = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    const workspaceDir = path.join(require('os').tmpdir(), `dkg-t75-custom-dkg-adapter-${Date.now()}`);
    const stateDir = path.join(workspaceDir, '.dkg-adapter');
    const legacyFile = path.join(workspaceDir, '.openclaw', 'dkg-adapter', 'chat-turn-watermarks.json');
    try {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        'openclaw:tg:::unrelated': { w: 4, b: 1 },
      }));
      const plugin = new DkgNodePlugin({
        daemonUrl: 'http://localhost:9200',
        stateDir,
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
      expect(watermarkPath.replace(/\\/g, '/')).toBe(
        path.join(stateDir, 'dkg-adapter', 'chat-turn-watermarks.json').replace(/\\/g, '/'),
      );
      expect(fs.existsSync(path.join(stateDir, 'chat-turn-watermarks.json'))).toBe(false);
      expect(fs.existsSync(legacyFile)).toBe(true);
      await plugin.stop();
    } finally {
      if (prevEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prevEnv;
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
