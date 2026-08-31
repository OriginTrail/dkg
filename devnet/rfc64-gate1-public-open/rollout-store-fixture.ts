import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  createTripleStore,
  quadsToNQuads,
  readExactGraphPaged,
  type Quad,
  type TripleStore,
  type TripleStoreConfig,
} from '@origintrail-official/dkg-storage';
import {
  createBlazegraphRolloutStoreBinding,
  createOxigraphRolloutStoreBinding,
  parseRolloutStoreBackend,
  rolloutStoreBackendForBinding,
  type RolloutStoreBinding,
} from './rollout-store-config.js';

export { parseRolloutStoreBackend, type RolloutStoreBackend } from './rollout-store-config.js';
export type RolloutStoreRole = 'author' | 'receiver';
export type RolloutStoreFactory = (config: TripleStoreConfig) => Promise<TripleStore>;

export interface RolloutStoreFixture {
  bindingForRole(role: RolloutStoreRole, dataDir: string): RolloutStoreBinding;
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
  /** Test seam for mocked remote stores. Normal callers use createTripleStore. */
  readonly storeFactory?: RolloutStoreFactory;
}

type RolloutStoreSlot = Readonly<{
  dataDir: string;
  key: string;
  namespace: string;
  role: RolloutStoreRole;
  roleIndex: number;
  sentinelGraph: string;
}>;

type ProvisionedRolloutStores = Readonly<{
  bindingByStore: ReadonlyMap<string, RolloutStoreBinding>;
  dispose: () => Promise<void>;
}>;

const DEFAULT_MANAGEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_STORE_DATA_DIRS = Object.freeze({
  author: Object.freeze(['author']),
  receiver: Object.freeze(['receiver']),
});

export async function createRolloutStoreFixture(
  options: RolloutStoreFixtureOptions = {},
): Promise<RolloutStoreFixture> {
  const backend = parseRolloutStoreBackend(options.backendInput);
  const slots = createRolloutStoreSlots(normalizeStoreDataDirs(options.storeDataDirs));
  const storeFactory = options.storeFactory ?? createTripleStore;
  const provisioned = backend === 'oxigraph'
    ? await provisionOxigraphRolloutStores(slots)
    : await provisionBlazegraphRolloutStores({
      configuredUrl: requiredBlazegraphUrl(options.blazegraphTestUrl),
      fetchImpl: options.fetchImpl ?? fetch,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_MANAGEMENT_TIMEOUT_MS,
      signal: options.signal,
      slots,
    });

  try {
    await Promise.all([...provisioned.bindingByStore.values()].map(
      (binding) => seedStoreSentinel(binding, storeFactory),
    ));
  } catch (cause) {
    try {
      await provisioned.dispose();
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        `${backend} rollout store sentinel setup and cleanup failed`,
      );
    }
    throw cause;
  }

  return new CanonicalRolloutStoreFixture(
    provisioned.bindingByStore,
    storeFactory,
    provisioned.dispose,
  );
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

class CanonicalRolloutStoreFixture implements RolloutStoreFixture {
  constructor(
    private readonly bindingByStore: ReadonlyMap<string, RolloutStoreBinding>,
    private readonly storeFactory: RolloutStoreFactory,
    private readonly disposeProvisionedStores: () => Promise<void>,
  ) {}

  bindingForRole(role: RolloutStoreRole, dataDir: string): RolloutStoreBinding {
    const binding = this.bindingByStore.get(roleDataDirKey(role, dataDir));
    if (binding === undefined) {
      throw new Error(`rollout fixture has no registered ${role} store for ${dataDir}`);
    }
    return binding;
  }

  async assertGraphExact(
    role: RolloutStoreRole,
    dataDir: string,
    graphUri: string,
    expectedQuads: readonly Quad[],
  ): Promise<void> {
    const binding = this.bindingForRole(role, dataDir);
    const backend = rolloutStoreBackendForBinding(binding);
    if (backend === 'blazegraph') {
      await assertPathMissing(
        join(dataDir, 'store.nq'),
        `Blazegraph ${role} unexpectedly created an Oxigraph fallback store`,
      );
    }
    const observer = await this.storeFactory(binding.tripleStore);
    try {
      const safeGraphUri = assertSafeIri(graphUri);
      const actual = await readExactGraphPaged(observer, safeGraphUri, {
        expectedQuadCount: expectedQuads.length,
        maxQuadCount: expectedQuads.length,
        outputGraph: safeGraphUri,
      });
      const actualLines = canonicalQuadLines(actual);
      const expectedLines = canonicalQuadLines(expectedQuads.map((quad) => ({
        ...quad,
        graph: safeGraphUri,
      })));
      if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
        throw new Error(
          `${backend} ${role} graph ${safeGraphUri} differs from the exact persisted projection`,
        );
      }
    } finally {
      await observer.close();
    }
  }

  async dispose(): Promise<void> {
    await this.disposeProvisionedStores();
  }
}

async function provisionOxigraphRolloutStores(
  slots: readonly RolloutStoreSlot[],
): Promise<ProvisionedRolloutStores> {
  const bindingByStore = new Map<string, RolloutStoreBinding>();
  for (const slot of slots) {
    await mkdir(slot.dataDir, { recursive: true, mode: 0o700 });
    bindingByStore.set(slot.key, createOxigraphRolloutStoreBinding({
      dataDir: slot.dataDir,
      sentinelGraph: slot.sentinelGraph,
    }));
  }
  return Object.freeze({
    bindingByStore,
    dispose: async () => undefined,
  });
}

async function provisionBlazegraphRolloutStores(input: Readonly<{
  configuredUrl: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  slots: readonly RolloutStoreSlot[];
}>): Promise<ProvisionedRolloutStores> {
  const namespaceManager = new BlazegraphNamespaceManager({
    namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(input.configuredUrl),
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  const handles = await namespaceManager.acquireMany(
    input.slots.map((slot) => slot.namespace),
    input.signal,
  );
  const dispose = async (): Promise<void> => namespaceManager.disposeAll(handles);
  try {
    const bindingByStore = new Map<string, RolloutStoreBinding>();
    for (const [index, slot] of input.slots.entries()) {
      const endpoint = handles[index]?.sparqlUrl;
      if (endpoint === undefined) throw new Error(`missing namespace handle for ${slot.key}`);
      bindingByStore.set(slot.key, createBlazegraphRolloutStoreBinding({
        endpoint,
        sentinelGraph: slot.sentinelGraph,
      }));
    }
    return Object.freeze({ bindingByStore, dispose });
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        'Blazegraph rollout store provisioning and cleanup failed',
      );
    }
    throw cause;
  }
}

function createRolloutStoreSlots(
  storeDataDirs: Readonly<Record<RolloutStoreRole, readonly string[]>>,
): readonly RolloutStoreSlot[] {
  const nonce = fixtureNonce();
  const slots: RolloutStoreSlot[] = [];
  for (const role of ['author', 'receiver'] as const) {
    for (const [roleIndex, dataDir] of storeDataDirs[role].entries()) {
      slots.push(Object.freeze({
        dataDir,
        key: roleDataDirKey(role, dataDir),
        namespace: `rfc64-rollout-${nonce}-${role}-${roleIndex}`,
        role,
        roleIndex,
        sentinelGraph: sentinelGraph(nonce, role, roleIndex),
      }));
    }
  }
  return Object.freeze(slots);
}

function fixtureNonce(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sentinelGraph(nonce: string, role: RolloutStoreRole, index: number): string {
  return `urn:dkg:rfc64:rollout-store-sentinel:${nonce}:${role}:${index}`;
}

async function seedStoreSentinel(
  binding: RolloutStoreBinding,
  storeFactory: RolloutStoreFactory,
): Promise<void> {
  const store = await storeFactory(binding.tripleStore);
  try {
    const graph = binding.sentinelGraph;
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

function canonicalQuadLines(quads: readonly Quad[]): string[] {
  return quadsToNQuads(quads).split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

function requiredBlazegraphUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error('Blazegraph rollout certification requires BLAZEGRAPH_TEST_URL');
  }
  return value;
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
      throw new Error(`rollout ${role} data directories must be non-empty and unique`);
    }
    if (dataDirs.some((dataDir) => dataDir.length === 0)) {
      throw new Error(`rollout ${role} data directory must be non-empty`);
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
