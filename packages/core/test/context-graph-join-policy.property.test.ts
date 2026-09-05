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
    fc.constantFrom(null, [], false, 0, ''),
    fc.record({ field: fc.constantFrom('version', 'contextGraphId', 'ownerDid', 'mode', 'updatedAt', 'maxMembers', 'maxApprovalsPerHour'), value: fc.anything() }),
  );
  fc.assert(fc.property(policy, corrupt, (base, edit) => {
    const input = edit && typeof edit === 'object' && 'field' in edit ? { ...base, mode: 'open', [edit.field]: edit.value } : edit;
    const result = parseContextGraphJoinPolicyRecord(input);
    if (result === null) {
      expect(isBoundedOpenEnrollmentPolicy(input)).toBe(false);
      expect(isContextGraphJoinPolicyRecord(input)).toBe(false);
    } else {
      expect(result.version).toBe(1);
      expect(typeof result.contextGraphId).toBe('string'); expect(result.contextGraphId.length).toBeGreaterThan(0);
      expect(typeof result.ownerDid).toBe('string'); expect(result.ownerDid.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.updatedAt)).toBe(true);
      expect(['manual', 'open']).toContain(result.mode);
      if (result.mode === 'open') {
        expect(Number.isInteger(result.maxMembers)).toBe(true);
        expect(result.maxMembers).toBeGreaterThan(0); expect(result.maxMembers).toBeLessThanOrEqual(10_000);
        expect(Number.isInteger(result.maxApprovalsPerHour)).toBe(true);
        expect(result.maxApprovalsPerHour).toBeGreaterThan(0); expect(result.maxApprovalsPerHour).toBeLessThanOrEqual(1_000);
      }
    }
  }), propertyOptions());
});
