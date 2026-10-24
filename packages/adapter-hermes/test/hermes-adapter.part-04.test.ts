import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';



describe('HermesDkgClient', () => {


  it('registers Hermes through the local-agent integration route', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, integration: { id: 'hermes' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HermesDkgClient({
      baseUrl: 'http://127.0.0.1:9200/',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.connectHermesIntegration({
      metadata: { profileName: 'dkg-smoke' },
      transport: { bridgeUrl: 'http://127.0.0.1:3199' },
    });

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/connect');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.id).toBe('hermes');
    expect(body.manifest.setupEntry).toBe('./setup-entry.mjs');
    expect(body.transport.kind).toBe('hermes-channel');
    expect(body.capabilities.localChat).toBe(true);
  });

  it('redacts bearer tokens from daemon errors', async () => {
    const fetchImpl = async () => new Response('Bearer secret-token exploded', { status: 500 });
    const client = new HermesDkgClient({
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.getHermesChannelHealth()).rejects.toThrow('[REDACTED]');
    await expect(client.getHermesChannelHealth()).rejects.not.toThrow('secret-token');
    expect(redact('Authorization: Bearer secret-token', 'secret-token')).not.toContain('secret-token');
  });

  it('reads the daemon Hermes channel health wire shape', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      target: 'gateway',
      bridge: { ok: false, error: 'bridge unavailable' },
      gateway: { ok: true, channel: 'hermes-channel' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const client = new HermesDkgClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    const health = await client.getHermesChannelHealth();

    expect(health.ok).toBe(true);
    expect(health.target).toBe('gateway');
    expect(health.bridge?.ok).toBe(false);
    expect(health.gateway?.channel).toBe('hermes-channel');
  });

  it('marks Hermes disconnected through the local-agent integration route', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, integration: { id: 'hermes', enabled: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HermesDkgClient({
      baseUrl: 'http://127.0.0.1:9200/',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.disconnectHermesIntegration();

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/hermes');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.enabled).toBe(false);
    expect(body.runtime.status).toBe('disconnected');
    expect(body.runtime.ready).toBe(false);
  });

  // Real, small deadlines: a 20 ms default class and a 1 s turn class. The stub
  // daemon answers after `latencyMs` unless the request's signal aborts first, in
  // which case it rejects with the abort reason, as fetch does.
  const slowDaemon = (latencyMs: number, respond: () => Response) =>
    ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond()), latencyMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      }, { once: true });
    })) as typeof fetch;
  const json = (body: unknown) => () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  it('an agent turn that outlasts the default timeout is not reported as failed', async () => {
    const client = new HermesDkgClient({
      timeoutMs: 20,
      turnTimeoutMs: 1_000,
      fetchImpl: slowDaemon(80, json({ ok: true, text: 'late reply' })),
    });

    await expect(client.sendHermesMessage({ text: 'hi', correlationId: 'c1' } as any))
      .resolves.toMatchObject({ text: 'late reply' });
  });

  it('a health read with the same latency still times out (control)', async () => {
    const client = new HermesDkgClient({
      timeoutMs: 20,
      turnTimeoutMs: 1_000,
      fetchImpl: slowDaemon(80, json({ ok: true })),
    });

    await expect(client.getHermesChannelHealth()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('keeps a streamed turn open past the default timeout', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
          controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"delta":"b"}\n\n'));
            controller.close();
          }, 80);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const events: unknown[] = [];
    const client = new HermesDkgClient({ timeoutMs: 20, turnTimeoutMs: 1_000, fetchImpl });

    await client.streamHermesMessage({ text: 'hi', correlationId: 'c1' } as any, (event) => events.push(event));

    expect(events).toEqual([{ delta: 'a' }, { delta: 'b' }]);
  });

});
