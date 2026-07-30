import { describe, expect, it } from 'vitest';
import {
  AdoptionTelemetryReporter,
  adoptionNodeIdHash,
  buildAdoptionTelemetryReceipt,
  resolveAdoptionTelemetryConfig,
} from '../src/adoption-telemetry.js';

describe('resolveAdoptionTelemetryConfig', () => {
  it('requires the telemetry master gate, explicit adoption opt-in, and an endpoint', () => {
    expect(resolveAdoptionTelemetryConfig(undefined, {}).enabled).toBe(false);
    expect(resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { endpoint: 'https://telemetry.example/adoption' },
    }, {}).enabled).toBe(false);
    const missingEndpoint = resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { enabled: true },
    }, {});
    expect(missingEndpoint.enabled).toBe(false);
    expect(missingEndpoint.warning).toMatch(/no endpoint/);
  });

  it('supports env overrides and fails closed for an unsafe endpoint', () => {
    const resolved = resolveAdoptionTelemetryConfig(
      { enabled: true, adoption: { enabled: false } },
      {
        DKG_ADOPTION_TELEMETRY_ENABLED: '1',
        DKG_ADOPTION_TELEMETRY_ENDPOINT: 'https://collector.example/v1/adoption',
        DKG_ADOPTION_TELEMETRY_TOKEN: 'secret',
        DKG_ADOPTION_TELEMETRY_TIMEOUT_MS: '4500',
        DKG_ADOPTION_TELEMETRY_MAX_ATTEMPTS: '2',
      },
    );
    expect(resolved).toMatchObject({
      enabled: true,
      endpoint: 'https://collector.example/v1/adoption',
      token: 'secret',
      timeoutMs: 4_500,
      maxAttempts: 2,
    });

    const unsafe = resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { enabled: true, endpoint: 'file:///tmp/receipts' },
    }, {});
    expect(unsafe.enabled).toBe(false);
    expect(unsafe.warning).toMatch(/must use https/);

    const insecureRemote = resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { enabled: true, endpoint: 'http://collector.example/adoption' },
    }, {});
    expect(insecureRemote.enabled).toBe(false);
    expect(insecureRemote.warning).toMatch(/loopback/);

    const localCollector = resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { enabled: true, endpoint: 'http://127.0.0.1:4319/adoption' },
    }, {});
    expect(localCollector.enabled).toBe(true);

    const invalidToggle = resolveAdoptionTelemetryConfig({
      enabled: true,
      adoption: { enabled: true, endpoint: 'https://collector.example/adoption' },
    }, { DKG_ADOPTION_TELEMETRY_ENABLED: 'perhaps' });
    expect(invalidToggle.enabled).toBe(false);
    expect(invalidToggle.warning).toMatch(/true\/false/);
  });
});

describe('adoption receipts', () => {
  it('uses stable event/node ids without exposing the raw Peer ID', () => {
    const peerId = '12D3KooWExamplePeer';
    const first = buildAdoptionTelemetryReceipt({
      type: 'context_graph_synced',
      contextGraphId: 'project-a',
      dataSynced: 42,
    }, { peerId, nodeVersion: '10.0.7', network: 'testnet' }, 1_000, 'occurrence-1');
    const later = buildAdoptionTelemetryReceipt({
      type: 'context_graph_synced',
      contextGraphId: 'project-a',
      dataSynced: 7,
    }, { peerId, nodeVersion: '10.0.7', network: 'testnet' }, 2_000, 'occurrence-2');
    const install = buildAdoptionTelemetryReceipt({
      type: 'install_completed',
      contextGraphId: 'project-a',
    }, { peerId }, 2_000, 'occurrence-3');

    expect(first.adoptionKey).toBe(later.adoptionKey);
    expect(first.receiptId).not.toBe(later.receiptId);
    expect(first.adoptionKey).not.toBe(install.adoptionKey);
    expect(first.nodeIdHash).toBe(adoptionNodeIdHash(peerId));
    expect(JSON.stringify(first)).not.toContain(peerId);
    expect(first).toMatchObject({
      event: 'context_graph_synced',
      contextGraphId: 'project-a',
      dataSynced: 42,
      occurredAt: new Date(1_000).toISOString(),
    });
  });
});

describe('AdoptionTelemetryReporter', () => {
  const enabledConfig = {
    enabled: true,
    endpoint: 'https://collector.example/v1/adoption',
    timeoutMs: 1_000,
    maxAttempts: 3,
  } as const;

  it('suppresses concurrent duplicates and sends idempotent receipts', async () => {
    let release!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { release = resolve; });
    const calls: Array<{ headers: Headers; body: string }> = [];
    const reporter = new AdoptionTelemetryReporter({
      config: enabledConfig,
      peerId: 'peer-a',
      fetcher: (async (_url, init) => {
        calls.push({
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return pendingResponse;
      }) as typeof fetch,
      delay: async () => {},
    });

    expect(reporter.enqueue({ type: 'context_graph_synced', contextGraphId: 'cg-a' })).toBe(true);
    expect(reporter.enqueue({ type: 'context_graph_synced', contextGraphId: 'cg-a' })).toBe(true);
    expect(calls).toHaveLength(1);
    release(new Response(null, { status: 204 }));
    await reporter.flush();

    const body = JSON.parse(calls[0].body);
    expect(calls[0].headers.get('Idempotency-Key')).toBe(body.receiptId);
  });

  it('retries transient failures but not successful delivery', async () => {
    let calls = 0;
    const warnings: string[] = [];
    const reporter = new AdoptionTelemetryReporter({
      config: enabledConfig,
      peerId: 'peer-a',
      fetcher: (async () => {
        calls += 1;
        return new Response(calls === 1 ? '' : null, { status: calls === 1 ? 503 : 204 });
      }) as typeof fetch,
      delay: async () => {},
      log: (message) => warnings.push(message),
    });

    reporter.enqueue({ type: 'install_completed', contextGraphId: 'cg-a' });
    await reporter.flush();
    expect(calls).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('does nothing when disabled', async () => {
    let calls = 0;
    const reporter = new AdoptionTelemetryReporter({
      config: { enabled: false, timeoutMs: 1_000, maxAttempts: 1 },
      peerId: 'peer-a',
      fetcher: (async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(reporter.enqueue({ type: 'install_completed', contextGraphId: 'cg-a' })).toBe(false);
    await reporter.flush();
    expect(calls).toBe(0);
  });

  it('stops accepting new receipts during shutdown', async () => {
    let calls = 0;
    const reporter = new AdoptionTelemetryReporter({
      config: enabledConfig,
      peerId: 'peer-a',
      fetcher: (async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    reporter.enqueue({ type: 'install_completed', contextGraphId: 'cg-a' });
    await reporter.shutdown();
    expect(reporter.enqueue({ type: 'install_completed', contextGraphId: 'cg-b' })).toBe(false);
    expect(calls).toBe(1);
  });
});
