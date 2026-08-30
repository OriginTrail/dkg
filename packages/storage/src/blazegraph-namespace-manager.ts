import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface BlazegraphNamespaceManagerOptions {
  readonly serviceUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly renderNamespaceXml: (namespace: string) => string;
  readonly requestTimeoutMs?: number;
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
  readonly #renderNamespaceXml: (namespace: string) => string;
  readonly #requestTimeoutMs: number;

  constructor(options: BlazegraphNamespaceManagerOptions) {
    if (!Number.isInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      || (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) <= 0) {
      throw new Error('Blazegraph namespace request timeout must be a positive integer');
    }
    this.namespaceApiUrl = deriveBlazegraphNamespaceApiUrl(options.serviceUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#renderNamespaceXml = options.renderNamespaceXml;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  namespaceUrl(namespace: string): string {
    assertNamespace(namespace);
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
      body: this.#renderNamespaceXml(namespace),
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

function deriveBlazegraphNamespaceApiUrl(serviceUrl: string): string {
  const parsed = new URL(serviceUrl);
  const path = parsed.pathname.replace(/\/$/u, '');
  const endpointMatch = /^(.*\/bigdata)\/namespace\/[^/]+\/sparql$/u.exec(path);
  if (endpointMatch !== null) {
    parsed.pathname = `${endpointMatch[1]}/namespace`;
  } else if (path.endsWith('/bigdata/namespace')) {
    parsed.pathname = path;
  } else if (path.endsWith('/bigdata')) {
    parsed.pathname = `${path}/namespace`;
  } else {
    parsed.pathname = `${path}/bigdata/namespace`.replace(/^\/+/u, '/');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

function assertNamespace(namespace: string): void {
  const hasControlOrSpace = [...namespace].some(
    (character) => character.codePointAt(0)! <= 0x20,
  );
  if (namespace.length === 0 || namespace.length > 255 || hasControlOrSpace || /[/\\]/u.test(namespace)) {
    throw new Error('Blazegraph namespace must be a bounded non-empty path segment');
  }
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
