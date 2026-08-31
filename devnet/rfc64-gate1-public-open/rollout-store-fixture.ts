import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  createTripleStore,
  quadsToNQuads,
  readExactGraphPaged,
  type BlazegraphNamespaceLease,
  type Quad,
  type TripleStoreConfig,
} from '@origintrail-official/dkg-storage';
import {
  parseRolloutStoreBackend,
  buildGate1RolloutStoreConfig,
  ROLLOUT_BLAZEGRAPH_URL_ENV,
  ROLLOUT_STORE_BACKEND_ENV,
  ROLLOUT_STORE_SENTINEL_GRAPH_ENV,
  type RolloutStoreBackend,
} from './rollout-store-config.js';

export { parseRolloutStoreBackend, type RolloutStoreBackend } from './rollout-store-config.js';
export type RolloutStoreRole = 'author' | 'receiver';

export interface RolloutStoreFixture {
  readonly backend: RolloutStoreBackend;
  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>>;
  assertGraphExact(
    role: RolloutStoreRole,
    dataDir: string,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface RolloutStoreFixtureOptions {
  readonly backendInput?: string;
  readonly blazegraphTestUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly storeDataDirs?: Readonly<Record<RolloutStoreRole, readonly string[]>>;
}

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_STORE_DATA_DIRS = Object.freeze({
  author: Object.freeze(['author']),
  receiver: Object.freeze(['receiver']),
});
export async function createRolloutStoreFixture(
  options: RolloutStoreFixtureOptions = {},
): Promise<RolloutStoreFixture> {
  const backend = parseRolloutStoreBackend(options.backendInput);
  const storeDataDirs = normalizeStoreDataDirs(options.storeDataDirs);
  if (backend === 'oxigraph') return OxigraphRolloutStoreFixture.create(storeDataDirs);
  const configuredUrl = options.blazegraphTestUrl;
  if (configuredUrl === undefined || configuredUrl.length === 0) {
    throw new Error('Blazegraph rollout certification requires BLAZEGRAPH_TEST_URL');
  }
  return BlazegraphRolloutStoreFixture.create({
    configuredUrl,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_MANAGEMENT_TIMEOUT_MS,
    signal: options.signal,
    storeDataDirs,
  });
}

export async function cleanupRolloutStoreFixture(
  fixture: RolloutStoreFixture | undefined,
  temporaryRoots: string[],
): Promise<void> {
  const roots = temporaryRoots.splice(0);
  const outcomes = await Promise.allSettled([
    fixture?.dispose() ?? Promise.resolve(),
    Promise.all(roots.map((path) => rm(path, { force: true, recursive: true }))),
  ]);
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'rollout store fixture cleanup failed');
  }
}

class OxigraphRolloutStoreFixture implements RolloutStoreFixture {
  readonly backend = 'oxigraph' as const;

  private constructor(
    private readonly sentinelByStore: ReadonlyMap<string, string>,
  ) {}

  static async create(
    storeDataDirs: Readonly<Record<RolloutStoreRole, readonly string[]>>,
  ): Promise<OxigraphRolloutStoreFixture> {
    const sentinelByStore = new Map<string, string>();
    const nonce = fixtureNonce();
    for (const role of ['author', 'receiver'] as const) {
      for (const [index, dataDir] of storeDataDirs[role].entries()) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const graph = sentinelGraph(nonce, role, index);
        await seedStoreSentinel(
          buildGate1RolloutStoreConfig({
            backendInput: 'oxigraph',
            blazegraphUrl: undefined,
            dataDir,
          }).tripleStore,
          graph,
        );
        sentinelByStore.set(roleDataDirKey(role, dataDir), graph);
      }
    }
    return new OxigraphRolloutStoreFixture(sentinelByStore);
  }

  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>> {
    const sentinelGraph = this.sentinelByStore.get(roleDataDirKey(role, dataDir));
    if (sentinelGraph === undefined) {
      throw new Error(`Oxigraph rollout fixture has no registered ${role} store for ${dataDir}`);
    }
    return Object.freeze({
      [ROLLOUT_STORE_BACKEND_ENV]: this.backend,
      [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: sentinelGraph,
    });
  }

  async assertGraphExact(
    role: RolloutStoreRole,
    dataDir: string,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void> {
    const persisted = await readFile(join(dataDir, 'store.nq'), 'utf8');
    const graphTerm = `<${assertSafeIri(graphUri)}>`;
    const actualLines = persisted.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith(` ${graphTerm} .`))
      .sort();
    const expectedLines = quadsToNQuads(expectedQuads.map((quad) => ({
      ...quad,
      graph: graphUri,
    }))).split('\n').map((line) => line.trim()).filter(Boolean).sort();
    if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
      throw new Error(
        `Oxigraph ${role} graph ${graphUri} differs from the exact persisted projection`,
      );
    }
  }

  async dispose(): Promise<void> {}
}

class BlazegraphRolloutStoreFixture implements RolloutStoreFixture {
  readonly backend = 'blazegraph' as const;

  private constructor(
    private readonly endpointByStore: ReadonlyMap<string, string>,
    private readonly sentinelByStore: ReadonlyMap<string, string>,
    private readonly namespaceManager: BlazegraphNamespaceManager,
    private readonly namespaceLeases: readonly BlazegraphNamespaceLease[],
    private readonly requestTimeoutMs: number,
  ) {}

  static async create(input: Readonly<{
    configuredUrl: string;
    fetchImpl: typeof fetch;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    storeDataDirs: Readonly<Record<RolloutStoreRole, readonly string[]>>;
  }>): Promise<BlazegraphRolloutStoreFixture> {
    const nonce = fixtureNonce();
    const namespaceManager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(input.configuredUrl),
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    const plan: Array<Readonly<{
      key: string;
      namespace: string;
      role: RolloutStoreRole;
      roleIndex: number;
    }>> = [];
    for (const role of ['author', 'receiver'] as const) {
      for (const [index, dataDir] of input.storeDataDirs[role].entries()) {
        plan.push(Object.freeze({
          key: roleDataDirKey(role, dataDir),
          namespace: `rfc64-rollout-${nonce}-${role}-${index}`,
          role,
          roleIndex: index,
        }));
      }
    }
    const leases = await namespaceManager.acquireMany(
      plan.map((entry) => entry.namespace),
      input.signal,
    );
    const endpointByStore = new Map<string, string>();
    const sentinelByStore = new Map<string, string>();
    for (const [index, entry] of plan.entries()) {
      const endpoint = leases[index]?.sparqlUrl;
      if (endpoint === undefined) throw new Error(`missing namespace lease for ${entry.key}`);
      endpointByStore.set(entry.key, endpoint);
      const graph = sentinelGraph(nonce, entry.role, entry.roleIndex);
      sentinelByStore.set(entry.key, graph);
    }
    try {
      await Promise.all([...endpointByStore.entries()].map(async ([key, endpoint]) => {
        const graph = sentinelByStore.get(key);
        if (graph === undefined) throw new Error(`missing store sentinel for ${key}`);
        await seedBlazegraphStoreSentinel(
          endpoint,
          graph,
          input.fetchImpl,
          input.requestTimeoutMs,
          input.signal,
        );
      }));
    } catch (cause) {
      try {
        await namespaceManager.disposeAll(leases, { reconcileAttempts: 3 });
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          'Blazegraph rollout store sentinel setup and cleanup failed',
        );
      }
      throw cause;
    }
    return new BlazegraphRolloutStoreFixture(
      endpointByStore,
      sentinelByStore,
      namespaceManager,
      leases,
      input.requestTimeoutMs,
    );
  }

  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>> {
    const endpoint = this.endpointByStore.get(roleDataDirKey(role, dataDir));
    const sentinelGraph = this.sentinelByStore.get(roleDataDirKey(role, dataDir));
    if (endpoint === undefined || sentinelGraph === undefined) {
      throw new Error(`Blazegraph rollout fixture has no registered ${role} store for ${dataDir}`);
    }
    return Object.freeze({
      [ROLLOUT_STORE_BACKEND_ENV]: this.backend,
      [ROLLOUT_BLAZEGRAPH_URL_ENV]: endpoint,
      [ROLLOUT_STORE_SENTINEL_GRAPH_ENV]: sentinelGraph,
    });
  }

  async assertGraphExact(
    role: RolloutStoreRole,
    dataDir: string,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void> {
    await assertPathMissing(
      join(dataDir, 'store.nq'),
      `Blazegraph ${role} unexpectedly created an Oxigraph fallback store`,
    );
    const endpoint = this.endpointByStore.get(roleDataDirKey(role, dataDir));
    if (endpoint === undefined) {
      throw new Error(`Blazegraph ${role} endpoint is not registered`);
    }
    const observer = await createTripleStore({
      backend: 'blazegraph',
      options: { url: endpoint, timeout: this.requestTimeoutMs },
    });
    try {
      const actual = await readExactGraphPaged(observer, graphUri, {
        expectedQuadCount: expectedQuads.length,
        maxQuadCount: expectedQuads.length,
        outputGraph: graphUri,
      });
      const actualLines = quadsToNQuads(actual).split('\n').filter(Boolean).sort();
      const expectedLines = quadsToNQuads(expectedQuads.map((quad) => ({
        ...quad,
        graph: assertSafeIri(graphUri),
      }))).split('\n').filter(Boolean).sort();
      if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
        throw new Error(
          `Blazegraph ${role} graph ${graphUri} differs from the exact persisted projection`,
        );
      }
    } finally {
      await observer.close();
    }
  }

  async dispose(): Promise<void> {
    await this.namespaceManager.disposeAll(this.namespaceLeases);
  }
}

function fixtureNonce(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sentinelGraph(nonce: string, role: RolloutStoreRole, index: number): string {
  return `urn:dkg:rfc64:rollout-store-sentinel:${nonce}:${role}:${index}`;
}

async function seedStoreSentinel(
  config: TripleStoreConfig,
  graph: string,
): Promise<void> {
  const store = await createTripleStore(config);
  try {
    await store.insert([{
      subject: `${graph}:subject`,
      predicate: 'urn:dkg:rfc64:rollout-store-sentinel:ready',
      object: '"true"',
      graph,
    }]);
  } finally {
    await store.close();
  }
}

async function seedBlazegraphStoreSentinel(
  endpoint: string,
  graph: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal === undefined
    ? timeout
    : AbortSignal.any([callerSignal, timeout]);
  const body = quadsToNQuads([{
    subject: `${graph}:subject`,
    predicate: 'urn:dkg:rfc64:rollout-store-sentinel:ready',
    object: '"true"',
    graph,
  }]);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/x-nquads' },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`failed to seed Blazegraph rollout store sentinel: HTTP ${response.status}`);
  }
}

function normalizeStoreDataDirs(
  input: Readonly<Record<RolloutStoreRole, readonly string[]>> | undefined,
): Readonly<Record<RolloutStoreRole, readonly string[]>> {
  const normalized = {
    author: [...(input?.author ?? DEFAULT_STORE_DATA_DIRS.author)],
    receiver: [...(input?.receiver ?? DEFAULT_STORE_DATA_DIRS.receiver)],
  };
  for (const [role, dataDirs] of Object.entries(normalized)) {
    if (dataDirs.length < 1 || new Set(dataDirs).size !== dataDirs.length) {
      throw new Error(`Blazegraph rollout ${role} data directories must be non-empty and unique`);
    }
    if (dataDirs.some((dataDir) => dataDir.length === 0)) {
      throw new Error(`Blazegraph rollout ${role} data directory must be non-empty`);
    }
  }
  return Object.freeze({
    author: Object.freeze(normalized.author),
    receiver: Object.freeze(normalized.receiver),
  });
}

function roleDataDirKey(role: RolloutStoreRole, dataDir: string): string {
  return `${role}\u0000${dataDir}`;
}

async function assertPathMissing(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
