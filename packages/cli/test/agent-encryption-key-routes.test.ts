// Tests for the encryption-key management HTTP routes added in PR #540.
//
// All three routes are exercised through `handleAgentChatRoutes` with a
// hand-rolled `RouteRequestContext` — same pattern as `daemon-pca-routes.test.ts`.
// We only populate the fields the new routes actually touch, so any
// accidental dependency on the wider ctx surface would surface as an
// undefined-property crash and we'd notice.

import { describe, it, expect } from 'vitest';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RouteRequestContext } from '../src/daemon/routes/context.js';
import { testRouteIdentityFields } from './helpers/route-request-context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, opts?: { body?: unknown; bearer?: string }) {
  const req: any = { method, url: path, headers: {} };
  if (opts?.bearer) {
    req.headers.authorization = `Bearer ${opts.bearer}`;
  }
  if (opts?.body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(opts.body));
  }
  return req;
}

function runCtx(
  method: string,
  rawPath: string,
  agent: any,
  opts?: { body?: unknown; bearer?: string; requestAgentAddress?: string },
) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${rawPath}`);
  // Derive requestToken / requestAgentAddress the same way the real
  // request pipeline does, so the route's `resolveAgentByToken` call
  // sees the same bearer the test passed in.
  const requestToken = opts?.bearer;
  const requestAgentAddress = opts?.requestAgentAddress ?? '';
  const ctx = {
    req: fakeReq(method, rawPath, opts),
    res,
    agent,
    path: url.pathname,
    url,
    ...testRouteIdentityFields({ token: requestToken, agentAddress: requestAgentAddress }),
    validTokens: new Set<string>(),
  } as unknown as RouteRequestContext;
  return { res, done: handleAgentChatRoutes(ctx) };
}

describe('POST /api/agent/:address/rotate-encryption-key — authorization gate', () => {
  // Codex round-2 review on PR #540: the route accepted any valid
  // agent token. These tests pin down the gate added in the fix.

  const TARGET = '0x' + 'a'.repeat(40);
  const ATTACKER = '0x' + 'b'.repeat(40);

  function agentStub(opts: {
    rotateCalls?: { address: string; opts: unknown }[];
    tokenToAddress?: Record<string, string>;
  }) {
    return {
      rotateWorkspaceEncryptionKey: async (address: string, o: unknown) => {
        opts.rotateCalls?.push({ address, opts: o });
        return { newKeyId: 'did:dkg:agent:x#x25519-new', profilePublished: true };
      },
      revokeWorkspaceEncryptionKey: async () => ({
        revokedKeyId: 'k', revokedAt: 't', profilePublished: true,
      }),
      publishProfile: async () => ({ ual: null }),
      resolveAgentByToken: (tok: string) => opts.tokenToAddress?.[tok],
    };
  }

  it('rejects with 403 when a different agent\'s token tries to rotate (cross-agent)', async () => {
    const rotateCalls: any[] = [];
    const agent = agentStub({
      rotateCalls,
      tokenToAddress: { 'dkg_at_attacker': ATTACKER },
    });

    const { res, done } = runCtx(
      'POST',
      `/api/agent/${TARGET}/rotate-encryption-key`,
      agent,
      { bearer: 'dkg_at_attacker', body: {} },
    );
    await done;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/cannot manage encryption keys/);
    expect(rotateCalls).toHaveLength(0);
  });

  it('allows agent-scoped token to rotate ITS OWN encryption key', async () => {
    const rotateCalls: any[] = [];
    const agent = agentStub({
      rotateCalls,
      tokenToAddress: { 'dkg_at_self': TARGET },
    });

    const { res, done } = runCtx(
      'POST',
      `/api/agent/${TARGET}/rotate-encryption-key`,
      agent,
      { bearer: 'dkg_at_self', body: {} },
    );
    await done;
    expect(res.statusCode).toBe(200);
    expect(rotateCalls).toEqual([{ address: TARGET, opts: { retireOld: false } }]);
  });

  it('node-admin token (resolveAgentByToken returns undefined) may rotate any local agent', async () => {
    const rotateCalls: any[] = [];
    const agent = agentStub({ rotateCalls, tokenToAddress: {} });

    const { res, done } = runCtx(
      'POST',
      `/api/agent/${TARGET}/rotate-encryption-key`,
      agent,
      { bearer: 'admin-token-not-in-agent-index', body: { retireOld: true } },
    );
    await done;
    expect(res.statusCode).toBe(200);
    expect(rotateCalls).toEqual([{ address: TARGET, opts: { retireOld: true } }]);
  });

  it('case-insensitive address compare: lowercase URL + checksum token, or vice versa, still authorizes self-rotation', async () => {
    const rotateCalls: any[] = [];
    // EIP-55 checksum form on the token side; lowercase on the URL.
    const checksum = '0xCdba429ca35B458E83420B8FD101172fd8B7CFA5';
    const lower = checksum.toLowerCase();
    const agent = agentStub({
      rotateCalls,
      tokenToAddress: { 'dkg_at_self': checksum },
    });

    const { res, done } = runCtx(
      'POST',
      `/api/agent/${lower}/rotate-encryption-key`,
      agent,
      { bearer: 'dkg_at_self', body: {} },
    );
    await done;
    expect(res.statusCode).toBe(200);
    expect(rotateCalls).toHaveLength(1);
  });
});

describe('POST /api/agent/:address/revoke-encryption-key — authorization gate', () => {
  const TARGET = '0x' + 'a'.repeat(40);
  const ATTACKER = '0x' + 'b'.repeat(40);
  const KEY_ID = `did:dkg:agent:${TARGET}#x25519-1234abcd`;

  function agentStub(opts: {
    revokeCalls?: { address: string; keyId: string }[];
    tokenToAddress?: Record<string, string>;
  }) {
    return {
      rotateWorkspaceEncryptionKey: async () => ({ newKeyId: 'x', profilePublished: true }),
      revokeWorkspaceEncryptionKey: async (address: string, keyId: string) => {
        opts.revokeCalls?.push({ address, keyId });
        return { revokedKeyId: keyId, revokedAt: 't', profilePublished: true };
      },
      publishProfile: async () => ({ ual: null }),
      resolveAgentByToken: (tok: string) => opts.tokenToAddress?.[tok],
    };
  }

  it('rejects 403 cross-agent revoke', async () => {
    const revokeCalls: any[] = [];
    const agent = agentStub({
      revokeCalls,
      tokenToAddress: { 'dkg_at_attacker': ATTACKER },
    });
    const { res, done } = runCtx(
      'POST',
      `/api/agent/${TARGET}/revoke-encryption-key`,
      agent,
      { bearer: 'dkg_at_attacker', body: { keyId: KEY_ID } },
    );
    await done;
    expect(res.statusCode).toBe(403);
    expect(revokeCalls).toHaveLength(0);
  });

  it('allows self-revoke and node-admin revoke', async () => {
    const revokeCalls: any[] = [];
    const agent = agentStub({
      revokeCalls,
      tokenToAddress: { 'dkg_at_self': TARGET },
    });
    // self
    const r1 = runCtx('POST', `/api/agent/${TARGET}/revoke-encryption-key`, agent, {
      bearer: 'dkg_at_self', body: { keyId: KEY_ID },
    });
    await r1.done;
    expect(r1.res.statusCode).toBe(200);
    // node admin
    const r2 = runCtx('POST', `/api/agent/${TARGET}/revoke-encryption-key`, agent, {
      bearer: 'admin', body: { keyId: KEY_ID },
    });
    await r2.done;
    expect(r2.res.statusCode).toBe(200);
    expect(revokeCalls).toHaveLength(2);
  });
});

describe('POST /api/agent/publish-profile — retry endpoint', () => {
  function agentStub(opts: {
    publishCalls?: number[];
    publishImpl?: () => Promise<unknown>;
    tokenToAddress?: Record<string, string>;
  }) {
    return {
      rotateWorkspaceEncryptionKey: async () => ({ newKeyId: 'x', profilePublished: true }),
      revokeWorkspaceEncryptionKey: async () => ({
        revokedKeyId: 'k', revokedAt: 't', profilePublished: true,
      }),
      publishProfile: async () => {
        opts.publishCalls?.push(Date.now());
        return opts.publishImpl ? opts.publishImpl() : { ual: 'did:dkg:profile:test' };
      },
      resolveAgentByToken: (tok: string) => opts.tokenToAddress?.[tok],
    };
  }

  it('200 with node-admin token and returns ual', async () => {
    const publishCalls: number[] = [];
    const agent = agentStub({ publishCalls, tokenToAddress: {} });
    const { res, done } = runCtx('POST', '/api/agent/publish-profile', agent, { bearer: 'admin' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(publishCalls).toHaveLength(1);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.ual).toBe('did:dkg:profile:test');
  });

  it('rejects agent-scoped token with 403', async () => {
    const publishCalls: number[] = [];
    const agent = agentStub({
      publishCalls,
      tokenToAddress: { 'dkg_at_alice': '0x' + 'a'.repeat(40) },
    });
    const { res, done } = runCtx('POST', '/api/agent/publish-profile', agent, { bearer: 'dkg_at_alice' });
    await done;
    expect(res.statusCode).toBe(403);
    expect(publishCalls).toHaveLength(0);
  });

  it('surfaces publishProfile failure as 502 with the error message', async () => {
    const agent = agentStub({
      publishImpl: async () => { throw new Error('chain rpc unreachable'); },
      tokenToAddress: {},
    });
    const { res, done } = runCtx('POST', '/api/agent/publish-profile', agent, { bearer: 'admin' });
    await done;
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/chain rpc unreachable/);
  });
});

describe('GET /api/agent/:address/encryption-keys', () => {
  const TARGET = '0x' + 'a'.repeat(40);
  const ATTACKER = '0x' + 'b'.repeat(40);
  const SECRET_PRIV = 'PRIVATE_ENCRYPTION_KEY_MUST_NOT_LEAK';

  function agentStub(tokenToAddress: Record<string, string> = {}) {
    return {
      resolveAgentByToken: (tok: string) => tokenToAddress[tok],
      listLocalAgents: () => [
        {
          agentAddress: TARGET,
          name: 'node-agent',
          workspaceEncryptionKeys: [
            {
              encryptionKeyId: 'did:dkg:agent:x#x25519-active',
              encryptionKeyAlgorithm: 'x25519',
              publicEncryptionKey: '0xpub1',
              // This MUST never reach the response body.
              privateEncryptionKey: SECRET_PRIV,
              encryptionKeyProof: '0xproof1',
              createdAt: '2026-01-01T00:00:00Z',
            },
            {
              encryptionKeyId: 'did:dkg:agent:x#x25519-retired',
              encryptionKeyAlgorithm: 'x25519',
              publicEncryptionKey: '0xpub2',
              privateEncryptionKey: SECRET_PRIV,
              encryptionKeyProof: '0xproof2',
              createdAt: '2026-01-02T00:00:00Z',
              revokedAt: '2026-02-01T00:00:00Z',
            },
          ],
        },
      ],
    };
  }

  it('returns active + retired keys with PUBLIC fields only — never private key material', async () => {
    const agent = agentStub({ admin: '' /* node-admin token: resolveAgentByToken → undefined */ });
    const { res, done } = runCtx('GET', `/api/agent/${TARGET}/encryption-keys`, agent, { bearer: 'admin' });
    await done;
    expect(res.statusCode).toBe(200);
    // SECURITY: the private encryption key must not appear anywhere.
    expect(res.body).not.toContain(SECRET_PRIV);
    expect(res.body).not.toContain('privateEncryptionKey');

    const parsed = JSON.parse(res.body);
    expect(parsed.agentAddress).toBe(TARGET);
    expect(parsed.keys).toHaveLength(2);
    expect(parsed.keys[0]).toEqual({
      encryptionKeyId: 'did:dkg:agent:x#x25519-active',
      encryptionKeyAlgorithm: 'x25519',
      publicEncryptionKey: '0xpub1',
      encryptionKeyProof: '0xproof1',
      createdAt: '2026-01-01T00:00:00Z',
      revokedAt: null,
      status: 'active',
    });
    expect(parsed.keys[1].status).toBe('revoked');
    expect(parsed.keys[1].revokedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('returns 404 when no local agent matches the address', async () => {
    const agent = agentStub();
    const { res, done } = runCtx('GET', `/api/agent/${ATTACKER}/encryption-keys`, agent, { bearer: 'admin' });
    await done;
    expect(res.statusCode).toBe(404);
  });

  it('rejects a cross-agent token with 403', async () => {
    const agent = agentStub({ dkg_at_attacker: ATTACKER });
    const { res, done } = runCtx('GET', `/api/agent/${TARGET}/encryption-keys`, agent, { bearer: 'dkg_at_attacker' });
    await done;
    expect(res.statusCode).toBe(403);
  });
});
