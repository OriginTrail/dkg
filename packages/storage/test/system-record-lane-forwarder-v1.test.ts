import { describe, expect, it, vi } from 'vitest';

import { SystemRecordLaneForwarderV1 } from '../src/system-record-lane-forwarder-v1-internal.js';
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
    const forwarder = new SystemRecordLaneForwarderV1(policy);
    const first = controllerFixture('generation-a');
    const replacement = controllerFixture('generation-b');

    const firstFacade = forwarder.forward(first.controller);
    expect(firstFacade).toBeDefined();
    expect(forwarder.forward(first.controller)).toBe(firstFacade);

    expect(forwarder.forward(undefined)).toBeUndefined();

    const replacementFacade = forwarder.forward(replacement.controller);
    expect(replacementFacade).toBeDefined();
    expect(replacementFacade).not.toBe(firstFacade);
    expect(forwarder.forward(replacement.controller)).toBe(replacementFacade);

    const session = await replacementFacade!.open(ACTIVATION);
    expect(first.controller.open).not.toHaveBeenCalled();
    expect(replacement.controller.open).toHaveBeenCalledOnce();
    expect(replacement.controller.open).toHaveBeenCalledWith(ACTIVATION);
    expect(session.activationGeneration).toBe('generation-b');
  });

  it('passes sessions and outcomes through while invoking the wrapper policy', async () => {
    const policy = { onOutcome: vi.fn() };
    const forwarder = new SystemRecordLaneForwarderV1(policy);
    const inner = controllerFixture('generation-a');

    const session = await forwarder.forward(inner.controller)!.open(ACTIVATION);
    expect(session.state).toBe('enabled');
    await expect(session.applyVerified({ proof: true })).resolves.toBe(APPLIED);
    expect(inner.session.applyVerified).toHaveBeenCalledWith({ proof: true });
    expect(policy.onOutcome).toHaveBeenCalledOnce();
    expect(policy.onOutcome).toHaveBeenCalledWith(APPLIED);

    await session.close('shutdown');
    expect(inner.session.close).toHaveBeenCalledWith('shutdown');
  });
});
