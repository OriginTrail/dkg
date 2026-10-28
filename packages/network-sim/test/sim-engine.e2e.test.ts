/**
 * E2E tests for the simulation: require devnet (and optionally sim server) to be running.
 * Opt in with DEVNET_E2E=1. Once enabled, unavailable services fail instead of silently skipping.
 */
import { describe, it, expect } from 'vitest';

const DEVNET_NODE1 = 'http://127.0.0.1:9201';
const SIM_ORIGIN = 'http://127.0.0.1:3000';
const RUN_E2E = process.env.DEVNET_E2E === '1' || process.env.DEVNET_E2E === 'true';

describe('sim-engine e2e', () => {
  it.skipIf(!RUN_E2E)(
    'when devnet is up, GET /api/status on node 1 returns 200 and peerId',
    async () => {
      const res = await fetch(`${DEVNET_NODE1}/api/status`, { signal: AbortSignal.timeout(2000) });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { peerId?: string; name?: string };
      expect(data.peerId).toBeDefined();
      expect(typeof data.peerId).toBe('string');
    },
  );

  it.skipIf(!RUN_E2E)(
    'when sim server is up, GET /sim/status returns 200 and running flag',
    async () => {
      const res = await fetch(`${SIM_ORIGIN}/sim/status`, { signal: AbortSignal.timeout(2000) });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { running: boolean; total: number; completed: number };
      expect(typeof data.running).toBe('boolean');
      expect(typeof data.total).toBe('number');
      expect(typeof data.completed).toBe('number');
    },
  );
});
