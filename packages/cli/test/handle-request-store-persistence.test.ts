import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import { handleRequest } from '../src/daemon/handle-request.js';
import type { StoreRuntimeContext } from '../src/daemon/store-runtime.js';

describe('handleRequest store config boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('persists the operator config rather than the materialized managed-store runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dkg-handle-request-store-'));
    vi.stubEnv('DKG_HOME', home);

    const operatorConfig: DkgConfig = {
      name: 'operator-config-route-test',
      nodeRole: 'edge',
      chain: { type: 'mock' },
    };
    const storeRuntime: StoreRuntimeContext = {
      operatorConfig,
      effectiveStore: { backend: 'oxigraph-server', options: {} },
      runtimeStore: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          managedByDkg: true,
        },
      },
    };

    const server = createServer((req, res) => {
      const args: Parameters<typeof handleRequest> = [
        req,
        res,
        { resolveAgentAddress: () => 'operator-config-route-test' } as any,
        {} as any,
        null,
        storeRuntime,
        Date.now(),
        {} as any,
        { wallets: [] },
        null,
        {} as any,
        {} as any,
        undefined,
        '0.0.0-test',
        '',
        {} as any,
        {} as any,
        new Map(),
        new Map(),
        {} as any,
        null,
        new Set(),
        '127.0.0.1',
        { value: 0 },
        [],
        { inFlight: 0, max: 0, rejectedTotal: 0 },
      ];
      void handleRequest(...args).catch(() => {
        res.statusCode = 500;
        res.end('route failed');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/register-adapter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'openclaw' }),
      });
      expect(response.status).toBe(200);

      const persisted = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as DkgConfig;
      expect(persisted.store).toBeUndefined();
      expect(persisted.localAgentIntegrations?.openclaw?.enabled).toBe(true);
      expect(JSON.stringify(persisted)).not.toContain('127.0.0.1:7878');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(home, { recursive: true, force: true });
    }
  });
});
