import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import { runPreAgentStoreBootSteps } from '../src/daemon/pre-agent-store-boot.js';

const steps = vi.hoisted(() => ({ validate: vi.fn(), health: vi.fn(), identity: vi.fn(), wipe: vi.fn() }));
vi.mock('../src/config.js', () => ({ exitOnStoreConfigErrors: steps.validate }));
vi.mock('../src/daemon/store-health-check.js', () => ({
  checkExternalStoreReachable: steps.health, checkOrSetStoreIdentity: steps.identity,
  formatHealthCheckFailure: () => 'health failed', formatIdentityTagMismatch: () => 'identity mismatch',
}));
vi.mock('../src/daemon/chain-reset-wipe.js', () => ({
  chainResetWipe: steps.wipe, formatChainResetWipeOutcome: () => ['wipe outcome'],
  skipChainResetWipe: () => false,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('boot refused'); });
  steps.health.mockResolvedValue({ ok: true, backend: 'sparql-http', endpoint: 'http://local' });
  steps.identity.mockResolvedValue({ ok: true, action: 'existing' });
  steps.wipe.mockResolvedValue({ requiresStoreRetag: true });
});
afterEach(() => vi.restoreAllMocks());
function setup() {
  const activity = { report: vi.fn(), dispose: vi.fn() };
  const options = {
    managedOxigraph: { registerStoreActivity: vi.fn(() => activity) },
    runtimeStore: { backend: 'sparql-http' as const, options: { queryEndpoint: 'http://local/query' } },
    runtimeStoreConfig: {} as DkgConfig, dataDir: '/tmp/dkg-boot',
    chainResetMarker: 'new-chain', randomSamplingWalPath: '/tmp/override.wal',
    nodeName: 'owner', log: vi.fn(),
  };
  return { options, activity };
}
describe('pre-agent store boot ownership', () => {
  it('holds maintenance admission across an unresolved probe and refuses wipe after an unreachable store', async () => {
    const { options, activity } = setup();
    let reply!: (value: { ok: boolean }) => void;
    steps.health.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const boot = runPreAgentStoreBootSteps(options);
    expect(activity.report).toHaveBeenCalledExactlyOnceWith(true);
    expect(activity.dispose).not.toHaveBeenCalled();
    expect(steps.wipe).not.toHaveBeenCalled();
    reply({ ok: false });
    await expect(boot).rejects.toThrow('boot refused');
    expect(steps.identity).not.toHaveBeenCalled();
    expect(steps.wipe).not.toHaveBeenCalled();
    expect(activity.dispose).toHaveBeenCalledOnce();
  });
  it('never wipes a namespace owned by another node', async () => {
    const { options, activity } = setup();
    steps.identity.mockResolvedValue({ ok: false, action: 'mismatch' });
    await expect(runPreAgentStoreBootSteps(options)).rejects.toThrow('boot refused');
    expect(steps.wipe).not.toHaveBeenCalled();
    expect(activity.dispose).toHaveBeenCalledOnce();
  });
  it('re-tags a wiped remote namespace before releasing its activity lease', async () => {
    const { options, activity } = setup();
    steps.identity.mockResolvedValueOnce({ ok: true, action: 'existing' }).mockImplementationOnce(async () => {
      expect(activity.dispose).not.toHaveBeenCalled();
      return { ok: false, action: 'error', error: 'post-wipe tag unavailable' };
    });
    await expect(runPreAgentStoreBootSteps(options)).rejects.toThrow('boot refused');
    expect(steps.wipe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      dataDir: options.dataDir, currentMarker: 'new-chain', randomSamplingWalPath: '/tmp/override.wal', storeConfig: options.runtimeStore,
    }));
    expect(steps.identity).toHaveBeenCalledTimes(2);
    expect(options.log).toHaveBeenCalledWith('[STORE-IDENTITY] failed to re-tag: post-wipe tag unavailable');
    expect(activity.dispose).toHaveBeenCalledOnce();
  });
});
