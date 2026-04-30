import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type CapturedService = {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type FakePluginInstance = {
  config: any;
  registerCalls: any[];
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

  async function loadEntryWithFakeRuntime() {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-entry-test-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    copyFileSync(new URL('../openclaw-entry.mjs', import.meta.url), join(root, 'openclaw-entry.mjs'));
    writeFileSync(
      join(root, 'dist', 'index.js'),
      [
        'export class DkgNodePlugin {',
        '  constructor(config) {',
        '    this.config = config;',
        '    this.registerCalls = [];',
        '    this.stopCalls = 0;',
        '    globalThis.__openclawEntryTestInstances ??= [];',
        '    globalThis.__openclawEntryTestInstances.push(this);',
        '  }',
        '  register(api) { this.registerCalls.push(api); }',
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
});
