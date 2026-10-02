import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  homeConfigFilePath,
  homeConfigLockPath,
  readHomeConfigSource,
  updateHomeConfigFile,
  type HomeConfigFile,
  type HomeConfigFilePatch,
} from '../src/home-config-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

/** The pid of a process that has already exited. */
const EXITED_PID = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;

describe('updateHomeConfigFile', () => {
  let home = '';
  let jsonPath = '';
  let yamlPath = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-home-config-'));
    jsonPath = join(home, 'config.json');
    yamlPath = join(home, 'config.yaml');
  });

  afterEach(async () => {
    vi.mocked(rename).mockReset();
    await rm(home, { recursive: true, force: true });
  });

  async function readJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(jsonPath, 'utf-8'));
  }

  function addKey(key: string, value: unknown): HomeConfigFilePatch {
    return (config) => { config[key] = value; };
  }

  it('changes only the keys a patch sets and adds no defaults', async () => {
    await writeFile(jsonPath, JSON.stringify({ name: 'node', legacyKey: { kept: true } }));

    await expect(updateHomeConfigFile(home, (config) => { config.contextGraphs = ['cg']; }))
      .resolves.toEqual({ path: jsonPath, changed: true });

    expect(await readJson()).toEqual({ name: 'node', legacyKey: { kept: true }, contextGraphs: ['cg'] });
  });

  it('creates config.json in a home that has no config yet, creating the home too', async () => {
    const fresh = join(home, 'nested', '.dkg');
    const seen: HomeConfigFile[] = [];

    const update = await updateHomeConfigFile(fresh, (config, file) => {
      seen.push(file);
      config.name = 'fresh';
    });

    expect(update).toEqual({ path: join(fresh, 'config.json'), changed: true });
    expect(seen).toEqual([{ path: join(fresh, 'config.json'), format: 'json', existed: false }]);
    expect(JSON.parse(await readFile(join(fresh, 'config.json'), 'utf-8'))).toEqual({ name: 'fresh' });
    expect(existsSync(join(fresh, 'config.yaml'))).toBe(false);
    expect(existsSync(homeConfigLockPath(fresh))).toBe(false);
  });

  it('tells the patch which file it is patching and that it existed', async () => {
    await writeFile(yamlPath, 'name: yaml-node\n');
    const seen: HomeConfigFile[] = [];

    await updateHomeConfigFile(home, (_config, file) => { seen.push(file); });

    expect(seen).toEqual([{ path: yamlPath, format: 'yaml', existed: true }]);
  });

  it('holds the config lock while the patch runs', async () => {
    await updateHomeConfigFile(home, () => {
      expect(existsSync(join(home, 'config.lock'))).toBe(true);
    });
    expect(existsSync(join(home, 'config.lock'))).toBe(false);
  });

  describe('overlapping writers', () => {
    it('keeps every patch when one process overlaps its writes', async () => {
      await writeFile(jsonPath, JSON.stringify({ name: 'node' }));

      await Promise.all(Array.from({ length: 25 }, (_, i) => updateHomeConfigFile(home, addKey(`key-${i}`, i))));

      const written = await readJson();
      expect(written.name).toBe('node');
      for (let i = 0; i < 25; i += 1) expect(written[`key-${i}`]).toBe(i);
    });

    it('keeps every patch when the writers find a lock a crashed writer left behind', async () => {
      await writeFile(jsonPath, JSON.stringify({ name: 'node' }));
      await writeFile(homeConfigLockPath(home), JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));

      await Promise.all(Array.from({ length: 10 }, (_, i) => updateHomeConfigFile(home, addKey(`key-${i}`, i))));

      const written = await readJson();
      for (let i = 0; i < 10; i += 1) expect(written[`key-${i}`]).toBe(i);
      expect(existsSync(homeConfigLockPath(home))).toBe(false);
    });

    it('keeps every patch when separate processes write at the same time', async () => {
      await writeFile(jsonPath, JSON.stringify({ name: 'node' }));
      const startFile = join(home, 'start');
      const fixture = fileURLToPath(new URL('./fixtures/home-config-writer.fixture.ts', import.meta.url));
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
      // as the daemon does while a CLI command or a setup flow edits the file.
      await vi.waitFor(() => {
        for (const writer of writers) expect(existsSync(`${startFile}.${writer}.ready`)).toBe(true);
      }, { timeout: 60_000, interval: 50 });
      await writeFile(startFile, '');
      for (let i = 0; i < count; i += 1) await updateHomeConfigFile(home, addKey(`daemon-${i}`, i));
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
    await writeFile(jsonPath, original);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EIO: simulated'), { code: 'EIO' }));

    await expect(updateHomeConfigFile(home, (config) => { config.name = 'renamed'; }))
      .rejects.toMatchObject({ code: 'EIO' });

    expect(await readFile(jsonPath, 'utf-8')).toBe(original);
    // Neither the temp file nor the lock outlives the failed write.
    expect(await readdir(home)).toEqual(['config.json']);
    await updateHomeConfigFile(home, (config) => { config.name = 'renamed'; });
    expect(await readJson()).toEqual({ name: 'renamed', apiPort: 9200 });
  });

  describe('file format', () => {
    it('keeps a YAML-only home in YAML and never adds a shadowing config.json', async () => {
      await writeFile(yamlPath, 'name: yaml-node\napiPort: 9317\n');

      await expect(updateHomeConfigFile(home, (config) => { config.contextGraphs = ['cg']; }))
        .resolves.toEqual({ path: yamlPath, changed: true });

      expect(existsSync(jsonPath)).toBe(false);
      expect(yaml.load(await readFile(yamlPath, 'utf-8')))
        .toEqual({ name: 'yaml-node', apiPort: 9317, contextGraphs: ['cg'] });
    });

    it('updates config.json when both files exist and leaves the shadowed YAML alone', async () => {
      await writeFile(jsonPath, JSON.stringify({ name: 'json-node' }));
      await writeFile(yamlPath, 'name: yaml-node\n');

      await updateHomeConfigFile(home, (config) => { config.apiPort = 9555; });

      expect(await readJson()).toEqual({ name: 'json-node', apiPort: 9555 });
      expect(await readFile(yamlPath, 'utf-8')).toBe('name: yaml-node\n');
    });

    it('drops a key a YAML patch clears instead of failing to serialize it', async () => {
      await writeFile(yamlPath, 'name: yaml-node\nllm:\n  apiKey: secret\n');

      await updateHomeConfigFile(home, (config) => { config.llm = undefined; });

      expect(yaml.load(await readFile(yamlPath, 'utf-8'))).toEqual({ name: 'yaml-node' });
    });

    it('treats an empty config.yaml as an empty config', async () => {
      await writeFile(yamlPath, '');

      await updateHomeConfigFile(home, (config) => { config.name = 'from-empty'; });

      expect(yaml.load(await readFile(yamlPath, 'utf-8'))).toEqual({ name: 'from-empty' });
      expect(existsSync(jsonPath)).toBe(false);
    });

    it('writes nothing for a patch that changes nothing, so YAML comments survive', async () => {
      const original = '# operator notes\nname: yaml-node # inline\n';
      await writeFile(yamlPath, original);

      await expect(updateHomeConfigFile(home, (config) => { config.name = 'yaml-node'; }))
        .resolves.toEqual({ path: yamlPath, changed: false });

      expect(await readFile(yamlPath, 'utf-8')).toBe(original);
      expect(rename).not.toHaveBeenCalled();
    });
  });

  it('keeps the permission bits of the config file', async () => {
    for (const mode of [0o600, 0o640]) {
      await writeFile(jsonPath, JSON.stringify({ name: 'node' }));
      await chmod(jsonPath, mode);

      await updateHomeConfigFile(home, (config) => { config.apiPort = mode; });

      expect((await readJson()).apiPort).toBe(mode);
      // Windows keeps only a read-only flag, not POSIX permission bits.
      if (process.platform !== 'win32') expect((await stat(jsonPath)).mode & 0o777).toBe(mode);
    }
  });

  describe('refusals', () => {
    it('refuses an async patch, writes nothing and releases the lock', async () => {
      await writeFile(jsonPath, JSON.stringify({ name: 'node' }));
      const asyncPatches = [
        async (config: Record<string, unknown>) => { config.name = 'async'; },
        // A patch that rejects after the refusal must not surface as an unhandled rejection.
        async () => { await Promise.resolve(); throw new Error('late failure'); },
      ];

      for (const patch of asyncPatches) {
        await expect(updateHomeConfigFile(home, patch as unknown as HomeConfigFilePatch))
          .rejects.toThrow('A config file patch must be synchronous');
      }

      expect(await readJson()).toEqual({ name: 'node' });
      expect(existsSync(homeConfigLockPath(home))).toBe(false);
    });

    it('refuses to overwrite a config.json it cannot parse, naming the file', async () => {
      await writeFile(jsonPath, '{ not json');
      await writeFile(yamlPath, 'name: stale-yaml\n');

      const refusal = updateHomeConfigFile(home, (config) => { config.name = 'x'; });

      await expect(refusal).rejects.toThrow(`${jsonPath} is not valid JSON (`);
      await expect(refusal).rejects.toMatchObject({ cause: expect.any(SyntaxError) });
      expect(await readFile(jsonPath, 'utf-8')).toBe('{ not json');
      expect(await readFile(yamlPath, 'utf-8')).toBe('name: stale-yaml\n');
    });

    it('refuses to overwrite a config.yaml it cannot parse, naming the file', async () => {
      await writeFile(yamlPath, 'name: [unclosed\n');

      await expect(updateHomeConfigFile(home, (config) => { config.name = 'x'; }))
        .rejects.toThrow(`${yamlPath} is not valid YAML (`);

      expect(await readFile(yamlPath, 'utf-8')).toBe('name: [unclosed\n');
      expect(existsSync(jsonPath)).toBe(false);
    });

    it('refuses a config file that does not hold an object', async () => {
      await writeFile(jsonPath, '[1, 2]');

      await expect(updateHomeConfigFile(home, (config) => { config.name = 'x'; }))
        .rejects.toThrow(`${jsonPath} does not contain a config object; refusing to update it`);

      expect(await readFile(jsonPath, 'utf-8')).toBe('[1, 2]');
    });

    it('propagates a failure to read the config other than a missing file', async () => {
      // A directory where the config should be fails the read with EISDIR.
      await mkdir(jsonPath);

      await expect(updateHomeConfigFile(home, (config) => { config.name = 'x'; }))
        .rejects.toMatchObject({ code: 'EISDIR' });
    });
  });
});

describe('readHomeConfigSource', () => {
  let home = '';

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'dkg-home-config-source-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('returns the source-of-truth file unparsed, config.json before config.yaml', async () => {
    expect(await readHomeConfigSource(home)).toBeUndefined();

    await writeFile(join(home, 'config.yaml'), 'name: yaml-node\n');
    const yamlSource = await readHomeConfigSource(home);
    expect(yamlSource).toMatchObject({ path: join(home, 'config.yaml'), format: 'yaml', text: 'name: yaml-node\n' });
    expect(yamlSource!.parse(yamlSource!.text)).toEqual({ name: 'yaml-node' });

    // An unparseable config.json still wins; the caller's parse decides.
    await writeFile(join(home, 'config.json'), '{ not json');
    const jsonSource = await readHomeConfigSource(home);
    expect(jsonSource).toMatchObject({ path: join(home, 'config.json'), format: 'json', text: '{ not json' });
    expect(() => jsonSource!.parse(jsonSource!.text)).toThrow(SyntaxError);
  });
});

describe('homeConfigFilePath', () => {
  let home = '';

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'dkg-home-config-path-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('names config.json, else config.yaml, else a new config.json', async () => {
    expect(homeConfigFilePath(home)).toBe(join(home, 'config.json'));

    await writeFile(join(home, 'config.yaml'), 'name: yaml-node\n');
    expect(homeConfigFilePath(home)).toBe(join(home, 'config.yaml'));

    await writeFile(join(home, 'config.json'), '{}');
    expect(homeConfigFilePath(home)).toBe(join(home, 'config.json'));
  });
});
