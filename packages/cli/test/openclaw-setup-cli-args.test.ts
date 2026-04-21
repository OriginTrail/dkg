import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { openclawSetupAction } from '../src/openclaw-setup.js';

// Regression test for PR #228 Codex review #4 (--no-fund backwards-compat)
// and review #5 (don't depend on a prebuilt CLI). Unit-tests the extracted
// action handler directly — no child process, no `dist/cli.js` dependency,
// so it runs green on an unbuilt checkout.

type FundSource = 'cli' | 'default' | 'env' | 'config' | 'implied';

/**
 * Minimal commander-like stub that satisfies the `getOptionValueSource`
 * surface the action consults. Pass `'cli'` to simulate the user explicitly
 * supplying `--fund` or `--no-fund`; `'default'` simulates the flag not
 * being passed.
 */
function makeCommand(fundSource: FundSource): Pick<Command, 'getOptionValueSource'> {
  return {
    getOptionValueSource: (optionName: string) =>
      optionName === 'fund' ? fundSource : undefined,
  } as Pick<Command, 'getOptionValueSource'>;
}

describe('openclawSetupAction — deprecated --no-fund/--fund flags', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs a deprecation warning and strips `fund` from opts when --no-fund was supplied', async () => {
    const runSetup = vi.fn(async () => {});
    // Commander's `--no-fund` parsing sets `fund: false`; source is `'cli'`.
    const opts = { dryRun: true, fund: false };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('--no-fund/--fund is deprecated'),
    );
    expect(runSetup).toHaveBeenCalledTimes(1);
    const forwarded = runSetup.mock.calls[0][0];
    expect(forwarded).not.toHaveProperty('fund');
    expect(forwarded.dryRun).toBe(true);
  });

  it('logs a deprecation warning and strips `fund` from opts when --fund was supplied', async () => {
    const runSetup = vi.fn(async () => {});
    // Commander's `--fund` parsing sets `fund: true`; source is `'cli'`.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('--no-fund/--fund is deprecated'),
    );
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runSetup.mock.calls[0][0]).not.toHaveProperty('fund');
  });

  it('does NOT log the deprecation warning when neither flag is explicitly supplied', async () => {
    const runSetup = vi.fn(async () => {});
    // Default value present (commander fills `fund: true` from the --no-fund
    // declaration) but source is `'default'` — user did not type the flag.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('default'), { runSetup: runSetup as any });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(runSetup).toHaveBeenCalledTimes(1);
    // `fund` is still stripped — SetupOptions on the adapter side has no such field.
    expect(runSetup.mock.calls[0][0]).not.toHaveProperty('fund');
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
