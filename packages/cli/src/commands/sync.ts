import { Command } from 'commander';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import { runCatchupStatusCommand, type CatchupStatusCommandOptions } from '../cli-helpers.js';
import { registerSyncCheckpointCommand } from './sync-checkpoint.js';

export function registerSyncCommand(program: Command): void {
// ─── dkg sync ─────────────────────────────────────────────────────────

const syncCmd = program
  .command('sync')
  .description('Sync status and public bootstrap helpers');
registerSyncCheckpointCommand(syncCmd);


syncCmd
  .command('catchup-status <context-graph>')
  .description('Show latest background catch-up status for a context graph (id, name hash or on-chain id, e.g. 32)')
  .option('--watch', 'Poll until the catch-up job reaches a terminal state')
  .option('--interval <seconds>', 'Polling interval for --watch', '2')
  .action(async (contextGraph: string, opts: CatchupStatusCommandOptions) => {
    try {
      await runCatchupStatusCommand(contextGraph, opts);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
