// OT-RFC-27 Codex OAuth login (PKCE): challenge correctness, refused state
// mismatches, the token exchange against a fake endpoint, the auth file's
// shape and modes (0600 file under a 0700 `.secrets/`), timeout, one flow at
// a time, an injectable port.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CodexOAuthFlow,
  codexAccountId,
  pkceChallenge,
} from '../src/marketplace-codex-oauth-flow.js';
import { tempHome } from './marketplace-gateway-fixtures.js';

const flows: CodexOAuthFlow[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const flow of flows.splice(0)) flow.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const mode = (path: string): number => statSync(path).mode & 0o777;
const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const ACCESS = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' }, exp: 4_000_000_000 });

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function fakeTokenEndpoint(reply: { status: number; body: unknown }): Promise<{ url: string; requests: URLSearchParams[] }> {
  const requests: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(new URLSearchParams(body));
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/token`, requests };
}

function newFlow(): CodexOAuthFlow {
  const flow = new CodexOAuthFlow();
  flows.push(flow);
  return flow;
}

describe('PKCE and claims', () => {
  it('S256 challenge matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('reads the ChatGPT account claim from the access token, then the id token', () => {
    expect(codexAccountId(ACCESS)).toBe('acct_123');
    expect(codexAccountId('garbage', jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9' } }))).toBe('acct_9');
    expect(codexAccountId('garbage')).toBeUndefined();
  });
});

describe('CodexOAuthFlow', () => {
  it('runs the full flow: authorize URL, state check, exchange, 0600 auth file under 0700 .secrets', async () => {
    const home = tempHome();
    const authFile = join(home, 'marketplace', '.secrets', 'codex-auth.json');
    // A pre-existing, too-open file and directory are tightened.
    mkdirSync(dirname(authFile), { recursive: true, mode: 0o755 });
    chmodSync(dirname(authFile), 0o755);
    writeFileSync(authFile, '{}');
    chmodSync(authFile, 0o644);
    const token = await fakeTokenEndpoint({ status: 200, body: { access_token: ACCESS, refresh_token: 'rt-1', id_token: 'it-1' } });
    const port = await freePort();
    const flow = newFlow();
    const started = await flow.start({ authFile, tokenUrl: token.url, port, authBase: 'https://auth.example' });
    expect(started.status).toBe('pending');
    const authorize = new URL(started.authorizeUrl!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://auth.example/oauth/authorize');
    const params = authorize.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(params.get('redirect_uri')).toBe(`http://localhost:${port}/auth/callback`);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = params.get('state')!;

    // One flow at a time: a second start returns the pending one.
    expect((await flow.start({ authFile, tokenUrl: token.url, port })).authorizeUrl).toBe(started.authorizeUrl);

    // A wrong state is refused and the flow stays pending.
    const wrong = await fetch(`http://127.0.0.1:${port}/auth/callback?state=nope&code=c1`);
    expect(wrong.status).toBe(400);
    expect(flow.status().status).toBe('pending');
    expect(token.requests).toHaveLength(0);

    const ok = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${encodeURIComponent(state)}&code=code-xyz`);
    expect(ok.status).toBe(200);
    expect(flow.status().status).toBe('done');
    expect(token.requests).toHaveLength(1);
    const exchange = token.requests[0];
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('code-xyz');
    expect(exchange.get('redirect_uri')).toBe(`http://localhost:${port}/auth/callback`);
    expect(pkceChallenge(exchange.get('code_verifier')!)).toBe(params.get('code_challenge'));

    const stored = JSON.parse(readFileSync(authFile, 'utf8'));
    expect(stored).toEqual({
      auth_mode: 'chatgpt',
      tokens: { access_token: ACCESS, refresh_token: 'rt-1', id_token: 'it-1', account_id: 'acct_123' },
      last_refresh: expect.any(String),
    });
    expect(mode(authFile)).toBe(0o600);
    expect(mode(dirname(authFile))).toBe(0o700);
    expect(JSON.stringify(flow.status())).not.toContain('rt-1');
    // The listener is gone after the flow completes.
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback`)).rejects.toThrow();
  });

  it('a refused exchange ends in error without writing tokens or leaking them', async () => {
    const home = tempHome();
    const authFile = join(home, 'codex-auth.json');
    const token = await fakeTokenEndpoint({ status: 401, body: { error: 'invalid_grant', refresh_token: 'leak?' } });
    const port = await freePort();
    const flow = newFlow();
    const started = await flow.start({ authFile, tokenUrl: token.url, port });
    const state = new URL(started.authorizeUrl!).searchParams.get('state')!;
    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?state=${encodeURIComponent(state)}&code=c`);
    expect(res.status).toBe(400);
    expect(flow.status()).toMatchObject({ status: 'error', detail: 'E_OAUTH_EXCHANGE_401' });
    expect(() => readFileSync(authFile)).toThrow();
  });

  it('an incomplete token set or a missing account claim is refused', async () => {
    for (const [body, detail] of [
      [{ access_token: ACCESS }, 'E_OAUTH_INCOMPLETE'],
      [{ access_token: jwt({}), refresh_token: 'r' }, 'E_OAUTH_NO_ACCOUNT'],
    ] as const) {
      const token = await fakeTokenEndpoint({ status: 200, body });
      const port = await freePort();
      const flow = newFlow();
      const started = await flow.start({ authFile: join(tempHome(), 'a.json'), tokenUrl: token.url, port });
      const state = new URL(started.authorizeUrl!).searchParams.get('state')!;
      await fetch(`http://127.0.0.1:${port}/auth/callback?state=${encodeURIComponent(state)}&code=c`);
      expect(flow.status().detail).toBe(detail);
    }
  });

  it('times out', async () => {
    const port = await freePort();
    const flow = newFlow();
    await flow.start({ authFile: join(tempHome(), 'a.json'), port, timeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(flow.status()).toMatchObject({ status: 'error', detail: 'E_OAUTH_TIMEOUT' });
  });

  it('a busy port is reported, and a later start can retry', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const flow = newFlow();
    expect(await flow.start({ authFile: join(tempHome(), 'a.json'), port })).toMatchObject({ status: 'error', detail: `E_OAUTH_PORT_${port}_BUSY` });
    const retry = await flow.start({ authFile: join(tempHome(), 'a.json'), port: await freePort() });
    expect(retry.status).toBe('pending');
  });
});
