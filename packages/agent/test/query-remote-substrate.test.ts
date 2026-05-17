import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  PROTOCOL_QUERY_REMOTE,
  RELIABLE_ENVELOPE_VERSION,
  RESPONSE_GONE_MARKER,
  encodeReliableEnvelope,
  type ProtocolRouter,
  type StreamHandler,
} from '@origintrail-official/dkg-core';
import { QueryHandler } from '@origintrail-official/dkg-query';
import { DKGAgent } from '../src/dkg-agent.js';
import { Messenger } from '../src/p2p/messenger.js';

function makeAgentLike(messenger: {
  sendReliable: ReturnType<typeof vi.fn>;
  discardOutboxEntry: ReturnType<typeof vi.fn>;
}): DKGAgent {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.messenger = messenger;
  agent.log = { info: vi.fn() };
  return agent as DKGAgent;
}

interface RouterDouble {
  send: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  inboundHandler?: StreamHandler;
}

function makeRouter(): RouterDouble {
  const router: RouterDouble = {
    send: vi.fn(),
    register: vi.fn((_protocol: string, handler: StreamHandler) => {
      router.inboundHandler = handler;
    }),
  };
  return router;
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

  it('exhausts RESPONSE_GONE after two fresh-messageId retries', async () => {
    const encoder = new TextEncoder();
    const sendReliable = vi.fn(async (
      _peerId: string,
      _protocolId: string,
      _payload: Uint8Array,
      opts: { messageId: string },
    ) => ({
      delivered: true as const,
      response: encoder.encode(RESPONSE_GONE_MARKER),
      attempts: 1,
      messageId: opts.messageId,
    }));
    const discardOutboxEntry = vi.fn(() => true);
    const agent = makeAgentLike({ sendReliable, discardOutboxEntry });

    await expect(agent.queryRemote('12D3KooWRemotePeer', {
      lookupType: 'SPARQL_QUERY',
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
    })).rejects.toThrow('RESPONSE_GONE');

    expect(sendReliable).toHaveBeenCalledTimes(3);
    const messageIds = sendReliable.mock.calls.map(call => call[3].messageId);
    expect(new Set(messageIds).size).toBe(3);
    expect(discardOutboxEntry).not.toHaveBeenCalled();
  });

  it('handles inbound query-remote requests through the reliable envelope receive path', async () => {
    const router = makeRouter();
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore: new InMemoryProtocolOutboxStore(),
    });
    const queryEngine = {
      query: vi.fn(async () => ({
        bindings: [{ value: 'ok' }],
      })),
    };
    const queryRemoteHandler = new QueryHandler(queryEngine as any, {
      defaultPolicy: 'public',
    });
    messenger.register(PROTOCOL_QUERY_REMOTE, async (data, peerId) => {
      const request = JSON.parse(new TextDecoder().decode(data));
      const response = await queryRemoteHandler.handle(request, peerId);
      return new TextEncoder().encode(JSON.stringify(response));
    });

    const request = {
      operationId: 'remote-op',
      lookupType: 'SPARQL_QUERY',
      contextGraphId: 'cg-1',
      sparql: 'SELECT ?value WHERE { ?s ?p ?value }',
    };
    const envelope = encodeReliableEnvelope({
      messageId: '00000000-0000-4000-8000-000000000051',
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: Date.now(),
      payload: new TextEncoder().encode(JSON.stringify(request)),
    });
    const responseBytes = await router.inboundHandler!(
      envelope,
      { toString: () => '12D3KooWRemotePeer', toBytes: () => new Uint8Array() },
    );
    const response = JSON.parse(new TextDecoder().decode(responseBytes));

    expect(response).toMatchObject({
      operationId: 'remote-op',
      status: 'OK',
      resultCount: 1,
      truncated: false,
    });
    expect(queryEngine.query).toHaveBeenCalledWith(
      'SELECT ?value WHERE { ?s ?p ?value }',
      { contextGraphId: 'cg-1' },
    );
  });
});
