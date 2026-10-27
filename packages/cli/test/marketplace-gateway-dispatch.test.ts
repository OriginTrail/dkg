// OT-RFC-27 buyer gateway dispatch: the carve-out path match (S1), key-first
// authentication before any body byte (S3), the header-only credential (S10)
// and the no-key-state oracle (S11).

import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MARKETPLACE_GATEWAY_BASE_PATH,
  isMarketplaceGatewayPath,
} from '../src/daemon/marketplace-gateway-dispatch.js';
import { MarketplaceGatewayKeyStore, gatewayKeyStorePath } from '../src/marketplace-gateway-key-store.js';
import {
  bearer,
  getJson,
  makeFakeAgent,
  mintKey,
  postJson,
  startGatewayServer,
  tempHome,
  type GatewayServer,
} from './marketplace-gateway-fixtures.js';

let server: GatewayServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const pathnameOf = (raw: string): string => new URL(raw, 'http://127.0.0.1:9202').pathname;

describe('isMarketplaceGatewayPath (S1 narrow match)', () => {
  it('matches only the base or base + "/" subpaths', () => {
    expect(MARKETPLACE_GATEWAY_BASE_PATH).toBe('/api/marketplace/gateway/v1');
    for (const yes of [
      '/api/marketplace/gateway/v1',
      '/api/marketplace/gateway/v1/',
      '/api/marketplace/gateway/v1/models',
      '/api/marketplace/gateway/v1/chat/completions',
      '/api/marketplace/gateway/v1/query',
      '/api/marketplace/gateway/v1/unknown/deeper',
    ]) expect(isMarketplaceGatewayPath(yes), yes).toBe(true);
    for (const no of [
      '',
      '/',
      '/API/marketplace/gateway/v1',
      '/api/Marketplace/gateway/v1/models',
      '/api/marketplace/Gateway/v1/models',
      '/api/marketplace/gateway/V1/models',
      '/api/marketplace/gateway/v10',
      '/api/marketplace/gateway/v10/models',
      '/api/marketplace/gateway/v1x/models',
      '/api/marketplace/gateway/v1.models',
      '/api/marketplace/gateway',
      '/api/marketplace/gateway/',
      '/api/marketplace/status',
      '/api/marketplace/keys',
      '/api/query',
      '/x/api/marketplace/gateway/v1/models',
    ]) expect(isMarketplaceGatewayPath(no), no).toBe(false);
  });

  it('dot segments resolve BEFORE the match and leave the prefix (normal token auth applies)', () => {
    expect(pathnameOf('/api/marketplace/gateway/v1/../../status')).toBe('/api/marketplace/status');
    expect(pathnameOf('/api/marketplace/gateway/v1/%2e%2e/%2e%2e/status')).toBe('/api/marketplace/status');
    expect(pathnameOf('/api/marketplace/gateway/v1/%2E%2E/%2E%2E/keys')).toBe('/api/marketplace/keys');
    expect(pathnameOf('/api/marketplace/gateway/v1\\..\\..\\status')).toBe('/api/marketplace/status');
    // `//api/…` parses as host `api`, pathname `/marketplace/…`.
    expect(pathnameOf('//api/marketplace/gateway/v1/models')).toBe('/marketplace/gateway/v1/models');
    for (const raw of [
      '/api/marketplace/gateway/v1/../../status',
      '/api/marketplace/gateway/v1/%2e%2e/%2e%2e/status',
      '/api/marketplace/gateway/v1\\..\\..\\status',
      '//api/marketplace/gateway/v1/models',
    ]) expect(isMarketplaceGatewayPath(pathnameOf(raw)), raw).toBe(false);
  });

  it('percent-encoded separators stay encoded: the request lands IN the gateway', () => {
    const encoded = pathnameOf('/api/marketplace/gateway/v1/chat%2F..%2F..%2Fstatus');
    expect(encoded).toBe('/api/marketplace/gateway/v1/chat%2F..%2F..%2Fstatus');
    expect(isMarketplaceGatewayPath(encoded)).toBe(true);
  });
});

describe('gateway key authentication (S3, S10, S11)', () => {
  it('an encoded traversal is 401 without a key and 404 unknown_url with one — never another route', async () => {
    const { agent, calls } = makeFakeAgent();
    server = await startGatewayServer({ agent });
    const { plaintext } = await mintKey(server.store);
    const target = `${server.base}/chat%2F..%2F..%2Fstatus`;
    const noKey = await getJson(target);
    expect(noKey.status).toBe(401);
    const withKey = await getJson(target, bearer(plaintext));
    expect(withKey.status).toBe(404);
    expect(withKey.json.error.code).toBe('unknown_url');
    expect(calls).toEqual([]);
  });

  it('answers 401 before reading the body (headers sent, body left open) with Connection: close', async () => {
    const { agent, calls } = makeFakeAgent();
    server = await startGatewayServer({ agent });
    const port = new URL(server.url).port;
    const started = Date.now();
    const response = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `${MARKETPLACE_GATEWAY_BASE_PATH}/chat/completions`,
        headers: {
          Authorization: `Bearer dkg_gw_0badc0de_${'A'.repeat(43)}`,
          'Content-Type': 'application/json',
          'Content-Length': '1000000',
        },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      // Only a fragment of the declared body; the stream stays open.
      req.write('{"model":"stub-chat","messages":[');
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(401);
    expect(String(response.headers.connection).toLowerCase()).toBe('close');
    expect(response.headers['www-authenticate']).toBe('Bearer realm="dkg-marketplace-gateway"');
    expect(JSON.parse(response.body).error.code).toBe('invalid_api_key');
    expect(calls).toEqual([]);
  });

  it('reads the key ONLY from Authorization: Bearer (query, body, x-api-key, cookie are ignored)', async () => {
    const { agent, calls } = makeFakeAgent();
    server = await startGatewayServer({ agent });
    const { plaintext } = await mintKey(server.store);
    const attempts = [
      getJson(`${server.base}/models?api_key=${plaintext}`),
      getJson(`${server.base}/models?key=${plaintext}`),
      getJson(`${server.base}/models`, { 'x-api-key': plaintext }),
      getJson(`${server.base}/models`, { Cookie: `api_key=${plaintext}; key=${plaintext}` }),
      getJson(`${server.base}/models`, { Authorization: `Basic ${plaintext}` }),
      getJson(`${server.base}/models`, { Authorization: `Bearer ${plaintext} extra` }),
      getJson(`${server.base}/models`, { Authorization: plaintext }),
      postJson(`${server.base}/chat/completions`, { api_key: plaintext, model: 'stub-chat', messages: [] }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
      expect(res.json.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' });
      expect(res.text).not.toContain(plaintext);
    }
    expect(calls).toEqual([]);
    // The header form works, scheme case-insensitive, surrounding whitespace trimmed.
    expect((await getJson(`${server.base}/models`, { Authorization: `bearer ${plaintext}` })).status).toBe(200);
    expect((await getJson(`${server.base}/models`, { Authorization: `  Bearer   ${plaintext}  ` })).status).toBe(200);
  });

  it('S11: revoked/expired are only revealed to the holder of the correct secret', async () => {
    const { agent } = makeFakeAgent();
    let nowMs = Date.now();
    server = await startGatewayServer({ agent, nowMs: () => nowMs });
    const revoked = await mintKey(server.store);
    await server.store.revoke(revoked.keyId, Math.floor(nowMs / 1000));
    const expiring = await mintKey(server.store, { expiresAt: Math.floor(nowMs / 1000) + 60 });
    const wrongSecret = (key: string) => `${key.slice(0, -43)}${'Z'.repeat(43)}`;

    const revokedRight = await getJson(`${server.base}/models`, bearer(revoked.plaintext));
    expect(revokedRight.status).toBe(401);
    expect(revokedRight.json.error.code).toBe('key_revoked');
    const revokedWrong = await getJson(`${server.base}/models`, bearer(wrongSecret(revoked.plaintext)));
    expect(revokedWrong.status).toBe(401);
    expect(revokedWrong.json.error.code).toBe('invalid_api_key');

    expect((await getJson(`${server.base}/models`, bearer(expiring.plaintext))).status).toBe(200);
    nowMs += 61_000;
    const expiredRight = await getJson(`${server.base}/models`, bearer(expiring.plaintext));
    expect(expiredRight.json.error.code).toBe('key_expired');
    const expiredWrong = await getJson(`${server.base}/models`, bearer(wrongSecret(expiring.plaintext)));
    expect(expiredWrong.json.error.code).toBe('invalid_api_key');
    // Same shape for every 401: the type, the realm header, Connection: close.
    for (const res of [revokedRight, revokedWrong, expiredRight, expiredWrong]) {
      expect(res.json.error.type).toBe('authentication_error');
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dkg-marketplace-gateway"');
      expect(res.headers.get('connection')).toBe('close');
    }
  });

  it('unknown subpaths are 404 only after the key verified; wrong methods 405', async () => {
    const { agent } = makeFakeAgent();
    server = await startGatewayServer({ agent });
    const { plaintext } = await mintKey(server.store);
    for (const path of ['', '/', '/embeddings', '/v1/models', '/models/stub-chat']) {
      expect((await getJson(`${server.base}${path}`)).status, `no key ${path}`).toBe(401);
      const res = await getJson(`${server.base}${path}`, bearer(plaintext));
      expect(res.status, path).toBe(404);
      expect(res.json.error).toMatchObject({ type: 'invalid_request_error', code: 'unknown_url' });
    }
    const wrongMethod = await getJson(`${server.base}/chat/completions`, bearer(plaintext));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
    expect(wrongMethod.json.error.code).toBe('method_not_allowed');
    const postModels = await postJson(`${server.base}/models`, {}, bearer(plaintext));
    expect(postModels.status).toBe(405);
  });

  it('a malformed key file fails closed: every gateway path is 503 and the file is untouched', async () => {
    const home = tempHome();
    const path = gatewayKeyStorePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"version":1,"keys":[{"keyId":"nope"}]}');
    const logs: string[] = [];
    const store = new MarketplaceGatewayKeyStore(path, { log: (line) => logs.push(line) });
    expect(store.available).toBe(false);
    const { agent, calls } = makeFakeAgent();
    server = await startGatewayServer({ agent, store });
    for (const res of [
      await getJson(`${server.base}/models`, bearer(`dkg_gw_0badc0de_${'A'.repeat(43)}`)),
      await getJson(`${server.base}/anything`),
      await postJson(`${server.base}/chat/completions`, { model: 'm', messages: [] }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('marketplace_unavailable');
    }
    expect(calls).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('{"version":1,"keys":[{"keyId":"nope"}]}');
    expect(logs.join('\n')).toContain(path);
  });
});
