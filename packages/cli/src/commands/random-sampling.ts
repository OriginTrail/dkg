import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';

import { toErrorMessage } from '@origintrail-official/dkg-core';

import { dkgDir } from '../config.js';
import { ApiClient } from '../api-client.js';
import { describeRandomSamplingDisabledStatus } from '../random-sampling-status.js';

import type { ActionOpts } from '../cli-helpers.js';

export function registerRandomSamplingCommand(program: Command): void {
// ─── dkg random-sampling (alias: rs) ─────────────────────────────────

const randomSamplingCmd = program
  .command('random-sampling')
  .alias('rs')
  .description('V10 Random Sampling prover — operator surface');

randomSamplingCmd
  .command('status')
  .description('Show the running prover snapshot (last tick, last submitted proof, etc.)')
  .option('--json', 'Print the raw JSON response instead of the formatted summary')
  .action(async (opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const status = await client.randomSamplingStatus();
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`  Prover:    ${status.enabled ? 'enabled' : 'disabled'}`);
      console.log(`  Role:      ${status.role}`);
      console.log(`  Identity:  ${status.identityId}`);
      if (!status.loop) {
        console.log(`  Loop:      not running`);
        if (!status.enabled) {
          console.log(`  Reason:    ${describeRandomSamplingDisabledStatus(status)}`);
        }
        return;
      }
      const last = status.loop.lastOutcome as { kind?: string } | null;
      console.log(`  Ticks:     ${status.loop.totalTicks} (in flight: ${status.loop.inflight})`);
      console.log(`  Last tick: ${status.loop.lastTickAt ?? '—'} (${last?.kind ?? 'never run'})`);
      console.log(`  Submitted: ${status.loop.submittedCount} proof${status.loop.submittedCount === 1 ? '' : 's'}`);
      if (status.loop.lastSubmittedAt) {
        console.log(`  Last tx:   ${status.loop.lastSubmittedTxHash} (${status.loop.lastSubmittedAt})`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

randomSamplingCmd
  .command('wal-tail [path]')
  .description(
    'Tail the prover WAL (JSONL). If no path is given, reads ~/.dkg/random-sampling.wal. ' +
    'Local file read — does not require the daemon to be running.',
  )
  .option('-n, --count <count>', 'Number of trailing entries to print', '50')
  .option('--json', 'Print raw JSONL (one entry per line)', false)
  .action(async (path: string | undefined, opts: ActionOpts) => {
    try {
      const walPath = path ?? join(dkgDir(), 'random-sampling.wal');
      if (!existsSync(walPath)) {
        console.error(`No WAL file at ${walPath}`);
        console.error('Hint: set `randomSamplingWalPath` in your dkg config to enable persistent WAL.');
        process.exit(1);
      }
      const limit = Math.max(1, parseInt(String(opts.count ?? '50'), 10) || 50);
      const raw = readFileSync(walPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const tail = lines.slice(-limit);
      if (opts.json) {
        for (const line of tail) console.log(line);
        return;
      }
      for (const line of tail) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const ts = String(entry.ts ?? '—');
          const status = String(entry.status ?? '?');
          const epoch = String(entry.epoch ?? '?');
          const periodStart = String(entry.periodStartBlock ?? '?');
          const kaId = entry.kaId !== undefined ? `kc=${entry.kaId}` : '';
          const tx = entry.txHash !== undefined ? ` tx=${String(entry.txHash).slice(0, 14)}…` : '';
          const errCode = entry.error && typeof entry.error === 'object'
            ? ` err=${(entry.error as { code?: string }).code ?? '?'}`
            : '';
          console.log(`${ts}  ep=${epoch} pb=${periodStart}  ${status.padEnd(10)} ${kaId}${tx}${errCode}`);
        } catch {
          console.log(line);
        }
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
