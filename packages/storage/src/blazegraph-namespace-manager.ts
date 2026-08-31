import { setTimeout as delay } from 'node:timers/promises';

import blazegraphNamespaceContract from '../blazegraph-namespace-contract.cjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const canonicalNamespaceCodec: BlazegraphNamespaceCodec = Object.freeze({
  assertNamespace: blazegraphNamespaceContract.assertBlazegraphNamespace,
  renderNamespaceXml: blazegraphNamespaceContract.renderBlazegraphNamespaceXml,
});

export interface BlazegraphNamespaceManagerOptions {
  readonly namespaceApiUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Test seam only; production callers use the canonical storage-owned contract. */
  readonly namespaceCodec?: BlazegraphNamespaceCodec;
  readonly requestTimeoutMs?: number;
}

/** One contract owns both path safety and the XML representation. */
export interface BlazegraphNamespaceCodec {
  assertNamespace(namespace: string): void;
  renderNamespaceXml(namespace: string): string;
}

export interface BlazegraphNamespaceEnsureResult {
  readonly created: boolean;
  readonly sparqlUrl: string;
}

export interface BlazegraphNamespaceDisposeOptions {
  readonly reconcileAttempts?: number;
}

/**
 * One explicitly owned Blazegraph namespace. A lease is registered before its
 * create request is sent, so an indeterminate POST can always be reconciled by
 * DELETE even when the response was lost after Blazegraph committed it.
 */
export class BlazegraphNamespaceLease {
  readonly namespaceUrl: string;
  readonly sparqlUrl: string;

  constructor(
    readonly namespace: string,
    private readonly manager: BlazegraphNamespaceManager,
  ) {
    this.namespaceUrl = manager.namespaceUrl(namespace);
    this.sparqlUrl = `${this.namespaceUrl}/sparql`;
  }

  dispose(options: BlazegraphNamespaceDisposeOptions = {}): Promise<void> {
    return this.manager.deleteNamespace(
      this.namespaceUrl,
      options.reconcileAttempts ?? 1,
    );
  }
}

/**
 * Canonical bounded lifecycle for Blazegraph namespaces.
 *
 * Production provisioning uses `ensure`, while isolated tests use leases and
 * dispose them. Batch acquisition and disposal operate concurrently and report
 * every failure, so total cleanup latency is bounded by one namespace budget
 * rather than the number of namespaces.
 */
export class BlazegraphNamespaceManager {
  readonly namespaceApiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #namespaceCodec: BlazegraphNamespaceCodec;
  readonly #requestTimeoutMs: number;

  constructor(options: BlazegraphNamespaceManagerOptions) {
    if (!Number.isInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      || (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) <= 0) {
      throw new Error('Blazegraph namespace request timeout must be a positive integer');
    }
    this.namespaceApiUrl = normalizeBlazegraphNamespaceApiUrl(options.namespaceApiUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#namespaceCodec = options.namespaceCodec ?? canonicalNamespaceCodec;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  namespaceUrl(namespace: string): string {
    this.#namespaceCodec.assertNamespace(namespace);
    return `${this.namespaceApiUrl}/${encodeURIComponent(namespace)}`;
  }

  sparqlUrl(namespace: string): string {
    return `${this.namespaceUrl(namespace)}/sparql`;
  }

  async ensure(namespace: string, signal?: AbortSignal): Promise<BlazegraphNamespaceEnsureResult> {
    const namespaceUrl = this.namespaceUrl(namespace);
    const properties = await this.#boundedFetch(
      `${namespaceUrl}/sparql/properties`,
      { method: 'GET' },
      this.#requestTimeoutMs,
      signal,
    );
    if (properties.ok) {
      return Object.freeze({ created: false, sparqlUrl: `${namespaceUrl}/sparql` });
    }
    if (properties.status !== 404) {
      throw new Error(
        `Could not inspect Blazegraph namespace "${namespace}" — HTTP ${properties.status}`,
      );
    }
    await this.#create(namespace, signal);
    return Object.freeze({ created: true, sparqlUrl: `${namespaceUrl}/sparql` });
  }

  async acquireMany(
    namespaces: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly BlazegraphNamespaceLease[]> {
    if (namespaces.length === 0 || new Set(namespaces).size !== namespaces.length) {
      throw new Error('Blazegraph namespace lease plan must be non-empty and unique');
    }
    const leases = namespaces.map((namespace) => new BlazegraphNamespaceLease(namespace, this));
    const outcomes = await Promise.allSettled(
      leases.map(async (lease) => {
        await this.#create(lease.namespace, signal);
        return lease;
      }),
    );
    const createFailures = rejectedReasons(outcomes);
    if (createFailures.length === 0) return Object.freeze(leases);

    const cleanupOutcomes = await Promise.allSettled(
      leases.map((lease) => lease.dispose({ reconcileAttempts: 3 })),
    );
    const cleanupFailures = rejectedReasons(cleanupOutcomes);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [...createFailures, ...cleanupFailures],
        'Blazegraph namespace setup failed and cleanup could not be proven',
      );
    }
    throw new AggregateError(createFailures, 'Blazegraph namespace setup failed');
  }

  async disposeAll(
    leases: readonly BlazegraphNamespaceLease[],
    options: BlazegraphNamespaceDisposeOptions = {},
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      leases.map((lease) => lease.dispose(options)),
    );
    const failures = rejectedReasons(outcomes);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Blazegraph namespace cleanup failed');
    }
  }

  async deleteNamespace(namespaceUrl: string, reconcileAttempts: number): Promise<void> {
    const attempts = normalizeReconcileAttempts(reconcileAttempts, this.#requestTimeoutMs);
    const retryDelayMs = attempts === 1
      ? 0
      : Math.max(1, Math.min(100, Math.floor(this.#requestTimeoutMs / (attempts * 4))));
    const perAttemptTimeoutMs = Math.max(
      1,
      Math.floor((this.#requestTimeoutMs - retryDelayMs * (attempts - 1)) / attempts),
    );
    let failure: unknown = new Error(`Blazegraph namespace cleanup did not run for ${namespaceUrl}`);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.#boundedFetch(
          namespaceUrl,
          { method: 'DELETE' },
          perAttemptTimeoutMs,
        );
        if (response.ok || response.status === 404) return;
        failure = new Error(`${namespaceUrl}: HTTP ${response.status}`);
      } catch (error) {
        failure = error;
      }
      if (attempt + 1 < attempts) await delay(retryDelayMs);
    }
    throw failure instanceof Error
      ? failure
      : new Error(`${namespaceUrl}: ${String(failure)}`);
  }

  async #create(namespace: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#boundedFetch(this.namespaceApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: this.#namespaceCodec.renderNamespaceXml(namespace),
    }, this.#requestTimeoutMs, signal);
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch { /* best effort */ }
      throw new Error(
        `Failed to create Blazegraph namespace "${namespace}" — HTTP ${response.status}`
          + (detail.length === 0 ? '' : `: ${detail}`),
      );
    }
  }

  async #boundedFetch(
    input: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal === undefined
      ? timeout
      : AbortSignal.any([callerSignal, timeout]);
    return this.#fetch(input, { ...init, signal });
  }
}

export const BLAZEGRAPH_NAMESPACE_XML_TEMPLATE =
  blazegraphNamespaceContract.BLAZEGRAPH_NAMESPACE_XML_TEMPLATE;
export const assertBlazegraphNamespace =
  blazegraphNamespaceContract.assertBlazegraphNamespace;
export const normalizeBlazegraphNamespace =
  blazegraphNamespaceContract.normalizeBlazegraphNamespace;
export const renderBlazegraphNamespaceXml =
  blazegraphNamespaceContract.renderBlazegraphNamespaceXml;

export function normalizeBlazegraphNamespaceApiUrl(namespaceApiUrl: string): string {
  const parsed = parseHttpUrl(namespaceApiUrl, 'Blazegraph namespace API URL');
  const path = parsed.pathname.replace(/\/$/u, '');
  if (!path.endsWith('/bigdata/namespace')) {
    throw new Error('Blazegraph namespace API URL must end with /bigdata/namespace');
  }
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/u, '');
}

/** Convert only the exact per-namespace SPARQL endpoint shape used by operators. */
export function blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint: string): string {
  const parsed = parseHttpUrl(endpoint, 'Blazegraph SPARQL endpoint');
  const path = parsed.pathname.replace(/\/$/u, '');
  const match = /^(.*\/bigdata\/namespace)\/([^/]+)\/sparql$/u.exec(path);
  const apiPath = match?.[1];
  const namespace = match?.[2];
  if (apiPath === undefined || namespace === undefined || namespace.length === 0) {
    throw new Error(
      'Blazegraph SPARQL endpoint must end with /bigdata/namespace/<namespace>/sparql',
    );
  }
  parsed.pathname = apiPath;
  return parsed.toString().replace(/\/$/u, '');
}

/** Convert the CLI provisioner's exact origin-style service URL. */
export function blazegraphNamespaceApiUrlFromBaseUrl(baseUrl: string): string {
  const parsed = parseHttpUrl(baseUrl, 'Blazegraph base URL');
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Blazegraph base URL must not contain a path');
  }
  parsed.pathname = '/bigdata/namespace';
  return parsed.toString().replace(/\/$/u, '');
}

function parseHttpUrl(input: string, label: string): URL {
  const parsed = new URL(input);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return parsed;
}

function normalizeReconcileAttempts(input: number, timeoutMs: number): number {
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('Blazegraph namespace reconcile attempts must be a positive integer');
  }
  return Math.min(input, timeoutMs);
}

function rejectedReasons(outcomes: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
}
