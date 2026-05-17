import { describe, it, expect, vi } from 'vitest';
import {
  PROTOCOL_QUERY_REMOTE,
  RESPONSE_GONE_MARKER,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';

function makeAgentLike(messenger: {
  sendReliable: ReturnType<typeof vi.fn>;
  discardOutboxEntry: ReturnType<typeof vi.fn>;
}): DKGAgent {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.messenger = messenger;
  agent.log = { info: vi.fn() };
  return agent as DKGAgent;
}

describe('queryRemote Messenger substrate behavior', () => {
  it('discards queued outbox entries before surfacing synchronous transport failures', async () => {
    const sendReliable = vi.fn(async (
      _peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId: string },
    ) => ({
      delivered: false as const,
      queued: true as const,
      attempts: 1,
      messageId: opts.messageId,
      error: 'ECONNRESET',
    }));
    const discardOutboxEntry = vi.fn(() => true);
    const agent = makeAgentLike({ sendReliable, discardOutboxEntry });

    await expect(agent.queryRemote('12D3KooWRemotePeer', {
      lookupType: 'SPARQL_QUERY',
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
    })).rejects.toThrow('query-remote send not synchronously deliverable');

    const messageId = sendReliable.mock.calls[0][3].messageId;
    expect(discardOutboxEntry).toHaveBeenCalledWith(
      '12D3KooWRemotePeer',
      PROTOCOL_QUERY_REMOTE,
      messageId,
    );
  });

  it('reissues RESPONSE_GONE responses with a fresh messageId', async () => {
    const encoder = new TextEncoder();
    const okResponse = {
      operationId: 'remote-op',
      status: 'OK',
      truncated: false,
      resultCount: 0,
      bindings: '[]',
    };
    const responses = [
      encoder.encode(RESPONSE_GONE_MARKER),
      encoder.encode(JSON.stringify(okResponse)),
    ];
    const sendReliable = vi.fn(async (
      _peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId: string },
    ) => ({
      delivered: true as const,
      response: responses.shift() ?? encoder.encode(JSON.stringify(okResponse)),
      attempts: 1,
      messageId: opts.messageId,
    }));
    const discardOutboxEntry = vi.fn(() => true);
    const agent = makeAgentLike({ sendReliable, discardOutboxEntry });

    const result = await agent.queryRemote('12D3KooWRemotePeer', {
      lookupType: 'SPARQL_QUERY',
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
    });

    expect(result.status).toBe('OK');
    expect(sendReliable).toHaveBeenCalledTimes(2);
    const firstMessageId = sendReliable.mock.calls[0][3].messageId;
    const secondMessageId = sendReliable.mock.calls[1][3].messageId;
    expect(firstMessageId).not.toBe(secondMessageId);
    expect(discardOutboxEntry).not.toHaveBeenCalled();
  });
});
