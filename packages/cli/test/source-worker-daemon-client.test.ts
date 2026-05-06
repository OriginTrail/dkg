import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonAsyncLiftJobClient, createDaemonSharedMemoryWriteClient } from '../src/source-worker-daemon-client.js';

const originalFetch = globalThis.fetch;

describe('source worker daemon client', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/api/shared-memory/write')) {
        return new Response(JSON.stringify({ shareOperationId: 'swm-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/publisher/enqueue')) {
        return new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/publisher/job')) {
        return new Response(JSON.stringify({ job: { status: 'finalized' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('writes shared memory and enqueues/polls async jobs', async () => {
    const share = createDaemonSharedMemoryWriteClient('http://127.0.0.1:9200', 'token');
    const jobs = createDaemonAsyncLiftJobClient('http://127.0.0.1:9200', 'token');
    await expect(share.share('cg', [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"' }])).resolves.toEqual({ shareOperationId: 'swm-1' });
    await expect(jobs.lift({
      swmId: 'swm',
      shareOperationId: 'swm-1',
      roots: ['urn:s'],
      contextGraphId: 'cg',
      namespace: 'ns',
      scope: 'scope',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof' },
    })).resolves.toBe('job-1');
    await expect(jobs.getJobStatus('job-1')).resolves.toBe('finalized');
  });
});
