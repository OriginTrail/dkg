import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  BlazegraphNamespaceManager,
  createTripleStore,
  quadsToNQuads,
  readExactGraphPaged,
  type BlazegraphNamespaceLease,
  type Quad,
} from '@origintrail-official/dkg-storage';
import blazegraphRuntimeContract from
  '@origintrail-official/dkg/blazegraph-runtime-contract';

import {
  parseRolloutStoreBackend,
  ROLLOUT_BLAZEGRAPH_URL_ENV,
  ROLLOUT_STORE_BACKEND_ENV,
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
const { renderBlazegraphNamespaceXml } = blazegraphRuntimeContract;

export async function createRolloutStoreFixture(
  options: RolloutStoreFixtureOptions = {},
): Promise<RolloutStoreFixture> {
  const backend = parseRolloutStoreBackend(options.backendInput);
  if (backend === 'oxigraph') return new OxigraphRolloutStoreFixture();
  const configuredUrl = options.blazegraphTestUrl;
  if (configuredUrl === undefined || configuredUrl.length === 0) {
    throw new Error('Blazegraph rollout certification requires BLAZEGRAPH_TEST_URL');
  }
  return BlazegraphRolloutStoreFixture.create({
    configuredUrl,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_MANAGEMENT_TIMEOUT_MS,
    signal: options.signal,
    storeDataDirs: normalizeStoreDataDirs(options.storeDataDirs),
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

  envForRole(_role: RolloutStoreRole, _dataDir: string): Readonly<Record<string, string>> {
    return Object.freeze({ [ROLLOUT_STORE_BACKEND_ENV]: this.backend });
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
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const namespaceManager = new BlazegraphNamespaceManager({
      serviceUrl: input.configuredUrl,
      fetchImpl: input.fetchImpl,
      renderNamespaceXml: renderBlazegraphNamespaceXml,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    const plan: Array<Readonly<{ key: string; namespace: string }>> = [];
    for (const role of ['author', 'receiver'] as const) {
      for (const [index, dataDir] of input.storeDataDirs[role].entries()) {
        plan.push(Object.freeze({
          key: roleDataDirKey(role, dataDir),
          namespace: `rfc64-rollout-${nonce}-${role}-${index}`,
        }));
      }
    }
    const leases = await namespaceManager.acquireMany(
      plan.map((entry) => entry.namespace),
      input.signal,
    );
    const endpointByStore = new Map<string, string>();
    for (const [index, entry] of plan.entries()) {
      endpointByStore.set(entry.key, leases[index].sparqlUrl);
    }
    return new BlazegraphRolloutStoreFixture(
      endpointByStore,
      namespaceManager,
      leases,
      input.requestTimeoutMs,
    );
  }

  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>> {
    const endpoint = this.endpointByStore.get(roleDataDirKey(role, dataDir));
    if (endpoint === undefined) {
      throw new Error(`Blazegraph rollout fixture has no registered ${role} store for ${dataDir}`);
    }
    return Object.freeze({
      [ROLLOUT_STORE_BACKEND_ENV]: this.backend,
      [ROLLOUT_BLAZEGRAPH_URL_ENV]: endpoint,
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
