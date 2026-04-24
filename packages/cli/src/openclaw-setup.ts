import type { Command } from 'commander';
import type { runSetup as RunSetupFn } from '@origintrail-official/dkg-adapter-openclaw';

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
}

export interface OpenClawSetupActionDeps {
  /** Adapter's `runSetup`. Injectable so tests can stub without spawning a CLI. */
  runSetup: typeof RunSetupFn;
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
  await deps.runSetup(opts);
}
