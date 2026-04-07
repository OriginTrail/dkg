import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@origintrail-official/dkg-core', () => ({
  readDaemonPid: vi.fn(),
  isProcessAlive: vi.fn(),
  readDkgApiPort: vi.fn(),
  loadAuthToken: vi.fn(),
}));

import {
  readDaemonPid,
  isProcessAlive,
  readDkgApiPort,
  loadAuthToken,
} from '@origintrail-official/dkg-core';
import { DkgClient } from '../src/connection.js';

function jsonRes(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 422,
    statusText: ok ? 'OK' : 'Unprocessable',
    json: async () => data,
  } as Response;
}

describe('DkgClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  describe('connect', () => {
    it('returns client when API port is available', async () => {
      vi.mocked(readDkgApiPort).mockResolvedValue(9201);
      vi.mocked(loadAuthToken).mockResolvedValue('tok');
      const c = await DkgClient.connect();
      expect(c).toBeInstanceOf(DkgClient);
    });

    it('throws when daemon is not running', async () => {
      vi.mocked(readDkgApiPort).mockResolvedValue(undefined as unknown as number);
      vi.mocked(readDaemonPid).mockResolvedValue(undefined);
      vi.mocked(isProcessAlive).mockReturnValue(false);
      await expect(DkgClient.connect()).rejects.toThrow(/not running/);
    });

    it('throws when port unreadable but process alive', async () => {
      vi.mocked(readDkgApiPort).mockResolvedValue(undefined as unknown as number);
      vi.mocked(readDaemonPid).mockResolvedValue(42);
      vi.mocked(isProcessAlive).mockReturnValue(true);
      vi.mocked(loadAuthToken).mockResolvedValue(undefined);
      await expect(DkgClient.connect()).rejects.toThrow(/Cannot read API port/);
    });
  });

  describe('HTTP helpers', () => {
    it('status sends bearer token when set', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonRes({
          name: 'n',
          peerId: 'p',
          uptimeMs: 1,
          connectedPeers: 0,
          relayConnected: false,
          multiaddrs: [],
        }),
      );
      const c = new DkgClient(9200, 'secret');
      await c.status();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9200/api/status',
        expect.objectContaining({
          headers: { Authorization: 'Bearer secret' },
        }),
      );
    });

    it('get surfaces non-JSON error body', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Err',
        json: async () => {
          throw new Error('not json');
        },
      } as Response);
      const c = new DkgClient(9200);
      await expect(c.status()).rejects.toThrow(/Err/);
    });

    it('post sends JSON body', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(jsonRes({ result: { bindings: [] } }));
      const c = new DkgClient(9200);
      await c.query('SELECT * WHERE { ?s ?p ?o }');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9200/api/query',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sparql: 'SELECT * WHERE { ?s ?p ?o }', contextGraphId: undefined }),
        }),
      );
    });

    it('post propagates API error string', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonRes({ error: 'bad query' }, false),
      );
      const c = new DkgClient(9200);
      await expect(c.query('x')).rejects.toThrow('bad query');
    });

    it('covers publish, listContextGraphs, createContextGraph, agents, subscribe', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/publish')) return jsonRes({ kcId: '1', status: 'ok', kas: [] });
        if (u.includes('/context-graph/list')) return jsonRes({ contextGraphs: [] });
        if (u.includes('/context-graph/create')) return jsonRes({ created: '1', uri: 'u' });
        if (u.includes('/agents')) return jsonRes({ agents: [] });
        if (u.includes('/subscribe')) return jsonRes({ subscribed: 'cg' });
        return jsonRes({});
      });
      const c = new DkgClient(9200);
      await c.publish('cg', []);
      await c.listContextGraphs();
      await c.createContextGraph('id', 'name', 'desc');
      await c.agents();
      await c.subscribe('cg');
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });
});
