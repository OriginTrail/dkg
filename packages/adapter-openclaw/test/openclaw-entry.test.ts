import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CapturedService = {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type FakePluginInstance = {
  config: any;
  updateConfigCalls: Array<{ config: any; options: any }>;
  registerCalls: any[];
  workspaceDirsAtRegister: Array<unknown>;
  stopCalls: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __openclawEntryTestInstances: FakePluginInstance[] | undefined;
}

describe('openclaw-entry', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    delete globalThis.__openclawEntryTestInstances;
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function loadEntryWithFakeRuntime(options: { skillText?: string } = {}) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openclaw-entry-test-'));
    tempRoots.push(tempRoot);
    const root = join(tempRoot, 'adapter-openclaw');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    if (options.skillText !== undefined) {
      const skillPath = join(tempRoot, 'cli', 'skills', 'dkg-node', 'SKILL.md');
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, options.skillText, 'utf8');
    }
    copyFileSync(new URL('../openclaw-entry.mjs', import.meta.url), join(root, 'openclaw-entry.mjs'));
    writeFileSync(
      join(root, 'dist', 'index.js'),
      [
        'const ADAPTER_PLUGIN_CONFIG_KEYS = [',
        "  'daemonUrl',",
        "  'dkgHome',",
        "  'stateDir',",
        "  'stateDirSource',",
        "  'installedWorkspace',",
        "  'memory',",
        "  'channel',",
        '];',
        "const STATE_METADATA_CONFIG_KEYS = ['stateDir', 'stateDirSource', 'installedWorkspace'];",
        'export function isObjectRecord(value) {',
        "  return !!value && typeof value === 'object' && !Array.isArray(value);",
        '}',
        'export function looksLikeAdapterPluginConfig(value) {',
        '  if (!isObjectRecord(value)) return false;',
        "  if (isObjectRecord(value.plugins) || isObjectRecord(value.agents) || isObjectRecord(value.session) || typeof value.workspace === 'string' || typeof value.workspaceDir === 'string') return false;",
        '  return ADAPTER_PLUGIN_CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));',
        '}',
        // T364 round 6 — mirror production extractAdapterPluginConfigOverlay.
        // Splits mixed gateway payloads (route metadata + adapter overlay)
        // by returning only the adapter-config keys, or undefined if none.
        // Rejects merged-config-shaped objects (presence of `plugins`).
        // Returns the original reference for pure adapter configs (no
        // mixed route-metadata keys) so identity-based equality holds.
        'export function extractAdapterPluginConfigOverlay(value) {',
        '  if (!isObjectRecord(value)) return undefined;',
        '  if (isObjectRecord(value.plugins)) return undefined;',
        '  if (Object.keys(value).length === 0) return undefined;',
        '  if (looksLikeAdapterPluginConfig(value)) return value;',
        '  const overlay = {};',
        '  for (const key of ADAPTER_PLUGIN_CONFIG_KEYS) {',
        '    if (Object.prototype.hasOwnProperty.call(value, key)) overlay[key] = value[key];',
        '  }',
        '  return Object.keys(overlay).length > 0 ? overlay : undefined;',
        '}',
        // T364 follow-up: sameResolvedPath polyfill for the test fake.
        // Real `state-dir-path.ts` walks up to existing parent then
        // realpathSync; the test fake operates on hypothetical paths
        // (mkdtemp dirs, fictional workspaces) so a string-equality
        // fallback after resolve() suffices for the test surface.
        "import { resolve as resolvePath } from 'node:path';",
        'export function sameResolvedPath(a, b) {',
        '  if (typeof a !== "string" || typeof b !== "string") return false;',
        '  const an = resolvePath(a).replace(/\\\\/g, "/").replace(/\\/+$/, "");',
        '  const bn = resolvePath(b).replace(/\\\\/g, "/").replace(/\\/+$/, "");',
        "  return process.platform === 'win32' ? an.toLowerCase() === bn.toLowerCase() : an === bn;",
        '}',
        'export function isStateMetadataOnlyAdapterConfig(value) {',
        '  if (!looksLikeAdapterPluginConfig(value)) return false;',
        '  const keys = Object.keys(value);',
        '  return keys.length > 0 && keys.every((key) => STATE_METADATA_CONFIG_KEYS.includes(key));',
        '}',
        // T364 round 5 — mirror production isPartialAdapterConfigOverlay
        // (src/openclaw-config.ts): the fast-path returns true when ALL
        // keys are module keys (memory/channel), regardless of whether
        // those modules have `enabled`. Pre-fix this stub used the old
        // `!enabled`-only rule, so module-only configs with `enabled`
        // set were misclassified relative to production and the entry
        // tests could exercise a different merge path than runtime.
        'export function isPartialAdapterConfigOverlay(value) {',
        '  if (!looksLikeAdapterPluginConfig(value)) return false;',
        '  const partialOverlayKeys = new Set([\'daemonUrl\', \'dkgHome\', \'stateDir\', \'stateDirSource\', \'installedWorkspace\']);',
        '  const partialModuleKeys = new Set([\'memory\', \'channel\']);',
        '  const keys = Object.keys(value);',
        '  if (keys.length === 0) return false;',
        '  if (keys.every((key) => partialModuleKeys.has(key))) return true;',
        '  return keys.every((key) => partialOverlayKeys.has(key) || (partialModuleKeys.has(key) && isObjectRecord(value[key]) && !Object.prototype.hasOwnProperty.call(value[key], \'enabled\')));',
        '}',
        'export function mergeAdapterPluginConfigs(...configs) {',
        '  const merged = {};',
        '  for (const config of configs) {',
        '    if (!isObjectRecord(config)) continue;',
        '    const priorMemory = isObjectRecord(merged.memory) ? merged.memory : undefined;',
        '    const priorChannel = isObjectRecord(merged.channel) ? merged.channel : undefined;',
        '    const nextMemory = isObjectRecord(config.memory) ? config.memory : undefined;',
        '    const nextChannel = isObjectRecord(config.channel) ? config.channel : undefined;',
        '    Object.assign(merged, config);',
        '    if (priorMemory || nextMemory) {',
        '      if (nextMemory) merged.memory = { ...(priorMemory ?? {}), ...nextMemory };',
        "      else if (!Object.prototype.hasOwnProperty.call(config, 'memory')) merged.memory = priorMemory;",
        '    }',
        '    if (priorChannel || nextChannel) {',
        '      if (nextChannel) merged.channel = { ...(priorChannel ?? {}), ...nextChannel };',
        "      else if (!Object.prototype.hasOwnProperty.call(config, 'channel')) merged.channel = priorChannel;",
        '    }',
        '  }',
        '  return merged;',
        '}',
        'export class DkgNodePlugin {',
        '  constructor(config) {',
        '    this.config = config;',
        '    this.updateConfigCalls = [];',
        '    this.registerCalls = [];',
        '    this.workspaceDirsAtRegister = [];',
        '    this.stopCalls = 0;',
        '    globalThis.__openclawEntryTestInstances ??= [];',
        '    globalThis.__openclawEntryTestInstances.push(this);',
        '  }',
        '  updateConfig(config, options = {}) {',
        '    this.updateConfigCalls.push({ config, options });',
        '    this.config = options.partial ? mergeAdapterPluginConfigs(this.config, config) : { ...config };',
        '  }',
        '  register(api) { this.registerCalls.push(api); this.workspaceDirsAtRegister.push(api.workspaceDir); }',
        '  async stop() { this.stopCalls += 1; }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const href = `${pathToFileURL(join(root, 'openclaw-entry.mjs')).href}?t=${Date.now()}-${Math.random()}`;
    return (await import(href)).default as (api: any) => void;
  }

  function makeApi(daemonUrl: string) {
    const services: CapturedService[] = [];
    return {
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl,
                memory: { enabled: true },
                channel: { enabled: false },
              },
            },
          },
        },
      },
      registerService: vi.fn((service: CapturedService) => { services.push(service); }),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      services,
    };
  }

  function makeDirectPluginConfigApi(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const services: CapturedService[] = [];
    return {
      pluginConfig: config,
      registerService: vi.fn((service: CapturedService) => { services.push(service); }),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      services,
      ...extra,
    };
  }

  it('does not register stale lifecycle event names through api.on', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeApi('http://127.0.0.1:9200');

    entry(api);

    const registeredEvents = api.on.mock.calls.map((call) => call[0]);
    expect(registeredEvents).not.toContain('shutdown');
    expect(registeredEvents).not.toContain('close');
    expect(registeredEvents).not.toContain('restart');
    expect(registeredEvents).not.toContain('reload');
  });

  it('uses registerService stop to clear the singleton so reloads pick up fresh config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeApi('http://127.0.0.1:9300');

    entry(firstApi);
    const firstInstance = globalThis.__openclawEntryTestInstances![0];
    expect(firstInstance.config.daemonUrl).toBe('http://127.0.0.1:9200');
    expect(firstApi.registerService).toHaveBeenCalledTimes(1);
    expect(firstApi.services[0].name).toBe('dkg-adapter-openclaw-runtime');

    await firstApi.services[0].stop();
    expect(firstInstance.stopCalls).toBe(1);

    entry(secondApi);
    const secondInstance = globalThis.__openclawEntryTestInstances![1];
    expect(globalThis.__openclawEntryTestInstances).toHaveLength(2);
    expect(secondInstance).not.toBe(firstInstance);
    expect(secondInstance.config.daemonUrl).toBe('http://127.0.0.1:9300');
  });

  it('keeps multi-phase singleton re-registration delegated to DkgNodePlugin.register before teardown', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeApi('http://127.0.0.1:9300');

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(globalThis.__openclawEntryTestInstances).toHaveLength(1);
    expect(instance.registerCalls).toEqual([firstApi, secondApi]);
    expect(secondApi.registerService).toHaveBeenCalledTimes(1);

    await firstApi.services[0].stop();
    expect(instance.stopCalls).toBe(0);

    await secondApi.services[0].stop();
    expect(instance.stopCalls).toBe(1);
  });

  for (const registrationMode of ['setup-only', 'cli-metadata'] as const) {
    it(`defers singleton config updates during ${registrationMode} re-registration`, async () => {
      const entry = await loadEntryWithFakeRuntime();
      const firstApi = makeApi('http://127.0.0.1:9200');
      const metadataApi = makeDirectPluginConfigApi({
        daemonUrl: 'http://127.0.0.1:9300',
        memory: { enabled: false },
        channel: { enabled: true, port: 9301 },
      }, { registrationMode });
      const runtimeApi = makeDirectPluginConfigApi({
        daemonUrl: 'http://127.0.0.1:9300',
        memory: { enabled: false },
        channel: { enabled: true, port: 9301 },
      }, { registrationMode: 'setup-runtime' });

      entry(firstApi);
      entry(metadataApi);

      const instance = globalThis.__openclawEntryTestInstances![0];
      expect(instance.updateConfigCalls).toEqual([]);
      expect(instance.config).toMatchObject({
        daemonUrl: 'http://127.0.0.1:9200',
        memory: { enabled: true },
        channel: { enabled: false },
      });
      expect(instance.registerCalls).toEqual([firstApi, metadataApi]);

      entry(runtimeApi);

      expect(instance.updateConfigCalls).toHaveLength(1);
      expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
      expect(instance.config).toMatchObject({
        daemonUrl: 'http://127.0.0.1:9300',
        memory: { enabled: false },
        channel: { enabled: true, port: 9301 },
      });
    });

    it(`defers skill sync during ${registrationMode} re-registration`, async () => {
      const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-metadata-skill-workspace-'));
      tempRoots.push(installedWorkspace);
      const skillPath = join(installedWorkspace, 'skills', 'dkg-node', 'SKILL.md');
      const entry = await loadEntryWithFakeRuntime({ skillText: 'fresh skill' });
      const firstApi = makeApi('http://127.0.0.1:9200');
      const metadataApi = makeDirectPluginConfigApi({
        stateDir: join(installedWorkspace, '.dkg-adapter'),
        stateDirSource: 'setup-default',
        installedWorkspace,
      }, { registrationMode });
      const runtimeApi = makeDirectPluginConfigApi({
        stateDir: join(installedWorkspace, '.dkg-adapter'),
        stateDirSource: 'setup-default',
        installedWorkspace,
      }, { registrationMode: 'setup-runtime' });

      entry(firstApi);
      entry(metadataApi);

      expect(existsSync(skillPath)).toBe(false);

      entry(runtimeApi);

      expect(existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, 'utf8')).toBe('fresh skill');
    });
  }

  it('accepts OpenClaw-provided direct pluginConfig including setup state metadata', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9400',
      stateDir: '/work/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/work',
      memory: { enabled: true },
      channel: { enabled: false },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9400',
      stateDir: '/work/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/work',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.workspaceDirsAtRegister).toEqual([undefined]);
  });

  it('accepts api.config when the gateway passes validated plugin config directly', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      config: {
        daemonUrl: 'http://127.0.0.1:9500',
        stateDir: '/direct/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/direct',
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9500',
      stateDir: '/direct/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/direct',
    });
  });

  it('accepts api.cfg when the gateway passes validated plugin config directly', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      cfg: {
        daemonUrl: 'http://127.0.0.1:9505',
        stateDir: '/direct-cfg/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/direct-cfg',
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9505',
      stateDir: '/direct-cfg/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/direct-cfg',
    });
  });

  it('deep-merges direct plugin memory and channel config over entry config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      config: {
        memory: { enabled: false },
        channel: { enabled: true },
      },
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9550',
                memory: { enabled: true, memoryDir: '/persisted-memory' },
                channel: { enabled: false, port: 9551 },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9550',
      memory: { enabled: false, memoryDir: '/persisted-memory' },
      channel: { enabled: true, port: 9551 },
    });
  });

  it('keeps current api plugin config ahead of stale runtime plugin config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9660',
      memory: { enabled: false },
      channel: { enabled: true, port: 9661 },
    }, {
      runtime: {
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9550',
          memory: { enabled: true },
          channel: { enabled: false, port: 9551 },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9660',
      memory: { enabled: false },
      channel: { enabled: true, port: 9661 },
    });
  });

  it('keeps current api config entry ahead of stale runtime config entry', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9665',
                memory: { enabled: false },
              },
            },
          },
        },
      },
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9555',
                  memory: { enabled: true },
                },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9665',
      memory: { enabled: false },
    });
  });

  it('keeps current full api.config workspace and entry ahead of stale runtime config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      config: {
        agents: { defaults: { workspace: '/fresh-workspace' } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9670',
                stateDir: '/fresh-workspace/.dkg-adapter',
              },
            },
          },
        },
      },
      runtime: {
        config: {
          agents: { defaults: { workspace: '/stale-workspace' } },
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9560',
                  stateDir: '/stale-workspace/.dkg-adapter',
                },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/fresh-workspace');
    expect(instance.workspaceDirsAtRegister).toEqual(['/fresh-workspace']);
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9670',
      stateDir: '/fresh-workspace/.dkg-adapter',
    });
  });

  it('keeps plugin-shaped api.config ahead of stale runtime plugin config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      config: {
        stateDir: '/fresh-direct/.dkg-adapter',
        memory: { enabled: false },
      },
      runtime: {
        pluginConfig: {
          stateDir: '/stale-direct/.dkg-adapter',
          memory: { enabled: true },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      stateDir: '/fresh-direct/.dkg-adapter',
      memory: { enabled: false },
    });
  });

  it('keeps runtime cfg direct config ahead of stale runtime pluginConfig on first load', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      runtime: {
        cfg: {
          daemonUrl: 'http://127.0.0.1:9765',
          memory: { enabled: false },
          channel: { enabled: true, port: 9766 },
        },
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9565',
          memory: { enabled: true },
          channel: { enabled: false, port: 9566 },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9765',
      memory: { enabled: false },
      channel: { enabled: true, port: 9766 },
    });
  });

  it('keeps runtime cfg entry config ahead of stale runtime pluginConfig on first load', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      runtime: {
        cfg: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9775',
                  memory: { enabled: false },
                  channel: { enabled: true, port: 9776 },
                },
              },
            },
          },
        },
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9575',
          memory: { enabled: true },
          channel: { enabled: false, port: 9576 },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9775',
      memory: { enabled: false },
      channel: { enabled: true, port: 9776 },
    });
  });

  it('keeps refreshed api.config ahead of stale api.pluginConfig', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9610',
      memory: { enabled: true },
      channel: { enabled: false },
    }, {
      config: {
        daemonUrl: 'http://127.0.0.1:9715',
        memory: { enabled: false },
        channel: { enabled: true, port: 9716 },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9715',
      memory: { enabled: false },
      channel: { enabled: true, port: 9716 },
    });
  });

  it('keeps refreshed api.cfg ahead of stale api.pluginConfig', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9615',
      memory: { enabled: true },
      channel: { enabled: false },
    }, {
      cfg: {
        daemonUrl: 'http://127.0.0.1:9725',
        memory: { enabled: false },
        channel: { enabled: true, port: 9726 },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9725',
      memory: { enabled: false },
      channel: { enabled: true, port: 9726 },
    });
  });

  it('merges api.pluginConfig when the strongest direct api config only carries state metadata', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9727',
      memory: { enabled: false },
      channel: { enabled: true, port: 9728 },
    }, {
      config: {
        daemonUrl: 'http://127.0.0.1:9627',
        dkgHome: '/stale-direct-dkg-home',
        memory: { enabled: true },
        channel: { enabled: false, port: 9628 },
      },
      cfg: {
        stateDir: '/direct-metadata-workspace/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/direct-metadata-workspace',
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9727',
      stateDir: '/direct-metadata-workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/direct-metadata-workspace',
      memory: { enabled: false },
      channel: { enabled: true, port: 9728 },
    });
    expect(instance.config.dkgHome).toBeUndefined();
  });

  it('layers fresher api.pluginConfig over stale merged entry config', async () => {
    // T364 — Pre-fix this test asserted that the entry config in
    // `cfg.plugins.entries['adapter-openclaw'].config` won over a fresher
    // `api.pluginConfig` direct config. That encoded the bug Codex
    // flagged: a stale merged-snapshot entry would beat the fresher
    // direct config that the operator had just supplied, so the
    // singleton kept the old daemonUrl / memory / channel until a
    // later pass rebuilt the merged snapshot. Post-fix
    // `currentDirectConfigs` always layers `api.pluginConfig` on top of
    // current entry configs, so the operator's fresher pluginConfig
    // wins on conflicts (with module deep-merge preserving entry-only
    // fields like `channel.port` that the direct config didn't override).
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9620',
      memory: { enabled: true },
      channel: { enabled: false },
    }, {
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9735',
                memory: { enabled: false },
                channel: { enabled: true, port: 9736 },
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      // Fresher pluginConfig wins on top-level + module-key conflicts.
      daemonUrl: 'http://127.0.0.1:9620',
      memory: { enabled: true },
      // channel.enabled from pluginConfig wins; channel.port preserved
      // from entry config via module deep-merge (pluginConfig didn't
      // override that field).
      channel: { enabled: false, port: 9736 },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
  });

  it('merges fresh api.pluginConfig when the current entry config only carries state metadata', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9745',
      stateDir: '/stale-plugin/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/stale-plugin',
      memory: { enabled: false },
      channel: { enabled: true, port: 9746 },
    }, {
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/metadata-workspace/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/metadata-workspace',
              },
            },
          },
        },
      },
      runtime: {
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9600',
          stateDir: '/stale-runtime/.dkg-adapter',
          memory: { enabled: true },
          channel: { enabled: false, port: 9601 },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9745',
      stateDir: '/metadata-workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/metadata-workspace',
      memory: { enabled: false },
      channel: { enabled: true, port: 9746 },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
  });

  it('keeps api.pluginConfig operational fields when the strongest current entry only carries state metadata', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9755',
      memory: { enabled: false },
      channel: { enabled: true, port: 9756 },
    }, {
      config: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9655',
                dkgHome: '/stale-entry-dkg-home',
                memory: { enabled: true },
                channel: { enabled: false, port: 9656 },
              },
            },
          },
        },
      },
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/strongest-entry-workspace/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/strongest-entry-workspace',
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9755',
      stateDir: '/strongest-entry-workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/strongest-entry-workspace',
      memory: { enabled: false },
      channel: { enabled: true, port: 9756 },
    });
    expect(instance.config.dkgHome).toBeUndefined();
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
  });

  it('keeps lower full entry fields when api.pluginConfig is only a partial overlay', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      channel: { port: 9766 },
    }, {
      config: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9665',
                dkgHome: '/entry-dkg-home',
                memory: { enabled: true },
                channel: { enabled: true, port: 9666 },
              },
            },
          },
        },
      },
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/partial-overlay-workspace/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/partial-overlay-workspace',
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9665',
      dkgHome: '/entry-dkg-home',
      stateDir: '/partial-overlay-workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial-overlay-workspace',
      memory: { enabled: true },
      channel: { enabled: true, port: 9766 },
    });
  });

  it('keeps metadata-only entry plus metadata-only api.pluginConfig as a partial update', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      stateDir: '/plugin-metadata/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/plugin-metadata',
    }, {
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/entry-metadata/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/entry-metadata',
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/entry-metadata/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/entry-metadata',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('prefers live api.cfg over stale api.config for full OpenClaw config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi(undefined as any, {
      cfg: {
        agents: { defaults: { workspace: '/live-workspace' } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9710',
                stateDir: '/live-workspace/.dkg-adapter',
                memory: { enabled: true },
                channel: { enabled: false },
              },
            },
          },
        },
      },
      config: {
        agents: { defaults: { workspace: '/stale-workspace' } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9500',
                stateDir: '/stale-workspace/.dkg-adapter',
                memory: { enabled: false },
                channel: { enabled: true, port: 9501 },
              },
            },
          },
        },
      },
    });
    delete (api as any).pluginConfig;

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/live-workspace');
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9710',
      stateDir: '/live-workspace/.dkg-adapter',
      memory: { enabled: true },
      channel: { enabled: false },
    });
  });

  it('replaces singleton config when direct plugin config carries a full snapshot', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9600',
      stateDir: '/second/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/second',
      memory: { enabled: false },
      channel: { enabled: true, port: 9601 },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9600',
      stateDir: '/second/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/second',
      memory: { enabled: false },
      channel: { enabled: true, port: 9601 },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
    expect(instance.registerCalls).toEqual([firstApi, secondApi]);
  });

  it('treats empty direct pluginConfig as no current config source', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({}, {
      runtime: {
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9999',
          memory: { enabled: true },
          channel: { enabled: true },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9999',
      memory: { enabled: true },
      channel: { enabled: true },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
  });

  it('does not let empty api.config hide runtime pluginConfig fallback', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi(undefined as any, {
      config: {},
      runtime: {
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9700',
          memory: { enabled: true },
          channel: { enabled: false },
        },
      },
    });
    delete (api as any).pluginConfig;

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9700',
      memory: { enabled: true },
      channel: { enabled: false },
    });
  });

  it('does not let empty first-load pluginConfig hide runtime pluginConfig fallback', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      runtime: {
        pluginConfig: {
          daemonUrl: 'http://127.0.0.1:9740',
          memory: { enabled: true },
          channel: { enabled: false },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9740',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls).toEqual([]);
  });

  it('treats a re-registration with no config source as partial', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi(undefined as any);
    delete (secondApi as any).pluginConfig;

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('merges direct-only partial re-registration without dropping existing modules', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      stateDir: '/partial/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial',
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/partial/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('treats daemon/home-only direct re-registration config as a partial overlay', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9810',
      dkgHome: '/next-daemon-home',
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9810',
      dkgHome: '/next-daemon-home',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('treats module-shaped direct re-registration config without enabled as a partial overlay', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9800',
      channel: { port: 9801 },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9800',
      memory: { enabled: true },
      channel: { enabled: false, port: 9801 },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('treats module-shaped direct re-registration config with enabled as a full snapshot', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9800',
      channel: { enabled: true, port: 9801 },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9800',
      channel: { enabled: true, port: 9801 },
    });
    expect(instance.config).not.toHaveProperty('memory');
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: false });
  });

  it('does not backfill stale runtime config when current direct config is state-only partial', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({
      stateDir: '/partial-current/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial-current',
    }, {
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9550',
                  memory: { enabled: false },
                  channel: { enabled: true, port: 9551 },
                },
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/partial-current/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial-current',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('does not backfill stale runtime config when current api.config is state-only partial', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({}, {
      config: {
        stateDir: '/partial-api-config/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/partial-api-config',
      },
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9580',
                  memory: { enabled: false },
                  channel: { enabled: true, port: 9581 },
                },
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/partial-api-config/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/partial-api-config',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
  });

  it('uses current entry setup metadata to reject a stale route workspace even when direct config exists', async () => {
    const staleWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-stale-route-workspace-'));
    const freshWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-fresh-entry-workspace-'));
    tempRoots.push(staleWorkspace, freshWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'fresh skill' });
    const api = makeDirectPluginConfigApi(undefined as any, {
      cfg: {
        channel: { port: 9861 },
      },
      config: {
        agents: {
          defaults: {
            workspace: staleWorkspace,
          },
        },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(freshWorkspace, '.dkg-adapter'),
                stateDirSource: 'setup-default',
                installedWorkspace: freshWorkspace,
              },
            },
          },
        },
      },
    });
    delete (api as any).pluginConfig;

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      stateDir: join(freshWorkspace, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      installedWorkspace: freshWorkspace,
      channel: { port: 9861 },
    });
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.workspaceDirsAtRegister).toEqual([undefined]);
    expect(readFileSync(join(freshWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(staleWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('uses runtime fallback workspace when current route workspace is stale', async () => {
    const staleRouteWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-stale-current-route-'));
    const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-installed-fallback-'));
    const runtimeWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-runtime-fallback-'));
    tempRoots.push(staleRouteWorkspace, installedWorkspace, runtimeWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'runtime fallback skill' });
    const api = makeDirectPluginConfigApi(undefined as any, {
      config: {
        agents: {
          defaults: {
            workspace: staleRouteWorkspace,
          },
        },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(installedWorkspace, '.dkg-adapter'),
                stateDirSource: 'setup-default',
                installedWorkspace,
              },
            },
          },
        },
      },
      runtime: {
        config: {
          agents: {
            defaults: {
              workspace: runtimeWorkspace,
            },
          },
        },
      },
    });
    delete (api as any).pluginConfig;

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe(runtimeWorkspace);
    expect(instance.config.installedWorkspace).toBe(installedWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([runtimeWorkspace]);
    expect(readFileSync(join(runtimeWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('runtime fallback skill');
    expect(existsSync(join(staleRouteWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(installedWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('merges state-only first load with fallback runtime entry config', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/bootstrap-current/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/bootstrap-current',
    }, {
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9720',
                  memory: { enabled: true },
                  channel: { enabled: false },
                },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9720',
      stateDir: '/bootstrap-current/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/bootstrap-current',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls).toEqual([]);
  });

  it('merges daemon/home-only first-load overlays with fallback runtime entry modules', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({}, {
      config: {
        daemonUrl: 'http://127.0.0.1:9820',
        dkgHome: '/current-daemon-home',
      },
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  daemonUrl: 'http://127.0.0.1:9720',
                  memory: { enabled: true, memoryDir: '/persisted-memory' },
                  channel: { enabled: false, port: 9721 },
                },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9820',
      dkgHome: '/current-daemon-home',
      memory: { enabled: true, memoryDir: '/persisted-memory' },
      channel: { enabled: false, port: 9721 },
    });
    expect(instance.updateConfigCalls).toEqual([]);
  });

  it('applies DKG_DAEMON_URL to partial first-load bootstrap config', async () => {
    const prevDaemonUrl = process.env.DKG_DAEMON_URL;
    process.env.DKG_DAEMON_URL = 'http://127.0.0.1:9730';
    try {
      const entry = await loadEntryWithFakeRuntime();
      const api = makeDirectPluginConfigApi({
        stateDir: '/bootstrap-env/.dkg-adapter',
        stateDirSource: 'setup-default',
        installedWorkspace: '/bootstrap-env',
      }, {
        runtime: {
          config: {
            plugins: {
              entries: {
                'adapter-openclaw': {
                  config: {
                    daemonUrl: 'http://127.0.0.1:9500',
                    dkgHome: '/old-daemon-home',
                    memory: { enabled: true },
                    channel: { enabled: false },
                  },
                },
              },
            },
          },
        },
      });

      entry(api);

      const instance = globalThis.__openclawEntryTestInstances![0];
      expect(instance.config).toMatchObject({
        daemonUrl: 'http://127.0.0.1:9730',
        stateDir: '/bootstrap-env/.dkg-adapter',
        dkgHome: undefined,
        memory: { enabled: true },
        channel: { enabled: false },
      });
      const startupLog = api.logger.info.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('[dkg-entry] config'));
      expect(startupLog).toContain('daemonUrl: http://127.0.0.1:9730');
      expect(startupLog).not.toContain('http://127.0.0.1:9500');
    } finally {
      if (prevDaemonUrl === undefined) delete process.env.DKG_DAEMON_URL;
      else process.env.DKG_DAEMON_URL = prevDaemonUrl;
    }
  });

  it('T364 round 5 — drops stale lower-priority dkgHome when higher-priority overlay changes only daemonUrl', async () => {
    // Regression: pre-fix `dkgHomeFromCurrentConfig` was true if ANY
    // current source supplied `dkgHome`, so a stale lower-priority
    // entry-config dkgHome (e.g. from yesterday's daemon) survived
    // through the merge while a higher-priority direct overlay
    // changed only `daemonUrl`. The result: client points at the new
    // daemon URL while reading auth from the old home. Fix pairs
    // `dkgHome` with the source that supplied the winning daemonUrl —
    // here the direct overlay wins and does not supply dkgHome, so
    // the stale lower-priority value is cleared.
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      daemonUrl: 'http://127.0.0.1:9999',
    }, {
      config: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                daemonUrl: 'http://127.0.0.1:9200',
                dkgHome: '/stale-entry-dkg-home',
                memory: { enabled: true },
                channel: { enabled: false },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config.daemonUrl).toBe('http://127.0.0.1:9999');
    expect(instance.config.dkgHome).toBeUndefined();
    expect(instance.config.memory).toEqual({ enabled: true });
    expect(instance.config.channel).toEqual({ enabled: false });
  });

  it('resolves workspace from runtime.config even when it only carries workspace metadata', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/runtime-only/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/runtime-only',
    }, {
      runtime: {
        config: {
          workspace: '/runtime-only',
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/runtime-only');
    expect(instance.workspaceDirsAtRegister).toEqual(['/runtime-only']);
  });

  it('sets resolved workspaceDir before singleton re-registration', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({}, {
      cfg: {
        agents: { defaults: { workspace: '/cfg-workspace' } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/cfg-workspace/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/cfg-workspace',
              },
            },
          },
        },
      },
    });

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((secondApi as any).workspaceDir).toBe('/cfg-workspace');
    expect(instance.config).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/cfg-workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/cfg-workspace',
      memory: { enabled: true },
      channel: { enabled: false },
    });
    expect(instance.updateConfigCalls[0].options).toEqual({ partial: true });
    expect(instance.workspaceDirsAtRegister).toEqual([undefined, '/cfg-workspace']);
  });

  it('does not let installedWorkspace mask a later runtime workspace', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/setup/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/setup',
    }, {
      runtime: {
        config: {
          agents: {
            defaults: {
              workspace: '/setup',
            },
          },
        },
      },
    });

    entry(api);
    expect((api as any).workspaceDir).toBe('/setup');

    // The first value was assigned by this entry wrapper, so a later runtime
    // workspace from config should still replace it.
    (api as any).runtime = {
      config: {
        agents: {
          defaults: {
            workspace: '/runtime-workspace',
          },
        },
      },
    };

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/runtime-workspace');
    expect(instance.workspaceDirsAtRegister).toEqual(['/setup', '/runtime-workspace']);
  });

  it('keeps caller workspaceDir ahead of stale merged config workspace', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const firstApi = makeApi('http://127.0.0.1:9200');
    const secondApi = makeDirectPluginConfigApi({}, {
      cfg: {
        agents: { defaults: { workspace: '/stale-config-workspace' } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: '/stale-config-workspace/.dkg-adapter',
                stateDirSource: 'setup-default',
                installedWorkspace: '/stale-config-workspace',
              },
            },
          },
        },
      },
    });
    (secondApi as any).workspaceDir = '/live-runtime-workspace';

    entry(firstApi);
    entry(secondApi);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((secondApi as any).workspaceDir).toBe('/live-runtime-workspace');
    expect(instance.workspaceDirsAtRegister).toEqual([undefined, '/live-runtime-workspace']);
  });

  it('keeps fresh direct installedWorkspace ahead of stale route workspace metadata', async () => {
    const freshWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-fresh-workspace-'));
    const staleWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-stale-route-workspace-'));
    tempRoots.push(freshWorkspace, staleWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'fresh skill' });
    const api = makeDirectPluginConfigApi({
      stateDir: join(freshWorkspace, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      installedWorkspace: freshWorkspace,
    }, {
      cfg: {
        agents: { defaults: { workspace: staleWorkspace } },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.config.installedWorkspace).toBe(freshWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([undefined]);
    expect(readFileSync(join(freshWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(staleWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('keeps metadata-only current entry installedWorkspace ahead of stale route workspace metadata with pluginConfig flags', async () => {
    const freshWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-fresh-entry-workspace-'));
    const staleWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-stale-entry-route-workspace-'));
    tempRoots.push(freshWorkspace, staleWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'fresh entry skill' });
    const api = makeDirectPluginConfigApi({
      memory: { enabled: true },
      channel: { enabled: true, port: 9876 },
    }, {
      config: {
        agents: { defaults: { workspace: staleWorkspace } },
      },
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(freshWorkspace, '.dkg-adapter'),
                stateDirSource: 'setup-default',
                installedWorkspace: freshWorkspace,
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.config.installedWorkspace).toBe(freshWorkspace);
    expect(instance.config.memory).toEqual({ enabled: true });
    expect(instance.workspaceDirsAtRegister).toEqual([undefined]);
    expect(readFileSync(join(freshWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('fresh entry skill');
    expect(existsSync(join(staleWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('keeps legacy setup-owned entry installedWorkspace ahead of stale route workspace metadata', async () => {
    const freshWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-legacy-entry-workspace-'));
    const staleWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-legacy-stale-route-workspace-'));
    tempRoots.push(freshWorkspace, staleWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'legacy entry skill' });
    const api = makeDirectPluginConfigApi({}, {
      config: {
        agents: { defaults: { workspace: staleWorkspace } },
      },
      cfg: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(freshWorkspace, '.openclaw'),
                stateDirSource: 'setup-default',
                installedWorkspace: freshWorkspace,
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.config.installedWorkspace).toBe(freshWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([undefined]);
    expect(readFileSync(join(freshWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('legacy entry skill');
    expect(existsSync(join(staleWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('keeps live route workspace when current direct overlay lacks setup state metadata', async () => {
    const liveWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-live-route-workspace-'));
    const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-entry-installed-workspace-'));
    tempRoots.push(liveWorkspace, installedWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'live route skill' });
    const api = makeDirectPluginConfigApi({}, {
      config: {
        memory: { enabled: true },
      },
      cfg: {
        agents: { defaults: { workspace: liveWorkspace } },
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(installedWorkspace, '.dkg-adapter'),
                stateDirSource: 'setup-default',
                installedWorkspace,
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe(liveWorkspace);
    expect(instance.config.installedWorkspace).toBe(installedWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([liveWorkspace]);
    expect(readFileSync(join(liveWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('live route skill');
    expect(existsSync(join(installedWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('keeps live api.cfg workspace ahead of lower setup metadata without direct config', async () => {
    const liveWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-live-cfg-workspace-'));
    const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-lower-entry-workspace-'));
    tempRoots.push(liveWorkspace, installedWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'live cfg skill' });
    const api = makeDirectPluginConfigApi(undefined as any, {
      cfg: {
        agents: { defaults: { workspace: liveWorkspace } },
      },
      config: {
        plugins: {
          entries: {
            'adapter-openclaw': {
              config: {
                stateDir: join(installedWorkspace, '.dkg-adapter'),
                stateDirSource: 'setup-default',
                installedWorkspace,
              },
            },
          },
        },
      },
    });
    delete (api as any).pluginConfig;

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe(liveWorkspace);
    expect(instance.config.installedWorkspace).toBe(installedWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([liveWorkspace]);
    expect(readFileSync(join(liveWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('live cfg skill');
    expect(existsSync(join(installedWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('keeps current workspace metadata when direct installedWorkspace has no setup-default stateDir evidence', async () => {
    const currentWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-current-workspace-'));
    const staleWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-stale-installed-workspace-'));
    tempRoots.push(currentWorkspace, staleWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'current skill' });
    const api = makeDirectPluginConfigApi({
      installedWorkspace: staleWorkspace,
    }, {
      cfg: {
        agents: { defaults: { workspace: currentWorkspace } },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe(currentWorkspace);
    expect(instance.config.installedWorkspace).toBe(staleWorkspace);
    expect(instance.workspaceDirsAtRegister).toEqual([currentWorkspace]);
    expect(readFileSync(join(currentWorkspace, 'skills', 'dkg-node', 'SKILL.md'), 'utf8')).toBe('current skill');
    expect(existsSync(join(staleWorkspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
  });

  it('T364 round 10 — empty-string workspaceDir alias falls through to the next config source', async () => {
    // Pre-fix `workspaceDirFromConfig` returned the first non-undefined
    // alias even if it was an empty string, so a stray
    // `cfg.workspaceDir = ''` (or whitespace-only) suppressed the
    // fallback chain — `workspaceDir` ended up empty and
    // `syncSkillToWorkspace()` would write to `./skills/...` under
    // the process CWD. Post-fix `isNonEmptyString` is required for
    // an alias to count, so empty/whitespace-only values fall through
    // to the next priority source.
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/dir/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/dir',
    }, {
      cfg: {
        workspaceDir: '   ',  // whitespace-only — should NOT block fallback
      },
      runtime: {
        config: {
          workspace: '/real-fallback',
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.workspaceDirsAtRegister[0]).toBe('/real-fallback');
  });

  it('T364 round 12 — partial direct overlay from api.config layers api.pluginConfig underneath instead of dropping it', async () => {
    // Pre-fix `currentDirectApiConfigSources` only layered
    // `api.pluginConfig` underneath the strongest direct config when
    // that direct was strictly state-metadata-only. For a mixed
    // gateway payload like `{ workspaceDir, channel: { port: 9801 } }`
    // (extracted to `{ channel: { port: 9801 } }` — partial but NOT
    // metadata-only), the helper returned `undefined` and the
    // bootstrap collapsed to just the overlay. `daemonUrl` /
    // `memory.enabled` / `channel.enabled` from `api.pluginConfig`
    // were dropped on the floor on first load and re-register.
    // Post-fix the layering extends to all partial overlays — the
    // partial direct rides on top of `pluginConfig` via merge order,
    // and the resulting bootstrap carries all four fields.
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      // Full pluginConfig — the rest of the adapter config.
      daemonUrl: 'http://127.0.0.1:9201',
      memory: { enabled: true },
      channel: { enabled: true, port: 0 },
    }, {
      // Mixed partial overlay (workspaceDir is route metadata; channel
      // partial is the adapter overlay). After round-6 extraction,
      // currentDirectApiConfigs contains just `{ channel: { port: 9801 } }`.
      config: {
        workspaceDir: '/legacy-workspace',
        channel: { port: 9801 },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    // Base values from pluginConfig flow through.
    expect(instance.config.daemonUrl).toBe('http://127.0.0.1:9201');
    expect(instance.config.memory).toEqual({ enabled: true });
    // Partial direct overlay layers on top — channel.enabled stays
    // (from pluginConfig, deep-merged) and channel.port is overridden
    // (from the partial direct).
    expect(instance.config.channel).toEqual({ enabled: true, port: 9801 });
  });

  it('T364 round 11 — full current adapter config carries fallback setup metadata into bootstrapConfig', async () => {
    // Pre-fix a "full" current adapter config like `{ daemonUrl,
    // memory, channel }` was classified as `configIsPartial = false`,
    // so `bootstrapConfig = config` ended up with no `stateDir` /
    // `stateDirSource` / `installedWorkspace` even when fallback
    // runtime config supplied them. `DkgNodePlugin.ensureChatTurnWriter()`
    // then fell back to `~/.openclaw` and persisted watermarks in the
    // wrong place. Post-fix the setup metadata is carried forward
    // from fallback into `config` (and `bootstrapConfig`) regardless
    // of the partial/full classification — setup metadata is
    // orthogonal to the daemon/memory/channel adapter decisions.
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      // Full current adapter config — has memory/channel with `enabled`,
      // so isPartialAdapterConfigOverlay returns false (full snapshot).
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 0 },
    }, {
      runtime: {
        config: {
          plugins: {
            entries: {
              'adapter-openclaw': {
                config: {
                  stateDir: '/installed/.dkg-adapter',
                  stateDirSource: 'setup-default',
                  installedWorkspace: '/installed',
                },
              },
            },
          },
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect(instance.config.daemonUrl).toBe('http://127.0.0.1:9200');
    expect(instance.config.memory).toEqual({ enabled: true });
    expect(instance.config.channel).toEqual({ enabled: true, port: 0 });
    // The setup metadata MUST be present on the bootstrap config so
    // ensureChatTurnWriter() can resolve the right state directory
    // instead of falling back to ~/.openclaw.
    expect(instance.config.stateDir).toBe('/installed/.dkg-adapter');
    expect(instance.config.stateDirSource).toBe('setup-default');
    expect(instance.config.installedWorkspace).toBe('/installed');
  });

  it('T364 round 9 — partial pluginConfig overlay inherits fallback installedWorkspace for stale-route check', async () => {
    // Pre-fix the stale-route check read `installedWorkspace` and
    // `stateDirSource` from raw `config` (just current sources). For a
    // partial overlay update (e.g. `api.pluginConfig = { channel: { port: 9801 } }`),
    // those keys aren't in current at all — they live only in fallback
    // runtime config. So `currentRouteWorkspaceIsStale` stayed false and
    // we kept stamping/syncing against the stale `api.cfg.workspace` even
    // though the fallback metadata had grounds to reject it.
    // Post-fix the stale check reads from `bootstrapConfig` (which merges
    // fallback under partial current), so the fallback installedWorkspace
    // / stateDirSource correctly engage the rejection path.
    const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-installed-r9-'));
    tempRoots.push(installedWorkspace);
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      // Partial overlay — no installedWorkspace / stateDirSource here.
      channel: { port: 9801 },
    }, {
      cfg: {
        // Stale route workspace pointed at the installedWorkspace
        // (matches the setup-default detection trigger).
        agents: { defaults: { workspace: installedWorkspace } },
      },
      runtime: {
        // Fallback carries the setup metadata that should engage the
        // stale-route rejection path.
        pluginConfig: {
          stateDir: join(installedWorkspace, '.dkg-adapter'),
          stateDirSource: 'setup-default',
          installedWorkspace,
        },
      },
    });

    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    // Bootstrap should resolve the installedWorkspace (the fallback
    // metadata kicked in via the stale-route rejection path), not the
    // stale `api.cfg.agents.defaults.workspace` value.
    expect(instance.workspaceDirsAtRegister[0]).toBe(installedWorkspace);
  });

  it('T364 round 9 — gracefully tolerates a non-configurable api.workspaceDir property', async () => {
    // Pre-fix `setEntryAssignedWorkspaceDir` used a hard
    // `Object.defineProperty` that throws on plugin load if a future
    // OpenClaw API exposed `workspaceDir` as a non-configurable own
    // property. Post-fix the install is wrapped in a try/catch that
    // falls back to plain assignment + value tracking, so the plugin
    // loads cleanly and the resolver still yields the computed workspace.
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/dir/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/dir',
    }, {
      runtime: {
        config: {
          workspace: '/from-runtime',
        },
      },
    });
    // Pre-pin api.workspaceDir as non-configurable, simulating a future
    // gateway that locks the property.
    Object.defineProperty(api, 'workspaceDir', {
      configurable: false,
      enumerable: true,
      writable: true,
      value: undefined,
    });

    expect(() => entry(api)).not.toThrow();

    const instance = globalThis.__openclawEntryTestInstances![0];
    // The fallback path writes through plain assignment, so the
    // gateway sees the value via api.workspaceDir.
    expect((api as any).workspaceDir).toBe('/from-runtime');
    expect(instance.workspaceDirsAtRegister).toEqual(['/from-runtime']);
  });

  it('does not reuse a workspaceDir written by an earlier same-api registration', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/first/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/first',
    }, {
      runtime: {
        config: {
          workspace: '/runtime-first',
        },
      },
    });

    entry(api);
    expect((api as any).workspaceDir).toBe('/runtime-first');

    delete (api as any).runtime;
    (api as any).pluginConfig = {
      stateDir: '/second/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/second',
    };
    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBeUndefined();
    expect(instance.workspaceDirsAtRegister).toEqual(['/runtime-first', undefined]);
  });

  it('keeps a caller-provided workspaceDir even when it matches an earlier wrapper assignment', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/first/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/first',
    }, {
      runtime: {
        config: {
          workspace: '/runtime-same',
        },
      },
    });

    entry(api);
    expect((api as any).workspaceDir).toBe('/runtime-same');

    (api as any).workspaceDir = '/runtime-same';
    delete (api as any).runtime;
    (api as any).pluginConfig = {
      stateDir: '/second/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/second',
    };
    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/runtime-same');
    expect(instance.workspaceDirsAtRegister).toEqual(['/runtime-same', '/runtime-same']);
  });

  it('syncs skills into installedWorkspace without stamping api.workspaceDir', async () => {
    const installedWorkspace = mkdtempSync(join(tmpdir(), 'openclaw-installed-workspace-'));
    tempRoots.push(installedWorkspace);
    const entry = await loadEntryWithFakeRuntime({ skillText: 'fresh skill' });
    const api = makeDirectPluginConfigApi({
      stateDir: join(installedWorkspace, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      installedWorkspace,
    });

    entry(api);

    expect((api as any).workspaceDir).toBeUndefined();
    const skillPath = join(installedWorkspace, 'skills', 'dkg-node', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, 'utf8')).toBe('fresh skill');
  });

  it('preserves a caller-provided api.workspaceDir value', async () => {
    const entry = await loadEntryWithFakeRuntime();
    const api = makeDirectPluginConfigApi({
      stateDir: '/caller/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/caller',
    });
    (api as any).workspaceDir = '/caller-workspace';

    entry(api);
    entry(api);

    const instance = globalThis.__openclawEntryTestInstances![0];
    expect((api as any).workspaceDir).toBe('/caller-workspace');
    expect(instance.workspaceDirsAtRegister).toEqual(['/caller-workspace', '/caller-workspace']);
  });
});
