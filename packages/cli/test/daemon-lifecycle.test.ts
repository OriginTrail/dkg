import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
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

const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise<boolean>(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });
}

interface SupervisorFixture {
  tempRoot: string;
  selectedHome: string;
  tsconfigPath: string;
  /** Absolute path to a scratch file inside the fixture. */
  file(name: string): string;
  /** The fake daemon worker the supervisor spawns from the active release slot. */
  writeWorker(lines: string[]): Promise<void>;
  /** A helper script the worker can spawn as a descendant. */
  writeScript(name: string, lines: string[]): Promise<string>;
}

/**
 * Temp DKG home wired for a real supervisor process: workspace tsconfig,
 * config.json, an active release slot, and a fake worker at the slot entrypoint.
 *
 * Each supervisor regression differs only in what its worker and descendants
 * *do*, so that is all a test should have to spell out.
 */
async function createSupervisorFixture(opts: {
  prefix: string;
  name: string;
  apiPort: number;
  /** Configures the managed-Oxigraph backend on this port. */
  managedPort?: number;
}): Promise<SupervisorFixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), opts.prefix));
  const selectedHome = join(tempRoot, '.dkg-dev');
  const tsconfigPath = join(tempRoot, 'tsx-tsconfig.json');
  const fakeWorker = join(
    selectedHome, 'releases', 'a', 'packages', 'cli', 'dist', 'cli.js',
  );

  await mkdir(dirname(fakeWorker), { recursive: true });
  await writeWorkspaceTsconfig(tsconfigPath);
  await writeFile(
    join(selectedHome, 'config.json'),
    JSON.stringify({
      name: opts.name,
      apiPort: opts.apiPort,
      listenPort: 0,
      nodeRole: 'core',
      ...(opts.managedPort === undefined
        ? {}
        : { store: { backend: 'oxigraph-server', options: { port: opts.managedPort } } }),
    }),
  );
  await symlink('a', join(selectedHome, 'releases', 'current'));

  return {
    tempRoot,
    selectedHome,
    tsconfigPath,
    file: (name: string) => join(tempRoot, name),
    async writeWorker(lines: string[]) {
      await writeFile(fakeWorker, lines.join('\n'));
      await chmod(fakeWorker, 0o755);
    },
    async writeScript(name: string, lines: string[]) {
      const scriptPath = join(tempRoot, name);
      await writeFile(scriptPath, lines.join('\n'));
      return scriptPath;
    },
  };
}

/**
 * A TCP listener standing in for the managed Oxigraph a worker owns.
 *
 * Its port and ready-file arrive as argv rather than being interpolated into
 * the source, so no test-controlled value is ever spliced into generated code.
 */
function managedStoreListenerLines(): string[] {
  return [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    'const [port, ready] = process.argv.slice(2);',
    'const server = net.createServer(() => {});',
    "server.listen(Number(port), '127.0.0.1', () => fs.writeFileSync(ready, String(process.pid)));",
    'setInterval(() => {}, 1000);',
    '',
  ];
}

describe('daemon lifecycle control-plane files', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('passes the selected DKG home to the supervised daemon worker', async () => {
    const fixture = await createSupervisorFixture({
      prefix: 'dkg-supervised-home-',
      name: 'supervisor-home-regression',
      apiPort: 25001,
    });
    tempRoot = fixture.tempRoot;
    const defaultHome = join(tempRoot, '.dkg');

    await fixture.writeWorker([
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
    ]);

    await runSupervisor(tempRoot, fixture.tsconfigPath);

    expect(readFileSync(join(fixture.selectedHome, 'api.port'), 'utf8')).toBe('25001');
    expect(readFileSync(join(fixture.selectedHome, 'daemon.pid'), 'utf8')).toMatch(/^\d+$/);
    expect(existsSync(join(defaultHome, 'api.port'))).toBe(false);
    expect(existsSync(join(defaultHome, 'daemon.pid'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'reaps a SIGKILLed worker descendant and releases the managed-store port before respawn',
    async () => {
      const managedPort = await freePort();
      const fixture = await createSupervisorFixture({
        prefix: 'dkg-supervised-reap-',
        name: 'supervisor-reap-regression',
        apiPort: 25002,
        managedPort,
      });
      tempRoot = fixture.tempRoot;
      const stateFile = fixture.file('first-worker-started');
      const listenerReady = fixture.file('listener-ready');
      const replacementBound = fixture.file('replacement-bound');
      const listenerScript = await fixture.writeScript(
        'listener.cjs',
        managedStoreListenerLines(),
      );

      // First worker: leaks a store listener, then SIGKILLs itself so it has no
      // chance to clean up. Second worker: proves the port is free again.
      await fixture.writeWorker([
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
        "  spawn(process.execPath, [listener, String(port), ready], { stdio: 'ignore' });",
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
        '  const server = net.createServer(() => {});',
        "  server.once('error', () => process.exit(4));",
        "  server.listen(port, '127.0.0.1', () => {",
        "    fs.writeFileSync(success, 'bound');",
        '    server.close(() => process.exit(0));',
        '  });',
        '}',
        '',
      ]);

      await runSupervisor(tempRoot, fixture.tsconfigPath);

      expect(readFileSync(replacementBound, 'utf8')).toBe('bound');
      const orphanPid = Number(readFileSync(listenerReady, 'utf8'));
      expect(() => process.kill(orphanPid, 0)).toThrow();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'SIGHUP to the foreground supervisor reaps the worker and its managed store',
    async () => {
      const managedPort = await freePort();
      const fixture = await createSupervisorFixture({
        prefix: 'dkg-foreground-hup-',
        name: 'supervisor-foreground-hup-regression',
        apiPort: 25004,
        managedPort,
      });
      tempRoot = fixture.tempRoot;
      const workerPidFile = fixture.file('worker-pid');
      const listenerReady = fixture.file('listener-ready');
      const listenerScript = await fixture.writeScript(
        'listener.cjs',
        managedStoreListenerLines(),
      );

      // The foreground worker owns a store listener and then idles forever: only
      // a signal that actually reaches it can end this process tree.
      await fixture.writeWorker([
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const listener = ${JSON.stringify(listenerScript)};`,
        `const pidFile = ${JSON.stringify(workerPidFile)};`,
        `const ready = ${JSON.stringify(listenerReady)};`,
        `const port = ${managedPort};`,
        "if (process.argv[2] !== 'daemon-foreground-worker') process.exit(2);",
        "spawn(process.execPath, [listener, String(port), ready], { stdio: 'ignore' });",
        'fs.writeFileSync(pidFile, String(process.pid));',
        'setInterval(() => {}, 1000);',
        '',
      ]);

      // `dkg start --foreground` runs the supervisor in the shell's foreground
      // job. The worker is setsid()'d into its own session, so a terminal-close
      // SIGHUP is delivered to the supervisor alone — the worker only dies if
      // the supervisor relays it.
      const driver = await fixture.writeScript('foreground-driver.mts', [
        `import { runForegroundSupervisor } from ${JSON.stringify(
          join(__dirname, '..', 'src', 'cli-supervisor.ts'),
        )};`,
        'await runForegroundSupervisor(process.env);',
        '',
      ]);

      const env = {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        TSX_TSCONFIG_PATH: fixture.tsconfigPath,
        DKG_DISABLE_TELEMETRY: '1',
        DKG_SUPERVISOR_LIVENESS_PROBE: 'off',
      };
      delete env.DKG_HOME;
      delete env.DKG_NO_BLUE_GREEN;

      const supervisor = spawn(
        process.execPath,
        ['--import', tsxLoader, driver],
        { env, stdio: 'ignore', detached: true },
      );
      const supervisorExit = new Promise<void>(resolveExit => {
        supervisor.once('close', () => resolveExit());
      });

      try {
        await waitFor(() => existsSync(listenerReady), 'the managed store to bind');
        await waitFor(() => existsSync(workerPidFile), 'the foreground worker to start');
        const workerPid = Number(readFileSync(workerPidFile, 'utf8'));
        const listenerPid = Number(readFileSync(listenerReady, 'utf8'));
        expect(await portAcceptsConnections(managedPort)).toBe(true);

        process.kill(supervisor.pid!, 'SIGHUP');
        await supervisorExit;

        // Nothing may outlive the terminal: not the worker, not the store it
        // owns, not the port binding that would block the next `dkg start`.
        await waitFor(() => !processExists(workerPid), 'the foreground worker to exit');
        await waitFor(() => !processExists(listenerPid), 'the managed store to exit');
        await waitFor(
          async () => !(await portAcceptsConnections(managedPort)),
          'the managed-store port to be released',
        );
      } finally {
        for (const file of [workerPidFile, listenerReady]) {
          if (!existsSync(file)) continue;
          const pid = Number(readFileSync(file, 'utf8'));
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        try {
          process.kill(supervisor.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'Ctrl-Z stops the whole foreground job, and resuming brings it back',
    async () => {
      const managedPort = await freePort();
      const fixture = await createSupervisorFixture({
        prefix: 'dkg-foreground-tstp-',
        name: 'supervisor-foreground-tstp-regression',
        apiPort: 25005,
        managedPort,
      });
      tempRoot = fixture.tempRoot;
      const workerPidFile = fixture.file('worker-pid');
      const listenerReady = fixture.file('listener-ready');
      const listenerScript = await fixture.writeScript(
        'listener.cjs',
        managedStoreListenerLines(),
      );

      await fixture.writeWorker([
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const listener = ${JSON.stringify(listenerScript)};`,
        `const pidFile = ${JSON.stringify(workerPidFile)};`,
        `const ready = ${JSON.stringify(listenerReady)};`,
        `const port = ${managedPort};`,
        "if (process.argv[2] !== 'daemon-foreground-worker') process.exit(2);",
        "spawn(process.execPath, [listener, String(port), ready], { stdio: 'ignore' });",
        'fs.writeFileSync(pidFile, String(process.pid));',
        'setInterval(() => {}, 1000);',
        '',
      ]);

      const driver = await fixture.writeScript('foreground-driver.mts', [
        `import { runForegroundSupervisor } from ${JSON.stringify(
          join(__dirname, '..', 'src', 'cli-supervisor.ts'),
        )};`,
        'await runForegroundSupervisor(process.env);',
        '',
      ]);

      const env = {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        TSX_TSCONFIG_PATH: fixture.tsconfigPath,
        DKG_DISABLE_TELEMETRY: '1',
        DKG_SUPERVISOR_LIVENESS_PROBE: 'off',
      };
      delete env.DKG_HOME;
      delete env.DKG_NO_BLUE_GREEN;

      const supervisor = spawn(
        process.execPath,
        ['--import', tsxLoader, driver],
        { env, stdio: 'ignore', detached: true },
      );

      const stopped = (pid: number): boolean => {
        try {
          return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
            .toString().trim().startsWith('T');
        } catch {
          return false;
        }
      };

      try {
        await waitFor(() => existsSync(workerPidFile), 'the foreground worker to start');
        const workerPid = Number(readFileSync(workerPidFile, 'utf8'));

        // Ctrl-Z. The worker sits in its own session, whose process group is
        // orphaned — a relayed SIGTSTP would be discarded by the kernel and the
        // node would keep running behind the user's shell prompt.
        process.kill(supervisor.pid!, 'SIGTSTP');
        await waitFor(() => stopped(workerPid), 'the foreground worker to stop');

        // `fg` — the job must come back, not stay frozen holding the store port.
        process.kill(supervisor.pid!, 'SIGCONT');
        await waitFor(() => !stopped(workerPid), 'the foreground worker to resume');
        expect(processExists(workerPid)).toBe(true);
      } finally {
        try {
          process.kill(supervisor.pid!, 'SIGCONT');
          process.kill(supervisor.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
        for (const file of [workerPidFile, listenerReady]) {
          if (!existsSync(file)) continue;
          const pid = Number(readFileSync(file, 'utf8'));
          try {
            process.kill(pid, 'SIGCONT');
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed instead of respawning while an external managed-store listener survives',
    async () => {
      const managedPort = await freePort();
      const fixture = await createSupervisorFixture({
        prefix: 'dkg-supervised-fail-closed-',
        name: 'supervisor-fail-closed-regression',
        apiPort: 25003,
        managedPort,
      });
      tempRoot = fixture.tempRoot;
      const stateFile = fixture.file('first-worker-started');
      const listenerReady = fixture.file('external-listener-ready');
      const replacementStarted = fixture.file('replacement-started');
      const listenerScript = await fixture.writeScript(
        'external-listener.cjs',
        managedStoreListenerLines(),
      );

      // The listener is detached, so reaping the worker's group cannot remove
      // it: the port stays bound and the supervisor must refuse to respawn.
      await fixture.writeWorker([
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const state = ${JSON.stringify(stateFile)};`,
        `const ready = ${JSON.stringify(listenerReady)};`,
        `const replacement = ${JSON.stringify(replacementStarted)};`,
        `const port = ${managedPort};`,
        `const listener = ${JSON.stringify(listenerScript)};`,
        "if (process.argv[2] !== 'daemon-worker') process.exit(2);",
        'if (fs.existsSync(state)) {',
        "  fs.writeFileSync(replacement, 'unexpected');",
        '  process.exit(0);',
        '}',
        "fs.writeFileSync(state, '1');",
        "const external = spawn(process.execPath, [listener, String(port), ready], { detached: true, stdio: 'ignore' });",
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
      ]);

      try {
        const result = await runSupervisorProcess(tempRoot, fixture.tsconfigPath);

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
