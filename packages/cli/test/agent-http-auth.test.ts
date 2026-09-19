import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { authenticateHttpRequest, authenticatedAgentAddress, canAdministerNode } from '../src/auth.js';
import { normalizeOperatorAgentAddresses } from '../src/agent-http-auth.js';
import { signAgentHttpHeaders, createAgentHttpClient, type AgentHttpRequest } from '../src/agent-http-signing.js';
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
  const headers = signAgentHttpHeaders(input, wallet.signingKey);
  return { ...input, headers };
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
      if (req.url === '/api/redirect') { res.writeHead(302, { location: '/api/example' }); res.end(); return; }
      const allowed = req.url?.startsWith('/api/admin') ? canAdministerNode(auth) : true;
      res.writeHead(allowed ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        caller: authenticatedAgentAddress(auth), effective: actor.effectiveAgentAddress,
        admin: canAdministerNode(auth), principal: auth.principal.kind,
        body: await readBody(req), nonce: req.headers['x-dkg-agent-nonce'],
      }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dispatched: () => dispatched,
    restartStore: () => { db.close(); db = new Database(join(dir, 'auth.sqlite3')); nonces = new SqliteAgentHttpNonceStore(db); },
    send: (r: { method?: string; path?: string; headers?: Record<string, string | string[]>; body?: Uint8Array }) =>
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
    if (field === 'timestamp') req.headers['x-dkg-agent-timestamp'] = String(Number(req.timestamp) - 1);
    if (field === 'nonce') req.headers['x-dkg-agent-nonce'] = randomBytes(24).toString('hex');
    if (field === 'address') req.headers['x-dkg-agent-address'] = other.address;
    if (field === 'signature') req.headers.authorization = 'DKG-Agent 0x' + '00'.repeat(65);
    expect((await f.send(req)).body.code).toBe('AGENT_HTTP_SIGNATURE_INVALID');
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

  it.each([true, false])('cannot downgrade an invalid signature to public or disabled auth (%s)', async (enabled) => {
    const f = await fixture(false, enabled);
    for (const path of ['/api/example', '/api/status']) {
      expect((await f.send({ path, headers: { authorization: 'DKG-Agent invalid' } })).status).toBe(401);
    }
    expect(f.dispatched()).toBe(0);
  });

  it.each(['authorization', 'x-dkg-agent-address', 'x-dkg-agent-target', 'x-dkg-agent-timestamp', 'x-dkg-agent-nonce', 'content-type'])('rejects duplicate %s headers', async (name) => {
    const f = await fixture(); const req = await signed();
    expect((await f.send({ ...req, headers: { ...req.headers, [name]: [req.headers[name], req.headers[name]] } })).status).toBe(401);
    expect(f.dispatched()).toBe(0);
  });

  it.each(['x-dkg-agent-address', 'x-dkg-agent-target', 'x-dkg-agent-timestamp', 'x-dkg-agent-nonce'])('rejects missing %s headers', async (name) => {
    const f = await fixture(); const req = await signed();
    delete req.headers[name];
    expect((await f.send(req)).status).toBe(401);
    expect(f.dispatched()).toBe(0);
  });

  it.each(['authorization', 'Bearer operator-token'])('cannot downgrade partial signature headers to public/bearer authentication: %s', async (authorization) => {
    const f = await fixture(false, false); const req = await signed({ path: '/api/status' });
    delete req.headers.authorization;
    if (authorization.startsWith('Bearer')) req.headers.authorization = authorization;
    expect((await f.send(req)).status).toBe(401);
    expect(f.dispatched()).toBe(0);
  });

  it.each(['-1', '1e12', '01', 'NaN', '9007199254740992'])('rejects noncanonical timestamps: %s', async (timestamp) => {
    const f = await fixture(); const req = await signed();
    req.headers['x-dkg-agent-timestamp'] = timestamp;
    expect((await f.send(req)).status).toBe(401);
  });

  it('does not accept the former JWT envelope', async () => {
    const f = await fixture(); const req = await signed();
    req.headers.authorization = 'DKG-Agent eyJhbGciOiJFUzI1NksifQ.eyJpc3MiOiJhZ2VudCJ9.c2lnbmF0dXJl';
    expect((await f.send(req)).body.code).toBe('AGENT_HTTP_SIGNATURE_INVALID');
  });

  it('accepts wallet.signMessage over the documented preimage without the signing helper', async () => {
    const f = await fixture(); const req = await signed();
    const message = JSON.stringify(['DKG-HTTP-REQUEST-V1', wallet.address.toLowerCase(), req.targetPeerId,
      req.method, req.path, req.contentType, createHash('sha256').update(req.body).digest('hex'), req.timestamp, req.nonce]);
    req.headers.authorization = 'DKG-Agent ' + await wallet.signMessage(message);
    expect((await f.send(req)).status).toBe(200);
    req.headers.authorization = 'DKG-Agent ' + await wallet.signMessage(message.replace('DKG-HTTP-REQUEST-V1', 'DKG-OTHER-V1'));
    expect((await f.send(req)).status).toBe(401);
  });

  it('configures the backend signer once and generates fresh authentication on every request', async () => {
    const f = await fixture();
    const client = createAgentHttpClient({ baseUrl: f.baseUrl, targetPeerId: 'peer-receiver', signer: wallet });
    const results = await Promise.all([0, 1].map(async () => {
      const response = await client.request('/api/example?a=1&b=%2F', { method: 'POST', body: '{ "text": "é" }' });
      expect(response.status).toBe(200);
      return response.json();
    }));
    expect(results.map((r) => r.caller)).toEqual([wallet.address, wallet.address]);
    expect(results[0].nonce).not.toBe(results[1].nonce);
    expect(results[0].body).toBe('{ "text": "é" }');
    expect(f.dispatched()).toBe(2);
  });

  it('prevents the backend client from forwarding signatures to another origin or normalized path', async () => {
    const f = await fixture();
    const client = createAgentHttpClient({ baseUrl: f.baseUrl, targetPeerId: 'peer-receiver', signer: wallet });
    for (const path of ['//evil.invalid/api', 'https://evil.invalid/api', '/api/../admin', '/api/%2e%2e/admin', '/api#fragment']) {
      await expect(client.request(path)).rejects.toThrow();
    }
    expect(() => createAgentHttpClient({ baseUrl: f.baseUrl + '/prefix', targetPeerId: 'peer', signer: wallet })).toThrow();
    expect(f.dispatched()).toBe(0);
  });

  it('does not follow redirects with agent authentication', async () => {
    const f = await fixture();
    const client = createAgentHttpClient({ baseUrl: f.baseUrl, targetPeerId: 'peer-receiver', signer: wallet });
    await expect(client.request('/api/redirect')).rejects.toThrow();
    expect(f.dispatched()).toBe(1);
  });

  it('rejects a signer configured as another agent', async () => {
    const req = await signed();
    expect(() => signAgentHttpHeaders({ ...req, agentAddress: other.address }, wallet.signingKey)).toThrow('Signing key does not match');
  });

  it('validates explicit operator addresses without granting defaults', () => {
    expect(normalizeOperatorAgentAddresses(undefined)).toEqual([]);
    expect(normalizeOperatorAgentAddresses([wallet.address.toLowerCase(), wallet.address])).toEqual([wallet.address]);
    expect(() => normalizeOperatorAgentAddresses(['not-an-agent'])).toThrow();
  });
});

