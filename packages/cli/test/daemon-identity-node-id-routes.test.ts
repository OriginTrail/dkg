// Tests for the Profile nodeId routes (/api/identity/node-id and /sync).
// Same hand-rolled RequestContext pattern as daemon-operational-wallet-routes:
// only the fields the route touches are populated.

import { describe, expect, it } from 'vitest';
import type { ProfileNodeIdStatus, ProfileNodeIdSyncResult } from '@origintrail-official/dkg-agent';
import { handleIdentityNodeIdRoutes } from '../src/daemon/routes/identity-node-id.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const EXPECTED = `0x${Buffer.from(PEER_ID, 'utf8').toString('hex')}`;
const LEGACY = '0x' + '7c'.repeat(32);

const STATUS: ProfileNodeIdStatus = {
  identityId: 63n,
  peerId: PEER_ID,
  expectedNodeId: EXPECTED,
  onChainNodeId: LEGACY,
  onChainPeerId: null,
  state: 'legacy',
  expectedNodeIdTaken: false,
  expectedNodeIdHolder: null,
  support: {
    supported: true,
    profileAddress: '0x370943487c766633Da68DB4048E57674a7a6c076',
    profileVersion: '10.1.0',
    requiredVersion: '10.1.0',
  },
};

function fakeRes() {
  const res: any = { statusCode: 0, body: '', writableEnded: false, headers: {} };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  res.end = (body: string) => { res.body = body; res.writableEnded = true; };
  return res;
}

function runCtx(
  method: string,
  path: string,
  agent: any,
  auth?: { enabled: boolean; token?: string; agentToken?: boolean },
) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req: { method, url: path },
    res,
    agent,
    path: url.pathname,
    url,
    config: { auth: { enabled: auth?.enabled ?? false } },
    authentication: auth?.enabled
      ? (auth.agentToken
        ? requestAuthentication({ kind: 'agent', agentAddress: '0x' + '1'.repeat(40), token: auth.token ?? 'agent-token' })
        : requestAuthentication({ kind: 'nodeOperator', token: auth.token ?? 'node-token' }))
      : requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
  } as unknown as RequestContext;
  return { res, done: handleIdentityNodeIdRoutes(ctx) };
}

function recordingAgent(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const agent = {
    getProfileNodeIdStatus: async () => STATUS,
    syncProfileNodeId: async (...args: unknown[]): Promise<ProfileNodeIdSyncResult | null> => {
      calls.push(args);
      return {
        outcome: 'updated',
        status: { ...STATUS, onChainNodeId: EXPECTED, onChainPeerId: PEER_ID, state: 'in-sync', expectedNodeIdTaken: null },
        tx: { hash: '0x' + 'ab'.repeat(32), blockNumber: 1234, success: true },
        signer: '0x' + '2'.repeat(40),
      };
    },
    ...overrides,
  };
  return { agent, calls };
}

describe('GET /api/identity/node-id', () => {
  it('serializes the status, with bigints as strings', async () => {
    const { res, done } = runCtx('GET', '/api/identity/node-id', recordingAgent().agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      identityId: '63',
      peerId: PEER_ID,
      expectedNodeId: EXPECTED,
      onChainNodeId: LEGACY,
      onChainPeerId: null,
      state: 'legacy',
      expectedNodeIdTaken: false,
      expectedNodeIdHolder: null,
      profile: {
        address: '0x370943487c766633Da68DB4048E57674a7a6c076',
        version: '10.1.0',
        updateNodeIdSupported: true,
        requiredVersion: '10.1.0',
      },
    });
  });

  it('serializes a sharding-table holder of the peer id', async () => {
    const agent = recordingAgent({
      getProfileNodeIdStatus: async () => ({ ...STATUS, expectedNodeIdTaken: true, expectedNodeIdHolder: 61n }),
    }).agent;
    const { res, done } = runCtx('GET', '/api/identity/node-id', agent);
    await done;
    expect(JSON.parse(res.body)).toMatchObject({ expectedNodeIdTaken: true, expectedNodeIdHolder: '61' });
  });

  it('answers 503 without a chain surface, and maps chain failures', async () => {
    const unavailable = runCtx('GET', '/api/identity/node-id', recordingAgent({ getProfileNodeIdStatus: async () => null }).agent);
    await unavailable.done;
    expect(unavailable.res.statusCode).toBe(503);
    expect(JSON.parse(unavailable.res.body).code).toBe('PROFILE_NODE_ID_UNAVAILABLE');

    const noChain = runCtx('GET', '/api/identity/node-id', recordingAgent({
      getProfileNodeIdStatus: async () => { throw new Error('No blockchain configured. To use on-chain operations…'); },
    }).agent);
    await noChain.done;
    expect(noChain.res.statusCode).toBe(503);

    const rpc = runCtx('GET', '/api/identity/node-id', recordingAgent({
      getProfileNodeIdStatus: async () => { throw Object.assign(new Error('all endpoints failed'), { code: 'RPC_ENDPOINTS_EXHAUSTED' }); },
    }).agent);
    await rpc.done;
    expect(rpc.res.statusCode).toBe(503);
    expect(JSON.parse(rpc.res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');

    const broken = runCtx('GET', '/api/identity/node-id', recordingAgent({
      getProfileNodeIdStatus: async () => { throw new Error('boom'); },
    }).agent);
    await broken.done;
    expect(broken.res.statusCode).toBe(500);
    expect(JSON.parse(broken.res.body).error).toBe('profile nodeId status failed: boom');
  });
});

describe('POST /api/identity/node-id/sync', () => {
  it("syncs in manual mode and returns the outcome, the operator line and the tx", async () => {
    const { agent, calls } = recordingAgent();
    const { res, done } = runCtx('POST', '/api/identity/node-id/sync', agent, { enabled: true });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['manual']]);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      outcome: 'updated',
      txHash: '0x' + 'ab'.repeat(32),
      blockNumber: 1234,
      signer: '0x' + '2'.repeat(40),
      status: { state: 'in-sync', onChainNodeId: EXPECTED, onChainPeerId: PEER_ID },
    });
    expect(body.message).toBe(
      `Profile nodeId of identity 63 now names this node's peer id ${PEER_ID} (tx 0x${'ab'.repeat(32)})`,
    );
  });

  it('returns a non-updating outcome as a normal answer', async () => {
    const agent = recordingAgent({
      syncProfileNodeId: async () => ({
        outcome: 'unsupported',
        status: { ...STATUS, support: { ...STATUS.support, supported: false, profileVersion: '10.0.2' } },
      }),
    }).agent;
    const { res, done } = runCtx('POST', '/api/identity/node-id/sync', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ outcome: 'unsupported', txHash: null, signer: null });
    expect(JSON.parse(res.body).message).toContain('needs Profile >= 10.1.0');
  });

  it('refuses an agent-scoped token before touching the chain', async () => {
    const { agent, calls } = recordingAgent();
    const { res, done } = runCtx('POST', '/api/identity/node-id/sync', agent, { enabled: true, agentToken: true });
    await done;
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers 503 without a chain surface and 500 on an unexpected failure', async () => {
    const unavailable = runCtx('POST', '/api/identity/node-id/sync', recordingAgent({ syncProfileNodeId: async () => null }).agent);
    await unavailable.done;
    expect(unavailable.res.statusCode).toBe(503);

    const broken = runCtx('POST', '/api/identity/node-id/sync', recordingAgent({
      syncProfileNodeId: async () => { throw new Error('nonce too low'); },
    }).agent);
    await broken.done;
    expect(broken.res.statusCode).toBe(500);
    expect(JSON.parse(broken.res.body).error).toBe('profile nodeId sync failed: nonce too low');
  });
});

describe('other requests', () => {
  it('leave other paths and methods to the next handler', async () => {
    for (const [method, path] of [
      ['GET', '/api/operational-wallets'],
      ['POST', '/api/identity/node-id'],
      ['GET', '/api/identity/node-id/sync'],
    ] as const) {
      const { res, done } = runCtx(method, path, recordingAgent().agent);
      await done;
      expect(res.writableEnded, `${method} ${path}`).toBe(false);
    }
  });
});
