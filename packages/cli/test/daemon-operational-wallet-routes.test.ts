// Tests for the node operational-wallet management routes
// (/api/operational-wallets). Same hand-rolled RequestContext pattern as
// daemon-pca-routes.test.ts — only the fields the route touches are populated.

import { describe, it, expect } from 'vitest';
import { handleOperationalWalletRoutes } from '../src/daemon/routes/operational-wallets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const PRIMARY = '0x' + '1'.repeat(40);
const SECOND = '0x' + '2'.repeat(40);
const ADMIN = '0x' + 'a'.repeat(40);
const EXTERNAL = '0x' + 'e'.repeat(40);
const SECRET_PK = '0xdeadbeef'.padEnd(66, '0');

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  return req;
}

function runCtx(
  method: string,
  rawPath: string,
  agent: any,
  opWallets: any,
  body?: unknown,
  auth?: { authEnabled?: boolean; requestToken?: string; validTokens?: Set<string> },
) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, body),
    res,
    agent,
    opWallets,
    path: url.pathname,
    url,
    // Default auth disabled → node-admin gate short-circuits true; route-logic
    // tests below run without a token. Gating is covered in its own block.
    config: { auth: { enabled: auth?.authEnabled ?? false } },
    requestToken: auth?.requestToken,
    validTokens: auth?.validTokens ?? new Set<string>(),
  } as unknown as RequestContext;
  return { res, done: handleOperationalWalletRoutes(ctx) };
}

// A wallets.json-shaped config that DELIBERATELY carries private keys, to prove
// the GET serializer never leaks them.
const opWalletsWithAdmin = {
  adminWallet: { address: ADMIN, privateKey: SECRET_PK },
  wallets: [
    { address: PRIMARY, privateKey: SECRET_PK },
    { address: SECOND, privateKey: SECRET_PK },
  ],
};

describe('GET /api/operational-wallets', () => {
  it('lists wallets with status + flags and NEVER serializes private keys', async () => {
    const agent = {
      getNodeIdentityId: async () => 5n,
      isOperationalWalletRegistered: async (_id: bigint, addr: string) =>
        addr.toLowerCase() !== SECOND.toLowerCase(), // SECOND not yet registered
    };
    const { res, done } = runCtx('GET', '/api/operational-wallets', agent, opWalletsWithAdmin);
    await done;
    expect(res.statusCode).toBe(200);
    // Security invariant: the private key must not appear anywhere in the body.
    expect(res.body).not.toContain(SECRET_PK);
    expect(res.body).not.toContain('privateKey');

    const parsed = JSON.parse(res.body);
    expect(parsed.identityId).toBe('5');
    expect(parsed.hasProfile).toBe(true);
    expect(parsed.adminKeyConfigured).toBe(true);
    expect(parsed.canManage).toBe(true);

    const byAddr = Object.fromEntries(parsed.wallets.map((w: any) => [w.address.toLowerCase(), w]));
    expect(byAddr[PRIMARY.toLowerCase()].isPrimary).toBe(true);
    expect(byAddr[PRIMARY.toLowerCase()].registered).toBe(true);
    expect(byAddr[SECOND.toLowerCase()].registered).toBe(false);
    expect(byAddr[ADMIN.toLowerCase()].isAdmin).toBe(true);
  });

  it('canManage is false when no admin key is configured', async () => {
    const agent = {
      getNodeIdentityId: async () => 5n,
      isOperationalWalletRegistered: async () => true,
    };
    const { res, done } = runCtx('GET', '/api/operational-wallets', agent, {
      wallets: [{ address: PRIMARY, privateKey: SECRET_PK }],
    });
    await done;
    const parsed = JSON.parse(res.body);
    expect(parsed.adminKeyConfigured).toBe(false);
    expect(parsed.canManage).toBe(false);
  });

  it('canManage is false when the node has no on-chain profile', async () => {
    const agent = {
      getNodeIdentityId: async () => 0n,
      isOperationalWalletRegistered: async () => null,
    };
    const { res, done } = runCtx('GET', '/api/operational-wallets', agent, opWalletsWithAdmin);
    await done;
    const parsed = JSON.parse(res.body);
    expect(parsed.hasProfile).toBe(false);
    expect(parsed.canManage).toBe(false);
    // registered stays null when there is no identity to check against.
    expect(parsed.wallets.every((w: any) => w.registered === null)).toBe(true);
  });
});

describe('POST /api/operational-wallets', () => {
  it('authorizes a valid address and forwards it to the facade', async () => {
    const calls: string[] = [];
    const agent = {
      addOperationalWallet: async (addr: string) => {
        calls.push(addr);
        return { hash: '0xtx', blockNumber: 9, txIndex: 0, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/operational-wallets', agent, opWalletsWithAdmin, { address: EXTERNAL });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).added).toBe(true);
    // The route EIP-55-checksums before forwarding; compare case-insensitively.
    expect(calls.map((c) => c.toLowerCase())).toEqual([EXTERNAL.toLowerCase()]);
  });

  it('rejects a malformed address with 400', async () => {
    const agent = { addOperationalWallet: async () => { throw new Error('should not be called'); } };
    const { res, done } = runCtx('POST', '/api/operational-wallets', agent, opWalletsWithAdmin, { address: 'not-an-address' });
    await done;
    expect(res.statusCode).toBe(400);
  });

  it('maps a missing admin key to 409 AdminKeyNotConfigured', async () => {
    const agent = {
      addOperationalWallet: async () => { throw new Error('Cannot add operational wallet to identity 5: adminPrivateKey is not configured.'); },
    };
    const { res, done } = runCtx('POST', '/api/operational-wallets', agent, opWalletsWithAdmin, { address: EXTERNAL });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('AdminKeyNotConfigured');
  });

  it('returns 503 when the chain adapter has no surface (null)', async () => {
    const agent = { addOperationalWallet: async () => null };
    const { res, done } = runCtx('POST', '/api/operational-wallets', agent, opWalletsWithAdmin, { address: EXTERNAL });
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('maps OperationalKeyTaken to 409', async () => {
    const agent = { addOperationalWallet: async () => { throw new Error('execution reverted: OperationalKeyTaken'); } };
    const { res, done } = runCtx('POST', '/api/operational-wallets', agent, opWalletsWithAdmin, { address: EXTERNAL });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('OperationalKeyTaken');
  });
});

describe('DELETE /api/operational-wallets/:address', () => {
  it('de-authorizes a valid address', async () => {
    const calls: string[] = [];
    const agent = {
      removeOperationalWallet: async (addr: string) => {
        calls.push(addr);
        return { hash: '0xtx', blockNumber: 9, txIndex: 0, success: true };
      },
    };
    const { res, done } = runCtx('DELETE', `/api/operational-wallets/${SECOND}`, agent, opWalletsWithAdmin);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).removed).toBe(true);
    expect(calls).toEqual([SECOND]);
  });

  it('maps the primary-wallet refusal to 409 CannotRemovePrimaryOperationalWallet', async () => {
    const agent = {
      removeOperationalWallet: async () => {
        throw new Error(`removeOperationalWallet: refusing to remove the node's primary operational wallet ${PRIMARY} — it anchors on-chain identity resolution.`);
      },
    };
    const { res, done } = runCtx('DELETE', `/api/operational-wallets/${PRIMARY}`, agent, opWalletsWithAdmin);
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('CannotRemovePrimaryOperationalWallet');
  });

  it('rejects a malformed address with 400', async () => {
    const agent = { removeOperationalWallet: async () => { throw new Error('should not be called'); } };
    const { res, done } = runCtx('DELETE', '/api/operational-wallets/not-an-address', agent, opWalletsWithAdmin);
    await done;
    expect(res.statusCode).toBe(400);
  });
});

describe('operational-wallet write routes — node-admin caller gating', () => {
  const ADMIN_TOKEN = 'node-admin-token';
  const AGENT_TOKEN = 'dkg_at_agent';
  const gateAgent = (extra: Record<string, any> = {}) => ({
    resolveAgentByToken: (tok: string) => (tok === AGENT_TOKEN ? '0x' + 'a'.repeat(40) : undefined),
    addOperationalWallet: async () => ({ hash: '0x', blockNumber: 1, txIndex: 0, success: true }),
    removeOperationalWallet: async () => ({ hash: '0x', blockNumber: 1, txIndex: 0, success: true }),
    ...extra,
  });

  it('rejects an agent-scoped token with 403 (POST add)', async () => {
    const { res, done } = runCtx('POST', '/api/operational-wallets', gateAgent(), opWalletsWithAdmin, { address: EXTERNAL }, {
      authEnabled: true, requestToken: AGENT_TOKEN, validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/admin token/i);
  });

  it('rejects an agent-scoped token with 403 (DELETE remove)', async () => {
    const { res, done } = runCtx('DELETE', `/api/operational-wallets/${SECOND}`, gateAgent(), opWalletsWithAdmin, undefined, {
      authEnabled: true, requestToken: AGENT_TOKEN, validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('allows a node-admin token (POST add)', async () => {
    const { res, done } = runCtx('POST', '/api/operational-wallets', gateAgent(), opWalletsWithAdmin, { address: EXTERNAL }, {
      authEnabled: true, requestToken: ADMIN_TOKEN, validTokens: new Set([ADMIN_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(200);
  });

  it('does NOT gate the read-only GET list', async () => {
    const agent = gateAgent({ getNodeIdentityId: async () => 5n, isOperationalWalletRegistered: async () => true });
    const { res, done } = runCtx('GET', '/api/operational-wallets', agent, opWalletsWithAdmin, undefined, {
      authEnabled: true, requestToken: AGENT_TOKEN, validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(200);
  });
});
