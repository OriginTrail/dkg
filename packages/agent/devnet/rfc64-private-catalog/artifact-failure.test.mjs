// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  RFC64_PRIVATE_CHILD_PROTOCOL_V1,
  childCommandDescriptorV1,
  isSafeChildDiagnosticPhaseV1,
} from './child-protocol.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';
import { assertInitialFinalizedAuthorityV1 } from './initial-authority.mjs';
import { createPrivatePolicyAndRoster, roleAgentAddress } from './fixture.mjs';

test('child protocol table classifies every request, response, and safe phase', () => {
  for (const descriptor of Object.values(RFC64_PRIVATE_CHILD_PROTOCOL_V1)) {
    assert.equal(childCommandDescriptorV1({ cmd: descriptor.command }), descriptor);
    assert.equal(isSafeChildDiagnosticPhaseV1(descriptor.responseEvent), true);
    assert.equal(descriptor.safeDiagnosticPhase, descriptor.responseEvent);
  }
  assert.equal(
    isSafeChildDiagnosticPhaseV1(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready),
    true,
  );
  assert.equal(
    isSafeChildDiagnosticPhaseV1(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.commandError),
    false,
  );
  assert.throws(() => childCommandDescriptorV1({ cmd: 'unknown' }), /unknown/u);
});

test('child command failures retain only a bounded command phase', () => {
  const sensitiveCause = new Error('provider endpoint and wallet material');
  const classified = sanitizeGateFailureV1(
    createGateCommandFailureV1('persisted-inspection', sensitiveCause),
  );
  assert.deepEqual(classified, {
    failureClass: 'gate-command-failed',
    commandPhase: 'persisted-inspection',
  });
  assert.equal(JSON.stringify(classified).includes(sensitiveCause.message), false);
  assert.deepEqual(sanitizeGateFailureV1(
    createGateCommandFailureV1('caller-controlled-phase', sensitiveCause),
  ), { failureClass: 'gate-execution-failed' });
});

test('initial authority rejects a finalized-chain roster fault before readiness', () => {
  const expected = createPrivatePolicyAndRoster();
  const expectedAuthority = {
    policy: expected.policy,
    policyDigest: expected.policyDigest,
    roster: expected.roster,
    source: 'finalized-chain',
  };
  const finalizedAuthority = {
    ...expectedAuthority,
    roster: {
      ...expected.roster,
      members: expected.roster.members.filter(
        ({ agentAddress }) => agentAddress !== roleAgentAddress('receiver'),
      ),
    },
  };
  assert.throws(
    () => assertInitialFinalizedAuthorityV1({
      acceptedAuthority: expectedAuthority,
      finalizedAuthority,
      expectedAuthority,
    }),
    /differs from the finalized chain snapshot/u,
  );
});
