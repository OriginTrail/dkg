import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DKGAgent as Agent } from '../src/dkg-agent.js';
import type { DKGAgentBase as AgentBase } from '../src/dkg-agent-base.js';

// Distinct values make a wrong-field assignment observable at the consumer.
const settings = [
  ['DKG_VM_RECONCILE_INTERVAL_MS', 'VM_RECONCILE_SWEEP_INTERVAL_MS', 101],
  ['DKG_VM_RECONCILE_BACKOFF_MAX_MS', 'VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS', 202],
  ['DKG_VM_RECONCILE_CACHE_MAX_ENTRIES', 'VM_RECONCILE_CACHE_MAX_ENTRIES', 3],
  ['DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES', 'VM_RECONCILE_CG_STATE_MAX_ENTRIES', 4],
  ['DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS', 'VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS', 5],
  ['DKG_VM_RECONCILE_QUEUE_MAX_PENDING', 'VM_RECONCILE_QUEUE_MAX_PENDING', 6],
  ['DKG_VM_RECONCILE_BATCH_SIZE', 'VM_RECONCILE_BATCH_SIZE', 7],
  ['DKG_VM_RECONCILE_ORDINAL_CONCURRENCY', 'VM_RECONCILE_ORDINAL_CONCURRENCY', 8],
  ['DKG_VM_RECONCILE_CONCURRENCY', 'VM_RECONCILE_CONCURRENCY', 9],
  ['DKG_VM_RECONCILE_MAX_FOREGROUND_BURST', 'VM_RECONCILE_MAX_FOREGROUND_BURST', 10],
  ['DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', 111],
  ['DKG_RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', 'RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS', 222],
  ['DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS', 'CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS', 333],
  ['DKG_VM_RECONCILE_CONFIRMATION_DEPTH', 'VM_RECONCILE_CONFIRMATION_DEPTH', 14],
  ['DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS', 'VM_RECONCILE_STARTUP_MAX_DELAY_MS', 55],
] as const satisfies readonly (readonly [string, keyof typeof AgentBase, number])[];

let DKGAgent: typeof Agent;
let DKGAgentBase: typeof AgentBase;
let catchup: typeof import('../src/sync/catchup-concurrency.js');
let policy: typeof import('../src/sync/catchup-policy.js');

beforeAll(async () => {
  vi.resetModules();
  for (const [env, , value] of settings) vi.stubEnv(env, String(value));
  vi.stubEnv('DKG_CATCHUP_MAX_CONCURRENT_PEERS', '15');
  vi.stubEnv('DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS', '444');
  ({ DKGAgent } = await import('../src/dkg-agent.js'));
  ({ DKGAgentBase } = await import('../src/dkg-agent-base.js'));
  catchup = await import('../src/sync/catchup-concurrency.js');
  policy = await import('../src/sync/catchup-policy.js');
  for (const [env, , value] of settings) vi.stubEnv(env, String(value + 100));
  vi.stubEnv('DKG_CATCHUP_MAX_CONCURRENT_PEERS', '16');
  vi.stubEnv('DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS', '445');
});

afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(settings)('captures %s in %s at module load', (_env, field, expected) => {
  expect(DKGAgentBase[field]).toBe(expected);
  expect(DKGAgent[field]).toBe(expected);
});

it('captures the independent catch-up fanout and admission retry deadlines', async () => {
  expect(catchup.CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBe(15);
  expect(policy.CATCHUP_BACKPRESSURE_MAX_WAIT_MS).toBe(444);
  expect((await import('../src/sync/catchup-concurrency.js')).CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBe(15);
  expect((await import('../src/sync/catchup-policy.js')).CATCHUP_BACKPRESSURE_MAX_WAIT_MS).toBe(444);
});
