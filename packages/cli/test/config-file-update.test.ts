import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDkgNodeConfig, homeConfigLockPath, withFileLock } from '@origintrail-official/dkg-core';
import { DkgHomeFiles } from '../src/config.js';

// `DkgHomeFiles.updateConfigFile` is the CLI and daemon entry point to core's
// `updateHomeConfigFile`, whose lock, atomic replace, format and refusal
// rules are covered in packages/core/test/home-config-file.test.ts. These
// tests pin the CLI wiring: the path it returns, that the CLI's readers
// resolve the same source of truth as the writer, and the lock it shares with
// the adapter setup writers.
describe('DkgHomeFiles.updateConfigFile', () => {
  let home = '';
  let files: DkgHomeFiles;
  const originalDkgHome = process.env.DKG_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-config-update-'));
    files = new DkgHomeFiles(home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    await rm(home, { recursive: true, force: true });
  });

  async function readJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(files.configPath, 'utf-8'));
  }

  it('patches only the keys it sets and returns the file it wrote', async () => {
    await writeFile(files.configPath, JSON.stringify({ name: 'node', legacyKey: { kept: true } }));

    expect(await files.updateConfigFile((config) => { config.contextGraphs = ['cg']; })).toBe(files.configPath);

    expect(await readJson()).toEqual({ name: 'node', legacyKey: { kept: true }, contextGraphs: ['cg'] });
  });

  it('keeps a YAML-only home in YAML, and every reader resolves the file it wrote', async () => {
    await writeFile(files.configYamlPath, 'name: yaml-node\napiPort: 9317\n');

    expect(await files.updateConfigFile((config) => { config.contextGraphs = ['cg']; })).toBe(files.configYamlPath);

    expect(existsSync(files.configPath)).toBe(false);
    expect(yaml.load(await readFile(files.configYamlPath, 'utf-8')))
      .toEqual({ name: 'yaml-node', apiPort: 9317, contextGraphs: ['cg'] });
    expect(files.configExists()).toBe(true);
    expect((await files.loadConfig()).contextGraphs).toEqual(['cg']);
    expect(files.readConfigSync()).toEqual({ name: 'yaml-node', apiPort: 9317, contextGraphs: ['cg'] });
  });

  it('agrees with the readers on an unparseable config.json: neither falls back to the YAML', async () => {
    await writeFile(files.configPath, '{ not json');
    await writeFile(files.configYamlPath, 'name: stale-yaml\n');

    await expect(files.loadConfig()).rejects.toThrow(SyntaxError);
    expect(() => files.readConfigSync()).toThrow(SyntaxError);
    await expect(files.updateConfigFile((config) => { config.name = 'x'; }))
      .rejects.toThrow(`${files.configPath} is not valid JSON`);

    expect(await readFile(files.configPath, 'utf-8')).toBe('{ not json');
    expect(await readFile(files.configYamlPath, 'utf-8')).toBe('name: stale-yaml\n');
  });

  it('takes the same lock as the adapter setup writers', async () => {
    expect(files.configLockPath).toBe(homeConfigLockPath(home));
    await writeFile(files.configPath, JSON.stringify({ name: 'node' }));

    let cliWrite: Promise<string> | undefined;
    await withFileLock(homeConfigLockPath(home), async () => {
      cliWrite = files.updateConfigFile((config) => { config.apiPort = 9555; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Whoever holds the lock (here, standing in for a setup flow) writes first.
      await writeFile(files.configPath, JSON.stringify({ ...(await readJson()), networkConfig: 'testnet' }));
    });
    await cliWrite;

    expect(await readJson()).toEqual({ name: 'node', networkConfig: 'testnet', apiPort: 9555 });
  });

  it('keeps daemon patches and a setup write that overlap', async () => {
    await writeFile(files.configPath, JSON.stringify({ name: 'node', apiPort: 9300 }));
    process.env.DKG_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => files.updateConfigFile((config) => {
        (config as Record<string, unknown>)[`daemon-${i}`] = i;
      })),
      ensureDkgNodeConfig({
        agentName: 'setup-name',
        network: { networkName: 'Test Net', defaultNodeRole: 'edge', defaultContextGraphs: ['cg'] },
        networkConfigName: 'testnet',
        apiPort: 9200,
      }),
    ]);

    const written = await readJson();
    for (let i = 0; i < 10; i += 1) expect(written[`daemon-${i}`]).toBe(i);
    expect(written).toMatchObject({ name: 'node', apiPort: 9300, networkConfig: 'testnet', contextGraphs: ['cg'] });
  });
});
