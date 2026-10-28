// SPDX-License-Identifier: Apache-2.0
import type { Command } from 'commander';
import { open } from 'node:fs/promises';
import { normalizePublicSnapshotSyncOptions } from '@origintrail-official/dkg-agent';
import { ApiClient } from '../api-client.js';

export function registerSyncCheckpointCommand(sync: Command): void {
  sync.command('prepare-bootstrap')
    .description('Prepare a verified public bootstrap checkpoint; leaves the active store unchanged')
    .requiredOption('--request <json-file>', 'Public graph, chain evidence mode and core source policy')
    .option('--native', 'Build and fully audit a fresh journal with the daemon-configured pinned native runtime')
    .action(async (options: { request: string; native?: boolean }) => {
      try {
        const input = await open(options.request, 'r');
        let raw: unknown;
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > 4096) throw new Error('Checkpoint request must be a JSON file of at most 4096 bytes');
          raw = JSON.parse(await input.readFile('utf8'));
        } finally { await input.close(); }
        const { signal: _signal, transport: _transport, ...request } = normalizePublicSnapshotSyncOptions(raw);
        const client = await ApiClient.connect();
        const job = await client.checkpoints.prepare({ ...request, native: options.native === true });
        if (!job.id) throw new Error('Checkpoint request returned no job identity');
        console.log(`Preparing public bootstrap (${job.id}). The active store remains unchanged.`);
        const deadline = Date.now() + 3_600_000;
        for (;;) {
          const status = await client.checkpoints.status();
          if (status.id !== job.id) throw new Error('Checkpoint job ownership changed; inspect the daemon before retrying');
          if (status.state === 'failed') throw new Error(status.error ?? 'Checkpoint preparation failed');
          if (status.state === 'complete') { console.log(JSON.stringify(status.result, null, 2)); return; }
          if (Date.now() >= deadline) throw new Error('Stopped waiting at the snapshot deadline; inspect job status before retrying');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
      }
    });
}
