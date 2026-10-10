// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/status.chain` endpoint observability.
 *
 * The failover counters moved here from the route body unchanged; these rows pin that, and the
 * fact added beside them: which chain endpoints failed the pinned version read. A failing
 * primary is passed over on every read without a word, and when no endpoint serves the read
 * confirmed publishes wait, so status has to be able to say which.
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

const ENDPOINTS = ['one', 'two', 'three'] as const;

/**
 * One version read through the real adapter over three scripted endpoints. Those named in
 * `refusing` serve `latest` reads and refuse the read pinned to a block number.
 */
async function readVersionSnapshot(refusing: ReadonlyArray<(typeof ENDPOINTS)[number]>): Promise<unknown> {
  const urls = ENDPOINTS.map((name) => `https://${name}.example/${SECRET}`);
  const adapter = new EVMChainAdapter({
    rpcUrl: urls[0],
    rpcUrls: urls.slice(1),
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    finalityConfirmations: 1,
  } as never) as unknown as Record<string, unknown>;
  const providers = urls.map((url, index) => ({
    url,
    refuses: refusing.includes(ENDPOINTS[index]!),
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
      if (provider.refuses) {
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

  async function statusChain(): Promise<Record<string, any>> {
    const started = await startStatusServer();
    server = started.server;
    const response = await fetch(`${started.baseUrl}/api/status`);
    expect(response.status).toBe(200);
    return (await response.json() as { chain: Record<string, any> }).chain;
  }

  it('names a primary that every version read passes over, by position and host only', async () => {
    // The reads succeed through the next endpoint; nothing but this says the primary fails.
    await expect(readVersionSnapshot(['one'])).resolves.toMatchObject({ blockNumber: 500 });
    await expect(readVersionSnapshot(['one'])).resolves.toMatchObject({ blockNumber: 500 });

    const chain = await statusChain();

    expect(chain).toMatchObject({
      chainId: 'evm:31337',
      configured: true,
      rpcEndpointCount: 3,
      hubConfigured: true,
      rpcFailovers: 0,
      rpcExhaustions: 0,
      versionSnapshot: {
        established: 2,
        unavailable: 0,
        consecutiveUnavailable: 0,
        unavailableSince: null,
        lastUnavailableReason: null,
        failingEndpoints: [{
          position: 1,
          endpointCount: 3,
          host: 'one.example',
          stage: 'pinned-read',
          failure: 'http-client-error',
          httpStatus: 400,
          consecutive: 2,
        }],
      },
    });
    // The status route is public. Neither the configured URLs nor the provider's error text
    // (which quotes the URL) may reach it.
    const text = JSON.stringify(chain);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('apikey');
    expect(text).not.toContain('://');
  });

  it('says so when no endpoint serves the version read, and names each one', async () => {
    await expect(readVersionSnapshot(['one', 'two', 'three'])).resolves.toBeNull();

    const chain = await statusChain();

    expect(chain.versionSnapshot).toMatchObject({
      established: 0,
      unavailable: 1,
      consecutiveUnavailable: 1,
      lastUnavailableReason: 'endpoints-failed',
    });
    expect(chain.versionSnapshot.unavailableSince).toEqual(expect.any(Number));
    expect(chain.versionSnapshot.failingEndpoints.map((entry: { host: string }) => entry.host))
      .toEqual(['one.example', 'two.example', 'three.example']);
    expect(JSON.stringify(chain)).not.toContain('SECRET');
  });

  it('shows nothing failing once the primary serves the pinned read again', async () => {
    await readVersionSnapshot(['one']);
    await expect(readVersionSnapshot([])).resolves.toMatchObject({ blockNumber: 500 });

    expect(chainRpcStatusFields().versionSnapshot).toEqual({
      established: 2,
      unavailable: 0,
      consecutiveUnavailable: 0,
      unavailableSince: null,
      lastUnavailableReason: null,
      failingEndpoints: [],
    });
    expect(getKnowledgeAssetVersionSnapshotHealth().failingEndpoints).toEqual([]);
  });
});
