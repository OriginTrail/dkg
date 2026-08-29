import { access, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';

export type RolloutStoreBackend = 'oxigraph' | 'blazegraph';
export type RolloutStoreRole = 'author' | 'receiver';

export interface RolloutStoreFixture {
  readonly backend: RolloutStoreBackend;
  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>>;
  assertGraphExact(
    role: RolloutStoreRole,
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
  readonly storesPerRole?: Readonly<Partial<Record<RolloutStoreRole, number>>>;
}

interface BlazegraphRuntimeContract {
  renderBlazegraphNamespaceXml(namespace: string): string;
}

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_STORES_PER_ROLE = Object.freeze({ author: 1, receiver: 3 });
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
    storesPerRole: normalizeStoresPerRole(options.storesPerRole),
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

export function parseRolloutStoreBackend(input: string | undefined): RolloutStoreBackend {
  if (input === undefined || input === '' || input === 'oxigraph') return 'oxigraph';
  if (input === 'blazegraph') return input;
  throw new Error('DKG_RFC64_GATE1_STORE_BACKEND must be oxigraph or blazegraph');
}

class OxigraphRolloutStoreFixture implements RolloutStoreFixture {
  readonly backend = 'oxigraph' as const;
  private readonly dataDirs = new Map<RolloutStoreRole, string>();

  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>> {
    this.dataDirs.set(role, dataDir);
    return Object.freeze({ DKG_RFC64_GATE1_STORE_BACKEND: this.backend });
  }

  async assertGraphExact(
    role: RolloutStoreRole,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void> {
    const dataDir = this.dataDirs.get(role);
    if (dataDir === undefined) throw new Error(`Oxigraph ${role} data directory is not registered`);
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
  private readonly dataDirs = new Map<RolloutStoreRole, string>();
  private readonly endpointByStore = new Map<string, string>();
  private readonly assignedStoreCount = new Map<RolloutStoreRole, number>();

  private constructor(
    private readonly endpoints: Readonly<Record<RolloutStoreRole, readonly string[]>>,
    private readonly namespaceUrls: readonly string[],
    private readonly fetchImpl: typeof fetch,
    private readonly requestTimeoutMs: number,
    private readonly operationSignal?: AbortSignal,
  ) {}

  static async create(input: Readonly<{
    configuredUrl: string;
    fetchImpl: typeof fetch;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    storesPerRole: Readonly<Record<RolloutStoreRole, number>>;
  }>): Promise<BlazegraphRolloutStoreFixture> {
    const namespaceApiUrl = blazegraphNamespaceApiUrl(input.configuredUrl);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const createdNamespaceUrls: string[] = [];
    const endpoints: Record<RolloutStoreRole, string[]> = { author: [], receiver: [] };
    try {
      for (const role of ['author', 'receiver'] as const) {
        for (let index = 0; index < input.storesPerRole[role]; index += 1) {
          const namespace = `rfc64-rollout-${nonce}-${role}-${index}`;
          await createBlazegraphNamespace({
            namespaceApiUrl,
            namespace,
            fetchImpl: input.fetchImpl,
            requestTimeoutMs: input.requestTimeoutMs,
            signal: input.signal,
          });
          const namespaceUrl = `${namespaceApiUrl}/${encodeURIComponent(namespace)}`;
          createdNamespaceUrls.push(namespaceUrl);
          endpoints[role].push(`${namespaceUrl}/sparql`);
        }
      }
    } catch (error) {
      await cleanupBlazegraphNamespaces(
        createdNamespaceUrls,
        input.fetchImpl,
        input.requestTimeoutMs,
      ).catch(() => undefined);
      throw error;
    }
    return new BlazegraphRolloutStoreFixture(
      Object.freeze({
        author: Object.freeze(endpoints.author),
        receiver: Object.freeze(endpoints.receiver),
      }),
      Object.freeze(createdNamespaceUrls),
      input.fetchImpl,
      input.requestTimeoutMs,
      input.signal,
    );
  }

  envForRole(role: RolloutStoreRole, dataDir: string): Readonly<Record<string, string>> {
    this.dataDirs.set(role, dataDir);
    const storeKey = roleDataDirKey(role, dataDir);
    let endpoint = this.endpointByStore.get(storeKey);
    if (endpoint === undefined) {
      const assignedCount = this.assignedStoreCount.get(role) ?? 0;
      endpoint = this.endpoints[role][assignedCount];
      if (endpoint === undefined) {
        throw new Error(
          `Blazegraph rollout fixture exhausted its ${role} store pool at ${assignedCount}`,
        );
      }
      this.endpointByStore.set(storeKey, endpoint);
      this.assignedStoreCount.set(role, assignedCount + 1);
    }
    return Object.freeze({
      DKG_RFC64_GATE1_STORE_BACKEND: this.backend,
      DKG_RFC64_GATE1_BLAZEGRAPH_URL: endpoint,
    });
  }

  async assertGraphExact(
    role: RolloutStoreRole,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void> {
    const dataDir = this.dataDirs.get(role);
    if (dataDir === undefined) throw new Error(`Blazegraph ${role} data directory is not registered`);
    await assertPathMissing(
      join(dataDir, 'store.nq'),
      `Blazegraph ${role} unexpectedly created an Oxigraph fallback store`,
    );
    const endpoint = this.endpointByStore.get(roleDataDirKey(role, dataDir));
    if (endpoint === undefined) {
      throw new Error(`Blazegraph ${role} endpoint is not registered`);
    }
    const graph = sparqlIri(graphUri, 'graph URI');
    const count = await this.queryJson(endpoint,
      `SELECT (COUNT(*) AS ?count) WHERE { GRAPH ${graph} { ?s ?p ?o } }`);
    const countValue = readSparqlCount(count);
    if (countValue !== expectedQuads.length) {
      throw new Error(
        `Blazegraph ${role} graph ${graphUri} has ${countValue} quads, expected ${expectedQuads.length}`,
      );
    }
    for (const quad of expectedQuads) {
      const ask = await this.queryJson(
        endpoint,
        `ASK WHERE { GRAPH ${graph} { ${sparqlIri(quad.subject, 'subject')} `
          + `${sparqlIri(quad.predicate, 'predicate')} ${sparqlObject(quad.object)} } }`,
      );
      if (ask.boolean !== true) {
        throw new Error(`Blazegraph ${role} graph ${graphUri} lacks an expected projection quad`);
      }
    }
  }

  async dispose(): Promise<void> {
    await cleanupBlazegraphNamespaces(
      this.namespaceUrls,
      this.fetchImpl,
      this.requestTimeoutMs,
    );
  }

  private async queryJson(endpoint: string, query: string): Promise<Record<string, unknown>> {
    const response = await boundedFetch(this.fetchImpl, endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/sparql-results+json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }),
    }, this.requestTimeoutMs, this.operationSignal);
    if (!response.ok) {
      throw new Error(`Blazegraph direct observation failed: HTTP ${response.status}`);
    }
    return await response.json() as Record<string, unknown>;
  }
}

function normalizeStoresPerRole(
  input: Readonly<Partial<Record<RolloutStoreRole, number>>> | undefined,
): Readonly<Record<RolloutStoreRole, number>> {
  const normalized = {
    author: input?.author ?? DEFAULT_STORES_PER_ROLE.author,
    receiver: input?.receiver ?? DEFAULT_STORES_PER_ROLE.receiver,
  };
  for (const [role, count] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Blazegraph rollout ${role} store count must be a positive safe integer`);
    }
  }
  return Object.freeze(normalized);
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
): Promise<void> {
  const failures: string[] = [];
  for (const url of namespaceUrls) {
    try {
      const response = await boundedFetch(
        fetchImpl,
        url,
        { method: 'DELETE' },
        requestTimeoutMs,
      );
      if (!response.ok && response.status !== 404) failures.push(`${url}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
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

function readSparqlCount(value: Record<string, unknown>): number {
  const results = plainRecord(value.results, 'SPARQL results');
  const bindings = results.bindings;
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error('SPARQL count response must contain exactly one binding');
  }
  const row = plainRecord(bindings[0], 'SPARQL count row');
  const count = plainRecord(row.count, 'SPARQL count binding');
  if (typeof count.value !== 'string' || !/^\d+$/u.test(count.value)) {
    throw new Error('SPARQL count binding must be a non-negative integer');
  }
  return Number(count.value);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  return value as Record<string, unknown>;
}

function sparqlIri(value: string, label: string): string {
  return `<${assertSafeIri(value, label)}>`;
}

function assertSafeIri(value: string, label: string): string {
  const hasControlOrSpace = [...value].some((character) => character.codePointAt(0)! <= 0x20);
  if (hasControlOrSpace || /[<>"{}|\\^`]/u.test(value)) {
    throw new Error(`${label} cannot be represented safely in the fixture SPARQL query`);
  }
  return value;
}

function sparqlObject(value: string): string {
  if (value.startsWith('"')) {
    if (/[\r\n]/u.test(value)) throw new Error('literal object cannot contain a raw line break');
    return value;
  }
  return sparqlIri(value, 'object');
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
