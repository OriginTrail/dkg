import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { AutoUpdateConfig } from '../src/config.js';

describe.sequential('auto-update versioned e2e', { timeout: 30_000 }, () => {
  let tmpDir: string;
  let bareRepo: string;
  let workDir: string;
  let dkgHome: string;
  let releasesDirPath: string;
  let slotA: string;
  let slotB: string;
  let tagStable = '';
  let tagPrerelease = '';
  let shaStable = '';
  let shaPrerelease = '';
  let apiServer: Server;
  let apiPort: number;
  const origFetch = globalThis.fetch;
  const origDkgHome = process.env.DKG_HOME;

  function git(cmd: string, cwd: string): string {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  }

  async function makeCommit(version: string, tag: string): Promise<string> {
    await writeFile(
      join(workDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dkg-e2e-fixture',
          private: true,
          version,
          scripts: {
            build:
              'node -e "require(\'node:fs\').mkdirSync(\'packages/cli/dist\', { recursive: true }); require(\'node:fs\').writeFileSync(\'packages/cli/dist/cli.js\', \'#!/usr/bin/env node\\\\nconsole.log(\\\"fixture\\\")\\\\n\');"',
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(workDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n");
    await mkdir(join(workDir, 'packages', 'cli'), { recursive: true });
    await writeFile(
      join(workDir, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@fixture/cli', version }, null, 2),
    );
    git('git add -A', workDir);
    git(`git commit -m "fixture ${version}"`, workDir);
    git(`git tag -f ${tag}`, workDir);
    git('git push origin main --tags --force', workDir);
    return git('git rev-parse HEAD', workDir);
  }

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-au-v-e2e-'));
    bareRepo = join(tmpDir, 'origin.git');
    workDir = join(tmpDir, 'work');
    dkgHome = join(tmpDir, '.dkg');
    releasesDirPath = join(dkgHome, 'releases');
    slotA = join(releasesDirPath, 'a');
    slotB = join(releasesDirPath, 'b');

    process.env.DKG_HOME = dkgHome;
    execSync(`git init --bare --initial-branch=main "${bareRepo}"`, { stdio: 'pipe' });
    execSync(`git clone "${bareRepo}" "${workDir}"`, { stdio: 'pipe' });
    git('git config user.email "test@example.com"', workDir);
    git('git config user.name "AutoUpdate E2E"', workDir);
    git('git checkout -B main', workDir);

    await writeFile(join(workDir, 'README.md'), 'fixture');
    git('git add -A', workDir);
    git('git commit -m "init"', workDir);
    git('git push -u origin main', workDir);

    await mkdir(releasesDirPath, { recursive: true });
    execSync(`git clone -b main "${bareRepo}" "${slotA}"`, { stdio: 'pipe' });
    execSync(`git clone -b main "${bareRepo}" "${slotB}"`, { stdio: 'pipe' });
    await symlink('a', join(releasesDirPath, 'current'));
    await writeFile(join(releasesDirPath, 'active'), 'a');

    tagStable = 'v9.0.5';
    tagPrerelease = 'v9.0.6-rc.1';
    shaStable = await makeCommit('9.0.5', tagStable);
    shaPrerelease = await makeCommit('9.0.6-rc.1', tagPrerelease);

    await writeFile(join(dkgHome, '.current-commit'), 'seed-old-sha');

    await new Promise<void>((resolve) => {
      apiServer = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.includes(tagPrerelease)) {
          res.end(JSON.stringify({ sha: shaPrerelease }));
        } else {
          res.end(JSON.stringify({ sha: shaStable }));
        }
      });
      apiServer.listen(0, '127.0.0.1', () => {
        apiPort = (apiServer.address() as { port: number }).port;
        resolve();
      });
    });

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      return origFetch(`http://127.0.0.1:${apiPort}/api`, init);
    };
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    if (origDkgHome !== undefined) {
      process.env.DKG_HOME = origDkgHome;
    } else {
      delete process.env.DKG_HOME;
    }
    await new Promise<void>((resolve, reject) => apiServer.close((err) => (err ? reject(err) : resolve())));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('updates to a specific stable version tag and writes commit/version metadata', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const au: AutoUpdateConfig = {
      enabled: true,
      repo: bareRepo,
      branch: 'main',
      checkIntervalMinutes: 30,
    };

    const updated = await performUpdate(au, () => {}, {
      refOverride: `refs/tags/${tagStable}`,
      verifyTagSignature: false,
    });
    expect(updated).toBe(true);
    expect(await readlink(join(releasesDirPath, 'current'))).toBe('b');
    expect((await readFile(join(dkgHome, '.current-commit'), 'utf-8')).trim()).toBe(shaStable);
    expect((await readFile(join(dkgHome, '.current-version'), 'utf-8')).trim()).toBe('9.0.5');
  });

  it('blocks prerelease tag when allowPrerelease=false', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const au: AutoUpdateConfig = {
      enabled: true,
      repo: bareRepo,
      branch: 'main',
      allowPrerelease: false,
      checkIntervalMinutes: 30,
    };
    const updated = await performUpdate(au, () => {}, {
      refOverride: `refs/tags/${tagPrerelease}`,
      verifyTagSignature: false,
    });
    expect(updated).toBe(false);
    expect(await readlink(join(releasesDirPath, 'current'))).toBe('b');
    expect((await readFile(join(dkgHome, '.current-version'), 'utf-8')).trim()).toBe('9.0.5');
  });

  it('allows prerelease tag when allowPrerelease=true', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const au: AutoUpdateConfig = {
      enabled: true,
      repo: bareRepo,
      branch: 'main',
      allowPrerelease: true,
      checkIntervalMinutes: 30,
    };
    const updated = await performUpdate(au, () => {}, {
      refOverride: `refs/tags/${tagPrerelease}`,
      verifyTagSignature: false,
    });
    expect(updated).toBe(true);
    expect(await readlink(join(releasesDirPath, 'current'))).toBe('a');
    expect((await readFile(join(dkgHome, '.current-commit'), 'utf-8')).trim()).toBe(shaPrerelease);
    expect((await readFile(join(dkgHome, '.current-version'), 'utf-8')).trim()).toBe('9.0.6-rc.1');
  });
});
