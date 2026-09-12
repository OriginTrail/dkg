import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { copyFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfigFile, writeConfigSettingsTransaction as publishWithActivation } from '../src/config-file.js';
import { DkgHomeFiles, type DkgConfig } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';

// Existing file-fault cases have no runtime mutation; their compensation is empty.
function writeConfigSettingsTransaction<T>(path: string, contents: string, apply: () => T) {
  return publishWithActivation(path, contents, { apply, rollback() {} });
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    copyFile: vi.fn(actual.copyFile),
    rename: vi.fn(actual.rename),
  };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

describe('configuration file publication', () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'dkg-config-file-'));
    path = join(directory, 'config.json');
    await fs.writeFile(path, 'old configuration\n');
  });
  afterEach(async () => {
    vi.mocked(writeFile).mockImplementation(fs.writeFile);
    vi.mocked(copyFile).mockImplementation(fs.copyFile);
    vi.mocked(rename).mockImplementation(fs.rename);
    vi.clearAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('publishes the complete file before activation and cleans temporary files', async () => {
    const activate = vi.fn(() => {
      expect(readFileSync(path, 'utf8')).toBe('new configuration\n');
      return undefined;
    });
    await writeConfigSettingsTransaction(path, 'new configuration\n', activate);
    expect(activate).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it('preserves the old file after a partial staging write fails', async () => {
    vi.mocked(writeFile).mockImplementationOnce(async (target, _contents, options) => {
      await fs.writeFile(target, 'partial', options);
      throw new Error('disk full');
    });
    const activate = vi.fn(() => undefined);
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', activate)).rejects.toThrow('disk full');
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe('old configuration\n');
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it('preserves the old file if backup creation fails partway', async () => {
    vi.mocked(copyFile).mockImplementationOnce(async (_from, to) => {
      await fs.writeFile(to, 'partial backup');
      throw new Error('backup full');
    });
    const activate = vi.fn(() => undefined);
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', activate)).rejects.toThrow('backup full');
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe('old configuration\n');
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it('does not activate if atomic publication fails', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('rename denied'));
    const activate = vi.fn(() => undefined);
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', activate)).rejects.toThrow('rename denied');
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe('old configuration\n');
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it('restores the exact previous file if synchronous activation fails', async () => {
    if (process.platform !== 'win32') await fs.chmod(path, 0o640);
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', () => {
      expect(readFileSync(path, 'utf8')).toBe('new configuration\n');
      throw new Error('activation failed');
    })).rejects.toThrow('activation failed');
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(path, 'utf8')).toBe('old configuration\n');
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it('restores an absent JSON file after activation fails', async () => {
    await fs.unlink(path);
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', () => {
      throw new Error('activation failed');
    })).rejects.toThrow('activation failed');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('retains the recovery copy and reports both errors if rollback fails', async () => {
    vi.mocked(rename).mockImplementationOnce(fs.rename).mockRejectedValueOnce(new Error('rollback denied'));
    await expect(writeConfigSettingsTransaction(path, 'new configuration\n', () => {
      throw new Error('activation failed');
    })).rejects.toMatchObject({
      message: expect.stringContaining('configuration rollback failed'),
      errors: [expect.objectContaining({ message: 'activation failed' }), expect.objectContaining({ message: 'rollback denied' })],
    });
    const backup = (await fs.readdir(directory)).find(name => name.endsWith('.rollback'));
    expect(backup).toBeDefined();
    expect(await fs.readFile(join(directory, backup!), 'utf8')).toBe('old configuration\n');
  });

  it('serializes an ordinary save behind publication and rollback of a failed activation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await blocked;
      return fs.writeFile(...args);
    });
    const activationOrder: string[] = [];
    const first = writeConfigSettingsTransaction(path, 'first', () => {
      activationOrder.push(readFileSync(path, 'utf8'));
      throw new Error('first failed');
    });
    let ordinaryCompleted = false;
    const second = writeConfigFile(path, 'ordinary').then(() => {
      ordinaryCompleted = true;
    });
    const completions = Promise.allSettled([first, second]);
    expect(activationOrder).toEqual([]);
    expect(ordinaryCompleted).toBe(false);
    release();
    expect(await completions).toMatchObject([{ status: 'rejected' }, { status: 'fulfilled' }]);
    expect(activationOrder).toEqual(['first']);
    expect(ordinaryCompleted).toBe(true);
    expect(await fs.readFile(path, 'utf8')).toBe('ordinary');
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it.each(['same path', 'file symlink', 'directory symlink'] as const)(
    'rebases updates from two handles through the %s owner', async aliasKind => {
      const initial: DkgConfig = { name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge' };
      const firstFiles = new DkgHomeFiles(directory);
      let alias = directory;
      if (aliasKind !== 'same path') {
        alias = join(directory, 'alias');
        if (aliasKind === 'file symlink') {
          await fs.mkdir(alias);
          await fs.symlink('../config.json', join(alias, 'config.json'));
        } else {
          await fs.symlink(directory, alias, 'dir');
        }
      }
      const first = await DkgConfigStore.open(firstFiles, initial);
      const second = await DkgConfigStore.open(new DkgHomeFiles(alias), initial);
      expect(second).toBe(first);
      await first.update(current => ({ ...current, name: 'first committed edit' }), 'configuration-only');
      await second.update(current => ({ ...current, sharedMemoryTtlMs: 1234 }), 'configuration-only');
      const expected = { name: 'first committed edit', sharedMemoryTtlMs: 1234 };
      expect(first.current).toMatchObject(expected);
      expect(second.current).toMatchObject(expected);
      expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject(expected);
      if (aliasKind === 'file symlink') expect((await fs.lstat(join(alias, 'config.json'))).isSymbolicLink()).toBe(true);
      if (aliasKind === 'directory symlink') expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    },
  );

  it.each(['ordinary', 'transactional'] as const)('rejects %s raw writes after the daemon claims configuration', async kind => {
    const files = new DkgHomeFiles(directory);
    const initial: DkgConfig = { name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge', llm: { apiKey: 'old-key' } };
    await files.saveConfig(initial);
    const owner = await DkgConfigStore.open(files, initial);
    const before = await fs.readFile(path, 'utf8');
    const replacement = { ...initial, llm: { apiKey: 'unactivated-key' }, sharedMemoryTtlMs: 5678 };
    const apply = vi.fn();
    const saving = kind === 'ordinary' ? files.saveConfig(replacement)
      : publishWithActivation(path, JSON.stringify(replacement), { apply, rollback() {} });
    await expect(saving).rejects.toThrow('explicit activation');
    expect(apply).not.toHaveBeenCalled();
    expect(owner.current).toEqual(initial);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    await owner.update(current => ({ ...current, name: 'typed commit still works' }), 'configuration-only');
    expect(owner.current.name).toBe('typed commit still works');
  });

  it('drains an admitted standalone save before initializing the daemon owner', async () => {
    const files = new DkgHomeFiles(directory);
    const initial: DkgConfig = { name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge' };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => { await gate; return fs.writeFile(...args); });
    const saving = files.saveConfig({ ...initial, name: 'saved before claim' });
    const opening = DkgConfigStore.open(files, initial);
    await expect(files.saveConfig(initial)).rejects.toThrow('explicit activation');
    release();
    await saving;
    const owner = await opening;
    expect(owner.current.name).toBe('saved before claim');
    await owner.update(current => ({ ...current, sharedMemoryTtlMs: 5678 }), 'configuration-only');
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({ name: 'saved before claim', sharedMemoryTtlMs: 5678 });
  });

  it('keeps deletions in an admitted pre-claim save absent from later publications', async () => {
    const files = new DkgHomeFiles(directory);
    const initial: DkgConfig = {
      name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge',
      llm: { apiKey: 'removed-fixture-key' },
      localAgentIntegrations: { openclaw: { enabled: true } },
    };
    const replacement = { ...initial };
    delete replacement.llm;
    delete replacement.localAgentIntegrations;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => { await gate; return fs.writeFile(...args); });
    const saving = files.saveConfig(replacement);
    const opening = DkgConfigStore.open(files, initial);
    release();
    await saving;
    const owner = await opening;
    expect(owner.current).toEqual(replacement);
    expect(owner.current).not.toHaveProperty('llm');
    expect(owner.current).not.toHaveProperty('localAgentIntegrations');
    await owner.update(current => ({ ...current, name: 'later settings update' }), 'configuration-only');
    const persisted = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(persisted).toEqual({ ...replacement, name: 'later settings update' });
    expect(persisted).not.toHaveProperty('llm');
    expect(persisted).not.toHaveProperty('localAgentIntegrations');
  });

  it('compensates partially applied runtime state before admitting the next update', async () => {
    const files = new DkgHomeFiles(directory);
    const initial: DkgConfig = { name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge', llm: { apiKey: 'old-key' } };
    await files.saveConfig(initial);
    const before = await fs.readFile(path, 'utf8');
    const owner = await DkgConfigStore.open(files, initial);
    let runtime = initial.llm;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failure = owner.update(current => ({ ...current, llm: { apiKey: 'new-key' } }), (next, previous) => ({
      apply() { runtime = next.llm; throw new Error('activation changed runtime then failed'); },
      async rollback() { await gate; runtime = previous.llm; },
    }));
    const failed = expect(failure).rejects.toThrow('activation changed runtime then failed');
    const following = owner.update(current => {
      expect(runtime).toEqual(initial.llm);
      expect(readFileSync(path, 'utf8')).toBe(before);
      return { ...current, name: 'queued successor' };
    }, 'configuration-only');
    await vi.waitFor(() => expect(runtime?.apiKey).toBe('new-key'));
    expect(owner.current).toEqual(initial);
    release();
    await failed;
    await following;
    expect(runtime).toEqual(initial.llm);
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual(owner.current);
  });

  it('restores the file even when runtime compensation also fails', async () => {
    const files = new DkgHomeFiles(directory);
    const initial: DkgConfig = { name: 'initial', apiPort: 9200, listenPort: 0, nodeRole: 'edge' };
    await files.saveConfig(initial);
    const before = await fs.readFile(path, 'utf8');
    const owner = await DkgConfigStore.open(files, initial);
    await expect(owner.update(current => ({ ...current, name: 'candidate' }), () => ({
      apply() { throw new Error('activation failed'); },
      rollback() { throw new Error('compensation failed'); },
    }))).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'activation failed' }), expect.objectContaining({ message: 'compensation failed' })] });
    expect(owner.current).toEqual(initial);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it.each(['ordinary', 'transactional'] as const)(
    'rejects %s cyclic-link publication asynchronously', async kind => {
      await fs.unlink(path);
      await fs.symlink('config.json', path);
      let publication!: Promise<void>;
      expect(() => {
        publication = kind === 'ordinary'
          ? writeConfigFile(path, 'unused')
          : writeConfigSettingsTransaction(path, 'unused', () => undefined);
      }).not.toThrow();
      await expect(publication).rejects.toMatchObject({ code: 'ELOOP' });
    },
  );

  it('keeps ordinary config writes focused on atomic persistence', async () => {
    await writeConfigFile(path, 'persisted only\n');
    expect(await fs.readFile(path, 'utf8')).toBe('persisted only\n');
    expect(copyFile).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it.each(['ordinary', 'transactional'] as const)(
    'publishes %s configuration with 0600 permissions', async kind => {
      if (process.platform !== 'win32') await fs.chmod(path, 0o644);
      if (kind === 'ordinary') {
        await writeConfigFile(path, 'private configuration\n');
      } else {
        await writeConfigSettingsTransaction(path, 'private configuration\n', () => {
          if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(readFileSync(path, 'utf8')).toBe('private configuration\n');
          return undefined;
        });
      }
      if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(path, 'utf8')).toBe('private configuration\n');
    },
  );

  it('captures an ordinary configuration snapshot before queued publication', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await blocked;
      return fs.writeFile(...args);
    });
    const first = writeConfigSettingsTransaction(path, 'first', () => undefined);
    const config = { name: 'captured at call time' } as DkgConfig;
    const saving = new DkgHomeFiles(directory).saveConfig(config);
    config.name = 'mutated after saveConfig';
    release();
    await Promise.all([first, saving]);
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({ name: 'captured at call time' });
  });

  it(
    'saveConfig updates a relative symlink target without replacing config.json', async () => {
      await fs.unlink(path);
      const targetDirectory = join(directory, 'state');
      const target = join(targetDirectory, 'active-config.json');
      await fs.mkdir(targetDirectory);
      await fs.writeFile(target, JSON.stringify({ name: 'old' }));
      await fs.symlink(join('state', 'active-config.json'), path);

      await new DkgHomeFiles(directory).saveConfig({ name: 'symlinked-save' } as DkgConfig);

      expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path)).toBe(join('state', 'active-config.json'));
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toMatchObject({ name: 'symlinked-save' });
    },
  );

  it(
    'transactional updates and rollback preserve a symlinked config.json', async () => {
      await fs.unlink(path);
      const targetDirectory = join(directory, 'state');
      const target = join(targetDirectory, 'active-config.json');
      await fs.mkdir(targetDirectory);
      await fs.writeFile(target, 'old through symlink\n');
      await fs.symlink(join('state', 'active-config.json'), path);

      await expect(writeConfigSettingsTransaction(path, 'candidate\n', () => {
        expect(readFileSync(path, 'utf8')).toBe('candidate\n');
        throw new Error('activation failed');
      })).rejects.toThrow('activation failed');

      expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path)).toBe(join('state', 'active-config.json'));
      expect(await fs.readFile(target, 'utf8')).toBe('old through symlink\n');
      expect(await fs.readdir(targetDirectory)).toEqual(['active-config.json']);
    },
  );

});
