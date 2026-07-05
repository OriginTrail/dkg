import type { Command } from 'commander';
import { assertSelectableNetwork } from './config.js';
import { ensureDashboardCredentialsForSetupBestEffort } from './dashboard-credential-setup.js';

/**
 * Options surface for the `dkg openclaw setup` subcommand as parsed by
 * commander. Mirrors the registered `.option(...)` declarations in `cli.ts`.
 * `fund` defaults to `true` (commander boolean-flag convention for
 * `--no-fund`/`--fund`); explicit `--no-fund` produces `fund === false` and
 * skips the faucet step in `runSetup`.
 */
export interface OpenClawSetupCliOptions {
  workspace?: string;
  name?: string;
  port?: string;
  verify?: boolean;
  start?: boolean;
  dryRun?: boolean;
  fund?: boolean;
  /** Network overlay to set up on; persisted as config.networkConfig. */
  network?: string;
}

export interface OpenClawSetupActionDeps {
  /** Adapter's `runSetup`. Injectable so tests can stub without spawning a CLI. */
  runSetup: (
    opts: OpenClawSetupCliOptions,
    runDeps?: {
      afterConfigBootstrap?: (dkgHome: string) => Promise<unknown>;
      loadOpWallets?: (dir: string) => Promise<unknown>;
    },
  ) => Promise<void>;
}

/**
 * Commander action handler for `dkg openclaw setup`. Extracted from the
 * `.action(...)` callback so it can be unit-tested without spawning the
 * built CLI or pre-building `packages/cli/dist/`. The commander wiring in
 * `cli.ts` dynamically imports the adapter and passes `runSetup` via `deps`.
 */
export async function openclawSetupAction(
  opts: OpenClawSetupCliOptions,
  _command: Pick<Command, 'getOptionValueSource'>,
  deps: OpenClawSetupActionDeps,
): Promise<void> {
  await assertSelectableNetwork(opts.network);
  // Inject the wallet creator from the cli layer (which has dkg-agent) so the
  // adapter eagerly creates wallets before the daemon starts (issue #1306)
  // without the adapter package depending on dkg-agent.
  await deps.runSetup(opts, {
    afterConfigBootstrap: (dkgHome: string) =>
      ensureDashboardCredentialsForSetupBestEffort(dkgHome),
    loadOpWallets: async (dir: string) => {
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      return loadOpWallets(dir);
    },
  });
}
