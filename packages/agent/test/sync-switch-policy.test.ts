import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  resolveDurableSyncEnabled,
  resolveSyncOnConnectEnabled,
  resolveSyncReconcilerEnabled,
} from '../src/sync/backpressure.js';

afterEach(() => vi.unstubAllEnvs());

describe('canonical sync-switch policy', () => {
  it.each([
    ['DKG_SYNC_RECONCILER_ENABLED', resolveSyncReconcilerEnabled],
    ['DKG_SYNC_ON_CONNECT_ENABLED', resolveSyncOnConnectEnabled],
    ['DKG_DURABLE_SYNC_ENABLED', resolveDurableSyncEnabled],
  ] as const)('resolves %s at every call as environment, config, then default on', (name, resolve) => {
    vi.stubEnv(name, undefined);
    expect(resolve()).toBe(true);
    expect(resolve(false)).toBe(false);
    expect(resolve(true)).toBe(true);
    vi.stubEnv(name, 'disabled');
    expect(resolve(true)).toBe(false);
    expect(resolve()).toBe(false);
    vi.stubEnv(name, 'enabled');
    expect(resolve(false)).toBe(true);
    vi.stubEnv(name, 'not-a-decision');
    expect(resolve(false)).toBe(false);
    expect(resolve()).toBe(true);
    vi.stubEnv(name, undefined);
    expect(resolve(false)).toBe(false);
  });

  it('phonebook admission follows the same durable switch as lifecycle on each call', () => {
    const host = { started: true, config: { nodeRole: 'edge', durableSyncEnabled: true } };
    const admission = () => DKGAgent.prototype.onDemandAgentsPhonebookEnabled
      .call(host as unknown as DKGAgent);
    vi.stubEnv('DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT', '0');
    vi.stubEnv('DKG_ON_DEMAND_AGENTS_PHONEBOOK', '1');
    vi.stubEnv('DKG_DURABLE_SYNC_ENABLED', '0');
    expect(resolveDurableSyncEnabled(host.config.durableSyncEnabled)).toBe(false);
    expect(admission()).toBe(false);
    vi.stubEnv('DKG_DURABLE_SYNC_ENABLED', '1');
    expect(resolveDurableSyncEnabled(host.config.durableSyncEnabled)).toBe(true);
    expect(admission()).toBe(true);
  });
});
