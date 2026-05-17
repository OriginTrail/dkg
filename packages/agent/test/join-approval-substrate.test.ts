import { describe, it, expect, vi } from 'vitest';
import { PROTOCOL_JOIN_REQUEST } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { JoinApprovalRetryQueue } from '../src/join-approval-retry-queue.js';

const CG = '0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E/chatt-test';
const AGENT = '0x3D6b4dee92805715cFfbE2A6C79D842f7Dce6b81';
const AGENT_TWO = '0x9fFd742fC9a07E7f4A91b9524764f2E21b5bC5f1';

function peer(id: string): { toString(): string } {
  return { toString: () => id };
}

function makeAgentLike(opts: {
  registryPeerId?: string;
  registryPeersByAgent?: Record<string, string>;
  connectedPeers?: string[];
  sendReliable?: ReturnType<typeof vi.fn>;
} = {}): DKGAgent {
  const sendReliable = opts.sendReliable ?? vi.fn(async (
    _peerId: string,
    _protocolId: string,
    _payload: Uint8Array,
    sendOpts: { messageId?: string },
  ) => ({
    delivered: true as const,
    response: new TextEncoder().encode(JSON.stringify({ ok: true })),
    attempts: 1,
    messageId: sendOpts.messageId ?? 'msg',
  }));
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.node = {
    peerId: 'self-peer',
    libp2p: {
      getConnections: vi.fn(() => []),
      getPeers: vi.fn(() => (opts.connectedPeers ?? []).map(peer)),
    },
  };
  agent.discovery = {
    findAgents: vi.fn(async () => {
      const entries: Array<{ agentAddress: string; peerId: string }> = [];
      if (opts.registryPeerId) {
        entries.push({ agentAddress: AGENT, peerId: opts.registryPeerId });
      }
      for (const [agentAddress, peerId] of Object.entries(opts.registryPeersByAgent ?? {})) {
        entries.push({ agentAddress, peerId });
      }
      return entries;
    }),
  };
  agent.messenger = {
    sendReliable,
    discardOutboxEntry: vi.fn(() => true),
  };
  agent.joinRequestOriginPeers = new Map<string, string>();
  agent.joinRequestAcceptedBy = new Map<string, Set<string>>();
  agent.joinApprovalRetryQueue = new JoinApprovalRetryQueue({
    backoffs: [10],
    maxAgeMs: 60_000,
  });
  agent.log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  agent.getJoinRequestStatus = vi.fn(async () => 'approved');
  return agent as DKGAgent;
}

describe('join approval substrate retry semantics', () => {
  it('moves queued approval sends back to the logical approval retry queue', async () => {
    const sendReliable = vi.fn(async (
      _peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId?: string },
    ) => ({
      delivered: false as const,
      queued: true as const,
      attempts: 1,
      messageId: opts.messageId ?? 'msg',
      error: 'ECONNRESET',
    }));
    const agent = makeAgentLike({ registryPeerId: 'new-peer', sendReliable }) as any;

    await agent.notifyJoinApproval(CG, AGENT);

    const messageId = sendReliable.mock.calls[0][3].messageId;
    expect(agent.messenger.discardOutboxEntry).toHaveBeenCalledWith(
      'new-peer',
      PROTOCOL_JOIN_REQUEST,
      messageId,
    );
    expect(agent.listPendingJoinApprovalRetries()).toMatchObject([
      {
        contextGraphId: CG,
        agentAddress: AGENT,
        attempts: 1,
        lastError: 'ECONNRESET',
      },
    ]);
  });

  it('redelivers approval by re-resolving the invitee peer ID', async () => {
    const agent = makeAgentLike({ registryPeerId: 'fresh-peer' }) as any;
    agent.joinRequestOriginPeers.set(`${CG}::${AGENT.toLowerCase()}`, 'stale-peer');

    const result = await agent.redeliverJoinApproval(CG, AGENT);

    expect(result.delivered).toBe(true);
    expect(result.peerId).toBe('fresh-peer');
    expect(agent.messenger.sendReliable).toHaveBeenCalledWith(
      'fresh-peer',
      PROTOCOL_JOIN_REQUEST,
      expect.any(Uint8Array),
      expect.objectContaining({ timeoutMs: expect.any(Number), messageId: expect.any(String) }),
    );
  });

  it('opportunistic reconnect retry only redelivers approvals for the reconnected peer', async () => {
    const agent = makeAgentLike({
      registryPeersByAgent: {
        [AGENT]: 'peer-a',
        [AGENT_TWO]: 'peer-b',
      },
    }) as any;
    agent.joinApprovalRetryQueue.enqueueFailure(CG, AGENT, 'offline', Date.now());
    agent.joinApprovalRetryQueue.enqueueFailure(CG, AGENT_TWO, 'offline', Date.now());

    await agent.processJoinApprovalRetryQueueOnConnect('peer-a');

    expect(agent.messenger.sendReliable).toHaveBeenCalledTimes(1);
    expect(agent.messenger.sendReliable).toHaveBeenCalledWith(
      'peer-a',
      PROTOCOL_JOIN_REQUEST,
      expect.any(Uint8Array),
      expect.objectContaining({ timeoutMs: expect.any(Number), messageId: expect.any(String) }),
    );
    expect(agent.listPendingJoinApprovalRetries()).toHaveLength(1);
    expect(agent.listPendingJoinApprovalRetries()[0].agentAddress).toBe(AGENT_TWO);
  });

  it('keeps broadcast join-request fallback best-effort by discarding queued broadcast entries', async () => {
    let sendCount = 0;
    const sendReliable = vi.fn(async (
      peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId?: string },
    ) => {
      sendCount += 1;
      if (sendCount === 1) {
        throw new Error('targeted dial failed');
      }
      return {
        delivered: false as const,
        queued: true as const,
        attempts: 1,
        messageId: opts.messageId ?? `msg-${peerId}`,
        error: 'ECONNRESET',
      };
    });
    const agent = makeAgentLike({
      connectedPeers: ['curator-peer', 'other-peer'],
      sendReliable,
    }) as any;

    await agent.forwardJoinRequest(
      CG,
      { agentAddress: AGENT } as any,
      undefined,
      'curator-peer',
    );

    expect(agent.messenger.discardOutboxEntry).toHaveBeenCalledTimes(2);
    expect(agent.messenger.discardOutboxEntry).toHaveBeenCalledWith(
      'curator-peer',
      PROTOCOL_JOIN_REQUEST,
      expect.any(String),
    );
    expect(agent.messenger.discardOutboxEntry).toHaveBeenCalledWith(
      'other-peer',
      PROTOCOL_JOIN_REQUEST,
      expect.any(String),
    );
  });

  it('discards queued targeted join requests before broadcast fallback can succeed', async () => {
    let sendCount = 0;
    const sendReliable = vi.fn(async (
      peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId?: string },
    ) => {
      sendCount += 1;
      if (sendCount === 1) {
        return {
          delivered: false as const,
          queued: true as const,
          attempts: 1,
          messageId: opts.messageId ?? `target-${peerId}`,
          error: 'ECONNRESET',
        };
      }
      return {
        delivered: true as const,
        response: new TextEncoder().encode(JSON.stringify({ ok: peerId === 'curator-peer' })),
        attempts: 1,
        messageId: opts.messageId ?? `broadcast-${peerId}`,
      };
    });
    const agent = makeAgentLike({
      connectedPeers: ['curator-peer'],
      sendReliable,
    }) as any;

    const result = await agent.forwardJoinRequest(
      CG,
      { agentAddress: AGENT } as any,
      undefined,
      'curator-peer',
    );

    expect(result.delivered).toBe(1);
    const targetedMessageId = sendReliable.mock.calls[0][3].messageId;
    expect(agent.messenger.discardOutboxEntry).toHaveBeenCalledWith(
      'curator-peer',
      PROTOCOL_JOIN_REQUEST,
      targetedMessageId,
    );
    expect(sendReliable).toHaveBeenCalledTimes(2);
  });
});
