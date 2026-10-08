// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/status.chain` endpoint observability.
 *
 * The failover counters moved here from the route body unchanged; these rows pin that, and the
 * fact added beside them: which chain endpoint gave no view on the pinned version read. One
 * such endpoint holds every confirmed publish on the node, so status has to be able to say so.
 * Pure: an in-process route call and a chain adapter over scripted endpoints, no daemon.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EVMChainAdapter,
  _resetKnowledgeAssetVersionSnapshotHealthForTest,
  _resetRpcFailoverStatsForTest,
  getKnowledgeAssetVersionSnapshotHealth,
  getRpcFailoverStats,
  noteRpcExhaustion,
  noteRpcFailover,
  notePreferredEndpoint,
  noteRpcServed,
} from '@origintrail-official/dkg-chain';
import {
  resolveRfc64CatalogActivationsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
} from '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import { chainRpcStatusFields } from '../src/daemon/routes/status-chain-rpc.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const SECRET = 'v3/SECRET-PATH-KEY?apikey=SECRET-QUERY-KEY';

/**
 * One version read through the real adapter over three scripted endpoints, the third of which
 * refuses the read pinned to a block number unless `serving`.
 */
async function readVersionSnapshot(serving = false): Promise<unknown> {
  const urls = ['one', 'two', 'three'].map((name) => `https://${name}.example/${SECRET}`);
  const adapter = new EVMChainAdapter({
    rpcUrl: urls[0],
    rpcUrls: urls.slice(1),
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    finalityConfirmations: 1,
  } as never) as unknown as Record<string, unknown>;
  const providers = urls.map((url) => ({
    url,
    async getNetwork() { return { chainId: 31337n }; },
    async getBlock() { return { number: 500, hash: `0x${'50'.repeat(32)}` }; },
  }));
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.ensureConfiguredStaticChainIdValidated = async () => 31337n;
  adapter.contracts = { knowledgeAssetStorage: { target: `0x${'33'.repeat(20)}` } };
  adapter.providers = providers;
  adapter.rebindContract = (_contract: unknown, provider: (typeof providers)[number]) => ({
    async getLatestMerkleRoot() {
      if (provider.url === urls[2] && !serving) {
        // The shape ethers gives an HTTP 400: the request URL, key and all, is in the message.
        throw Object.assign(new Error(`server response 400 Bad Request (url="${provider.url}")`), {
          code: 'SERVER_ERROR',
          response: { statusCode: 400 },
          info: { requestUrl: provider.url, responseStatus: '400 Bad Request' },
        });
      }
      return `0x${'aa'.repeat(32)}`;
    },
    async getKnowledgeAssetUpdateContext() { return { 0: 1n, length: 7 }; },
    async getLatestMerkleRootAuthor() { return `0x${'11'.repeat(20)}`; },
    async getLatestMerkleRootPublisher() { return `0x${'22'.repeat(20)}`; },
  });
  return (adapter as unknown as {
    readKnowledgeAssetVersionSnapshot(kaId: bigint): Promise<unknown>;
  }).readKnowledgeAssetVersionSnapshot(7n);
}

async function startStatusServer(): Promise<{ server: Server; baseUrl: string }> {
  const activationState = resolveRfc64CatalogActivationsV1(
    { persistenceAvailable: false },
    resolveRfc64PublicCatalogActivationChainIdentityV1(undefined),
  ).activationState;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handleStatusRoutes({
      req,
      res,
      publisherState: {
        runtime: null,
        availability: {
          available: false,
          reason: 'publisher_disabled',
          retryable: false,
          operatorActionRequired: true,
        },
      },
      path: url.pathname,
      url,
      network: null,
      config: {
        name: 'status-chain-rpc-test',
        nodeRole: 'edge',
        chain: {
          type: 'evm',
          rpcUrl: `https://one.example/${SECRET}`,
          rpcUrls: [`https://two.example/${SECRET}`, `https://three.example/${SECRET}`],
          hubAddress: `0x${'ab'.repeat(20)}`,
          chainId: 'evm:31337',
        },
      },
      rfc64PublicCatalog: { enabled: false, selectedContextGraphs: [] },
      rfc64CatalogActivationState: activationState,
      startedAt: Date.now(),
      agent: {
        peerId: 'peer-status-chain-rpc-test',
        multiaddrs: [],
        getSyncContextGraphIds: () => [],
        node: { libp2p: { getConnections: () => [] }, getRelayStats: () => null },
        publisher: { getIdentityId: () => 0n },
      },
      nodeVersion: '0.0.0-test',
      nodeCommit: '',
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
      authentication: requestAuthentication({ kind: 'anonymous' }),
    } as unknown as RequestContext);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('/api/status chain endpoint observability', () => {
  let server: Server | undefined;

  beforeEach(() => {
    _resetRpcFailoverStatsForTest();
    _resetKnowledgeAssetVersionSnapshotHealthForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetRpcFailoverStatsForTest();
    _resetKnowledgeAssetVersionSnapshotHealthForTest();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('carries the failover counters under the keys they always had', () => {
    noteRpcFailover('status-test publish', 'https://primary.example/key', { status: 429 }, 'https://backup.example');
    noteRpcExhaustion('status-test publish', ['https://primary.example/key', 'https://backup.example']);
    notePreferredEndpoint('status-test publish', 'https://backup.example');
    noteRpcServed('status-test read', 'https://served.example/key', { mode: 'read', key: 'status-test-read' });
    const stats = getRpcFailoverStats();

    expect(chainRpcStatusFields()).toEqual({
      rpcFailovers: 1,
      rpcExhaustions: 1,
      rpcFailoversByClass: { THROTTLE_429: 1 },
      rpcServedByEndpointHost: { 'served.example': 1 },
      rpcFailoversByEndpointHost: { 'primary.example': 1 },
      rpcPreferredEstablishments: 1,
      versionSnapshot: {
        established: 0,
        unavailable: 0,
        consecutiveUnavailable: 0,
        unavailableSince: null,
        lastUnavailableReason: null,
        failingEndpoints: [],
      },
    });
    expect(chainRpcStatusFields().rpcFailoversByClass).toEqual(stats.byErrorClass);
  });

  it('names the endpoint that refuses the pinned version read, by position and host only', async () => {
    await expect(readVersionSnapshot()).resolves.toBeNull();
    await expect(readVersionSnapshot()).resolves.toBeNull();
    const started = await startStatusServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/api/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as { chain: Record<string, any> };

    expect(body.chain).toMatchObject({
      chainId: 'evm:31337',
      configured: true,
      rpcEndpointCount: 3,
      hubConfigured: true,
      rpcFailovers: 0,
      rpcExhaustions: 0,
      versionSnapshot: {
        established: 0,
        unavailable: 2,
        consecutiveUnavailable: 2,
        lastUnavailableReason: 'endpoints-failed',
        failingEndpoints: [{
          position: 3,
          endpointCount: 3,
          host: 'three.example',
          stage: 'pinned-read',
          failure: 'http-client-error',
          httpStatus: 400,
          consecutive: 2,
        }],
      },
    });
    expect(body.chain.versionSnapshot.unavailableSince).toEqual(expect.any(Number));
    // The status route is public. Neither the configured URLs nor the provider's error text
    // (which quotes the URL) may reach it.
    const chain = JSON.stringify(body.chain);
    expect(chain).not.toContain('SECRET');
    expect(chain).not.toContain('apikey');
    expect(chain).not.toContain('://');
  });

  it('shows nothing failing once the endpoint serves the pinned read again', async () => {
    await readVersionSnapshot();
    await expect(readVersionSnapshot(true)).resolves.toMatchObject({ blockNumber: 500 });

    expect(chainRpcStatusFields().versionSnapshot).toEqual({
      established: 1,
      unavailable: 1,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      lastUnavailableReason: null,
      failingEndpoints: [],
    });
    expect(getKnowledgeAssetVersionSnapshotHealth().failingEndpoints).toEqual([]);
  });
});
