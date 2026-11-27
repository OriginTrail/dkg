import { EventEmitter } from 'node:events';
import { RequestOwnedAccessClient } from '@origintrail-official/dkg-publisher';
import { ProtocolRouter, generateEd25519Keypair, InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore, type DKGNode } from '@origintrail-official/dkg-core';
import { Messenger } from '../../agent/src/p2p/messenger.js';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handlePrivateAccessRoutes } from '../src/daemon/routes/private-access.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const UAL = 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0';
const PEER = '12D3KooWCUmtMdmJuxp2YsJya4JASgt4tf7VeKAFrA4NZ415q2RS';
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const AGENT = requestAuthentication({ kind: 'agent', agentAddress: '0x1111111111111111111111111111111111111111' });
const success = { granted: true, quads: [], storedInGraph: false,
  verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false } };
function fixture(authentication = OPERATOR, body: unknown = { publisherPeerId: PEER, kaUal: UAL }) {
  const req = Object.assign(Readable.from([]), { method: 'POST',
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, body: '', writableEnded: false, destroyed: false,
    writeHead(status: number) { this.statusCode = status; return this; },
    end(value: string) { this.body = value; this.writableEnded = true; return this; },
  });
  const requestPrivateAccess = vi.fn(async (_input: unknown, _options: { signal: AbortSignal }): Promise<Record<string, unknown>> => success);
  const ctx = { req, res, path: '/api/access/request', authentication,
    agent: { requestPrivateAccess }, requestAgentAddress: 'local-operator' } as unknown as RequestContext;
  return { ctx, req, res, requestPrivateAccess };
}

describe('operator-owned private access HTTP route', () => {
  it('rejects an agent token before sending a peer request', async () => {
    const f = fixture(AGENT);
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(403);
    expect(f.requestPrivateAccess).not.toHaveBeenCalled();
  });
  it.each([[AGENT, 403], [OPERATOR, 200]])('dispatches the authenticated route through the daemon: %j', async (authentication, status) => {
    const f = fixture(authentication);
    Object.assign(f.req, { url: '/api/access/request', headers: { host: '127.0.0.1' } });
    await handleRequest({
      req: f.req, res: f.res, authentication,
      agent: { resolveAgentAddress: () => 'local-operator', requestPrivateAccess: f.requestPrivateAccess },
    } as unknown as HandleRequestInput);
    expect(f.res.statusCode).toBe(status);
    expect(f.requestPrivateAccess).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });
  it('returns explicit self-check semantics to an authorized operator', async () => {
    const f = fixture();
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(200);
    expect(JSON.parse(f.res.body)).toEqual(success);
    expect(f.requestPrivateAccess).toHaveBeenCalledWith({ publisherPeerId: PEER, kaUal: UAL }, { signal: expect.any(AbortSignal) });
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.res.listenerCount('close')).toBe(0);
  });
  it.each([null, [], {}, { publisherPeerId: PEER }, { publisherPeerId: PEER, kaUal: UAL, paymentProof: 'unsupported' }])
    ('rejects malformed or unsupported requests: %j', async body => {
      const f = fixture(OPERATOR, body);
      await handlePrivateAccessRoutes(f.ctx);
      expect(f.res.statusCode).toBe(400);
      expect(f.requestPrivateAccess).not.toHaveBeenCalled();
    });
  it('aborts peer work when the HTTP caller disconnects, without returning a late payload', async () => {
    const f = fixture();
    f.requestPrivateAccess.mockImplementation(async (_input, { signal }) => {
      f.res.emit('close');
      expect(signal.aborted).toBe(true);
      return success;
    });
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.writableEnded).toBe(false);
    expect(f.res.listenerCount('close')).toBe(0);
  });
  it.each([
    ['ACCESS_INTEGRITY_FAILED', 502], ['ACCESS_RESPONSE_TOO_LARGE', 413],
    ['ACCESS_INVALID_REQUEST', 400], ['ACCESS_TIMEOUT', 504],
    ['ACCESS_BUSY', 429], ['ACCESS_UNAVAILABLE', 503], ['ACCESS_REQUEST_OWNED_REQUIRED', 503],
  ])('maps %s without returning peer payload', async (code, status) => {
    const f = fixture();
    f.requestPrivateAccess.mockRejectedValue(Object.assign(new Error('untrusted remote detail'), { code }));
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(status);
    expect(JSON.parse(f.res.body).code).toBe(code === 'ACCESS_REQUEST_OWNED_REQUIRED' ? 'ACCESS_UNAVAILABLE' : code);
    expect(f.res.body).not.toContain('untrusted remote detail');
    expect(JSON.parse(f.res.body)).not.toHaveProperty('quads');
  });
  it('retains the structured known-code error boundary', async () => {
    const f = fixture();
    f.requestPrivateAccess.mockRejectedValue({ code: 'ACCESS_BUSY', detail: 'private peer detail' });
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(429);
    expect(JSON.parse(f.res.body)).toEqual({ code: 'ACCESS_BUSY', error: 'A private access request is already running' });
  });
  it.each([new Error('private peer detail'), Object.assign(new Error('private peer detail'), { code: 'ACCESS_TIMOUT' }), null])
    ('keeps unknown failures sanitized: %j', async error => {
      const f = fixture();
      f.requestPrivateAccess.mockRejectedValue(error);
      await handlePrivateAccessRoutes(f.ctx);
      expect(f.res.statusCode).toBe(503);
      expect(JSON.parse(f.res.body)).toEqual({ code: 'ACCESS_UNAVAILABLE', error: 'Private access is unavailable' });
    });
  it('returns HTTP 413 when the real router rejects an oversized Messenger response early', async () => {
    const f = fixture();
    let yielded = 0;
    const abort = vi.fn();
    const stream = { send: () => {}, close: async () => {}, abort, writeStatus: 'open',
      async *[Symbol.asyncIterator]() {
        yielded++; yield new Uint8Array(5);
        yielded++; yield new Uint8Array(5);
      } };
    const router = new ProtocolRouter({ libp2p: {
      getConnections: () => [{ status: 'open', remotePeer: { equals: (peer: unknown) => String(peer) === PEER,
        toString: () => PEER }, newStream: async () => stream }],
      dialProtocol: async () => { throw new Error('must use existing connection'); },
      peerStore: { get: async () => { throw new Error('NotFound'); } },
      handle: () => {}, unhandle: () => {},
    } } as unknown as DKGNode);
    const messenger = new Messenger({ router, idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore: new InMemoryProtocolOutboxStore() });
    const access = new RequestOwnedAccessClient(messenger, await generateEd25519Keypair(), 'local-peer');
    f.requestPrivateAccess.mockImplementation(async () => access.requestAccess(PEER, UAL, undefined,
      { maxResponseBytes: 4 }) as unknown as Promise<Record<string, unknown>>);
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(413);
    expect(JSON.parse(f.res.body)).toMatchObject({ code: 'ACCESS_RESPONSE_TOO_LARGE' });
    expect(yielded).toBe(1);
    expect(abort).toHaveBeenCalled();
    expect(messenger.getOutboxStats()?.queuedEntries).toBe(0);
  });

  it('caps JSON output independently of the wire response', async () => {
    const f = fixture();
    f.requestPrivateAccess.mockResolvedValue({ ...success, quads: [{ subject: 'a', predicate: 'b', object: 'x'.repeat(2 * 1024 * 1024), graph: '' }] });
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(413);
  });
});
