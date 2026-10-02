import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeConfigLockPath, withFileLock } from '@origintrail-official/dkg-core';
import { discoverAgentName, runSetup, writeDkgConfig } from '../src/setup.js';

// `dkg openclaw setup` writes the node config through the same locked,
// re-read-then-patch update as the daemon and the CLI: an edit another writer
// makes meanwhile survives, a YAML-only home stays YAML, and the file keeps
// its permission bits.

const fakeNetwork = {
  networkName: 'Test Network',
  relays: ['/ip4/1.2.3.4/tcp/9090/p2p/12D3test'],
  defaultContextGraphs: ['testing'],
  defaultNodeRole: 'edge' as const,
  chain: {
    type: 'evm' as const,
    rpcUrl: 'https://rpc.test',
    hubAddress: '0xTEST',
    chainId: 'test:1',
  },
};

describe('writeDkgConfig — locked, format-preserving config writes', () => {
  let testDir: string;
  let dkgHome: string;
  let jsonPath: string;
  let yamlPath: string;
  const originalDkgHome = process.env.DKG_HOME;

  beforeEach(() => {
    testDir = join(tmpdir(), `dkg-setup-config-writes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    jsonPath = join(dkgHome, 'config.json');
    yamlPath = join(dkgHome, 'config.yaml');
    process.env.DKG_HOME = dkgHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  const readJson = (): Record<string, any> => JSON.parse(readFileSync(jsonPath, 'utf-8'));

  it('keeps a daemon edit made while setup waited for the config lock', async () => {
    writeFileSync(jsonPath, JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      openclawChannel: { bridgeUrl: 'http://127.0.0.1:9301' },
    }));

    let setupWrite: Promise<Record<string, any>> | undefined;
    await withFileLock(homeConfigLockPath(dkgHome), async () => {
      setupWrite = writeDkgConfig('discovered-name', fakeNetwork, 9200);
      // Let setup reach the lock and start waiting for it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The daemon saves a node-UI setting while setup waits.
      writeFileSync(jsonPath, JSON.stringify({ ...readJson(), llm: { model: 'set-by-daemon' } }));
    });
    await setupWrite;

    const written = readJson();
    expect(written.llm).toEqual({ model: 'set-by-daemon' });
    expect(written).toMatchObject({ name: 'existing-node', apiPort: 9300, networkConfig: 'testnet' });
    // The legacy migration ran on the re-read file, not on a stale copy.
    expect(written.openclawChannel).toBeUndefined();
    expect(written.localAgentIntegrations.openclaw.transport).toMatchObject({
      kind: 'openclaw-channel',
      bridgeUrl: 'http://127.0.0.1:9301',
    });
  });

  it('keeps a YAML-only home in YAML: migrates and merges in place, never writes config.json', async () => {
    writeFileSync(yamlPath, [
      'name: yaml-node',
      'apiPort: 9317',
      'networkConfig: testnet',
      'openclawChannel:',
      '  bridgeUrl: http://127.0.0.1:9301',
      '',
    ].join('\n'));

    const merged = await writeDkgConfig('discovered-name', fakeNetwork, 9200);

    expect(existsSync(jsonPath)).toBe(false);
    expect(merged).toMatchObject({
      name: 'yaml-node',
      apiPort: 9317,
      networkConfig: 'testnet',
      nodeRole: 'edge',
      contextGraphs: ['testing'],
      localAgentIntegrations: {
        openclaw: { transport: { kind: 'openclaw-channel', bridgeUrl: 'http://127.0.0.1:9301' } },
      },
    });
    // An existing node is never seeded onto a new store backend.
    expect(merged.store).toBeUndefined();
    expect(merged.openclawChannel).toBeUndefined();
    const onDisk = readFileSync(yamlPath, 'utf-8');
    expect(onDisk).toMatch(/^name: yaml-node$/m);
    expect(onDisk).toMatch(/^apiPort: 9317$/m);
    expect(onDisk).toMatch(/^ {6}bridgeUrl: http:\/\/127\.0\.0\.1:9301$/m);
    expect(onDisk).not.toContain('openclawChannel');
    expect(onDisk).not.toContain('store:');
  });

  it('keeps the permission bits of config.json', async () => {
    writeFileSync(jsonPath, JSON.stringify({ name: 'existing-node' }));
    chmodSync(jsonPath, 0o600);

    await writeDkgConfig('existing-node', fakeNetwork, 9200);

    expect(readJson().networkConfig).toBe('testnet');
    // Windows keeps only a read-only flag, not POSIX permission bits.
    if (process.platform !== 'win32') expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a config.json it cannot parse instead of overwriting it', async () => {
    writeFileSync(jsonPath, '{ not json');

    await expect(writeDkgConfig('agent', fakeNetwork, 9200)).rejects.toThrow(`${jsonPath} is not valid JSON`);

    expect(readFileSync(jsonPath, 'utf-8')).toBe('{ not json');
  });

  describe('runSetup on a YAML-only home', () => {
    let openclawHome: string;
    let workspace: string;
    const originalOpenclawHome = process.env.OPENCLAW_HOME;

    beforeEach(() => {
      openclawHome = join(testDir, '.openclaw');
      workspace = join(testDir, 'workspace');
      mkdirSync(openclawHome, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(openclawHome, 'openclaw.json'), JSON.stringify({ plugins: {} }, null, 2) + '\n');
      process.env.OPENCLAW_HOME = openclawHome;
      writeFileSync(yamlPath, 'name: yaml-node\napiPort: 9317\nnetworkConfig: testnet\n');
    });

    afterEach(() => {
      if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = originalOpenclawHome;
    });

    it('discovers the persisted agent name from config.yaml', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(discoverAgentName(workspace)).toBe('yaml-node');
      expect(log).toHaveBeenCalledWith(`[setup] Using persisted agent name "yaml-node" from ${yamlPath}`);
    });

    it('takes the effective API port from config.yaml for the adapter entry', async () => {
      await runSetup({ workspace, start: false, verify: false, fund: false });

      expect(existsSync(jsonPath)).toBe(false);
      const openclaw = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(openclaw.plugins.entries['adapter-openclaw'].config.daemonUrl).toBe('http://127.0.0.1:9317');
    });

    it('names config.yaml as the file a dry run would write', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runSetup({ workspace, start: false, verify: false, fund: false, dryRun: true });

      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes(`[dry-run] Would write ${yamlPath} `))).toBe(true);
      expect(readFileSync(yamlPath, 'utf-8')).toBe('name: yaml-node\napiPort: 9317\nnetworkConfig: testnet\n');
    });
  });
});
