/**
 * Source-worker daemon clients — REAL daemon round-trips, NO mocks.
 *
 * The retired version replaced `globalThis.fetch` with a stub that returned
 * canned `{ shareOperationId: 'swm-1' }` / `{ jobId: 'job-1' }` / finalized
 * job bodies for any matching URL — so a renamed route, a reshaped response,
 * or a changed required field kept it green while the real round-trip broke
 * (the exact drift class the no-mocks policy removes).
 *
 * This version drives both clients against a REAL edge daemon:
 *   - `share()` writes real quads into a real context graph's SWM and gets a
 *     REAL shareOperationId back,
 *   - `lift()` enqueues a real async-lift job (the daemon's persistent
 *     publisher queue accepts and stores it) and returns the REAL jobId,
 *   - `getJobStatus()` reads the REAL stored job back and deserializes the
 *     real lifecycle fields.
 * Runs in the standard cli lane against the shared Hardhat node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDaemonAsyncLiftJobClient, createDaemonSharedMemoryWriteClient } from '../src/source-worker-daemon-client.js';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

const CG = `swdc-${Date.now().toString(36)}`;
const ROOT = `urn:swdc:${Date.now().toString(36)}:s`;

describe('source worker daemon clients (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    daemon = await startLiveDaemon();
    const created = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG, accessPolicy: 0 });
    expect(created.status, `CG create failed: ${JSON.stringify(created.body)}`).toBeLessThan(300);
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('share() writes real SWM quads and returns the daemon-issued shareOperationId', async () => {
    const share = createDaemonSharedMemoryWriteClient(daemon.base, daemon.token ?? '');
    const result = await share.share(CG, [{ subject: ROOT, predicate: 'urn:p', object: '"v"' }]);
    // The daemon mints `swm-<timestamp>-<rand>` ids — assert the real shape,
    // not a canned constant.
    expect(result.shareOperationId).toMatch(/^swm-/);
  });

  it('lift() enqueues a real job and getJobStatus() reads the real stored job back', async () => {
    const share = createDaemonSharedMemoryWriteClient(daemon.base, daemon.token ?? '');
    const jobs = createDaemonAsyncLiftJobClient(daemon.base, daemon.token ?? '');

    const { shareOperationId } = await share.share(CG, [
      { subject: ROOT, predicate: 'urn:p:type', object: 'urn:Note' },
    ]);

    const jobId = await jobs.lift({
      swmId: 'swm-live',
      shareOperationId,
      roots: [ROOT],
      contextGraphId: CG,
      namespace: 'ns',
      scope: 'scope',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof' },
    } as never);
    // Real daemon issues a UUID job id.
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const status = await jobs.getJobStatus(jobId);
    // The job was REALLY persisted: a real lifecycle status comes back (the
    // edge daemon has no publisher runtime processing the queue, so the job
    // sits in its initial state — any real status string proves the
    // round-trip; a canned 'finalized' would prove nothing).
    expect(typeof status.status).toBe('string');
    expect(status.status.length).toBeGreaterThan(0);
  });

  it('getJobStatus() surfaces a real not-found for an unknown job id', async () => {
    const jobs = createDaemonAsyncLiftJobClient(daemon.base, daemon.token ?? '');
    await expect(jobs.getJobStatus('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
