import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

type Evidence = { event: string; [key: string]: unknown };
async function evidence(daemon: LiveDaemon): Promise<Evidence[]> {
  return (await readFile(join(daemon.home, '2361.events.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Evidence);
}

// Real built CLI worker + loopback libp2p + persistent Oxigraph worker + DashboardDB.
// The preload grants read authority for its fixture graph, stalls the chain
// adapter, and records production scheduling and teardown events.
// No Hardhat or external RPC is used.
describe('daemon chain event shutdown', () => {
  it.each(['scan', 'callback', 'noncooperative'] as const)('retires %s chain work before closing backing stores', async scenario => {
    let daemon: LiveDaemon | undefined;
    try {
      const preload = fileURLToPath(new URL('./fixtures/chain-event-shutdown-preload.mjs', import.meta.url));
      daemon = await startLiveDaemon({
        extraConfig: { chain: { type: 'mock' }, syncReconcilerEnabled: true },
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(preload)}`,
          DKG_TEST_CHAIN_EVENT_BOUNDARY: scenario,
          DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS: '250',
          DKG_SHUTDOWN_HARD_TIMEOUT_MS: '10000',
        },
      });
      const worker = daemon;
      await worker.owner.ready(async () => (await evidence(worker)).some(row => row.event === 'entered') ? true : undefined);
      const entered = (await evidence(worker)).find(row => row.event === 'entered');
      expect(entered).toMatchObject({ hasSignal: true });
      if (scenario !== 'scan') {
        // Live callbacks now hand off to the bounded VM scheduler. Wait for
        // the poll checkpoint independently of the stalled recovery lookup.
        await worker.owner.ready(async () => (await evidence(worker)).some(row => row.event === 'poll-retired') ? true : undefined);
      }
      worker.child.kill('SIGTERM');
      if (scenario === 'noncooperative') {
        await worker.owner.ready(async () => (await evidence(worker)).some(row => row.event === 'agent-stop-error') ? true : undefined);
        const waiting = await evidence(worker);
        expect(waiting.find(row => row.event === 'agent-stop-error')).toMatchObject({ code: 'VmReconcileShutdownTimeout' });
        expect(waiting.some(row => row.event === 'store-close' || row.event === 'dashboard-close')).toBe(false);
        expect(worker.child.exitCode).toBeNull();
        await writeFile(join(worker.home, '2361.release'), 'release');
      }
      await worker.owner.waitForExit(8000);
      const rows = await evidence(worker);
      const events = rows.map(row => row.event);
      expect(rows.find(row => row.event === 'aborted')).toMatchObject({ apiPortStillPresent: true });
      expect(rows.find(row => row.event === 'daemon-fence-return')).toMatchObject({ aborted: true });
      // The outer daemon fence also owns event-admitted VM recovery.
      expect(events.indexOf('aborted')).toBeLessThan(events.indexOf('store-close'));
      expect(rows.filter(row => row.event === 'entered')).toHaveLength(1);
      expect(rows.find(row => row.event === 'store-close')).toMatchObject({
        bound: null, binding: rows.find(row => row.event === 'initial-binding')?.binding, physicalRuns: 0,
      });
      expect(rows.find(row => row.event === 'dashboard-close')).toMatchObject({ cursor: scenario === 'scan' ? 10 : 20 });
      const physicalReadSettled = events.indexOf('physical-read-settled');
      expect(physicalReadSettled).toBeGreaterThanOrEqual(0);
      expect(physicalReadSettled).toBeLessThan(events.indexOf('store-close'));
      expect(events.indexOf('store-close')).toBeLessThan(events.indexOf('dashboard-close'));
      if (scenario !== 'noncooperative') expect(events).not.toContain('agent-stop-error');
    } finally { await stopLiveDaemon(daemon); }
  });
});
