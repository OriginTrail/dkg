import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { openclawSetupAction } from '../src/openclaw-setup.js';

// `--no-fund` / `--fund` are live flags on `dkg openclaw setup` (the faucet
// step runs by default; `--no-fund` opts out). This suite exercises the
// extracted action handler directly — no child process, no `dist/cli.js`
// dependency, so it runs green on an unbuilt checkout.

type FundSource = 'cli' | 'default' | 'env' | 'config' | 'implied';

/**
 * Minimal commander-like stub that satisfies the `getOptionValueSource`
 * surface. The handler no longer consults this value, but the signature is
 * preserved so the caller in `cli.ts` continues to compile unchanged and
 * tests match the production shape.
 */
function makeCommand(fundSource: FundSource): Pick<Command, 'getOptionValueSource'> {
  return {
    getOptionValueSource: (optionName: string) =>
      optionName === 'fund' ? fundSource : undefined,
  } as Pick<Command, 'getOptionValueSource'>;
}

describe('openclawSetupAction — --no-fund/--fund flag threading', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('forwards fund=false into runSetup when --no-fund was supplied', async () => {
    const runSetup = vi.fn(async () => {});
    // Commander's `--no-fund` parsing sets `fund: false`; source is `'cli'`.
    const opts = { dryRun: true, fund: false };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(runSetup).toHaveBeenCalledTimes(1);
    const forwarded = runSetup.mock.calls[0][0];
    expect(forwarded.fund).toBe(false);
    expect(forwarded.dryRun).toBe(true);
  });

  it('forwards fund=true into runSetup when --fund was supplied', async () => {
    const runSetup = vi.fn(async () => {});
    // Commander's `--fund` parsing sets `fund: true`; source is `'cli'`.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup.mock.calls[0][0].fund).toBe(true);
  });

  it('forwards fund=true into runSetup when neither flag is explicitly supplied (default)', async () => {
    const runSetup = vi.fn(async () => {});
    // Commander fills `fund: true` from the --no-fund declaration even when
    // the user did not type either flag; source is `'default'`.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('default'), { runSetup: runSetup as any });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup.mock.calls[0][0].fund).toBe(true);
  });

  it('propagates errors from runSetup so the caller can decide exit semantics', async () => {
    const runSetup = vi.fn(async () => {
      throw new Error('adapter blew up');
    });

    await expect(
      openclawSetupAction({ dryRun: true }, makeCommand('default'), { runSetup: runSetup as any }),
    ).rejects.toThrow('adapter blew up');
  });
});
