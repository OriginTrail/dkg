import { afterEach, expect, it, vi } from 'vitest';
import type { DKGAgentBase as AgentBase } from '../src/dkg-agent-base.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('does not initialize VM policy when a catch-up helper is imported first', async () => {
  vi.resetModules();
  vi.stubEnv('DKG_CATCHUP_MAX_CONCURRENT_PEERS', '15');
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '7');

  const catchup = await import('../src/sync/catchup-concurrency.js');
  expect(catchup.CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBe(15);

  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '23');
  const { DKGAgentBase } = await import('../src/dkg-agent-base.js') as {
    DKGAgentBase: typeof AgentBase;
  };
  expect(DKGAgentBase.VM_RECONCILE_BATCH_SIZE).toBe(23);

  // Each owner snapshot remains process-static after its own first import.
  vi.stubEnv('DKG_CATCHUP_MAX_CONCURRENT_PEERS', '16');
  vi.stubEnv('DKG_VM_RECONCILE_BATCH_SIZE', '24');
  expect((await import('../src/sync/catchup-concurrency.js')).CATCHUP_MAX_CONCURRENT_PEER_SYNCS)
    .toBe(15);
  expect((await import('../src/dkg-agent-base.js')).DKGAgentBase.VM_RECONCILE_BATCH_SIZE)
    .toBe(23);
});
