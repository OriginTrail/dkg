import type {
  BenchmarkClient,
  BenchmarkConfig,
  BenchmarkOperation,
  OperationTiming,
} from '../../src/benchmark/publish-get/index.js';

export function baseConfig(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return {
    contextGraphId: 'bench-cg',
    repeat: 1,
    warmups: 0,
    timeoutMs: 1000,
    payloadSizeBytes: 128,
    fixture: 'minimal',
    outputFormat: 'json',
    namespace: 'benchmark',
    scope: 'publish-async-get',
    authorityProofRef: 'proof:benchmark-local',
    pollIntervalMs: 1,
    asyncSuccessStatuses: ['finalized'],
    getView: 'verifiable-memory',
    ...overrides,
  };
}

export function timing(
  operation: BenchmarkOperation,
  iteration: number,
  warmup: boolean,
  success: boolean,
  durationMs: number,
  error?: string,
): OperationTiming {
  return { operation, iteration, warmup, success, durationMs, error, context: {} };
}

export function monotonicClock(): () => number {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
}

export function trackingFetch(calls: Array<{ url: string; init?: RequestInit }>, body: unknown): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

export class MockBenchmarkClient implements BenchmarkClient {
  readonly publishCalls: Array<{ name: string; roots: string[]; clearAfter?: boolean }> = [];
  readonly enqueueCalls: Array<{ roots: string[] }> = [];
  private readonly markersByRoot = new Map<string, string>();

  constructor(private readonly opts: {
    enqueueError?: string;
    jobStatus?: string;
    jobError?: string;
    queryMarkerOverride?: string;
    statusError?: string;
  } = {}) {}

  async status(): Promise<unknown> {
    if (this.opts.statusError) throw new Error(this.opts.statusError);
    return { ok: true };
  }

  async sharedMemoryWrite(
    _contextGraphId: string,
    quads: Array<{ subject: string; predicate: string; object: string }>,
  ) {
    const markerQuad = quads.find((quad) => quad.predicate === 'http://schema.org/identifier');
    if (markerQuad) this.markersByRoot.set(markerQuad.subject, markerQuad.object);
    return { shareOperationId: `share-${this.markersByRoot.size}` };
  }

  async publishAssertion(
    _contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string }>,
    options?: { clearAfter?: boolean },
  ) {
    // The named-KA composite stages the quads itself, so register the marker
    // here (the sync leg no longer calls sharedMemoryWrite first) — the `get`
    // validation looks up the marker by root. The KA `name` is recorded so tests can
    // assert warmup/measured name uniqueness: KA create is name-idempotent, so a reused
    // name would silently collide with the warmup KA — the root alone wouldn't catch it.
    const markerQuad = quads.find((quad) => quad.predicate === 'http://schema.org/identifier');
    if (markerQuad) this.markersByRoot.set(markerQuad.subject, markerQuad.object);
    const roots = [...new Set(quads.map((quad) => quad.subject))];
    this.publishCalls.push({ name, roots, clearAfter: options?.clearAfter });
    return { kaId: `kc-${this.publishCalls.length}`, kas: roots.map((rootEntity) => ({ tokenId: '1', rootEntity })) };
  }

  async publisherEnqueue(request: { roots: string[] }) {
    if (this.opts.enqueueError) throw new Error(this.opts.enqueueError);
    this.enqueueCalls.push({ roots: request.roots });
    return { jobId: `job-${this.enqueueCalls.length}` };
  }

  async publisherJob(_jobId: string) {
    return { job: { status: this.opts.jobStatus ?? 'finalized', error: this.opts.jobError } };
  }

  async query(sparql: string) {
    const root = sparql.match(/<([^>]+)>/)?.[1] ?? '';
    const value = this.opts.queryMarkerOverride ?? this.markersByRoot.get(root) ?? '"missing"';
    return { result: { type: 'bindings' as const, bindings: [{ value }] } };
  }
}
