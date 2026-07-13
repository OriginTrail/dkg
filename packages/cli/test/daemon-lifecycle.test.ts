import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNetworkId } from '../../core/src/genesis.js';
import { validateStartupGenesis } from '../src/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const cliSource = join(__dirname, '..', 'src', 'cli.ts');
const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

describe('daemon startup genesis validation', () => {
  it('continues when the selected network genesis id matches its network id', async () => {
    const networkId = await computeNetworkId('gnosis-mainnet');

    await expect(validateStartupGenesis({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      networkId,
    })).resolves.toEqual({ ok: true, networkId });
  });

  it('reports the selected overlay when the selected genesis id mismatches its network id', async () => {
    const staleNetworkId = await computeNetworkId('base-mainnet');
    const selectedNetworkId = await computeNetworkId('neuroweb-mainnet');

    await expect(validateStartupGenesis({
      networkName: 'DKG V10 NeuroWeb Mainnet',
      genesisId: 'neuroweb-mainnet',
      networkId: staleNetworkId,
    })).resolves.toEqual({
      ok: false,
      networkId: selectedNetworkId,
      messages: [
        `FATAL: genesis mismatch! Expected networkId ${staleNetworkId.slice(0, 16)}... but computed ${selectedNetworkId.slice(0, 16)}...`,
        `This node's genesis does not match DKG V10 NeuroWeb Mainnet. Rebuild or update the selected network config.`,
      ],
    });
  });

  it('rejects pre-deployment configs with placeholder relay peer ids', async () => {
    const networkId = await computeNetworkId('base-mainnet');

    const result = await validateStartupGenesis({
      networkName: 'DKG V10 Base Mainnet',
      genesisId: 'base-mainnet',
      networkId,
      _status: 'pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet',
      relays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS'],
    });

    expect(result.ok).toBe(false);
    expect(result.networkId).toBe(networkId);
    if (!result.ok) {
      expect(result.messages).toContain(
        'FATAL: network config DKG V10 Base Mainnet is marked pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet.',
      );
      expect(result.messages.some(message => message.includes('PEER_ID_SOLARIS'))).toBe(true);
    }
  });
});

async function writeWorkspaceTsconfig(tsconfigPath: string): Promise<void> {
  const packagesDir = join(repoRoot, 'packages');
  const paths: Record<string, string[]> = {};

  for (const packageDir of await readdir(packagesDir)) {
    const packageJsonPath = join(packagesDir, packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { name?: string };
    if (!parsed.name) continue;
    paths[parsed.name] = [`packages/${packageDir}/src/index.ts`];
    paths[`${parsed.name}/*`] = [`packages/${packageDir}/src/*`];
  }

  await writeFile(
    tsconfigPath,
    JSON.stringify({ compilerOptions: { baseUrl: repoRoot, paths } }),
  );
}

interface SupervisorResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runSupervisorProcess(
  tempHome: string,
  tsconfigPath: string,
): Promise<SupervisorResult> {
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    TSX_TSCONFIG_PATH: tsconfigPath,
    DKG_DISABLE_TELEMETRY: '1',
  };
  delete env.DKG_HOME;
  delete env.DKG_NO_BLUE_GREEN;

  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, cliSource, 'daemon-supervisor'],
    { env, stdio: 'pipe' },
  );

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));

  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code));
  });

  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function runSupervisor(tempHome: string, tsconfigPath: string): Promise<void> {
  const result = await runSupervisorProcess(tempHome, tsconfigPath);
  if (result.code !== 0) {
    throw new Error(
      `daemon-supervisor exited with ${result.code}\n` +
      result.stdout +
      result.stderr,
    );
  }
  expect(result.code).toBe(0);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve TCP port');
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('daemon lifecycle control-plane files', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('passes the selected DKG home to the supervised daemon worker', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dkg-supervised-home-'));
    const selectedHome = join(tempRoot, '.dkg-dev');
    const defaultHome = join(tempRoot, '.dkg');
    const tsconfigPath = join(tempRoot, 'tsx-tsconfig.json');
    const slotDir = join(selectedHome, 'releases', 'a');
    const fakeWorker = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');

    await mkdir(dirname(fakeWorker), { recursive: true });
    await mkdir(join(selectedHome, 'releases'), { recursive: true });
    await writeWorkspaceTsconfig(tsconfigPath);
    await writeFile(
      join(selectedHome, 'config.json'),
      JSON.stringify({
        name: 'supervisor-home-regression',
        apiPort: 25001,
        listenPort: 0,
        nodeRole: 'core',
      }),
    );
    await symlink('a', join(selectedHome, 'releases', 'current'));
    await writeFile(
      fakeWorker,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const home = process.env.DKG_HOME || path.join(os.homedir(), '.dkg');",
        'fs.mkdirSync(home, { recursive: true });',
        "if (process.argv[2] !== 'daemon-worker') process.exit(2);",
        "fs.writeFileSync(path.join(home, 'daemon.pid'), String(process.pid));",
        "fs.writeFileSync(path.join(home, 'api.port'), '25001');",
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    await chmod(fakeWorker, 0o755);

    await runSupervisor(tempRoot, tsconfigPath);

    expect(readFileSync(join(selectedHome, 'api.port'), 'utf8')).toBe('25001');
    expect(readFileSync(join(selectedHome, 'daemon.pid'), 'utf8')).toMatch(/^\d+$/);
    expect(existsSync(join(defaultHome, 'api.port'))).toBe(false);
    expect(existsSync(join(defaultHome, 'daemon.pid'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'reaps a SIGKILLed worker descendant and releases the managed-store port before respawn',
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'dkg-supervised-reap-'));
      const selectedHome = join(tempRoot, '.dkg-dev');
      const tsconfigPath = join(tempRoot, 'tsx-tsconfig.json');
      const slotDir = join(selectedHome, 'releases', 'a');
      const fakeWorker = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
      const listenerScript = join(tempRoot, 'listener.cjs');
      const stateFile = join(tempRoot, 'first-worker-started');
      const listenerReady = join(tempRoot, 'listener-ready');
      const replacementBound = join(tempRoot, 'replacement-bound');
      const managedPort = await freePort();

      await mkdir(dirname(fakeWorker), { recursive: true });
      await mkdir(join(selectedHome, 'releases'), { recursive: true });
      await writeWorkspaceTsconfig(tsconfigPath);
      await writeFile(
        join(selectedHome, 'config.json'),
        JSON.stringify({
          name: 'supervisor-reap-regression',
          apiPort: 25002,
          listenPort: 0,
          nodeRole: 'core',
          store: {
            backend: 'oxigraph-server',
            options: { port: managedPort },
          },
        }),
      );
      await symlink('a', join(selectedHome, 'releases', 'current'));
      await writeFile(
        listenerScript,
        [
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          `const port = ${managedPort};`,
          `const ready = ${JSON.stringify(listenerReady)};`,
          "const server = net.createServer(() => {});",
          "server.listen(port, '127.0.0.1', () => fs.writeFileSync(ready, String(process.pid)));",
          'setInterval(() => {}, 1000);',
          '',
        ].join('\n'),
      );
      await writeFile(
        fakeWorker,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          "const { spawn } = require('node:child_process');",
          `const state = ${JSON.stringify(stateFile)};`,
          `const ready = ${JSON.stringify(listenerReady)};`,
          `const success = ${JSON.stringify(replacementBound)};`,
          `const listener = ${JSON.stringify(listenerScript)};`,
          `const port = ${managedPort};`,
          "if (process.argv[2] !== 'daemon-worker') process.exit(2);",
          'if (!fs.existsSync(state)) {',
          "  fs.writeFileSync(state, '1');",
          "  spawn(process.execPath, [listener], { stdio: 'ignore' });",
          '  const deadline = Date.now() + 5000;',
          '  const timer = setInterval(() => {',
          '    if (fs.existsSync(ready)) {',
          '      clearInterval(timer);',
          "      process.kill(process.pid, 'SIGKILL');",
          '    } else if (Date.now() >= deadline) {',
          '      clearInterval(timer);',
          '      process.exit(3);',
          '    }',
          '  }, 10);',
          '} else {',
          "  const server = net.createServer(() => {});",
          "  server.once('error', () => process.exit(4));",
          "  server.listen(port, '127.0.0.1', () => {",
          "    fs.writeFileSync(success, 'bound');",
          '    server.close(() => process.exit(0));',
          '  });',
          '}',
          '',
        ].join('\n'),
      );
      await chmod(fakeWorker, 0o755);

      await runSupervisor(tempRoot, tsconfigPath);

      expect(readFileSync(replacementBound, 'utf8')).toBe('bound');
      const orphanPid = Number(readFileSync(listenerReady, 'utf8'));
      expect(() => process.kill(orphanPid, 0)).toThrow();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed instead of respawning while an external managed-store listener survives',
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'dkg-supervised-fail-closed-'));
      const selectedHome = join(tempRoot, '.dkg-dev');
      const tsconfigPath = join(tempRoot, 'tsx-tsconfig.json');
      const slotDir = join(selectedHome, 'releases', 'a');
      const fakeWorker = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
      const listenerScript = join(tempRoot, 'external-listener.cjs');
      const stateFile = join(tempRoot, 'first-worker-started');
      const listenerReady = join(tempRoot, 'external-listener-ready');
      const replacementStarted = join(tempRoot, 'replacement-started');
      const managedPort = await freePort();

      await mkdir(dirname(fakeWorker), { recursive: true });
      await mkdir(join(selectedHome, 'releases'), { recursive: true });
      await writeWorkspaceTsconfig(tsconfigPath);
      await writeFile(
        join(selectedHome, 'config.json'),
        JSON.stringify({
          name: 'supervisor-fail-closed-regression',
          apiPort: 25003,
          listenPort: 0,
          nodeRole: 'core',
          store: {
            backend: 'oxigraph-server',
            options: { port: managedPort },
          },
        }),
      );
      await symlink('a', join(selectedHome, 'releases', 'current'));
      await writeFile(
        listenerScript,
        [
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          `const port = ${managedPort};`,
          `const ready = ${JSON.stringify(listenerReady)};`,
          "const server = net.createServer(() => {});",
          "server.listen(port, '127.0.0.1', () => fs.writeFileSync(ready, String(process.pid)));",
          'setInterval(() => {}, 1000);',
          '',
        ].join('\n'),
      );
      await writeFile(
        fakeWorker,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          `const state = ${JSON.stringify(stateFile)};`,
          `const ready = ${JSON.stringify(listenerReady)};`,
          `const replacement = ${JSON.stringify(replacementStarted)};`,
          `const listener = ${JSON.stringify(listenerScript)};`,
          "if (process.argv[2] !== 'daemon-worker') process.exit(2);",
          'if (fs.existsSync(state)) {',
          "  fs.writeFileSync(replacement, 'unexpected');",
          '  process.exit(0);',
          '}',
          "fs.writeFileSync(state, '1');",
          "const external = spawn(process.execPath, [listener], { detached: true, stdio: 'ignore' });",
          'external.unref();',
          'const deadline = Date.now() + 5000;',
          'const timer = setInterval(() => {',
          '  if (fs.existsSync(ready)) {',
          '    clearInterval(timer);',
          '    process.exit(1);',
          '  } else if (Date.now() >= deadline) {',
          '    clearInterval(timer);',
          '    process.exit(3);',
          '  }',
          '}, 10);',
          '',
        ].join('\n'),
      );
      await chmod(fakeWorker, 0o755);

      try {
        const result = await runSupervisorProcess(tempRoot, tsconfigPath);

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/still listening.*refusing to spawn a replacement/);
        expect(existsSync(replacementStarted)).toBe(false);
      } finally {
        if (existsSync(listenerReady)) {
          const listenerPid = Number(readFileSync(listenerReady, 'utf8'));
          try {
            process.kill(listenerPid, 'SIGTERM');
          } catch {
            /* already gone */
          }
          for (let i = 0; i < 50 && processExists(listenerPid); i++) {
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
          }
          if (processExists(listenerPid)) {
            try {
              process.kill(listenerPid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }
      }
    },
  );
});
