import { describe, expect, it, vi } from 'vitest';

import { SystemRecordLaneForwarderV1 } from '../src/system-record-lane-forwarder-v1.js';
import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneActivationV1,
  SystemRecordLaneControllerV1,
  SystemRecordLaneSessionV1,
} from '../src/system-record-materializer-v1.js';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

const APPLIED: SystemRecordApplyOutcomeV1 = {
  outcome: 'applied',
  stateRevision: 'revision-1',
  appliedStateDigest: 'digest-1',
};

function controllerFixture(generation: string, outcome = APPLIED) {
  const session: SystemRecordLaneSessionV1 = {
    state: 'enabled',
    activationGeneration: generation,
    applyVerified: vi.fn(async () => outcome),
    close: vi.fn(async () => undefined),
  };
  const controller: SystemRecordLaneControllerV1 = {
    open: vi.fn(async () => session),
  };
  return { controller, session };
}

describe('SystemRecordLaneForwarderV1', () => {
  it('recovers after transient absence and re-wraps a replacement controller', async () => {
    const policy = { onOutcome: vi.fn() };
    const first = controllerFixture('generation-a');
    const replacement = controllerFixture('generation-b');
    let advertised: SystemRecordLaneControllerV1 | undefined = first.controller;
    const forwarder = new SystemRecordLaneForwarderV1(() => advertised, policy);

    const firstFacade = forwarder.forward();
    expect(firstFacade).toBeDefined();
    expect(forwarder.forward()).toBe(firstFacade);

    advertised = undefined;
    expect(forwarder.forward()).toBeUndefined();

    advertised = replacement.controller;
    const replacementFacade = forwarder.forward();
    expect(replacementFacade).toBeDefined();
    expect(replacementFacade).not.toBe(firstFacade);
    expect(forwarder.forward()).toBe(replacementFacade);

    const session = await replacementFacade!.open(ACTIVATION);
    expect(first.controller.open).not.toHaveBeenCalled();
    expect(replacement.controller.open).toHaveBeenCalledOnce();
    expect(replacement.controller.open).toHaveBeenCalledWith(ACTIVATION);
    expect(session.activationGeneration).toBe('generation-b');
  });

  it('re-wraps a controller replacement without an intervening absence', async () => {
    const first = controllerFixture('generation-a');
    const replacement = controllerFixture('generation-b');
    let advertised = first.controller;
    const forwarder = new SystemRecordLaneForwarderV1(
      () => advertised,
      { onOutcome: vi.fn() },
    );

    const firstFacade = forwarder.forward();
    advertised = replacement.controller;
    const replacementFacade = forwarder.forward();

    expect(replacementFacade).not.toBe(firstFacade);
    await replacementFacade!.open(ACTIVATION);
    expect(first.controller.open).not.toHaveBeenCalled();
    expect(replacement.controller.open).toHaveBeenCalledOnce();
  });

  it('passes sessions and outcomes through while invoking the wrapper policy', async () => {
    const policy = { onOutcome: vi.fn() };
    const inner = controllerFixture('generation-a');
    const forwarder = new SystemRecordLaneForwarderV1(() => inner.controller, policy);

    const session = await forwarder.forward()!.open(ACTIVATION);
    expect(session.state).toBe('enabled');
    await expect(session.applyVerified({ proof: true })).resolves.toBe(APPLIED);
    expect(inner.session.applyVerified).toHaveBeenCalledWith({ proof: true });
    expect(policy.onOutcome).toHaveBeenCalledOnce();
    expect(policy.onOutcome).toHaveBeenCalledWith(APPLIED);

    await session.close('shutdown');
    expect(inner.session.close).toHaveBeenCalledWith('shutdown');
  });

  it('does not mask an authoritative apply outcome when local bookkeeping fails', async () => {
    const policyError = new Error('cache refresh failed');
    const policy = {
      onOutcome: vi.fn(() => {
        throw policyError;
      }),
    };
    const inner = controllerFixture('generation-a');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const forwarder = new SystemRecordLaneForwarderV1(() => inner.controller, policy);

    try {
      const session = await forwarder.forward()!.open(ACTIVATION);
      await expect(session.applyVerified({ proof: true })).resolves.toBe(APPLIED);
      expect(policy.onOutcome).toHaveBeenCalledWith(APPLIED);
      expect(consoleError).toHaveBeenCalledWith(
        '[SystemRecordLaneForwarderV1] outcome policy failed after lane apply:',
        policyError,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
