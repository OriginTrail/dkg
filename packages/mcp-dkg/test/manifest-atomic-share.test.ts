import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
import { publishManifest } from '../src/manifest/publish.js';
import { makeConfig } from './harness.js';

function makeClient(shareResponse: Record<string, unknown>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new DkgClient({
    config: makeConfig(),
    fetcher: (async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const payload = String(url).endsWith('/swm/share') ? shareResponse : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  return { client, calls };
}

const manifestInput = {
  contextGraphId: 'team-cg',
  network: 'testnet' as const,
  supportedTools: ['claude-code'] as const,
  publisherAgentUri: 'did:dkg:agent:publisher',
  templates: {
    agentsMd: { encodingFormat: 'text/markdown', text: '# Agent rules' },
  },
};

describe('manifest publishing atomic share', () => {
  it('reports success only after the complete manifest reaches SWM', async () => {
    const { client, calls } = makeClient({
      swmShared: true,
      promotedCount: 0,
      sealed: true,
      publishReady: true,
      shareOperationId: 'manifest-share-1',
    });

    const result = await publishManifest({ ...manifestInput, client });
    expect(result.tripleCount).toBeGreaterThan(0);
    const share = calls.find((call) => call.url.endsWith('/project-manifest/swm/share'));
    expect(share?.body).toEqual({ contextGraphId: 'team-cg', subGraphName: 'meta' });
    expect(share?.body).not.toHaveProperty('entities');
  });

  it('fails instead of reporting success when the atomic share is incomplete', async () => {
    const { client } = makeClient({
      swmShared: false,
      promotedCount: 0,
      sealed: false,
      publishReady: false,
    });

    await expect(publishManifest({ ...manifestInput, client }))
      .rejects.toThrow('Manifest atomic share did not reach SWM');
  });
});
