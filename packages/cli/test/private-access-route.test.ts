import { EventEmitter } from 'node:events';
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
  ])('maps %s without returning peer payload', async (code, status) => {
    const f = fixture();
    f.requestPrivateAccess.mockRejectedValue(Object.assign(new Error('untrusted remote detail'), { code }));
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(status);
    expect(f.res.body).not.toContain('untrusted remote detail');
    expect(JSON.parse(f.res.body)).not.toHaveProperty('quads');
  });
  it('caps JSON output independently of the wire response', async () => {
    const f = fixture();
    f.requestPrivateAccess.mockResolvedValue({ ...success, quads: [{ subject: 'a', predicate: 'b', object: 'x'.repeat(2 * 1024 * 1024), graph: '' }] });
    await handlePrivateAccessRoutes(f.ctx);
    expect(f.res.statusCode).toBe(413);
  });
});
