import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKGAgent,
  signAgentPeerIdBinding,
} from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function runRegister(agent: DKGAgent, body: unknown) {
  const path = '/api/agent/register';
  const req: any = {
    method: 'POST',
    url: path,
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  };
  const res = fakeRes();
  const validTokens = new Set<string>();
  const ctx = {
    req,
    res,
    agent,
    path,
    url: new URL(`http://127.0.0.1${path}`),
    requestToken: undefined,
    requestAgentAddress: '',
    validTokens,
  } as unknown as RequestContext;
  return { res, validTokens, done: handleAgentChatRoutes(ctx) };
}

describe('POST /api/agent/register peer binding', () => {
  let agent: DKGAgent;

  beforeEach(async () => {
    agent = await DKGAgent.create({
      name: 'PeerBindingRoute',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: new MockChainAdapter(),
    });
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop().catch(() => {});
    await agent.store.close().catch(() => {});
  });

  it('forwards a valid off-node proof to registerAgent and returns 200', async () => {
    const wallet = ethers.Wallet.createRandom();
    const peerIdProof = signAgentPeerIdBinding(
      wallet.address,
      agent.peerId,
      wallet.privateKey,
    );
    const register = vi.spyOn(agent, 'registerAgent');
    const { res, validTokens, done } = runRegister(agent, {
      name: 'RouteBound',
      publicKey: wallet.signingKey.publicKey,
      peerIdProof,
      framework: 'route-test',
    });

    await done;

    expect(res.statusCode).toBe(200);
    expect(register).toHaveBeenCalledWith('RouteBound', {
      publicKey: wallet.signingKey.publicKey,
      peerIdProof,
      framework: 'route-test',
    });
    expect(validTokens).toContain(JSON.parse(res.body).authToken);
  });

  it('rejects a proof without a self-sovereign public key', async () => {
    const wallet = ethers.Wallet.createRandom();
    const peerIdProof = signAgentPeerIdBinding(
      wallet.address,
      agent.peerId,
      wallet.privateKey,
    );
    const { res, done } = runRegister(agent, {
      name: 'RouteMissingPublicKey',
      peerIdProof,
    });

    await done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/only accepted for self-sovereign agents/u);
  });

  it('rejects a proof signed by a different wallet', async () => {
    const requestedWallet = ethers.Wallet.createRandom();
    const signer = ethers.Wallet.createRandom();
    const peerIdProof = signAgentPeerIdBinding(
      signer.address,
      agent.peerId,
      signer.privateKey,
    );
    const { res, done } = runRegister(agent, {
      name: 'RouteWrongWallet',
      publicKey: requestedWallet.signingKey.publicKey,
      peerIdProof,
    });

    await done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not authorize node peer/u);
  });

  it('rejects a proof bound to a different peer ID', async () => {
    const wallet = ethers.Wallet.createRandom();
    const peerIdProof = signAgentPeerIdBinding(
      wallet.address,
      '12D3KooWWrongRoutePeer',
      wallet.privateKey,
    );
    const { res, done } = runRegister(agent, {
      name: 'RouteWrongPeer',
      publicKey: wallet.signingKey.publicKey,
      peerIdProof,
    });

    await done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not authorize node peer/u);
  });

  it('keeps proofless self-sovereign registration available for migration', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { res, done } = runRegister(agent, {
      name: 'RouteProoflessMigration',
      publicKey: wallet.signingKey.publicKey,
    });

    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ mode: 'self-sovereign' });
  });
});
