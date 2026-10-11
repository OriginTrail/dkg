/** Route-plugins live-daemon E2E: spawns two daemons (async publisher off and on) with the sample-fixture plugins and
 *  asserts HTTP behaviour. The shared live-daemon harness lets each daemon bind port 0 and reads the port from its api.port. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from '../helpers/live-daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolvePath(
  __dirname,
  '..',
  '..',
  'test-fixtures',
  'sample-route-plugin',
  'dist',
);
const ECHO_FIXTURE = join(FIXTURE_DIR, 'index.js');
const THROW_FIXTURE = join(FIXTURE_DIR, 'throwing.js');

let daemon: LiveDaemon | undefined;
let publisherDaemon: LiveDaemon | undefined;

beforeAll(async () => {
  // Route-plugin loading is fail-soft, so a missing fixture would otherwise show up as confusing 404s.
  if (!existsSync(ECHO_FIXTURE) || !existsSync(THROW_FIXTURE)) {
    throw new Error(`Sample route-plugin fixtures missing under ${FIXTURE_DIR}`);
  }
  const extraConfig = { routePlugins: [ECHO_FIXTURE, THROW_FIXTURE] };
  daemon = await startLiveDaemon({ extraConfig });
  publisherDaemon = await startLiveDaemon({ publisherEnabled: true, extraConfig });
}, 90_000);

afterAll(async () => {
  await stopLiveDaemon(daemon);
  await stopLiveDaemon(publisherDaemon);
}, 20_000);

function urlFor(path: string, target = daemon): string {
  return `${target!.base}${path}`;
}

describe('Route plugins — live daemon E2E', () => {
  it.each([
    {
      name: 'disabled',
      target: () => daemon,
      runtimePresent: false,
      availability: {
        available: false,
        reason: 'publisher_disabled',
        retryable: false,
        operatorActionRequired: true,
      },
    },
    {
      name: 'ready',
      target: () => publisherDaemon,
      runtimePresent: true,
      availability: { available: true },
    },
  ])('adapts canonical publisher state to legacy aliases through handleRequest ($name)', async ({
    target,
    runtimePresent,
    availability,
  }) => {
    const selected = target();
    const res = await fetch(urlFor('/api/sample-fixture/publisher-context', selected), {
      headers: { Authorization: `Bearer ${selected!.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      publisherRuntimePresent: runtimePresent,
      publisherAvailability: availability,
      runtimeAliasMatchesCanonical: true,
      availabilityAliasMatchesCanonical: true,
    });
  });

  it('echo plugin handles POST /api/sample-fixture/echo with the request body', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ echoed: { hello: 'world' } });
  });

  it('rejects an unauthenticated request to a plugin route (auth gate runs BEFORE plugin dispatch)', async () => {
    // Locks the security boundary: route-plugins are an extension
    // surface but they MUST NOT bypass the daemon's auth gate. A
    // regression where plugin routes were dispatched first (and the
    // bearer-token check ran only on built-in routes) would let a
    // misconfigured plugin leak data without auth. Probe with no
    // header, then with a wrong token, expecting both to fail.
    const noAuth = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect([401, 403]).toContain(noAuth.status);

    const wrongAuth = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token-xyz',
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect([401, 403]).toContain(wrongAuth.status);
  });

  it('two consecutive successful echo calls return independent responses (no plugin state leak)', async () => {
    // Defends against plugin authors capturing the request context
    // in a closure or holding it across requests. Two distinct bodies
    // → two distinct echoed responses, never aliased.
    const r1 = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ pass: 1 }),
    });
    const r2 = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ pass: 2 }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const d1 = await r1.json();
    const d2 = await r2.json();
    expect(d1).toEqual({ echoed: { pass: 1 } });
    expect(d2).toEqual({ echoed: { pass: 2 } });
  });

  it('built-in /api/status still answers 200 in the same daemon (regression)', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.relay).toMatchObject({
      isCore: expect.any(Boolean),
      reservationsHeld: expect.any(Number),
      natStatus: expect.stringMatching(/^(public|private|unknown)$/),
      advertisedAddresses: expect.any(Array),
      configuredAnnounceAddresses: expect.any(Array),
    });
  });

  it('throwing plugin yields a 500 PluginError with the plugin name', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/throw'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('PluginError');
    expect(data.plugin).toBe('sample-fixture-throw');
    expect(typeof data.message).toBe('string');
  });

  it('daemon survives a plugin throw — /api/status still answers 200 after the 500', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
  });

  it('HEAD /.well-known/skill.md mirrors the GET headers (ETag, Cache-Control, Vary) with no body', async () => {
    // HEAD must return the same caching headers GET would, so HTTP-cache-aware clients can validate
    // their cached copy without a body roundtrip. Body must be empty (HEAD spec).
    const headRes = await fetch(urlFor('/.well-known/skill.md'), { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('text/markdown');
    const etag = headRes.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(headRes.headers.get('cache-control')).toBeTruthy();
    expect(headRes.headers.get('vary')).toBeTruthy();
    const headBody = await headRes.text();
    expect(headBody).toBe('');

    // Conditional GET with the HEAD-discovered ETag must return 304.
    const getRes = await fetch(urlFor('/.well-known/skill.md'), {
      headers: { 'If-None-Match': etag! },
    });
    expect(getRes.status).toBe(304);

    // Conditional HEAD with matching ETag must also return 304.
    const headIfMatch = await fetch(urlFor('/.well-known/skill.md'), {
      method: 'HEAD',
      headers: { 'If-None-Match': etag! },
    });
    expect(headIfMatch.status).toBe(304);
  });
});
