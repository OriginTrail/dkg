import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dashboardCredentialsPath,
  verifyDashboardCredentials,
} from '../src/daemon/dashboard-credentials.js';
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

  it('#1306/#1439: injects setup runtime hooks into runSetup', async () => {
    const runSetupArgs: any[] = [];
    const runSetup = async (...args: any[]) => { runSetupArgs.push(args); };

    await openclawSetupAction({ dryRun: true }, makeCommand('default'), { runSetup: runSetup as any });

    expect(runSetupArgs).toHaveLength(1);
    // The 2nd arg is the injected runtime deps; loadOpWallets must be wired so
    // the adapter can eagerly create wallets before the daemon starts, and
    // dashboard credentials can be created by explicit CLI setup flows.
    const [, runDeps] = runSetupArgs[0];
    expect(typeof runDeps?.loadOpWallets).toBe('function');
    expect(typeof runDeps?.ensureDashboardCredentials).toBe('function');
  });

  it('#1439: injected dashboard credential hook creates credentials through the setup helper', async () => {
    const runSetupArgs: any[] = [];
    const runSetup = async (...args: any[]) => { runSetupArgs.push(args); };

    await openclawSetupAction({ dryRun: true }, makeCommand('default'), { runSetup: runSetup as any });

    const [, runDeps] = runSetupArgs[0] as [unknown, {
      ensureDashboardCredentials?: (dkgHome: string) => Promise<unknown>;
    }];
    expect(typeof runDeps?.ensureDashboardCredentials).toBe('function');

    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-openclaw-dashboard-hook-'));
    const logCalls: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logCalls.push(args); };
    try {
      await runDeps.ensureDashboardCredentials!(dkgHome);
      const credentialPath = dashboardCredentialsPath(dkgHome);
      const logs = logCalls.map((args) => args.join(' ')).join('\n');
      const password = logs.match(/Password: ([^\n]+)/)?.[1]?.trim();

      expect(logs).toContain('[setup] Dashboard login created:');
      expect(logs).toContain(`Credential file: ${credentialPath}`);
      expect(password).toEqual(expect.any(String));
      await expect(verifyDashboardCredentials('node-admin', password!, credentialPath))
        .resolves.toMatchObject({ ok: true });
      await expect(readFile(credentialPath, 'utf8'))
        .resolves.not.toContain(password);
    } finally {
      console.log = originalLog;
      await rm(dkgHome, { recursive: true, force: true });
    }
  });
});
