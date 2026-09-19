import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { authenticateHttpRequest, authenticatedAgentAddress, canAdministerNode } from '../src/auth.js';
import { signAgentHttpJwt, normalizeOperatorAgentAddresses, type AgentHttpRequest } from '../src/agent-http-auth.js';
import { SqliteAgentHttpNonceStore } from '../src/agent-http-nonce-store.js';
import { readBody } from '../src/daemon/http-utils.js';
import { createRequestActor } from '../src/daemon/routes/context.js';

const wallet = new ethers.Wallet('0x' + '01'.padStart(64, '0'));
const other = new ethers.Wallet('0x' + '02'.padStart(64, '0'));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function signed(overrides: Partial<AgentHttpRequest> = {}) {
  const input: AgentHttpRequest = {
    agentAddress: wallet.address, method: 'POST', targetPeerId: 'peer-receiver',
    path: '/api/example?a=1&b=%2F', contentType: 'application/json',
    body: Buffer.from('{"value":42}'), timestamp: String(Date.now()),
    nonce: randomBytes(24).toString('hex'), ...overrides,
  };
  const headers: Record<string, string> = {
    authorization: 'DKG-Agent ' + signAgentHttpJwt(input, wallet.signingKey),
    'content-type': input.contentType,
  };
  return { ...input, headers };
}
function mutateJwt(req: { headers: Record<string, string> }, mutate: (h: any, c: any) => void, resign = false) {
  const parts = req.headers.authorization.slice('DKG-Agent '.length).split('.');
  const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  mutate(h, c);
  const input = [h, c].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const signature = wallet.signingKey.sign('0x' + createHash('sha256').update(input).digest('hex'));
  req.headers.authorization = 'DKG-Agent ' + input + '.' + (resign ? Buffer.from(signature.r.slice(2) + signature.s.slice(2), 'hex').toString('base64url') : parts[2]);
}
async function fixture(operator = false, authEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-http-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let db = new Database(join(dir, 'auth.sqlite3'));
  let nonces = new SqliteAgentHttpNonceStore(db);
  cleanup.push(() => db.close());
  let dispatched = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      const auth = await authenticateHttpRequest({
        req, res, authEnabled, validTokens: new Set(['agent-token', 'operator-token']),
        resolveAgentByToken: (token) => token === 'agent-token' ? wallet.address : undefined,
        agentKey: { targetPeerId: 'peer-receiver', nonces, operatorAgentAddresses: operator ? [wallet.address] : [] },
      });
      if (!auth.allowed) return;
      const actor = createRequestActor(auth, () => other.address);
      dispatched++;
      const allowed = req.url?.startsWith('/api/admin') ? canAdministerNode(auth) : true;
      res.writeHead(allowed ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        caller: authenticatedAgentAddress(auth), effective: actor.effectiveAgentAddress,
        admin: canAdministerNode(auth), principal: auth.principal.kind,
        body: await readBody(req),
      }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  return {
    dispatched: () => dispatched,
    restartStore: () => { db.close(); db = new Database(join(dir, 'auth.sqlite3')); nonces = new SqliteAgentHttpNonceStore(db); },
    send: (r: { method?: string; path?: string; headers?: Record<string, string>; body?: Uint8Array }) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, method: r.method ?? 'POST', path: r.path ?? '/api/example', headers: { ...r.headers, 'content-length': String(r.body?.length ?? 0) } }, (res) => {
          const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
        });
        req.on('error', reject); req.end(r.body);
      }),
  };
}

describe('shared agent-key HTTP authentication', () => {
  it.each(['POST', 'PUT', 'DELETE', 'GET'])('authenticates %s and passes exact bytes to the route without a token', async (method) => {
    const f = await fixture();
    const req = await signed({ method, body: method === 'GET' ? Buffer.alloc(0) : Buffer.from('{ "text": "é", "n": 42 }\n') });
    const res = await f.send(req);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caller: wallet.address, effective: wallet.address, admin: false, body: Buffer.from(req.body).toString() });
    expect(f.dispatched()).toBe(1);
  });

  it.each(['body', 'method', 'path', 'query-order', 'content-type', 'timestamp', 'nonce', 'address', 'signature'])('rejects %s tampering before dispatch', async (field) => {
    const f = await fixture();
    const req = await signed();
    if (field === 'body') req.body = Buffer.from('{"value":43}');
    if (field === 'method') req.method = 'PUT';
    if (field === 'path') req.path = '/api/admin';
    if (field === 'query-order') req.path = '/api/example?b=%2F&a=1';
    if (field === 'content-type') req.headers['content-type'] = 'text/plain';
    if (field === 'timestamp') mutateJwt(req, (_, c) => { c.iat -= 1; });
    if (field === 'nonce') mutateJwt(req, (_, c) => { c.jti = randomBytes(24).toString('hex'); });
    if (field === 'address') mutateJwt(req, (_, c) => { c.iss = other.address; });
    if (field === 'signature') req.headers.authorization = 'DKG-Agent 0x' + '00'.repeat(65);
    expect((await f.send(req)).body.code).toBe(['body', 'method', 'path', 'query-order', 'content-type'].includes(field) ? 'AGENT_HTTP_REQUEST_MISMATCH' : 'AGENT_HTTP_SIGNATURE_INVALID');
    expect(f.dispatched()).toBe(0);
  });

  it('rejects the wrong physical destination independently of the Host header', async () => {
    const f = await fixture();
    const req = await signed({ targetPeerId: 'peer-other' });
    req.headers.host = 'peer-other';
    expect((await f.send(req)).body.code).toBe('AGENT_HTTP_TARGET_MISMATCH');
    expect(f.dispatched()).toBe(0);
  });

  it.each([-61_000, 10_000])('rejects an out-of-window timestamp (%s ms)', async (offset) => {
    const f = await fixture();
    expect((await f.send(await signed({ timestamp: String(Date.now() + offset) }))).body.code).toBe('AGENT_HTTP_EXPIRED');
    expect(f.dispatched()).toBe(0);
  });

  it('atomically rejects concurrent replays and retains the nonce after restart', async () => {
    const f = await fixture(); const req = await signed();
    const responses = await Promise.all([f.send(req), f.send(req)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    f.restartStore();
    expect((await f.send(req)).body.code).toBe('AGENT_HTTP_REPLAY');
    expect((await f.send(await signed())).status).toBe(200);
    expect(f.dispatched()).toBe(2);
  });

  it('does not consume a nonce on invalid authentication', async () => {
    const f = await fixture(); const req = await signed();
    expect((await f.send({ ...req, body: Buffer.from('tampered') })).status).toBe(401);
    expect((await f.send(req)).status).toBe(200);
  });

  it('requires an explicit operator role and preserves that operator agent identity', async () => {
    const ordinary = await fixture();
    expect((await ordinary.send(await signed({ path: '/api/admin/routes' }))).status).toBe(403);
    const operator = await fixture(true);
    const response = await operator.send(await signed({ path: '/api/admin/routes' }));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ caller: wallet.address, effective: wallet.address, admin: true, principal: 'agent' });
  });

  it('keeps public endpoints public and bearer authentication working', async () => {
    const f = await fixture();
    expect((await f.send({ method: 'GET', path: '/api/status' })).status).toBe(200);
    expect((await f.send({ method: 'OPTIONS' })).status).toBe(200);
    expect((await f.send({})).status).toBe(401);
    const agent = await f.send({ headers: { authorization: 'Bearer agent-token' } });
    expect(agent.body).toMatchObject({ caller: wallet.address, admin: false });
    expect((await f.send({ path: '/api/admin', headers: { authorization: 'Bearer operator-token' } })).status).toBe(200);
  });

  it.each([true, false])('cannot downgrade an invalid JWT to public or disabled auth (%s)', async (enabled) => {
    const f = await fixture(false, enabled);
    for (const path of ['/api/example', '/api/status']) {
      expect((await f.send({ path, headers: { authorization: 'DKG-Agent invalid' } })).status).toBe(401);
    }
    expect(f.dispatched()).toBe(0);
  });

  it.each(['alg', 'typ', 'private-jwk', 'remote-jwk', 'curve', 'issuer', 'claims', 'expiry'])('rejects incorrectly scoped JWTs: %s', async (field) => {
    const f = await fixture(); const req = await signed();
    mutateJwt(req, (h, c) => {
      if (field === 'alg') h.alg = 'HS256';
      if (field === 'typ') h.typ = 'JWT';
      if (field === 'private-jwk') h.jwk.d = 'unused';
      if (field === 'remote-jwk') h.jku = 'https://example.invalid/keys';
      if (field === 'curve') h.jwk.crv = 'P-256';
      if (field === 'issuer') c.iss = other.address;
      if (field === 'claims') c.admin = true;
      if (field === 'expiry') c.exp += 60;
    }, true);
    expect((await f.send(req)).status).toBe(401);
    expect(f.dispatched()).toBe(0);
  });

  it('accepts standard ES256K signing from Node crypto, independently of the helper', async () => {
    const f = await fixture(); const req = await signed();
    const parts = req.headers.authorization.slice('DKG-Agent '.length).split('.');
    const { jwk } = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const key = createPrivateKey({ key: { ...jwk, d: Buffer.from(wallet.privateKey.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
    const input = parts[0] + '.' + parts[1];
    req.headers.authorization = 'DKG-Agent ' + input + '.' + sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    expect((await f.send(req)).status).toBe(200);
  });

  it('validates explicit operator addresses without granting defaults', () => {
    expect(normalizeOperatorAgentAddresses(undefined)).toEqual([]);
    expect(normalizeOperatorAgentAddresses([wallet.address.toLowerCase(), wallet.address])).toEqual([wallet.address]);
    expect(() => normalizeOperatorAgentAddresses(['not-an-agent'])).toThrow();
  });
});

