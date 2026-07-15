import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonKnowledgeAssetLifecycleClient } from '../src/source-worker-daemon-client.js';

describe('source worker daemon client response decoding', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves a private graph commitment in the async publish envelope', async () => {
    const privateMerkleRoot = `0x${'ab'.repeat(32)}`;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      jobId: 'private-job',
      shareOperationId: 'private-share',
      contentScopeVersion: 2,
      kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '2',
      publicTripleCount: 1,
      privateMerkleRoot,
      privateTripleCount: 3,
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

    const client = createDaemonKnowledgeAssetLifecycleClient('http://127.0.0.1:1', 'token');
    const publish = await client.publishAsync('private-cg', 'private-ka');

    expect(publish).toMatchObject({
      jobId: 'private-job',
      privateMerkleRoot,
      privateTripleCount: 3,
    });
  });
});
