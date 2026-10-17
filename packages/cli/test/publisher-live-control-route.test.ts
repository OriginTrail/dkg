import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

async function request(action: 'pause' | 'resume' | 'control', options: { agent?: boolean; unavailable?: boolean; body?: string; failure?: boolean } = {}) {
  const path = `/api/publisher/${action}`;
  const req = Object.assign(Readable.from([]), { method: action === 'control' ? 'GET' : 'POST', url: path,
    headers: {}, __dkgPrebufferedBody: Buffer.from(options.body ?? '{}') });
  const res = { statusCode: 0, body: '', writableEnded: false,
    writeHead(status: number) { this.statusCode = status; return this; },
    end(body = '') { this.body = body; this.writableEnded = true; return this; } };
  const status = { desiredState: 'paused', effectiveState: 'paused', generation: 3, acknowledgedGeneration: 3,
    wallets: [{ walletId: 'real-runtime', paused: true, generation: 3 }], fault: null };
  const active = vi.fn(async () => { if (options.failure) throw new Error('secret raw adapter details'); return status; });
  const admission = vi.fn();
  const ctx = { req, res: res as unknown as ServerResponse, path, url: new URL(`http://localhost${path}`),
    authentication: requestAuthentication(options.agent ? { kind: 'agent', agentAddress: '0x1' } : { kind: 'nodeOperator' }),
    publisherControl: { pause: admission, resume: admission },
    publisherState: { runtime: options.unavailable ? null : { control: { pause: active, resume: active, status: () => status } } },
  } as unknown as RequestContext;
  await handlePublisherRoutes(ctx);
  return { code: res.statusCode, body: JSON.parse(res.body), active, admission };
}

describe('node administrator publisher live control routes', () => {
  it.each(['pause', 'resume'] as const)('sends %s to the active runtime and returns its wallet acknowledgement', async action => {
    const result = await request(action);
    expect(result.code).toBe(200); expect(result.active).toHaveBeenCalledOnce();
    expect(result.admission).not.toHaveBeenCalled();
    expect(result.body.wallets[0]).toEqual({ walletId: 'real-runtime', paused: true, generation: 3 });
  });
  it.each(['pause', 'resume', 'control'] as const)('denies agent-scoped %s', async action => {
    const result = await request(action, { agent: true });
    expect(result.code).toBe(403); expect(result.active).not.toHaveBeenCalled(); expect(result.admission).not.toHaveBeenCalled();
  });
  it('reports unavailable rather than controlling admission when no live runtime exists', async () => {
    const result = await request('pause', { unavailable: true });
    expect(result.code).toBe(503); expect(result.admission).not.toHaveBeenCalled();
  });
  it('rejects malformed or nonempty control input before calling the runtime', async () => {
    for (const body of ['{', 'null', '[]', '{"walletId":"other"}']) {
      const result = await request('resume', { body });
      expect(result.code).toBe(400); expect(result.active).not.toHaveBeenCalled();
    }
  });
  it('exposes bounded failure without adapter details', async () => {
    const result = await request('pause', { failure: true });
    expect(result.code).toBe(503); expect(JSON.stringify(result.body)).not.toContain('secret');
  });
});
