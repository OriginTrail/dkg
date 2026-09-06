import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundWorkerIteration,
} from '../src/cli-supervisor.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { resolveLivenessShutdownGraceMs } from '../src/daemon/supervisor-liveness.js';

const execFileAsync = promisify(execFile);

describe('foreground supervisor restart command', () => {
  it('exercises the default port, host, and shutdown probes against the selected home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-supervisor-default-probes-'));
    const savedDkgHome = process.env.DKG_HOME;
    const savedApiPort = process.env.DKG_API_PORT;
    let captured: Parameters<Parameters<typeof maybeStartSupervisorLivenessWatcher>[2]['startWatcher']>[0]
      | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    try {
      process.env.DKG_HOME = root;
      delete process.env.DKG_API_PORT;
      await writeFile(join(root, 'api.port'), '7878\n');
      await writeFile(join(root, 'config.json'), JSON.stringify({ apiHost: '0.0.0.0' }));
      const stop = await maybeStartSupervisorLivenessWatcher(
        { kill: () => true },
        { enabled: true, shutdownGraceMs: 6_000 },
        {
          startWatcher: (options) => {
            captured = options;
            markStarted();
            return { stop: () => undefined };
          },
        },
      );
      await started;
      expect(captured).toMatchObject({ port: 7878, host: '127.0.0.1', shutdownGraceMs: 6_000 });
      expect(captured!.isShuttingDown()).toBe(false);
      await rm(join(root, 'api.port'));
      expect(captured!.isShuttingDown()).toBe(true);
      stop();
    } finally {
      if (savedDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = savedDkgHome;
      if (savedApiPort === undefined) delete process.env.DKG_API_PORT;
      else process.env.DKG_API_PORT = savedApiPort;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('polls for a late port and wires failure and forced-kill reporting', async () => {
    let reads = 0;
    let killCalls = 0;
    const warnings: string[] = [];
    let captured: Parameters<Parameters<typeof maybeStartSupervisorLivenessWatcher>[2]['startWatcher']>[0]
      | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const stop = await maybeStartSupervisorLivenessWatcher(
      {
        kill: () => {
          killCalls += 1;
          if (killCalls === 2) throw new Error('already exited');
          return true;
        },
      },
      { enabled: true, shutdownGraceMs: 6_000 },
      {
        readPort: async () => (++reads === 1 ? null : 7878),
        loadApiHost: async () => undefined,
        apiPortExists: () => true,
        startWatcher: (options) => {
          captured = options;
          markStarted();
          return { stop: () => undefined };
        },
        wait: async () => undefined,
        warn: (message) => warnings.push(message),
      },
    );
    await started;
    captured!.onFailure?.(2);
    captured!.onUnresponsive();
    captured!.onUnresponsive();
    expect(reads).toBe(2);
    expect(killCalls).toBe(2);
    expect(warnings).toEqual([
      '[supervisor] liveness probe failed (2 in a row).',
      '[supervisor] worker unresponsive after 5 consecutive liveness probes; SIGKILL + respawn.',
      '[supervisor] worker unresponsive after 5 consecutive liveness probes; SIGKILL + respawn.',
    ]);
    stop();
  });

  it('runs the daemon supervisor loop around a cleanly exiting selected-slot worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-daemon-supervisor-loop-'));
    const savedDkgHome = process.env.DKG_HOME;
    const savedProbe = process.env.DKG_SUPERVISOR_LIVENESS_PROBE;
    try {
      const releasesDir = join(root, 'releases');
      const slotEntry = join(releasesDir, 'a', 'packages', 'cli', 'dist', 'cli.js');
      await mkdir(dirname(slotEntry), { recursive: true });
      await writeFile(join(root, 'config.json'), JSON.stringify({ nodeRole: 'core' }));
      await writeFile(slotEntry, 'process.exit(0);\n');
      await symlink('a', join(releasesDir, 'current'));
      process.env.DKG_HOME = root;
      process.env.DKG_SUPERVISOR_LIVENESS_PROBE = 'off';

      await expect(runDaemonSupervisor()).resolves.toBeUndefined();
    } finally {
      if (savedDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = savedDkgHome;
      if (savedProbe === undefined) delete process.env.DKG_SUPERVISOR_LIVENESS_PROBE;
      else process.env.DKG_SUPERVISOR_LIVENESS_PROBE = savedProbe;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hands the 300s worker shutdown policy to the real watcher constructor as 306s', async () => {
    let observedGraceMs: number | undefined;
    let stopCalls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const shutdownGraceMs = resolveLivenessShutdownGraceMs(
      resolveShutdownPolicy('300000').hardTimeoutMs,
    );
    const stop = await maybeStartSupervisorLivenessWatcher(
      { kill: () => true },
      { enabled: true, shutdownGraceMs },
      {
        readPort: async () => 7878,
        loadApiHost: async () => '127.0.0.1',
        apiPortExists: () => true,
        startWatcher: (options) => {
          observedGraceMs = options.shutdownGraceMs;
          markStarted();
          return { stop: () => { stopCalls += 1; } };
        },
        wait: async () => {},
        warn: () => {},
      },
    );

    await started;
    expect(observedGraceMs).toBe(306_000);
    stop();
    expect(stopCalls).toBe(1);
  });

  it('passes the startup-captured shutdown policy to the real watcher boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-foreground-shutdown-policy-'));
    const savedDkgHome = process.env.DKG_HOME;
    const observedGrace: number[] = [];
    const warnings: string[] = [];
    try {
      const dkgHome = join(root, 'home');
      const slotEntry = join(
        dkgHome,
        'releases',
        'a',
        'packages',
        'cli',
        'dist',
        'cli.js',
      );
      await mkdir(dirname(slotEntry), { recursive: true });
      await writeFile(join(dkgHome, 'config.json'), JSON.stringify({ nodeRole: 'core' }));
      await writeFile(slotEntry, 'process.exit(0);\n');
      await symlink('a', join(dkgHome, 'releases', 'current'));
      process.env.DKG_HOME = dkgHome;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DKG_HOME: dkgHome,
        DKG_SHUTDOWN_HARD_TIMEOUT_MS: '60000',
      };

      await expect(runForegroundWorkerIteration({
        childEnv: env,
        dependencies: {
          clearApiPort: async () => { throw new Error('stale port cleanup failed'); },
          startWorkerLiveness: async (_child, config) => {
            observedGrace.push(config.shutdownGraceMs);
            env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '5000';
            return () => undefined;
          },
          warn: (message) => warnings.push(message),
        },
      })).resolves.toMatchObject({ originalExitCode: 0 });
      expect(observedGrace).toEqual([66_000]);
      expect(warnings).toEqual([
        '[supervisor] could not clear stale api.port before foreground spawn: stale port cleanup failed',
      ]);
    } finally {
      if (savedDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = savedDkgHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid shutdown budget at `dkg start` before detached startup polling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-start-shutdown-policy-'));
    try {
      await writeFile(join(root, 'config.json'), '{}');
      const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
      const startedAt = Date.now();
      let failure: unknown;
      try {
        await execFileAsync(process.execPath, ['--import', 'tsx', cliPath, 'start'], {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            ...process.env,
            DKG_HOME: root,
            DKG_NO_BLUE_GREEN: '1',
            DKG_SHUTDOWN_HARD_TIMEOUT_MS: 'invalid',
          },
          timeout: 5_000,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error & { code?: number }).code).not.toBe(0);
      expect((failure as Error & { stderr?: string }).stderr).toMatch(
        /DKG_SHUTDOWN_HARD_TIMEOUT_MS must be an integer/u,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('spawns the active entrypoint with Node exec argv and the foreground worker argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-foreground-command-'));
    try {
      const dkgHome = join(root, 'home');
      const releasesDir = join(dkgHome, 'releases');
      const slotEntry = join(releasesDir, 'a', 'packages', 'cli', 'dist', 'cli.js');
      const capturePath = join(root, 'spawn.json');
      const harnessPath = join(root, 'run-supervisor.mjs');

      await mkdir(dirname(slotEntry), { recursive: true });
      await writeFile(join(dkgHome, 'config.json'), JSON.stringify({ nodeRole: 'core' }));
      await writeFile(
        slotEntry,
        [
          "const { writeFileSync } = require('node:fs');",
          'writeFileSync(process.env.FOREGROUND_CAPTURE, JSON.stringify({',
          '  execPath: process.execPath,',
          '  execArgv: process.execArgv,',
          '  argv: process.argv,',
          '}));',
        ].join('\n'),
      );
      await symlink('a', join(releasesDir, 'current'));

      const supervisorUrl = new URL('../src/cli-supervisor.ts', import.meta.url).href;
      await writeFile(
        harnessPath,
        `import { runForegroundSupervisor } from ${JSON.stringify(supervisorUrl)};\n` +
          'await runForegroundSupervisor(process.env);\n',
      );

      const env = { ...process.env };
      delete env.DKG_NO_BLUE_GREEN;
      env.DKG_HOME = dkgHome;
      env.DKG_SUPERVISOR_LIVENESS_PROBE = 'off';
      env.FOREGROUND_CAPTURE = capturePath;

      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', harnessPath],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env,
          timeout: 20_000,
        },
      );

      const captured = JSON.parse(await readFile(capturePath, 'utf-8')) as {
        execPath: string;
        execArgv: string[];
        argv: string[];
      };
      expect(captured.execPath).toBe(process.execPath);
      expect(captured.execArgv).toEqual(['--import', 'tsx']);
      expect(captured.argv.slice(1)).toEqual([
        join(releasesDir, 'current', 'packages', 'cli', 'dist', 'cli.js'),
        'daemon-foreground-worker',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
