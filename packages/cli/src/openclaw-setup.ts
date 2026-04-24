import type { Command } from 'commander';
import type { runSetup as RunSetupFn } from '@origintrail-official/dkg-adapter-openclaw';

/**
 * Options surface for the `dkg openclaw setup` subcommand as parsed by
 * commander. Mirrors the registered `.option(...)` declarations in `cli.ts`;
 * `fund` is the deprecated flag kept for backwards compatibility with
 * scripted invocations that predate the bundled adapter — it's stripped
 * before being passed to `runSetup`.
 */
export interface OpenClawSetupCliOptions {
  workspace?: string;
  name?: string;
  port?: string;
  verify?: boolean;
  start?: boolean;
  dryRun?: boolean;
  /** @deprecated Faucet funding was removed; kept for backwards-compat only. */
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
 *
 * Deprecation warning: if `--fund` or `--no-fund` was explicitly supplied
 * (detected via `command.getOptionValueSource('fund') === 'cli'`), logs a
 * one-line warning before `fund` is stripped from `opts`. Plain default
 * values do NOT trigger the warning.
 */
export async function openclawSetupAction(
  opts: OpenClawSetupCliOptions,
  command: Pick<Command, 'getOptionValueSource'>,
  deps: OpenClawSetupActionDeps,
): Promise<void> {
  if (command.getOptionValueSource('fund') === 'cli') {
    console.warn('[setup] note: --no-fund/--fund is deprecated; faucet funding was removed. Ignoring.');
  }
  delete opts.fund;

  await deps.runSetup(opts);
}
