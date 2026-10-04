// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceDurableFile } from '../src/durable-file-replace.js';
import { saveSourceWorkerState } from '../src/source-worker.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dkg-durable-replace-')); directories.push(path); return path; }

describe('shared durable file replacement', () => {
  it('replaces complete private bytes with explicit file/directory modes and no temporary residue', async () => {
    const parent = join(await directory(), 'private'), path = join(parent, 'journal.json');
    await replaceDurableFile(path, '{"old":true}', { fileMode: 0o600, directoryMode: 0o700 });
    await replaceDurableFile(path, '{"new":true}', { fileMode: 0o600, directoryMode: 0o700 });
    expect(await readFile(path, 'utf8')).toBe('{"new":true}');
    expect(await readdir(parent)).toEqual(['journal.json']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
      expect((await stat(parent)).mode & 0o777).toBe(0o700 & ~process.umask());
    }
  });

  it('preserves source-worker serialization and default creation permissions', async () => {
    const parent = join(await directory(), 'source'), path = join(parent, 'state.json'), state = { sources: {} };
    await saveSourceWorkerState(path, state);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(state, null, 2) + '\n');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o666 & ~process.umask());
      expect((await stat(parent)).mode & 0o777).toBe(0o777 & ~process.umask());
    }
  });

  it('removes its temporary file and preserves the target after a failed rename', async () => {
    const parent = await directory(), target = join(parent, 'state.json');
    await mkdir(target);
    await expect(replaceDurableFile(target, 'cannot replace a directory', { fileMode: 0o600, directoryMode: 0o700 })).rejects.toThrow();
    expect(await readdir(parent)).toEqual(['state.json']);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});
