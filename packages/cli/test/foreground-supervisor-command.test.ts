import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveSupervisorShutdownGraceMs } from '../src/cli-supervisor.js';

const execFileAsync = promisify(execFile);

describe('foreground supervisor restart command', () => {
  it('derives watcher grace from the exact child environment', () => {
    expect(resolveSupervisorShutdownGraceMs({})).toBe(30_000);
    expect(resolveSupervisorShutdownGraceMs({
      DKG_SHUTDOWN_HARD_TIMEOUT_MS: '60000',
    })).toBe(66_000);
    expect(() => resolveSupervisorShutdownGraceMs({
      DKG_SHUTDOWN_HARD_TIMEOUT_MS: 'invalid',
    })).toThrow(/DKG_SHUTDOWN_HARD_TIMEOUT_MS/u);
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
