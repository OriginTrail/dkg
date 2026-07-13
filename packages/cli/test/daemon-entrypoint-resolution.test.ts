import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveDaemonEntryPoint,
  resolveDaemonNodeCommand,
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
  const prevDkgHome = process.env.DKG_HOME;
  let tempHome: string | undefined;

  afterEach(async () => {
    if (prevNoBlueGreen === undefined) delete process.env.DKG_NO_BLUE_GREEN;
    else process.env.DKG_NO_BLUE_GREEN = prevNoBlueGreen;
    if (prevDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = prevDkgHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('returns an existing CLI entrypoint regardless of run mode', () => {
    // Force the simple (non-blue-green) branch so the result is the CLI's own
    // entry module rather than a release-slot path.
    process.env.DKG_NO_BLUE_GREEN = '1';

    const entry = resolveDaemonEntryPoint();

    expect(entry).toMatch(/cli\.(ts|js)$/);
    expect(existsSync(entry), `daemon entrypoint must exist: ${entry}`).toBe(true);
  });

  it('builds every launch and verifier shape through one canonical command', () => {
    process.env.DKG_NO_BLUE_GREEN = '1';

    for (const daemonArg of [
      'daemon-supervisor',
      'daemon-worker',
      'daemon-foreground-worker',
      '--version',
    ]) {
      const command = resolveDaemonNodeCommand(daemonArg);
      expect(command).toEqual({
        executable: process.execPath,
        args: [...process.execArgv, command.entryPoint, daemonArg],
        entryPoint: resolveDaemonEntryPoint(),
      });
    }
  });

  async function createLegacySlot(role: 'edge' | 'core'): Promise<string> {
    tempHome = await mkdtemp(join(tmpdir(), `dkg-${role}-entrypoint-`));
    process.env.DKG_HOME = tempHome;
    delete process.env.DKG_NO_BLUE_GREEN;
    await writeFile(join(tempHome, 'config.json'), JSON.stringify({ nodeRole: role }));
    const slotEntry = join(tempHome, 'releases', 'current', 'packages', 'cli', 'dist', 'cli.js');
    await mkdir(join(slotEntry, '..'), { recursive: true });
    await writeFile(slotEntry, '// stale legacy slot');
    return slotEntry;
  }

  it('keeps an Edge --version probe on the installed CLI when legacy slots remain', async () => {
    const legacySlotEntry = await createLegacySlot('edge');

    const command = resolveDaemonNodeCommand('--version');

    expect(command.entryPoint).not.toBe(legacySlotEntry);
    expect(command.entryPoint).toMatch(/cli\.(ts|js)$/);
    expect(command.args).toEqual([...process.execArgv, command.entryPoint, '--version']);
  });

  it('preserves the active legacy slot for Core daemon commands', async () => {
    const legacySlotEntry = await createLegacySlot('core');

    const command = resolveDaemonNodeCommand('daemon-worker');

    expect(command.entryPoint).toBe(legacySlotEntry);
    expect(command.args).toEqual([...process.execArgv, legacySlotEntry, 'daemon-worker']);
  });
});
