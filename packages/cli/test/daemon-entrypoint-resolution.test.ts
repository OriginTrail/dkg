import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';

import {
  daemonRestartCommandArgs,
  resolveDaemonEntryPoint,
  resolveDaemonRestartCommand,
} from '../src/daemon-entrypoint.js';

/**
 * Regression guard for #962 (cli.ts split review): `resolveDaemonEntryPoint`
 * moved out of `cli.ts` into `cli-helpers.ts`. It respawns the daemon worker
 * with this CLI's own entrypoint, so it MUST resolve to a file that actually
 * exists in BOTH run modes:
 *   - built install → `dist/cli.js`
 *   - source mode (tsx/ts-node, and this very test run) → `src/cli.ts`
 *
 * The buggy intermediate hardcoded `new URL('./cli.js', import.meta.url)`,
 * which under source mode pointed at a nonexistent `src/cli.js` and would have
 * spawned a missing entrypoint. Because vitest executes this suite from source,
 * `import.meta.url` inside `cli-helpers` is the `src/` file — so this test
 * exercises exactly the source-mode path that regressed.
 */
describe('resolveDaemonEntryPoint (#962)', () => {
  const prevNoBlueGreen = process.env.DKG_NO_BLUE_GREEN;

  afterEach(() => {
    if (prevNoBlueGreen === undefined) delete process.env.DKG_NO_BLUE_GREEN;
    else process.env.DKG_NO_BLUE_GREEN = prevNoBlueGreen;
  });

  it('returns an existing CLI entrypoint regardless of run mode', () => {
    // Force the simple (non-blue-green) branch so the result is the CLI's own
    // entry module rather than a release-slot path.
    process.env.DKG_NO_BLUE_GREEN = '1';

    const entry = resolveDaemonEntryPoint();

    expect(entry).toMatch(/cli\.(ts|js)$/);
    expect(existsSync(entry), `daemon entrypoint must exist: ${entry}`).toBe(true);
  });

  it('builds supervisor and verifier arguments from the same canonical command', () => {
    process.env.DKG_NO_BLUE_GREEN = '1';

    const command = resolveDaemonRestartCommand();

    expect(command).toEqual({
      nodeExecutable: process.execPath,
      nodeExecArgv: process.execArgv,
      restartEntryPoint: resolveDaemonEntryPoint(),
    });
    expect(daemonRestartCommandArgs(command, 'daemon-worker')).toEqual([
      ...process.execArgv,
      command.restartEntryPoint,
      'daemon-worker',
    ]);
    expect(daemonRestartCommandArgs(command, '--version')).toEqual([
      ...process.execArgv,
      command.restartEntryPoint,
      '--version',
    ]);
  });
});
