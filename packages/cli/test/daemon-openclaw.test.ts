import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenClawChannelHeaders,
  getOpenClawChannelTargets,
  isValidOpenClawPersistTurnPayload,
  pipeOpenClawStream,
} from '../src/daemon.js';
import type { DkgConfig } from '../src/config.js';

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  };
}

describe('OpenClaw channel routing helpers', () => {
  it('defaults to the standalone bridge when no gateway transport is configured', () => {
    expect(getOpenClawChannelTargets(makeConfig())).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9201/inbound',
        streamUrl: 'http://127.0.0.1:9201/inbound/stream',
        healthUrl: 'http://127.0.0.1:9201/health',
      },
    ]);
  });

  it('uses only the gateway route when gatewayUrl is configured without an explicit bridgeUrl', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      openclawChannel: { gatewayUrl: 'http://gateway.local:3030' },
    }))).toEqual([
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:3030/api/dkg-channel/inbound',
        healthUrl: 'http://gateway.local:3030/api/dkg-channel/health',
      },
    ]);
  });

  it('keeps both transports when bridgeUrl and gatewayUrl are both configured', () => {
    expect(getOpenClawChannelTargets(makeConfig({
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9301',
        gatewayUrl: 'http://gateway.local:3030',
      },
    }))).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9301/inbound',
        streamUrl: 'http://127.0.0.1:9301/inbound/stream',
        healthUrl: 'http://127.0.0.1:9301/health',
      },
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:3030/api/dkg-channel/inbound',
        healthUrl: 'http://gateway.local:3030/api/dkg-channel/health',
      },
    ]);
  });

  it('adds the bridge auth header only for standalone bridge requests', () => {
    const bridgeHeaders = buildOpenClawChannelHeaders(
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9201/inbound',
      },
      'secret-token',
      { 'Content-Type': 'application/json' },
    );
    expect(bridgeHeaders).toEqual({
      'Content-Type': 'application/json',
      'x-dkg-bridge-token': 'secret-token',
    });

    const gatewayHeaders = buildOpenClawChannelHeaders(
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local/api/dkg-channel/inbound',
      },
      'secret-token',
      { 'Content-Type': 'application/json' },
    );
    expect(gatewayHeaders).toEqual({ 'Content-Type': 'application/json' });
  });

  it('does not cancel the upstream stream on request close events after the body is consumed', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    const writes: string[] = [];
    res.writableEnded = false;
    res.write = (chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk).toString('utf8'));
      return true;
    };
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: async () => {
        if (writes.length === 0) {
          req.emit('close');
          return { done: false, value: Buffer.from('data: {"type":"text_delta","delta":"pong"}\n\n') };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const cancelSpy = vi.spyOn(reader, 'cancel');
    const releaseSpy = vi.spyOn(reader, 'releaseLock');

    await pipeOpenClawStream(req, res, reader);

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(writes).toEqual(['data: {"type":"text_delta","delta":"pong"}\n\n']);
    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  it('cancels the upstream stream when the downstream response closes before it finishes', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    let resolveRead!: (value: { done: boolean; value?: Uint8Array }) => void;

    res.writableEnded = false;
    res.write = () => true;
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => { resolveRead = resolve; }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const cancelSpy = vi.spyOn(reader, 'cancel');
    const releaseSpy = vi.spyOn(reader, 'releaseLock');

    const proxyPromise = pipeOpenClawStream(req, res, reader);
    res.emit('close');
    resolveRead({ done: true });
    await proxyPromise;

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  it('waits for downstream drain before reading more stream data', async () => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    const writes: string[] = [];
    let readCount = 0;
    let secondReadCalled = false;

    res.writableEnded = false;
    res.write = (chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk).toString('utf8'));
      return writes.length > 1;
    };
    res.end = () => { res.writableEnded = true; };

    const reader = {
      read: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: Buffer.from('data: first\n\n') };
        }
        secondReadCalled = true;
        return { done: true, value: undefined };
      }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };

    const proxyPromise = pipeOpenClawStream(req, res, reader);
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toEqual(['data: first\n\n']);
    expect(secondReadCalled).toBe(false);

    res.emit('drain');
    await proxyPromise;

    expect(secondReadCalled).toBe(true);
  });
});

describe('OpenClaw persist-turn validation', () => {
  it('accepts empty-string user and assistant messages when sessionId is present', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: 'openclaw:dkg-ui',
      userMessage: '',
      assistantReply: '',
    })).toBe(true);
  });

  it('rejects missing or blank session ids', () => {
    expect(isValidOpenClawPersistTurnPayload({
      sessionId: '',
      userMessage: '',
      assistantReply: '',
    })).toBe(false);
    expect(isValidOpenClawPersistTurnPayload({
      userMessage: '',
      assistantReply: '',
    })).toBe(false);
  });
});
