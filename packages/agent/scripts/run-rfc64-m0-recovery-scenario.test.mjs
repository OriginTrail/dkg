import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RFC64_M0_RECOVERY_SCENARIOS,
  validateRecoveryReport,
} from './run-rfc64-m0-recovery-scenario.mjs';

test('keeps scenario selection independent of human-readable display text', () => {
  const scenario = RFC64_M0_RECOVERY_SCENARIOS['provider-failover'];
  const matchingAssertion = {
    status: 'passed',
    title: `[${scenario.id}] this display text can change freely`,
  };

  assert.doesNotThrow(() => validateRecoveryReport(scenario, {
    numFailedTests: 0,
    numPassedTests: 1,
    testResults: [{ assertionResults: [matchingAssertion] }],
  }));
});

test('rejects a missing, skipped, or duplicated scenario proof', () => {
  const scenario = RFC64_M0_RECOVERY_SCENARIOS['provider-failover'];
  const matchingAssertion = {
    status: 'passed',
    title: `[${scenario.id}] source recovery`,
  };

  assert.throws(() => validateRecoveryReport(scenario, {
    numFailedTests: 0,
    numPassedTests: 0,
    testResults: [{ assertionResults: [] }],
  }), /did not prove exactly one passing/);

  assert.throws(() => validateRecoveryReport(scenario, {
    numFailedTests: 0,
    numPassedTests: 0,
    testResults: [{ assertionResults: [{ ...matchingAssertion, status: 'skipped' }] }],
  }), /did not prove exactly one passing/);

  assert.throws(() => validateRecoveryReport(scenario, {
    numFailedTests: 0,
    numPassedTests: 2,
    testResults: [{ assertionResults: [matchingAssertion, { ...matchingAssertion }] }],
  }), /did not prove exactly one passing/);
});
