import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
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

  async function makeCommit(version: string, tag: string, identity: 'legacy' | 'compiler' | 'failed' = 'legacy'): Promise<string> {
    await writeFile(
      join(workDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dkg-e2e-fixture',
          private: true,
          version,
          scripts: {
            build: `node fixture-build.mjs ${identity}`,
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
      JSON.stringify({ name: '@fixture/cli', type: 'module', version }, null, 2),
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
    // Hermetic against host gitconfig: a global `tag.gpgsign = true` turns
    // the lightweight `git tag -f` in makeCommit() into a signed annotated
    // tag and fails with "fatal: no tag message?".
    git('git config tag.gpgsign false', workDir);
    git('git config commit.gpgsign false', workDir);
    git('git checkout -B main', workDir);

    await writeFile(join(workDir, '.gitignore'), 'node_modules/\npackages/*/dist/\npackages/*/dist-ui/\npackages/cli/build-info.json\n');
    // Bundle the real identity reader into each tiny release, not a simulated
    // metadata reader. External dependencies remain in the preserved slot cache.
    await build({
      entryPoints: [fileURLToPath(new URL('../src/daemon/manifest.ts', import.meta.url))],
      outfile: join(workDir, 'fixture-manifest.mjs'), bundle: true, packages: 'external',
      platform: 'node', format: 'esm', logLevel: 'silent',
    });
    await writeFile(join(workDir, 'fixture-build.mjs'), `
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      fs.mkdirSync('packages/cli/dist/daemon', { recursive: true });
      fs.copyFileSync('fixture-manifest.mjs', 'packages/cli/dist/daemon/manifest.js');
      fs.writeFileSync('packages/cli/dist/cli.js', \`import {loadBuildInfo,getCurrentCommitFull} from './daemon/manifest.js';
        const buildInfo=loadBuildInfo();
        console.log(JSON.stringify({buildInfo,commit:buildInfo.commit==='uncommitted'?getCurrentCommitFull():buildInfo.commit}));\`);
      fs.mkdirSync('packages/node-ui/dist-ui', { recursive: true });
      fs.writeFileSync('packages/node-ui/dist-ui/index.html', '<!doctype html><title>fixture</title>');
      if (process.argv[2]==='failed') process.exit(1);
      if (process.argv[2]==='compiler') {
        const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
        fs.writeFileSync('packages/cli/build-info.json',JSON.stringify({commit,commitShort:commit.slice(0,8),dirty:false,distTag:'monorepo'}));
      }
    `);
    await writeFile(join(workDir, 'README.md'), 'fixture');
    git('git add -A', workDir);
    git('git commit -m "init"', workDir);
    git('git push -u origin main', workDir);

    await mkdir(releasesDirPath, { recursive: true });
    execSync(`git clone -b main "${bareRepo}" "${slotA}"`, { stdio: 'pipe' });
    execSync(`git clone -b main "${bareRepo}" "${slotB}"`, { stdio: 'pipe' });
    const dependencyCache = fileURLToPath(new URL('../node_modules', import.meta.url));
    for (const slot of [slotA, slotB]) {
      await mkdir(join(slot, 'packages/cli'), { recursive: true });
      await symlink(dependencyCache, join(slot, 'packages/cli/node_modules'));
    }
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
  function activeIdentity() {
    return JSON.parse(execFileSync(process.execPath, [join(releasesDirPath, 'current/packages/cli/dist/cli.js')], {
      encoding: 'utf8', env: { ...process.env, DKG_HOME: dkgHome },
    }));
  }

  it('reports historical B after activating a reused inactive slot stamped by A', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const activeBefore = await readlink(join(releasesDirPath, 'current'));
    const target = activeBefore === 'a' ? slotB : slotA;
    const oldActiveStamp = JSON.stringify({ commit: shaPrerelease, distTag: 'monorepo' });
    await writeFile(join(releasesDirPath, activeBefore, 'packages/cli/build-info.json'), oldActiveStamp);
    await writeFile(join(target, 'packages/cli/build-info.json'), JSON.stringify({ commit: shaStable, distTag: 'monorepo' }));
    const b = await makeCommit('9.0.7', 'v9.0.7');
    expect(await performUpdate({ enabled: true, repo: bareRepo, branch: 'main', checkIntervalMinutes: 30 }, () => {}, {
      refOverride: 'refs/tags/v9.0.7', verifyTagSignature: false,
    })).toBe(true);
    expect(activeIdentity()).toMatchObject({ commit: b, buildInfo: { commit: 'uncommitted', distTag: 'monorepo' } });
    // The active slot's old compiler identity was never a cleanup target.
    expect(await readFile(join(releasesDirPath, activeBefore, 'packages/cli/build-info.json'), 'utf8')).toBe(oldActiveStamp);
  });

  it('keeps a newly compiled B identity when reusing a stale stamped slot', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const activeBefore = await readlink(join(releasesDirPath, 'current'));
    const target = activeBefore === 'a' ? slotB : slotA;
    await writeFile(join(target, 'packages/cli/build-info.json'), JSON.stringify({ commit: shaStable, distTag: 'monorepo' }));
    const b = await makeCommit('9.0.8', 'v9.0.8', 'compiler');
    expect(await performUpdate({ enabled: true, repo: bareRepo, branch: 'main', checkIntervalMinutes: 30 }, () => {}, {
      refOverride: 'refs/tags/v9.0.8', verifyTagSignature: false,
    })).toBe(true);
    expect(activeIdentity()).toMatchObject({ commit: b, buildInfo: { commit: b, distTag: 'monorepo' } });
  });

  it('leaves the running compiler identity and current slot untouched on a failed historical rebuild', async () => {
    const { performUpdate } = await import('../src/daemon.js');
    const activeBefore = await readlink(join(releasesDirPath, 'current'));
    const identityBefore = activeIdentity();
    const persistedBefore = await readFile(join(dkgHome, '.current-commit'), 'utf8');
    await makeCommit('9.0.9', 'v9.0.9', 'failed');
    expect(await performUpdate({ enabled: true, repo: bareRepo, branch: 'main', checkIntervalMinutes: 30 }, () => {}, {
      refOverride: 'refs/tags/v9.0.9', verifyTagSignature: false,
    })).toBe(false);
    expect(await readlink(join(releasesDirPath, 'current'))).toBe(activeBefore);
    expect(activeIdentity()).toEqual(identityBefore);
    expect(await readFile(join(dkgHome, '.current-commit'), 'utf8')).toBe(persistedBefore);
  });

});
