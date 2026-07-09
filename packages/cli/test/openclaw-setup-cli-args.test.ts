import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  // Hand-rolled console.warn capture (no vitest mock API).
  let warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  beforeEach(() => {
    warnCalls = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  it('forwards fund=false into runSetup when --no-fund was supplied', async () => {
    const runSetupCalls: any[] = [];
    const runSetup = async (opts: any) => { runSetupCalls.push(opts); };
    // Commander's `--no-fund` parsing sets `fund: false`; source is `'cli'`.
    const opts = { dryRun: true, fund: false };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnCalls).toEqual([]);
    expect(runSetupCalls).toHaveLength(1);
    const forwarded = runSetupCalls[0];
    expect(forwarded.fund).toBe(false);
    expect(forwarded.dryRun).toBe(true);
  });

  it('forwards fund=true into runSetup when --fund was supplied', async () => {
    const runSetupCalls: any[] = [];
    const runSetup = async (opts: any) => { runSetupCalls.push(opts); };
    // Commander's `--fund` parsing sets `fund: true`; source is `'cli'`.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('cli'), { runSetup: runSetup as any });

    expect(warnCalls).toEqual([]);
    expect(runSetupCalls).toHaveLength(1);
    expect(runSetupCalls[0].fund).toBe(true);
  });

  it('forwards fund=true into runSetup when neither flag is explicitly supplied (default)', async () => {
    const runSetupCalls: any[] = [];
    const runSetup = async (opts: any) => { runSetupCalls.push(opts); };
    // Commander fills `fund: true` from the --no-fund declaration even when
    // the user did not type either flag; source is `'default'`.
    const opts = { dryRun: true, fund: true };

    await openclawSetupAction(opts, makeCommand('default'), { runSetup: runSetup as any });

    expect(warnCalls).toEqual([]);
    expect(runSetupCalls).toHaveLength(1);
    expect(runSetupCalls[0].fund).toBe(true);
  });

  it('propagates errors from runSetup so the caller can decide exit semantics', async () => {
    const runSetup = async () => {
      throw new Error('adapter blew up');
    };

    await expect(
      openclawSetupAction({ dryRun: true }, makeCommand('default'), { runSetup: runSetup as any }),
    ).rejects.toThrow('adapter blew up');
  });

  it('#1306: injects a loadOpWallets hook into runSetup (eager wallet creation)', async () => {
    const runSetupArgs: any[] = [];
    const runSetup = async (...args: any[]) => { runSetupArgs.push(args); };

    await openclawSetupAction({ dryRun: true }, makeCommand('default'), { runSetup: runSetup as any });

    expect(runSetupArgs).toHaveLength(1);
    // The 2nd arg is the injected runtime deps; loadOpWallets must be wired so
    // the adapter can eagerly create wallets before the daemon starts.
    const [, runDeps] = runSetupArgs[0];
    expect(typeof runDeps?.loadOpWallets).toBe('function');
  });
});
