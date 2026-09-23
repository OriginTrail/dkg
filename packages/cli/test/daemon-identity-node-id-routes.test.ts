// Tests for the Profile nodeId routes (/api/identity/node-id and /sync).
// Same hand-rolled RequestContext pattern as daemon-operational-wallet-routes:
// only the fields the route touches are populated.

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent, type ProfileNodeIdStatus, type ProfileNodeIdSyncResult } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, MockChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
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

// Through the top-level daemon dispatcher, with the agent's real nodeId
// methods (DKGAgent.prototype) over a real chain adapter class.
describe('/api/identity/node-id through handleRequest()', () => {
  const AGENT_ADDRESS = '0x' + '1'.repeat(40);

  /** Just the fields the dispatcher and the agent's nodeId methods read. */
  function nodeAgent(chain: ChainAdapter) {
    const proto = DKGAgent.prototype as any;
    return {
      chain,
      node: { peerId: { toString: () => PEER_ID } },
      resolveAgentAddress: () => ethers.ZeroAddress,
      getProfileNodeIdStatus: proto.getProfileNodeIdStatus,
      syncProfileNodeId: vi.fn(proto.syncProfileNodeId),
    };
  }

  async function dispatch(method: string, path: string, agent: unknown, as: 'node' | 'agent' = 'node') {
    const res = fakeRes();
    await handleRequest({
      req: { method, url: path, headers: { host: '127.0.0.1' } },
      res,
      agent,
      // Read only by the last handler before the dispatcher's 404.
      routePlugins: [],
      publisherState: { runtime: undefined, availability: undefined },
      authentication: as === 'node'
        ? requestAuthentication({ kind: 'nodeOperator' })
        : requestAuthentication({ kind: 'agent', agentAddress: AGENT_ADDRESS }),
    } as unknown as HandleRequestInput);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  /**
   * The EVM adapter losing the race for this node's peer id: the pre-read
   * says the value is free, but the Profile.updateNodeId preflight reverts
   * with ethers' decoded NodeIdAlreadyExists. Only the RPC seams are stubbed;
   * the revert-to-"taken" mapping under test is the adapter's own.
   */
  function evmAdapterLosingTheRace() {
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:59997',
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      adminPrivateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
    });
    const profileInterface = new ethers.Interface(['function updateNodeId(uint72 identityId, bytes nodeId)']);
    const selector = profileInterface.getFunction('updateNodeId')!.selector.slice(2);
    const profile = { interface: profileInterface, getAddress: async () => '0x' + '5a'.repeat(20) };
    const sends: string[] = [];
    Object.assign(adapter, {
      init: async () => undefined,
      getIdentityId: async () => 63n,
      resolveContract: async (name: string) => (name === 'Profile' ? profile : { name }),
      readContract: async (_contract: unknown, _label: string, method: string) => {
        if (method === 'getNodeId') return LEGACY;
        if (method === 'nodeIdsList') return false;
        if (method === 'version') return '10.1.0';
        throw new Error(`unexpected read ${method}`);
      },
      readProvider: async (_label: string, fn: (provider: unknown) => Promise<unknown>) =>
        fn({ getCode: async () => `0x6080604052${'63' + selector}1461002a57fe` }),
      rebindContract: () => ({
        getFunction: () => ({
          staticCall: async () => {
            throw Object.assign(new Error('execution reverted: NodeIdAlreadyExists'), {
              code: 'CALL_EXCEPTION',
              revert: { name: 'NodeIdAlreadyExists', args: [EXPECTED] },
            });
          },
        }),
      }),
      sendContractTransaction: async (_contract: unknown, method: string) => {
        sends.push(method);
        throw new Error('must not send after the preflight revert');
      },
    });
    return { adapter: adapter as ChainAdapter, sends };
  }

  it('reports the status and syncs a legacy nodeId (200, not the dispatcher 404)', async () => {
    const chain = new MockChainAdapter();
    await chain.ensureProfile();
    const agent = nodeAgent(chain);

    const before = await dispatch('GET', '/api/identity/node-id', agent);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ peerId: PEER_ID, expectedNodeId: EXPECTED, state: 'legacy' });

    const synced = await dispatch('POST', '/api/identity/node-id/sync', agent);
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ outcome: 'updated', status: { state: 'in-sync', onChainNodeId: EXPECTED } });
    expect(agent.syncProfileNodeId).toHaveBeenCalledWith('manual');
    await expect(chain.getProfileNodeId()).resolves.toBe(EXPECTED);
  });

  it('answers a lost race for the peer id as outcome "taken" (200), not a 500', async () => {
    const { adapter, sends } = evmAdapterLosingTheRace();
    const { status, body } = await dispatch('POST', '/api/identity/node-id/sync', nodeAgent(adapter));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: 'taken',
      txHash: null,
      status: { identityId: '63', state: 'legacy', onChainNodeId: LEGACY, expectedNodeIdTaken: true },
    });
    expect(body.message).toContain(`peer id ${PEER_ID} is already registered as the nodeId of another identity`);
    expect(sends).toEqual([]);
  });

  it('requires the node-admin token for the sync; the status read takes an agent token', async () => {
    const chain = new MockChainAdapter();
    await chain.ensureProfile();
    const legacy = await chain.getProfileNodeId();
    const agent = nodeAgent(chain);

    const refused = await dispatch('POST', '/api/identity/node-id/sync', agent, 'agent');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Node-admin token required/);
    expect(agent.syncProfileNodeId).not.toHaveBeenCalled();
    await expect(chain.getProfileNodeId()).resolves.toBe(legacy);

    const read = await dispatch('GET', '/api/identity/node-id', agent, 'agent');
    expect(read.status).toBe(200);
    expect(read.body.state).toBe('legacy');

    // A method the routes do not serve falls through to the dispatcher's 404.
    const wrongMethod = await dispatch('GET', '/api/identity/node-id/sync', agent);
    expect(wrongMethod).toEqual({ status: 404, body: { error: 'Not found' } });
  });
});
