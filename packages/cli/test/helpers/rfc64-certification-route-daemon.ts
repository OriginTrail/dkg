// SPDX-License-Identifier: Apache-2.0

import { createServer, type ServerResponse } from 'node:http';

import { createAllowedHttpAuthentication } from '../../src/auth.js';
import {
  createRequestContext,
  type RequestContext,
} from '../../src/daemon/routes/context.js';
import { handleKnowledgeAssetsRoutes } from '../../src/daemon/routes/knowledge-assets.js';
import { handleQueryRoutes } from '../../src/daemon/routes/query.js';
import { handleStatusRoutes } from '../../src/daemon/routes/status.js';

interface CertificationQuad {
  readonly subject: string;
  readonly predicate?: string;
  readonly object?: string;
}

export interface CertificationRouteState {
  readonly role: 'source' | 'receiver';
  readonly writtenByName: Map<string, readonly CertificationQuad[]>;
  readonly sharedSubjects: Set<string>;
  readonly routeCalls: Array<Readonly<{ method: string | undefined; path: string }>>;
}

export interface CertificationSynchronization {
  publish(quads: readonly CertificationQuad[]): void;
  receiverStopped(): void;
  receiverStarted(): void;
  stats(): Readonly<{
    liveDeliveries: number;
    queuedDeliveries: number;
    catchupDeliveries: number;
  }>;
}

export interface CertificationRouteServer {
  readonly baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface CertificationRouteOptions {
  readonly contextGraphId: string;
  readonly catalogSwmAsk: string;
  readonly nodeAddress: string;
  readonly nodeCommit: string;
  readonly networkId: string;
}

const OPERATIONAL_DIGEST = `0x${'ab'.repeat(32)}`;
const INVENTORY_DIGEST = `0x${'cd'.repeat(32)}`;

export function createCertificationRouteState(
  role: CertificationRouteState['role'],
): CertificationRouteState {
  return {
    role,
    writtenByName: new Map(),
    sharedSubjects: new Set(),
    routeCalls: [],
  };
}

export function createCertificationSynchronization(
  receiverState: CertificationRouteState,
  { enabled = true }: { readonly enabled?: boolean } = {},
): CertificationSynchronization {
  // Keep daemon stores independent. This adapter models only the production
  // network seam: live announcements reach an online receiver, while missed
  // announcements are applied by restart reconciliation.
  let receiverOnline = true;
  const queued: Array<readonly CertificationQuad[]> = [];
  let liveDeliveries = 0;
  let queuedDeliveries = 0;
  let catchupDeliveries = 0;
  const apply = (quads: readonly CertificationQuad[]) => {
    for (const quad of quads) receiverState.sharedSubjects.add(quad.subject);
  };
  return Object.freeze({
    publish(quads: readonly CertificationQuad[]) {
      if (!enabled) return;
      const detached = structuredClone(quads);
      if (receiverOnline) {
        apply(detached);
        liveDeliveries += 1;
      } else {
        queued.push(detached);
        queuedDeliveries += 1;
      }
    },
    receiverStopped() {
      receiverOnline = false;
    },
    receiverStarted() {
      receiverOnline = true;
      for (const quads of queued.splice(0)) {
        apply(quads);
        catchupDeliveries += 1;
      }
    },
    stats: () => Object.freeze({ liveDeliveries, queuedDeliveries, catchupDeliveries }),
  });
}

export async function startCertificationRouteServer(
  state: CertificationRouteState,
  options: CertificationRouteOptions,
  synchronization?: CertificationSynchronization,
): Promise<CertificationRouteServer> {
  const agent = createRouteAgent(state, options, synchronization);
  const server = createServer(async (req, res) => {
    const authentication = createAllowedHttpAuthentication({ mode: 'public' });
    const catalogActivation = {
      enabled: true,
      selectedContextGraphs: [options.contextGraphId],
      selectedPublicContextGraphs: [options.contextGraphId],
      selectedPrivateContextGraphs: [],
      selectedCatalogAuthoringControls: [],
      rollout: {
        killSwitch: false,
        contextGraphModes: { [options.contextGraphId]: 'catalog' },
      },
    } satisfies NonNullable<RequestContext['rfc64Catalog']>;
    const publicCatalogActivation = {
      enabled: true,
      selectedContextGraphs: [options.contextGraphId],
      rollout: {
        killSwitch: false,
        contextGraphModes: { [options.contextGraphId]: 'catalog' },
      },
    } satisfies RequestContext['rfc64PublicCatalog'];
    const tracker = {
      start: () => undefined,
      startPhase: () => undefined,
      completePhase: () => undefined,
      complete: () => undefined,
      fail: () => undefined,
      cancel: () => undefined,
    };
    const routeContext = createRequestContext({
      req,
      res,
      // The fixture deliberately implements only the production-handler surface
      // used by this contract. Keep the unsoundness localized at that boundary.
      agent: agent as unknown as RequestContext['agent'],
      publisherControl: {} as RequestContext['publisherControl'],
      publisherState: {
        runtime: null,
        availability: {
          available: false,
          reason: 'publisher_disabled',
          retryable: false,
          operatorActionRequired: true,
        },
      } satisfies RequestContext['publisherState'],
      config: {
        name: 'rfc64-canary-route-contract',
        nodeRole: 'edge',
        syncReconcilerEnabled: true,
        chain: {
          type: 'evm',
          rpcUrl: 'https://rpc.invalid',
          hubAddress: options.nodeAddress,
          chainId: '2160',
        },
      } as RequestContext['config'],
      rfc64Catalog: catalogActivation,
      rfc64PublicCatalog: publicCatalogActivation,
      startedAt: Date.now(),
      dashDb: {} as RequestContext['dashDb'],
      opWallets: {} as RequestContext['opWallets'],
      network: {
        networkId: options.networkId,
        networkName: 'testnet',
      } as RequestContext['network'],
      tracker: tracker as unknown as RequestContext['tracker'],
      memoryManager: {} as RequestContext['memoryManager'],
      bridgeAuthToken: undefined,
      nodeVersion: '10.0.0-test',
      nodeCommit: options.nodeCommit,
      catchupTracker: {
        jobs: new Map(),
        latestByContextGraph: new Map(),
      } as RequestContext['catchupTracker'],
      extractionRegistry: {} as RequestContext['extractionRegistry'],
      fileStore: {} as RequestContext['fileStore'],
      extractionStatus: new Map(),
      assertionImportLocks: new Map(),
      vectorStore: {} as RequestContext['vectorStore'],
      embeddingProvider: null,
      validTokens: new Set<string>(),
      apiHost: '127.0.0.1',
      apiPortRef: { value: 0 },
      routePlugins: [],
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
      authentication,
      emitMemoryGraphChanged: () => undefined,
      emitNotification: () => undefined,
    });
    const { path } = routeContext;
    state.routeCalls.push({ method: req.method, path });
    try {
      if (path === '/api/status') await handleStatusRoutes(routeContext);
      else if (path === '/api/knowledge-assets') {
        await handleKnowledgeAssetsRoutes(routeContext);
      } else if (path === '/api/query') await handleQueryRoutes(routeContext);
      if (!res.writableEnded) jsonNodeResponse(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.writableEnded) {
        jsonNodeResponse(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const stop = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('route server did not bind');
  }
  const port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    start: () => server.listening ? Promise.resolve() : listen(port),
    stop,
    close: stop,
  };
}

function createRouteAgent(
  state: CertificationRouteState,
  options: CertificationRouteOptions,
  synchronization?: CertificationSynchronization,
) {
  return {
    peerId: `12D3KooDaemonContract${state.role}`,
    multiaddrs: [],
    node: {
      libp2p: { getConnections: () => [] },
      getRelayStats: () => null,
    },
    publisher: { getIdentityId: () => 1n },
    getSyncContextGraphIds: () => [options.contextGraphId],
    resolveAgentAddress: () => options.nodeAddress,
    readRfc64CatalogOperationalStatusV1: async () => [{
      contextGraphId: options.contextGraphId,
      effectiveMode: 'catalog',
      legacySyncAllowed: false,
      phase: 'complete',
      authorityState: 'accepted',
      authorityFreshness: 'current',
      catalogServiceStarted: true,
      expectedCatalogHeadDigest: OPERATIONAL_DIGEST,
      appliedCatalogHeadDigest: OPERATIONAL_DIGEST,
      expectedInventoryDigest: INVENTORY_DIGEST,
      appliedInventoryDigest: INVENTORY_DIGEST,
      expectedRowCount: '2',
      appliedRowCount: '2',
      missingRowCount: '0',
      catalogVersion: '7',
      lastSuccessfulAdvanceAt: '1893456000',
    }],
    getDefaultAgentAddress: () => options.nodeAddress,
    resolveAgentByToken: () => undefined,
    listContextGraphs: async () => [{
      id: options.contextGraphId,
      uri: `did:dkg:context-graph:${options.contextGraphId}`,
      subscribed: true,
      synced: true,
    }],
    contextGraphExists: async (contextGraphId: string) => (
      contextGraphId === options.contextGraphId
    ),
    assertion: {
      history: async () => null,
      create: async (_contextGraphId: string, name: string) => `urn:assertion:${name}`,
      write: async (
        _contextGraphId: string,
        name: string,
        quads: readonly CertificationQuad[],
      ) => {
        state.writtenByName.set(name, structuredClone(quads));
      },
      finalize: async () => ({
        merkleRoot: new Uint8Array(32),
        authorAddress: options.nodeAddress,
      }),
      promote: async (_contextGraphId: string, name: string) => {
        const quads = state.writtenByName.get(name) ?? [];
        for (const quad of quads) state.sharedSubjects.add(quad.subject);
        synchronization?.publish(quads);
        return { promotedCount: 1, sealed: true, publishReady: true };
      },
    },
    query: async (sparql: string) => {
      const subject = sparql.match(/<([^>]+)>/u)?.[1];
      const value = sparql === options.catalogSwmAsk
        || sparql.includes('urn:known:vm-subject')
        || (subject !== undefined && state.sharedSubjects.has(subject));
      return { bindings: [{ result: String(value) }] };
    },
  };
}

function jsonNodeResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
