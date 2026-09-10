import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { copyFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfigFile, writeConfigSettingsTransaction } from '../src/config-file.js';

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
    const second = writeConfigFile(path, () => 'ordinary').then(() => {
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

  it('keeps ordinary config writes focused on atomic persistence', async () => {
    await writeConfigFile(path, () => 'persisted only\n');
    expect(await fs.readFile(path, 'utf8')).toBe('persisted only\n');
    expect(copyFile).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(['config.json']);
  });

  it.each(['ordinary', 'transactional'] as const)(
    'publishes %s configuration with 0600 permissions', async kind => {
      if (process.platform !== 'win32') await fs.chmod(path, 0o644);
      if (kind === 'ordinary') {
        await writeConfigFile(path, () => 'private configuration\n');
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

});
