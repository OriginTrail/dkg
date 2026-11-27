import { expect, it } from 'vitest';
import fc from 'fast-check';
import { parseContextGraphJoinPolicyRecord, isBoundedOpenEnrollmentPolicy, isContextGraphJoinPolicyRecord } from '../src/context-graph-join-policy.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

// Bounds are protocol expectations, deliberately independent of implementation constants.
const policy = fc.record({
  version: fc.constant(1), contextGraphId: fc.string({ minLength: 1 }), ownerDid: fc.string({ minLength: 1 }),
  mode: fc.constantFrom('manual', 'open'), updatedAt: fc.integer(),
  maxMembers: fc.integer({ min: 1, max: 10_000 }), maxApprovalsPerHour: fc.integer({ min: 1, max: 1_000 }),
});

it('canonical policies survive persistence and never authorize a different graph', () => {
  fc.assert(fc.property(policy, fc.string(), (input, suffix) => {
    const parsed = parseContextGraphJoinPolicyRecord(JSON.parse(JSON.stringify(input)), input.contextGraphId);
    const { maxMembers: _maxMembers, maxApprovalsPerHour: _maxApprovalsPerHour, ...manual } = input;
    expect(parsed).toEqual(input.mode === 'open' ? input : manual);
    expect(isContextGraphJoinPolicyRecord(parsed)).toBe(true);
    expect(isBoundedOpenEnrollmentPolicy(parsed)).toBe(input.mode === 'open');
    expect(parseContextGraphJoinPolicyRecord(parsed, input.contextGraphId + '\0' + suffix)).toBeNull();
    expect(parseContextGraphJoinPolicyRecord({ ...input, injected: true })).not.toHaveProperty('injected');
  }), propertyOptions());
});

it('one corrupt authority field cannot retain auto-admission', () => {
  const corrupt = fc.oneof(
    fc.record({ field: fc.constant('version'), value: fc.constantFrom(0, 2, '1', null) }),
    fc.record({ field: fc.constantFrom('contextGraphId', 'ownerDid'), value: fc.constantFrom('', 0, false, null) }),
    fc.record({ field: fc.constant('mode'), value: fc.constantFrom('', 'automatic', 0, null) }),
    fc.record({ field: fc.constant('updatedAt'), value: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, '0', null) }),
    fc.record({ field: fc.constant('maxMembers'), value: fc.constantFrom(0, -1, 10_001, 1.5, '1', null) }),
    fc.record({ field: fc.constant('maxApprovalsPerHour'), value: fc.constantFrom(0, -1, 1_001, 1.5, '1', null) }),
  );
  fc.assert(fc.property(policy, corrupt, (base, edit) => {
    const input = { ...base, mode: 'open', [edit.field]: edit.value };
    expect(parseContextGraphJoinPolicyRecord(input)).toBeNull();
    expect(isBoundedOpenEnrollmentPolicy(input)).toBe(false);
    expect(isContextGraphJoinPolicyRecord(input)).toBe(false);
  }), propertyOptions());
});
