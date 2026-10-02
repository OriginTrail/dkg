import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkgHomeFiles, configEdit, configValues, type DkgConfig, type DkgConfigEdit, type DkgConfigPath } from '../src/config.js';
import { Document } from 'yaml';
import { applyConfigEdits, editYamlInPlace, type YamlRewriteReason } from '../src/home-config-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), stat: vi.fn(actual.stat) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

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
    for (const mocked of [open, rename, stat]) vi.mocked(mocked).mockReset();
    await rm(home, { recursive: true, force: true });
  });

  async function readJson(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(files.configPath, 'utf-8'));
  }

  /** An edit of any path, including keys the config type does not declare. */
  function edit(path: readonly string[], update: (current: unknown) => unknown): DkgConfigEdit {
    return configEdit(path as DkgConfigPath, update as never);
  }

  function addKey(key: string, value: unknown): DkgConfigEdit[] {
    return configValues({ [key]: value } as Partial<DkgConfig>);
  }

  it('changes only the keys a patch sets and adds no defaults', async () => {
    await writeFile(files.configPath, JSON.stringify({ name: 'node', legacyKey: { kept: true } }));

    await files.updateConfigFile([configEdit(['contextGraphs'], () => ['cg'])]);

    expect(await readJson()).toEqual({ name: 'node', legacyKey: { kept: true }, contextGraphs: ['cg'] });
  });

  it('creates config.json in a home that has no config yet', async () => {
    expect(await files.updateConfigFile([configEdit(['name'], () => 'fresh')]))
      .toEqual({ path: files.configPath, changed: true, strategy: 'rename' });

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

    // The writer stalled past its lease and a waiter took the lock over; what
    // this writer read may be stale, so it must not replace the waiter's file.
    it('writes nothing when another writer took the lock over while the patch ran', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      const successor = JSON.stringify({ pid: EXITED_PID, token: 'successor', createdAt: Date.now() });

      await expect(files.updateConfigFile([configEdit(['name'], () => {
        writeFileSync(files.configLockPath, successor);
        return 'stale';
      })])).rejects.toThrow(`Lost the config lock: ${files.configLockPath} was taken over`);

      expect(await readJson()).toEqual({ name: 'node' });
      // The successor's lock is left to it, and no temp file is left behind.
      expect((await readdir(home)).sort()).toEqual(['config.json', 'config.lock']);
      expect(await readFile(files.configLockPath, 'utf-8')).toBe(successor);
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
    // Only the rename that would replace the config fails (not the lock guard's).
    const actualRename = actualFs.rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      // The writer renames onto the resolved path, so match the name.
      if (basename(String(to)) === 'config.json') throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
      return actualRename(from, to);
    });

    await expect(files.updateConfigFile([configEdit(['name'], () => 'renamed')]))
      .rejects.toMatchObject({ code: 'EIO' });
    vi.mocked(rename).mockReset();

    expect(await readFile(files.configPath, 'utf-8')).toBe(original);
    // Neither the temp file nor the lock outlives the failed write.
    expect(await readdir(home)).toEqual(['config.json']);
    await files.updateConfigFile([configEdit(['name'], () => 'renamed')]);
    expect(await readJson()).toEqual({ name: 'renamed', apiPort: 9200 });
  });

  describe('file format', () => {
    it('keeps a YAML-only home in YAML and never adds a shadowing config.json', async () => {
      await writeFile(files.configYamlPath, 'name: yaml-node\napiPort: 9317\n');

      expect(await files.updateConfigFile([configEdit(['contextGraphs'], () => ['cg'])]))
        .toEqual({ path: files.configYamlPath, changed: true, strategy: 'rename' });

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

      await files.updateConfigFile([configEdit(['apiPort'], () => 9555)]);

      expect(await readJson()).toEqual({ name: 'json-node', apiPort: 9555 });
      expect(await readFile(files.configYamlPath, 'utf-8')).toBe('name: yaml-node\n');
    });

    it('drops a key a YAML edit clears instead of failing to serialize it', async () => {
      await writeFile(files.configYamlPath, 'name: yaml-node\nllm:\n  apiKey: secret\n');

      await files.updateConfigFile([configEdit(['llm'], () => undefined)]);

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8'))).toEqual({ name: 'yaml-node' });
    });

    it('treats an empty config.yaml as an empty config', async () => {
      await writeFile(files.configYamlPath, '');

      await files.updateConfigFile([configEdit(['name'], () => 'from-empty')]);

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

      await files.updateConfigFile([
        configEdit(['localAgentIntegrations', 'hermes'], () => ({ id: 'hermes', enabled: true })),
        configEdit(['chain', 'chainId'], () => 'evm:100'),
        configEdit(['llm'], () => undefined),
      ]);

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

    // An edit returns the whole new value at its path; applying only what
    // changed inside it keeps an operator's notes on the keys it kept.
    it('keeps the comments inside a mapping that an edit merges into', async () => {
      await writeFile(files.configYamlPath, [
        'publisher:',
        '  # tuned for testnet',
        '  retryJitterRatio: 0.2 # jitter',
        '',
      ].join('\n'));

      await files.updateConfigFile([configEdit(['publisher'], (publisher) => ({ ...publisher, enabled: true }))]);

      const written = await readFile(files.configYamlPath, 'utf-8');
      expect(written).toContain('  # tuned for testnet\n');
      expect(written).toMatch(/retryJitterRatio: 0\.2 +# jitter/);
      expect(yaml.load(written)).toEqual({ publisher: { retryJitterRatio: 0.2, enabled: true } });
    });

    it('rewrites a YAML config whole when a change runs through an alias', async () => {
      await writeFile(files.configYamlPath, 'base: &base\n  level: info\nlogging: *base\n');

      await files.updateConfigFile([edit(['logging'], () => ({ level: 'debug' }))]);

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8')))
        .toEqual({ base: { level: 'info' }, logging: { level: 'debug' } });
    });

    // js-yaml, which loadConfig reads with, turns a plain 2026-09-24T10:00:00Z
    // into a Date, so the strings an edit writes must come back as strings.
    it('writes strings into YAML so that loadConfig reads them back as strings', async () => {
      await writeFile(files.configYamlPath, '# operator notes\nname: yaml-node\n');
      const record = { id: 'hermes', connectedAt: '2026-09-24T10:00:00.000Z', since: '2024-01-01', mode: 'yes' };

      await files.updateConfigFile([configEdit(['localAgentIntegrations', 'hermes'], () => record)]);

      expect((await files.loadConfig()).localAgentIntegrations?.hermes).toEqual(record);
      expect(await readFile(files.configYamlPath, 'utf-8')).toContain('# operator notes');
    });

    it('rewrites a YAML config whole when an in-place edit would not read back as the edited config', async () => {
      // Deleting a key a merge key supplies leaves it in place in the document.
      await writeFile(files.configYamlPath, 'defaults: &defaults\n  level: info\nlogging:\n  <<: *defaults\n  format: json\n');

      await files.updateConfigFile([edit(['logging', 'level'], () => undefined)]);

      expect((await files.loadConfig()).logging).toEqual({ format: 'json' });
    });

    // The two parsers can disagree about a YAML construct; each known case is
    // written whole for a named reason, and anything else is a defect.
    describe('what cannot be edited in place', () => {
      function editYaml(text: string, change: (config: Record<string, any>) => void) {
        const before = JSON.parse(JSON.stringify(yaml.load(text) ?? {})) as Record<string, unknown>;
        const after = structuredClone(before);
        change(after);
        return editYamlInPlace(text, before, after);
      }

      it.each<[string, string, (config: Record<string, any>) => void, YamlRewriteReason]>([
        ['a flow list the yaml package reads as badly indented', 'contextGraphs: [a,\nb]\nname: node\n',
          (config) => { config.name = 'renamed'; }, 'unparsed'],
        ['a change inside an alias', 'base: &base\n  level: info\nlogging: *base\n',
          (config) => { config.logging.level = 'debug'; }, 'not-a-mapping'],
        ['a removal inside a mapping a merge key supplies', 'defaults: &defaults\n  telemetry:\n    enabled: false\n<<: *defaults\n',
          (config) => { delete config.telemetry.enabled; }, 'not-a-mapping'],
        ['a change inside a !!set', 'localAgentIntegrations: !!set\n  ? hermes\n',
          (config) => { config.localAgentIntegrations.openclaw = { id: 'openclaw' }; }, 'not-a-mapping'],
        // YAML 1.1 reads the key `on` as true; js-yaml reads it as "on".
        ['a change inside a key the parsers read differently', 'localAgentIntegrations:\n  on:\n    enabled: false\n',
          (config) => { config.localAgentIntegrations.on.enabled = true; }, 'not-a-mapping'],
        ['a removal of the value an alias refers to', 'llm: &llm\n  provider: openai\nfallbackLlm: *llm\n',
          (config) => { delete config.llm; }, 'orphaned-alias'],
        ['a removal of a key a merge key supplies', 'defaults: &defaults\n  level: info\nlogging:\n  <<: *defaults\n  format: json\n',
          (config) => { delete config.logging.level; }, 'read-back'],
        ['a key the parsers read differently, written again', 'localAgentIntegrations:\n  on: legacy\n',
          (config) => { config.localAgentIntegrations.on = { enabled: true }; }, 'read-back'],
      ])('writes the config whole for %s', (_case, text, change, reason) => {
        expect(editYaml(text, change)).toEqual({ rewrite: reason });
      });

      it.each([
        ['a mapping', '# notes\nname: node # inline\n', '# notes\nname: renamed # inline\n'],
        ['a file of comments only', '# notes\n', '# notes\n\nname: renamed\n'],
      ])('edits %s in place', (_case, text, edited) => {
        expect(editYaml(text, (config) => { config.name = 'renamed'; })).toEqual({ text: edited });
      });

      it.each(['setIn', 'toString'] as const)(
        'propagates a failure of the yaml package it does not expect (%s), writing nothing',
        async (method) => {
          const original = '# operator notes\nname: yaml-node\n';
          await writeFile(files.configYamlPath, original);
          const defect = new TypeError(`yaml ${method} regressed`);
          const spy = vi.spyOn(Document.prototype, method).mockImplementation(() => { throw defect; });
          try {
            await expect(files.updateConfigFile([configEdit(['name'], () => 'renamed')])).rejects.toBe(defect);
          } finally {
            spy.mockRestore();
          }

          expect(await readFile(files.configYamlPath, 'utf-8')).toBe(original);
          // Neither a temp file nor the lock outlives it.
          expect(await readdir(home)).toEqual(['config.yaml']);
          await files.updateConfigFile([configEdit(['name'], () => 'renamed')]);
          expect(await readFile(files.configYamlPath, 'utf-8')).toBe('# operator notes\nname: renamed\n');
        },
      );

      it('propagates a failure of js-yaml, reading the edit back, other than refusing the text', () => {
        const defect = new TypeError('js-yaml load regressed');
        const spy = vi.spyOn(yaml, 'load').mockImplementationOnce(() => { throw defect; });
        try {
          expect(() => editYamlInPlace('name: node\n', { name: 'node' }, { name: 'renamed' })).toThrow(defect);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('writes nothing for edits that change nothing, so YAML comments survive', async () => {
      const original = '# operator notes\nname: yaml-node # inline\n';
      await writeFile(files.configYamlPath, original);

      expect(await files.updateConfigFile([configEdit(['name'], () => 'yaml-node')]))
        .toEqual({ path: files.configYamlPath, changed: false });

      expect(await readFile(files.configYamlPath, 'utf-8')).toBe(original);
      // Nothing was renamed over the config (the lock's guard is renamed into place on release).
      expect(vi.mocked(rename).mock.calls.filter(([, to]) => basename(String(to)) === 'config.yaml')).toEqual([]);
    });
  });

  // A config belonging to another user, written by a process that may not
  // give a new file to that user, is rewritten in place to keep its owner;
  // the update says so, since that write has no crash guarantee.
  it('reports rewriting a config in place when it may not give a new file its owner', async () => {
    await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
    const { uid, ino } = await actualFs.stat(files.configPath);
    vi.mocked(stat).mockImplementation(async (...args: Parameters<typeof stat>) => {
      const found = await actualFs.stat(...args);
      return basename(String(args[0])) === 'config.json' ? Object.assign(found, { uid: uid + 1 }) : found;
    });
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await actualFs.open(...args);
      handle.chown = async () => { throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' }); };
      return handle;
    });

    expect(await files.updateConfigFile([configEdit(['name'], () => 'renamed')]))
      .toEqual({ path: files.configPath, changed: true, strategy: 'in-place' });

    expect(await readJson()).toEqual({ name: 'renamed' });
    expect((await actualFs.stat(files.configPath)).ino).toBe(ino);
  });

  // A config linked into a directory another account owns: the home, where
  // the lock lives, is writable, and so is the config, but not its directory.
  it('rewrites in place a config linked into a directory it may not add to', async () => {
    // Windows ignores a directory's mode, and root is not held to it.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const managed = await mkdtemp(join(tmpdir(), 'dkg-config-managed-'));
    await writeFile(join(managed, 'config.json'), JSON.stringify({ name: 'node' }));
    await symlink(join(managed, 'config.json'), files.configPath);
    await chmod(managed, 0o555);
    try {
      expect(await files.updateConfigFile([configEdit(['name'], () => 'renamed')]))
        .toEqual({ path: files.configPath, changed: true, strategy: 'in-place' });

      expect(JSON.parse(await readFile(join(managed, 'config.json'), 'utf-8'))).toEqual({ name: 'renamed' });
      expect((await lstat(files.configPath)).isSymbolicLink()).toBe(true);
    } finally {
      await chmod(managed, 0o755);
      await rm(managed, { recursive: true, force: true });
    }
  });

  it('keeps the permission bits of the config file', async () => {
    for (const mode of [0o600, 0o640]) {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      await chmod(files.configPath, mode);

      await files.updateConfigFile([configEdit(['apiPort'], () => mode)]);

      expect((await readJson()).apiPort).toBe(mode);
      // Windows keeps only a read-only flag, not POSIX permission bits.
      if (process.platform !== 'win32') expect((await stat(files.configPath)).mode & 0o777).toBe(mode);
    }
  });

  describe('edits', () => {
    // An edit sees only the value at its path, so a config loaded earlier has
    // nowhere to be written back: a key another writer changed since stays changed.
    it('keeps a key another writer changed after this one loaded the config', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node', apiPort: 9200 }));
      const stale = await files.loadConfig();
      await files.updateConfigFile([configEdit(['apiPort'], () => 9300)]);

      await files.updateConfigFile([configEdit(['name'], () => `${stale.name}-renamed`)]);

      expect(await readJson()).toEqual({ name: 'node-renamed', apiPort: 9300 });
    });

    it('changes only the value at its path, keeping the keys beside it', async () => {
      await writeFile(files.configPath, JSON.stringify({
        telemetry: { enabled: false, logs: { enabled: true } },
        publisher: { enabled: false, retryJitterRatio: 0.2 },
      }));

      await files.updateConfigFile([
        configEdit(['telemetry', 'enabled'], (enabled) => !enabled),
        configEdit(['publisher'], (publisher) => ({ ...publisher, enabled: true })),
      ]);

      expect(await readJson()).toEqual({
        telemetry: { enabled: true, logs: { enabled: true } },
        publisher: { enabled: true, retryJitterRatio: 0.2 },
      });
    });

    it('removes a value an edit sets to undefined, without creating a missing parent', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node', llm: { apiKey: 'secret' } }));

      await files.updateConfigFile([
        configEdit(['llm'], () => undefined),
        configEdit(['telemetry', 'enabled'], () => undefined),
      ]);

      expect(await readJson()).toEqual({ name: 'node' });
    });

    it('creates the parent of a nested edit, replacing one that is not an object', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node', telemetry: 'on' }));

      await files.updateConfigFile([
        configEdit(['telemetry', 'enabled'], () => true),
        configEdit(['localAgentIntegrations', 'hermes'], () => ({ id: 'hermes' })),
      ]);

      expect(await readJson()).toEqual({
        name: 'node', telemetry: { enabled: true }, localAgentIntegrations: { hermes: { id: 'hermes' } },
      });
    });

    it('leaves the config it is given unchanged, even when a later edit throws', () => {
      const input = { name: 'node', contextGraphs: ['a'] };
      const seen: unknown[] = [];

      expect(() => applyConfigEdits(input, [
        configEdit(['contextGraphs'], (graphs) => { seen.push(graphs); return [...(graphs ?? []), 'b']; }),
        configEdit(['contextGraphs'], (graphs) => { seen.push(graphs); return [...(graphs ?? []), 'c']; }),
        configEdit(['apiPort'], () => { throw new Error('no port'); }),
      ])).toThrow('no port');

      expect(input).toEqual({ name: 'node', contextGraphs: ['a'] });
      expect(seen).toEqual([['a'], ['a', 'b']]);
      expect(applyConfigEdits(input, [configEdit(['name'], () => 'renamed')])).toEqual({
        before: { name: 'node', contextGraphs: ['a'] },
        after: { name: 'renamed', contextGraphs: ['a'] },
        changed: true,
      });
      expect(input).toEqual({ name: 'node', contextGraphs: ['a'] });
    });

    // `__proto__` is a valid integration id; assigning it would set the
    // object's prototype instead of storing an entry.
    it.each(['json', 'yaml'])('stores and removes an entry whose key is __proto__ like any other, in a %s home', async (format) => {
      const initial = { localAgentIntegrations: { hermes: { id: 'hermes' } } };
      if (format === 'json') await writeFile(files.configPath, JSON.stringify(initial));
      else await writeFile(files.configYamlPath, yaml.dump(initial));

      await files.updateConfigFile([
        configEdit(['localAgentIntegrations', '__proto__'], () => ({ id: '__proto__', enabled: true })),
      ]);
      const stored = (await files.loadConfig()).localAgentIntegrations ?? {};
      expect(Object.keys(stored)).toEqual(['hermes', '__proto__']);
      expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toEqual({ id: '__proto__', enabled: true });
      expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);

      await files.updateConfigFile([configEdit(['localAgentIntegrations', '__proto__'], () => undefined)]);
      expect(Object.keys((await files.loadConfig()).localAgentIntegrations ?? {})).toEqual(['hermes']);
    });

    it('applies edits in order, together, and writes nothing when one of them throws', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node', contextGraphs: ['a'] }));

      await files.updateConfigFile([
        configEdit(['contextGraphs'], (graphs) => [...(graphs ?? []), 'b']),
        configEdit(['contextGraphs'], (graphs) => [...(graphs ?? []), 'c']),
      ]);
      expect((await readJson()).contextGraphs).toEqual(['a', 'b', 'c']);

      await expect(files.updateConfigFile([
        configEdit(['name'], () => 'renamed'),
        configEdit(['apiPort'], () => { throw new Error('no port'); }),
      ])).rejects.toThrow('no port');
      expect(await readJson()).toEqual({ name: 'node', contextGraphs: ['a', 'b', 'c'] });
      expect(existsSync(files.configLockPath)).toBe(false);
    });
  });

  describe('refusals', () => {
    it('refuses an async update, writes nothing and releases the lock', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));
      const asyncUpdates = [
        async () => 'async',
        // An update that rejects after the refusal must not surface as an unhandled rejection.
        async () => { await Promise.resolve(); throw new Error('late failure'); },
      ];

      for (const update of asyncUpdates) {
        await expect(files.updateConfigFile([edit(['name'], update)]))
          .rejects.toThrow('A config edit must be synchronous');
      }

      expect(await readJson()).toEqual({ name: 'node' });
      expect(existsSync(files.configLockPath)).toBe(false);
    });

    it('refuses to overwrite a config.json it cannot parse', async () => {
      await writeFile(files.configPath, '{ not json');
      await writeFile(files.configYamlPath, 'name: stale-yaml\n');

      // The reader and the writer agree: neither falls back to the YAML.
      await expect(files.loadConfig()).rejects.toThrow(SyntaxError);
      await expect(files.updateConfigFile([configEdit(['name'], () => 'x')])).rejects.toThrow(SyntaxError);

      expect(await readFile(files.configPath, 'utf-8')).toBe('{ not json');
      expect(await readFile(files.configYamlPath, 'utf-8')).toBe('name: stale-yaml\n');
    });

    // js-yaml reads a bare YAML timestamp as a Date, which is not a mapping.
    it('refuses a YAML config that holds a timestamp instead of a mapping', async () => {
      await writeFile(files.configYamlPath, '2026-09-24\n');

      await expect(files.updateConfigFile([configEdit(['name'], () => 'node')]))
        .rejects.toThrow(`${files.configYamlPath} does not contain a config object; refusing to update it`);

      expect(await readFile(files.configYamlPath, 'utf-8')).toBe('2026-09-24\n');
    });

    it('replaces a timestamp where a nested edit needs a mapping', async () => {
      await writeFile(files.configYamlPath, 'name: node\ntelemetry: 2026-09-24\n');

      await files.updateConfigFile([configEdit(['telemetry', 'enabled'], () => true)]);

      expect(yaml.load(await readFile(files.configYamlPath, 'utf-8'))).toEqual({ name: 'node', telemetry: { enabled: true } });
    });

    it('refuses an edit not made by configEdit or configValues', async () => {
      await writeFile(files.configPath, JSON.stringify({ name: 'node' }));

      await expect(files.updateConfigFile([{ path: ['name'], update: () => 'hand-built' } as unknown as DkgConfigEdit]))
        .rejects.toThrow('A config edit must be made by configEdit or configValues');

      expect(await readJson()).toEqual({ name: 'node' });
    });

    it('refuses a config file that does not hold an object', async () => {
      await writeFile(files.configPath, '[1, 2]');

      await expect(files.updateConfigFile([configEdit(['name'], () => 'x')]))
        .rejects.toThrow(`${files.configPath} does not contain a config object; refusing to update it`);

      expect(await readFile(files.configPath, 'utf-8')).toBe('[1, 2]');
    });
  });
});
