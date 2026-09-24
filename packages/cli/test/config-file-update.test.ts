import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkgHomeFiles, type DkgConfigFilePatch } from '../src/config.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

/** The pid of a process that has already exited. */
const EXITED_PID = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;

describe('DkgHomeFiles.updateConfigFile', () => {
  let home = '';
  let files: DkgHomeFiles;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-config-update-'));
    files = new DkgHomeFiles(home);
  });

  afterEach(async () => {
    vi.mocked(rename).mockReset();
    await rm(home, { recursive: true, force: true });
  });

  async function readJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(files.configPath, 'utf-8'));
  }

  function addKey(key: string, value: unknown): DkgConfigFilePatch {
    return (config) => { (config as Record<string, unknown>)[key] = value; };
  }

  it('changes only the keys a patch sets and adds no defaults', async () => {
    await writeFile(files.configPath, JSON.stringify({ name: 'node', legacyKey: { kept: true } }));

    await files.updateConfigFile((config) => { config.contextGraphs = ['cg']; });

    expect(await readJson()).toEqual({ name: 'node', legacyKey: { kept: true }, contextGraphs: ['cg'] });
  });

  it('creates config.json in a home that has no config yet', async () => {
    expect(await files.updateConfigFile((config) => { config.name = 'fresh'; }))
      .toEqual({ path: files.configPath, changed: true });

    expect(await readJson()).toEqual({ name: 'fresh' });
    expect(existsSync(files.configYamlPath)).toBe(false);
    expect(existsSync(files.configLockPath)).toBe(false);
  });

  describe('overlapping writers', () => {
    it('keeps every patch when one process overlaps its writes', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));

      await Promise.all(Array.from({ length: 25 }, (_, i) => files.updateConfigFile(addKey(`key-${i}`, i))));

      const written = await readJson();
      expect(written.name).toBe('node');
      for (let i = 0; i < 25; i += 1) expect(written[`key-${i}`]).toBe(i);
    });

    it('keeps every patch when the writers find a lock a crashed writer left behind', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      await writeFile(files.configLockPath, JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));

      await Promise.all(Array.from({ length: 10 }, (_, i) => files.updateConfigFile(addKey(`key-${i}`, i))));

      const written = await readJson();
      for (let i = 0; i < 10; i += 1) expect(written[`key-${i}`]).toBe(i);
      expect(existsSync(files.configLockPath)).toBe(false);
    });

    it('keeps every patch when separate processes write at the same time', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      const startFile = join(home, 'start');
      const fixture = fileURLToPath(new URL('./fixtures/config-file-writer.fixture.ts', import.meta.url));
      const writers = ['cli-a', 'cli-b', 'cli-c'];
      const count = 15;
      const exits = writers.map((writer) => new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx/esm'), fixture, home, writer, String(count), startFile],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${writer} exited with ${code}: ${stderr}`));
        });
      }));
      // Release every writer at once, and write from this process meanwhile,
      // as the daemon does while a CLI command edits the same file.
      await vi.waitFor(() => {
        for (const writer of writers) expect(existsSync(`${startFile}.${writer}.ready`)).toBe(true);
      }, { timeout: 60_000, interval: 50 });
      await writeFile(startFile, '');
      for (let i = 0; i < count; i += 1) await files.updateConfigFile(addKey(`daemon-${i}`, i));
      await Promise.all(exits);

      const written = await readJson();
      expect(written.name).toBe('node');
      for (const writer of [...writers, 'daemon']) {
        for (let i = 0; i < count; i += 1) expect(written[`${writer}-${i}`]).toBe(i);
      }
    }, 120_000);
  });

  it('leaves the previous complete config in place when a write stops before the rename', async () => {
    const original = `${JSON.stringify({ name: 'node', apiPort: 9200 }, null, 2)}\n`;
    await writeFile(files.configPath, original);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EIO: simulated'), { code: 'EIO' }));

    await expect(files.updateConfigFile((config) => { config.name = 'renamed'; }))
      .rejects.toMatchObject({ code: 'EIO' });

    expect(await readFile(files.configPath, 'utf-8')).toBe(original);
    // Neither the temp file nor the lock outlives the failed write.
    expect(await readdir(home)).toEqual(['config.json']);
    await files.updateConfigFile((config) => { config.name = 'renamed'; });
    expect(await readJson()).toEqual({ name: 'renamed', apiPort: 9200 });
  });

  describe('file format', () => {
    it('keeps a YAML-only home in YAML and never adds a shadowing config.json', async () => {
      await writeFile(files.configYamlPath, 'name: yaml-node\napiPort: 9317\n');

      expect(await files.updateConfigFile((config) => { config.contextGraphs = ['cg']; }))
        .toEqual({ path: files.configYamlPath, changed: true });

      expect(existsSync(files.configPath)).toBe(false);
      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8')))
        .toEqual({ name: 'yaml-node', apiPort: 9317, contextGraphs: ['cg'] });
      // Every reader resolves the same source of truth as the writer.
      expect((await files.loadConfig()).contextGraphs).toEqual(['cg']);
      expect(files.readConfigSync()).toEqual({ name: 'yaml-node', apiPort: 9317, contextGraphs: ['cg'] });
    });

    it('updates config.json when both files exist and leaves the shadowed YAML alone', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'json-node' }));
      await writeFile(files.configYamlPath, 'name: yaml-node\n');

      await files.updateConfigFile((config) => { config.apiPort = 9555; });

      expect(await readJson()).toEqual({ name: 'json-node', apiPort: 9555 });
      expect(await readFile(files.configYamlPath, 'utf-8')).toBe('name: yaml-node\n');
    });

    it('drops a key a YAML patch clears instead of failing to serialize it', async () => {
      await writeFile(files.configYamlPath, 'name: yaml-node\nllm:\n  apiKey: secret\n');

      await files.updateConfigFile((config) => { config.llm = undefined; });

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8'))).toEqual({ name: 'yaml-node' });
    });

    it('treats an empty config.yaml as an empty config', async () => {
      await writeFile(files.configYamlPath, '');

      await files.updateConfigFile((config) => { config.name = 'from-empty'; });

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8'))).toEqual({ name: 'from-empty' });
      expect(existsSync(files.configPath)).toBe(false);
    });

    it('patches a YAML config in place, keeping its comments and untouched lines', async () => {
      const original = [
        '# Node config, edited by hand',
        'name: yaml-node # display name',
        '',
        '# pinned until the Q3 hub rotation',
        'chain:',
        '  hubAddress: "0xabc"',
        '  rpcUrl: https://rpc.example/a/long/path/that/runs/well/past/eighty/columns/without/being/folded',
        'llm:',
        '  apiKey: secret',
        '',
      ].join('\n');
      await writeFile(files.configYamlPath, original);

      await files.updateConfigFile((config) => {
        config.localAgentIntegrations = { hermes: { id: 'hermes', enabled: true } };
        config.chain = { ...config.chain, chainId: 'evm:100' };
        delete config.llm;
      });

      const written = await readFile(files.configYamlPath, 'utf-8');
      for (const line of [
        '# Node config, edited by hand',
        '# pinned until the Q3 hub rotation',
        '  hubAddress: "0xabc"',
        '  rpcUrl: https://rpc.example/a/long/path/that/runs/well/past/eighty/columns/without/being/folded',
      ]) expect(written).toContain(line);
      expect(written).toMatch(/^name: yaml-node +# display name$/m);
      expect(yaml.load(written)).toEqual({
        name: 'yaml-node',
        chain: {
          hubAddress: '0xabc',
          rpcUrl: 'https://rpc.example/a/long/path/that/runs/well/past/eighty/columns/without/being/folded',
          chainId: 'evm:100',
        },
        localAgentIntegrations: { hermes: { id: 'hermes', enabled: true } },
      });
      expect(existsSync(files.configPath)).toBe(false);
    });

    it('rewrites a YAML config whole when a change runs through an alias', async () => {
      await writeFile(files.configYamlPath, 'base: &base\n  level: info\nlogging: *base\n');

      await files.updateConfigFile((config) => {
        (config as Record<string, any>).logging = { level: 'debug' };
      });

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8')))
        .toEqual({ base: { level: 'info' }, logging: { level: 'debug' } });
    });

    // js-yaml, which loadConfig reads with, turns a plain 2026-09-24T10:00:00Z
    // into a Date, so the strings a patch writes must come back as strings.
    it('writes strings into YAML so that loadConfig reads them back as strings', async () => {
      await writeFile(files.configYamlPath, '# operator notes\nname: yaml-node\n');
      const record = { id: 'hermes', connectedAt: '2026-09-24T10:00:00.000Z', since: '2024-01-01', mode: 'yes' };

      await files.updateConfigFile((config) => {
        config.localAgentIntegrations = { hermes: record };
      });

      expect((await files.loadConfig()).localAgentIntegrations?.hermes).toEqual(record);
      expect(await readFile(files.configYamlPath, 'utf-8')).toContain('# operator notes');
    });

    it('rewrites a YAML config whole when an in-place edit would not read back as the patch', async () => {
      // Deleting a key a merge key supplies leaves it in place in the document.
      await writeFile(files.configYamlPath, 'defaults: &defaults\n  level: info\nlogging:\n  <<: *defaults\n  format: json\n');

      await files.updateConfigFile((config) => {
        delete (config as Record<string, any>).logging.level;
      });

      expect((await files.loadConfig()).logging).toEqual({ format: 'json' });
    });

    it('writes nothing for a patch that changes nothing, so YAML comments survive', async () => {
      const original = '# operator notes\nname: yaml-node # inline\n';
      await writeFile(files.configYamlPath, original);

      expect(await files.updateConfigFile((config) => { config.name = 'yaml-node'; }))
        .toEqual({ path: files.configYamlPath, changed: false });

      expect(await readFile(files.configYamlPath, 'utf-8')).toBe(original);
      expect(rename).not.toHaveBeenCalled();
    });
  });

  it('keeps the permission bits of the config file', async () => {
    for (const mode of [0o600, 0o640]) {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      await chmod(files.configPath, mode);

      await files.updateConfigFile((config) => { config.apiPort = mode; });

      expect((await readJson()).apiPort).toBe(mode);
      // Windows keeps only a read-only flag, not POSIX permission bits.
      if (process.platform !== 'win32') expect((await stat(files.configPath)).mode & 0o777).toBe(mode);
    }
  });

  describe('refusals', () => {
    it('refuses an async patch, writes nothing and releases the lock', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      const asyncPatches = [
        async (config: Parameters<DkgConfigFilePatch>[0]) => { config.name = 'async'; },
        // A patch that rejects after the refusal must not surface as an unhandled rejection.
        async () => { await Promise.resolve(); throw new Error('late failure'); },
      ];

      for (const patch of asyncPatches) {
        await expect(files.updateConfigFile(patch as DkgConfigFilePatch))
          .rejects.toThrow('A config file patch must be synchronous');
      }

      expect(await readJson()).toEqual({ name: 'node' });
      expect(existsSync(files.configLockPath)).toBe(false);
    });

    it('refuses to overwrite a config.json it cannot parse', async () => {
      await writeFile(files.configPath, '{ not json');
      await writeFile(files.configYamlPath, 'name: stale-yaml\n');

      // The reader and the writer agree: neither falls back to the YAML.
      await expect(files.loadConfig()).rejects.toThrow(SyntaxError);
      await expect(files.updateConfigFile((config) => { config.name = 'x'; })).rejects.toThrow(SyntaxError);

      expect(await readFile(files.configPath, 'utf-8')).toBe('{ not json');
      expect(await readFile(files.configYamlPath, 'utf-8')).toBe('name: stale-yaml\n');
    });

    it('refuses a config file that does not hold an object', async () => {
      await writeFile(files.configPath, '[1, 2]');

      await expect(files.updateConfigFile((config) => { config.name = 'x'; }))
        .rejects.toThrow(`${files.configPath} does not contain a config object; refusing to update it`);

      expect(await readFile(files.configPath, 'utf-8')).toBe('[1, 2]');
    });
  });
});
