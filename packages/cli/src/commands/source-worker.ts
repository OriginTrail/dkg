import { Command } from 'commander';

import { toErrorMessage } from '@origintrail-official/dkg-core';

import { runConfiguredSourceWorker } from '../source-worker-runner.js';

import type { ActionOpts } from '../cli-helpers.js';

export function registerSourceWorkerCommand(program: Command): void {
// ─── dkg source-worker ────────────────────────────────────────────────

const sourceWorkerCmd = program
  .command('source-worker')
  .description('Run generic source workers against the DKG daemon');

sourceWorkerCmd
  .command('run')
  .description('Run a source worker from a JSON config file')
  .requiredOption('--config <path>', 'Sensitive worker config JSON file')
  .option('--once', 'Run a single iteration and exit')
  .action(async (opts: ActionOpts) => {
    try {
      await runConfiguredSourceWorker(String(opts.config), { once: opts.once === true });
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
