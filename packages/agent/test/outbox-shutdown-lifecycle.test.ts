import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

describe('DKGAgent outbox shutdown lifecycle', () => {
  it('cancels and awaits the active outbox drain before network teardown', async () => {
    let release!: () => void;
    const activeDrain = new Promise<void>((resolve) => { release = resolve; });
    const stopOutboxDrain = vi.fn(() => activeDrain);
    const stopNode = vi.fn(async () => {});
    const agent = Object.create(DKGAgent.prototype) as any;
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: null,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: stopNode },
      store: { close: vi.fn(async () => {}) },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopOutboxDrain).toHaveBeenCalledOnce();
    expect(stopNode).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(stopNode).toHaveBeenCalledOnce();
  });
});
