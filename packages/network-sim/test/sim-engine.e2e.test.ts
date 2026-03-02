/**
 * E2E tests for the simulation: require devnet (and optionally sim server) to be running.
 * Skipped when DEVNET_E2E is not set or when node 1 is not reachable, so CI can run without devnet.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const DEVNET_NODE1 = 'http://127.0.0.1:9201';
const SIM_ORIGIN = 'http://127.0.0.1:3000';
const RUN_E2E = process.env.DEVNET_E2E === '1' || process.env.DEVNET_E2E === 'true';

async function isDevnetReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${DEVNET_NODE1}/api/status`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function isSimServerReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${SIM_ORIGIN}/sim/status`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

describe('sim-engine e2e', () => {
  let devnetOk: boolean;
  let simOk: boolean;

  beforeAll(async () => {
    devnetOk = await isDevnetReachable();
    simOk = await isSimServerReachable();
  });

  it.skipIf(!RUN_E2E || !devnetOk)(
    'when devnet is up, GET /api/status on node 1 returns 200 and peerId',
    async () => {
      const res = await fetch(`${DEVNET_NODE1}/api/status`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { peerId?: string; name?: string };
      expect(data.peerId).toBeDefined();
      expect(typeof data.peerId).toBe('string');
    },
  );

  it.skipIf(!RUN_E2E || !simOk)(
    'when sim server is up, GET /sim/status returns 200 and running flag',
    async () => {
      const res = await fetch(`${SIM_ORIGIN}/sim/status`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { running: boolean; total: number; completed: number };
      expect(typeof data.running).toBe('boolean');
      expect(typeof data.total).toBe('number');
      expect(typeof data.completed).toBe('number');
    },
  );
});
