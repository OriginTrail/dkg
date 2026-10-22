import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { ensureCuratorConnected } from '../src/curator-peer-connection.js';

const CURATOR_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const OTHER_PEER_ID = '12D3KooWR5C8ajtPigVGnBwDGTZ4XAtCepRs2WCgfPuBPrgGqcNK';
const CONTEXT = { kind: 'sync', id: 'curator-connection-test', startedAt: 0 } as OperationContext;

function makeAgent(
  outcome: { status: 'connected'; resolvedAddresses: string[] }
    | { status: 'unresolved'; resolvedAddresses: [] } = {
      status: 'connected', resolvedAddresses: [],
    },
) {
  let connected = false;
  const connect = vi.fn(async () => outcome);
  return {
    node: { libp2p: { getConnections: () => connected
      ? [{ remotePeer: { toString: () => CURATOR_PEER_ID } }]
      : [] } },
    peerResolver: { connect },
    log: { warn: vi.fn() },
    markConnected: () => { connected = true; },
  };
}

describe('curator connection recovery request', () => {
  it('forwards a verified private hint to the canonical resolver', async () => {
    const agent = makeAgent();
    const hint = `/ip4/127.0.0.1/tcp/9090/p2p/${CURATOR_PEER_ID}`;
    await expect(ensureCuratorConnected(
      agent, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined, hint,
    )).resolves.toBe(true);
    expect(agent.peerResolver.connect).toHaveBeenCalledOnce();
    expect(agent.peerResolver.connect).toHaveBeenCalledWith(CURATOR_PEER_ID, expect.objectContaining({
      recovery: expect.objectContaining({ verifiedInitialAddress: hint }),
    }));
  });

  it('drops a wrong-target hint while retaining resolver fallback', async () => {
    const agent = makeAgent();
    await expect(ensureCuratorConnected(
      agent, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined,
      `/ip4/127.0.0.1/tcp/9090/p2p/${OTHER_PEER_ID}`,
    )).resolves.toBe(true);
    expect(agent.peerResolver.connect).toHaveBeenCalledWith(CURATOR_PEER_ID, expect.objectContaining({
      recovery: expect.objectContaining({ verifiedInitialAddress: undefined }),
    }));
  });

  it('uses the resolver outcome instead of re-reading raw libp2p state', async () => {
    const connectedAgent = makeAgent();
    await expect(ensureCuratorConnected(
      connectedAgent, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined,
    )).resolves.toBe(true);

    const unresolvedAgent = makeAgent({ status: 'unresolved', resolvedAddresses: [] });
    await expect(ensureCuratorConnected(
      unresolvedAgent, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined,
    )).resolves.toBe(false);
  });

  it('keeps the synchronous read-only connection fast path', () => {
    const agent = makeAgent();
    agent.markConnected();
    expect(ensureCuratorConnected(
      agent, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined,
    )).toBe(true);
    expect(agent.peerResolver.connect).not.toHaveBeenCalled();
  });
});
