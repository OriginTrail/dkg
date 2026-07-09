/**
 * Source-worker daemon client - REAL daemon round-trips, NO mocks.
 *
 * This drives the lifecycle client against a REAL edge daemon:
 *   - createAndShare() creates, seals, and shares a real named KA into SWM,
 *   - publishAsync() enqueues a named KA VM publish job and returns the REAL jobId,
 *   - getJobStatus() reads the REAL stored job back and deserializes lifecycle fields.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDaemonKnowledgeAssetLifecycleClient } from '../src/source-worker-daemon-client.js';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

const CG = `swdc-${Date.now().toString(36)}`;
const ROOT = `urn:swdc:${Date.now().toString(36)}:s`;

describe('source worker daemon client (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    daemon = await startLiveDaemon();
    const created = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG, accessPolicy: 0 });
    expect(created.status, `CG create failed: ${JSON.stringify(created.body)}`).toBeLessThan(300);
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('createAndShare() creates, seals, and shares a real named KA', async () => {
    const client = createDaemonKnowledgeAssetLifecycleClient(daemon.base, daemon.token ?? '');
    const result = await client.createAndShare(CG, 'source-worker-create', [
      { subject: ROOT, predicate: 'urn:p', object: '"v"', graph: '' },
    ]);
    expect(result.promotedCount).toBeGreaterThan(0);
    expect(result.shareOperationId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });

  it('publishAsync() enqueues a real job and getJobStatus() reads the real stored job back', async () => {
    const client = createDaemonKnowledgeAssetLifecycleClient(daemon.base, daemon.token ?? '');
    const name = 'source-worker-async-publish';
    const share = await client.createAndShare(CG, name, [
      { subject: ROOT, predicate: 'urn:p:type', object: 'urn:Note', graph: '' },
    ]);

    const publish = await client.publishAsync(CG, name);
    const jobId = publish.jobId;
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(publish.shareOperationId).toBe(share.shareOperationId);
    expect(publish.rootsCount).toBeGreaterThan(0);
    expect(publish.intentKey).toMatch(/^sha256:[0-9a-f]{64}$/);

    const status = await client.getJobStatus(jobId);
    expect(typeof status.status).toBe('string');
    expect(status.status.length).toBeGreaterThan(0);
  });

  it('getJobStatus() surfaces a real not-found for an unknown job id', async () => {
    const client = createDaemonKnowledgeAssetLifecycleClient(daemon.base, daemon.token ?? '');
    await expect(client.getJobStatus('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
