import { access, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createTripleStore,
  quadsToNQuads,
  readExactGraphPaged,
  type Quad,
} from '@origintrail-official/dkg-storage';

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

interface BlazegraphRuntimeContract {
  renderBlazegraphNamespaceXml(namespace: string): string;
}

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_STORE_DATA_DIRS = Object.freeze({
  author: Object.freeze(['author']),
  receiver: Object.freeze(['receiver']),
});
const require = createRequire(import.meta.url);
const { renderBlazegraphNamespaceXml } = require(
  '../../packages/cli/blazegraph-image-metadata.cjs',
) as BlazegraphRuntimeContract;

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
    const graphTerm = `<${assertSafeIri(graphUri, 'graph URI')}>`;
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
    private readonly namespaceUrls: readonly string[],
    private readonly fetchImpl: typeof fetch,
    private readonly requestTimeoutMs: number,
  ) {}

  static async create(input: Readonly<{
    configuredUrl: string;
    fetchImpl: typeof fetch;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    storeDataDirs: Readonly<Record<RolloutStoreRole, readonly string[]>>;
  }>): Promise<BlazegraphRolloutStoreFixture> {
    const namespaceApiUrl = blazegraphNamespaceApiUrl(input.configuredUrl);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const attemptedNamespaceUrls: string[] = [];
    const endpointByStore = new Map<string, string>();
    try {
      for (const role of ['author', 'receiver'] as const) {
        for (const [index, dataDir] of input.storeDataDirs[role].entries()) {
          const namespace = `rfc64-rollout-${nonce}-${role}-${index}`;
          const namespaceUrl = `${namespaceApiUrl}/${encodeURIComponent(namespace)}`;
          // A rejected POST is indeterminate: Blazegraph may have committed the
          // namespace before its response was lost. Register before issuing it.
          attemptedNamespaceUrls.push(namespaceUrl);
          endpointByStore.set(roleDataDirKey(role, dataDir), `${namespaceUrl}/sparql`);
          await createBlazegraphNamespace({
            namespaceApiUrl,
            namespace,
            fetchImpl: input.fetchImpl,
            requestTimeoutMs: input.requestTimeoutMs,
            signal: input.signal,
          });
        }
      }
    } catch (error) {
      try {
        await cleanupBlazegraphNamespaces(
          attemptedNamespaceUrls,
          input.fetchImpl,
          input.requestTimeoutMs,
          3,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Blazegraph namespace setup failed and cleanup could not be proven',
        );
      }
      throw error;
    }
    return new BlazegraphRolloutStoreFixture(
      endpointByStore,
      Object.freeze(attemptedNamespaceUrls),
      input.fetchImpl,
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
        graph: assertSafeIri(graphUri, 'graph URI'),
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
    await cleanupBlazegraphNamespaces(
      this.namespaceUrls,
      this.fetchImpl,
      this.requestTimeoutMs,
    );
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

function blazegraphNamespaceApiUrl(configuredUrl: string): string {
  const parsed = new URL(configuredUrl);
  const match = /^(.*)\/namespace\/[^/]+\/sparql\/?$/u.exec(parsed.pathname);
  if (match === null || match[1].length === 0) {
    throw new Error(
      'BLAZEGRAPH_TEST_URL must end with /namespace/<name>/sparql for isolated certification',
    );
  }
  parsed.pathname = `${match[1]}/namespace`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

async function createBlazegraphNamespace(input: Readonly<{
  namespaceApiUrl: string;
  namespace: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}>): Promise<void> {
  const response = await boundedFetch(input.fetchImpl, input.namespaceApiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: renderBlazegraphNamespaceXml(input.namespace),
  }, input.requestTimeoutMs, input.signal);
  if (!response.ok) {
    throw new Error(
      `could not create isolated Blazegraph namespace ${input.namespace}: HTTP ${response.status}`,
    );
  }
}

async function cleanupBlazegraphNamespaces(
  namespaceUrls: readonly string[],
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
  reconcileAttempts = 1,
): Promise<void> {
  const failures: string[] = [];
  const attempts = Math.max(1, Math.min(reconcileAttempts, requestTimeoutMs));
  const retryDelayMs = attempts === 1
    ? 0
    : Math.max(1, Math.min(100, Math.floor(requestTimeoutMs / (attempts * 4))));
  const perAttemptTimeoutMs = Math.max(
    1,
    Math.floor((requestTimeoutMs - retryDelayMs * (attempts - 1)) / attempts),
  );
  for (const url of namespaceUrls) {
    let failure: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await boundedFetch(
          fetchImpl,
          url,
          { method: 'DELETE' },
          perAttemptTimeoutMs,
        );
        failure = !response.ok && response.status !== 404
          ? `${url}: HTTP ${response.status}`
          : null;
      } catch (error) {
        failure = `${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (attempt + 1 < attempts) await delay(retryDelayMs);
    }
    if (failure !== null) failures.push(failure);
  }
  if (failures.length > 0) {
    throw new Error(`could not clean isolated Blazegraph namespaces: ${failures.join('; ')}`);
  }
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('rollout store fixture request timeout must be a positive integer');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal === undefined
    ? timeout
    : AbortSignal.any([callerSignal, timeout]);
  return fetchImpl(input, { ...init, signal });
}

function assertSafeIri(value: string, label: string): string {
  const hasControlOrSpace = [...value].some((character) => character.codePointAt(0)! <= 0x20);
  if (hasControlOrSpace || /[<>"{}|\\^`]/u.test(value)) {
    throw new Error(`${label} cannot be represented safely in the fixture SPARQL query`);
  }
  return value;
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
