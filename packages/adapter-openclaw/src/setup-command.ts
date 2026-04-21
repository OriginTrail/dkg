/**
 * Shared commander registrar for the `setup` subcommand.
 *
 * Imported by both the standalone `dkg-openclaw` binary
 * (packages/adapter-openclaw/src/setup-cli.ts) and the top-level DKG
 * CLI's `dkg openclaw setup` entry so the flag surface, help text, and
 * error handling live in exactly one place.
 */

import type { Command } from 'commander';

/**
 * Attach the `setup` subcommand to an existing commander program and
 * return the sub-command so callers can chain further configuration.
 *
 * `runSetup` is imported lazily inside the action handler so merely
 * declaring the command (e.g. during `dkg --help`) does not eagerly
 * load the adapter's heavier runtime dependencies.
 */
export function registerSetupCommand(parent: Command): Command {
  return parent
    .command('setup')
    .description('Set up DKG node + OpenClaw adapter (non-interactive, idempotent)')
    .option('--workspace <dir>', 'Override OpenClaw workspace directory')
    .option('--name <name>', 'Override agent name')
    .option('--port <port>', 'Override daemon API port (default: 9200)')
    .option('--no-fund', 'Skip wallet funding via faucet')
    .option('--no-verify', 'Skip post-setup verification')
    .option('--no-start', 'Skip daemon start (configure only)')
    .option('--dry-run', 'Preview changes without writing anything')
    .action(async (opts) => {
      try {
        const { runSetup } = await import('./setup.js');
        await runSetup(opts);
      } catch (err: any) {
        console.error(`\n[setup] ERROR: ${err.message}\n`);
        process.exit(1);
      }
    });
}
