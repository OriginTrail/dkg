import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

describe('DkgClient context-graph registration', () => {
  const makeClient = () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({
          registered: 'pca-private',
          onChainId: '42',
          txHash: '0xreg',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, calls };
  };

  it('serializes publishPolicy and a uint256-safe PCA id', async () => {
    const { client, calls } = makeClient();
    await client.registerContextGraph({
      id: 'did:dkg:context-graph:pca-private',
      accessPolicy: 1,
      publishPolicy: 0,
      pcaAccountId: 9007199254740993n,
    });

    expect(calls[0].url).toContain('/api/context-graph/register');
    expect(calls[0].body).toEqual({
      id: 'pca-private',
      accessPolicy: 1,
      publishPolicy: 0,
      pcaAccountId: '9007199254740993',
    });
  });

  it('rejects invalid PCA ids before making an HTTP request', async () => {
    const { client, calls } = makeClient();
    await expect(client.registerContextGraph({
      id: 'pca-private',
      pcaAccountId: '0',
    })).rejects.toThrow(/positive decimal integer/);
    expect(calls).toHaveLength(0);
  });

  it('records a completed local install through the daemon without identity data', async () => {
    const { client, calls } = makeClient();
    await client.recordProjectInstall('did:dkg:context-graph:project/alpha');

    expect(calls[0].url).toContain(
      '/api/context-graph/project%2Falpha/manifest/install-receipt',
    );
    expect(calls[0].body).toEqual({});
  });
});
