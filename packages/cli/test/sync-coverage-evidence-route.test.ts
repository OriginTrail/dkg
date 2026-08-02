import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleSyncCoverageEvidenceRoutes } from '../src/daemon/routes/sync-coverage-evidence.js';

describe('sync coverage evidence diagnostics route', () => {
  let server: Server | undefined;
  let baseUrl = '';
  const getSyncCoverageEvidence = vi.fn((afterSequence: number) => ({
    schemaVersion: 1,
    processStartedAt: 100,
    waveId: 'wave-1',
    capacity: 256,
    nextSequence: 8,
    droppedBeforeSequence: 0,
    entries: [{ sequence: 7, afterSequence }],
  }));

  beforeEach(async () => {
    getSyncCoverageEvidence.mockClear();
    const agent = {
      getSyncCoverageEvidence,
      resolveAgentByToken: (token?: string) => token === 'agent-token'
        ? '0x1111111111111111111111111111111111111111'
        : undefined,
    };
    const validTokens = new Set(['admin-token', 'agent-token']);

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers.authorization;
      const requestToken = typeof auth === 'string'
        ? auth.replace(/^Bearer\s+/i, '')
        : undefined;
      await handleSyncCoverageEvidenceRoutes({
        req,
        res,
        agent,
        config: { auth: { enabled: true } },
        validTokens,
        url,
        path: url.pathname,
        requestToken,
      } as any);
      if (!res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (typeof address === 'object' && address) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('returns bounded journal entries after the requested cursor to node admins', async () => {
    const response = await fetch(`${baseUrl}/api/diagnostics/sync-coverage-evidence?afterSequence=6`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      waveId: 'wave-1',
      entries: [{ sequence: 7, afterSequence: 6 }],
    });
    expect(getSyncCoverageEvidence).toHaveBeenCalledWith(6);
  });

  it('rejects agent-scoped access and malformed cursors', async () => {
    const denied = await fetch(`${baseUrl}/api/diagnostics/sync-coverage-evidence`, {
      headers: { authorization: 'Bearer agent-token' },
    });
    expect(denied.status).toBe(403);

    const malformed = await fetch(`${baseUrl}/api/diagnostics/sync-coverage-evidence?afterSequence=-1`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(malformed.status).toBe(400);
    expect(getSyncCoverageEvidence).not.toHaveBeenCalled();
  });
});
