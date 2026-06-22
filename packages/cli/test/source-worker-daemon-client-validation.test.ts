import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonKnowledgeAssetLifecycleClient } from '../src/source-worker-daemon-client.js';

describe('source worker daemon lifecycle client response validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects createAndShare partial lifecycle responses with tail errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      created: true,
      status: 'wm-sealed',
      errors: [{ phase: 'swm-share', error: 'share failed' }],
      promotedCount: 0,
      publishReady: false,
    }), {
      status: 207,
      headers: { 'Content-Type': 'application/json' },
    })));

    const client = createDaemonKnowledgeAssetLifecycleClient('http://daemon.test', 'token');

    await expect(
      client.createAndShare('cg', 'ka', [
        { subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: '' },
      ]),
    ).rejects.toThrow(/partial lifecycle errors/);
  });

  it('rejects createAndShare 2xx responses that are not publish-ready SWM shares', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      created: true,
      status: 'wm-sealed',
      swmShared: true,
      promotedCount: 1,
      publishReady: false,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })));

    const client = createDaemonKnowledgeAssetLifecycleClient('http://daemon.test', 'token');

    await expect(
      client.createAndShare('cg', 'ka', [
        { subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: '' },
      ]),
    ).rejects.toThrow(/did not produce a publish-ready SWM share/);
  });
});
