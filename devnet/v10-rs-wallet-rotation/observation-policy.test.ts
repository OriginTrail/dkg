import { describe, expect, it } from 'vitest';
import {
  classifyObservedRsSenders,
  classifyRsRotationObservation,
} from './observation-policy.js';

describe('v10-rs-wallet-rotation observation policy', () => {
  it('fails observed unregistered senders even when the create-submit cycle is incomplete', () => {
    const create = new Set(['0xadmin']);
    const submit = new Set<string>();
    const senders = new Set([...create, ...submit]);

    const senderOutcome = classifyObservedRsSenders(senders, new Set(['0xop']));
    expect(senderOutcome.kind).toBe('fail');
    if (senderOutcome.kind === 'fail') {
      expect(senderOutcome.reason).toMatch(/fail-closed violation/);
    }

    expect(classifyRsRotationObservation(create, submit, 600_000, false).kind).toBe('skip');
  });

  it('skips incomplete observations locally and fails them in the required lane', () => {
    const create = new Set(['0xop1']);
    const submit = new Set<string>();

    expect(classifyRsRotationObservation(create, submit, 600_000, false).kind).toBe('skip');

    const required = classifyRsRotationObservation(create, submit, 600_000, true);
    expect(required.kind).toBe('fail');
    if (required.kind === 'fail') {
      expect(required.reason).toMatch(/DKG_REQUIRE_RS_ROTATION=1/);
    }
  });

  it('runs hard assertions only after a full create-submit cycle is observed', () => {
    expect(
      classifyRsRotationObservation(new Set(['0xop1']), new Set(['0xop2']), 600_000, false),
    ).toEqual({ kind: 'run' });
  });
});
