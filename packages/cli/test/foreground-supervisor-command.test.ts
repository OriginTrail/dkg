import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { maybeStartSupervisorLivenessWatcher } from '../src/cli-supervisor.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

const execFileAsync = promisify(execFile);

describe('foreground supervisor restart command', () => {
  it('passes the startup-captured shutdown policy to the real watcher boundary', async () => {
    const env: NodeJS.ProcessEnv = { DKG_SHUTDOWN_HARD_TIMEOUT_MS: '60000' };
    const shutdownPolicy = resolveShutdownPolicy(env.DKG_SHUTDOWN_HARD_TIMEOUT_MS);
    const observedGrace: number[] = [];
    const stop = await maybeStartSupervisorLivenessWatcher(
      { kill: () => true },
      { enabled: true, shutdownPolicy },
      {
        readApiPort: async () => 9200,
        loadApiHost: async () => '127.0.0.1',
        sleep: async () => undefined,
        apiPortExists: () => true,
        startWatcher: (options) => {
          observedGrace.push(options.shutdownGraceMs!);
          return { stop: () => undefined };
        },
      },
    );
    env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '5000';
    await vi.waitFor(() => expect(observedGrace).toEqual([66_000]));
    stop();
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
