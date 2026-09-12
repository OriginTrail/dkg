// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  RFC64_PRIVATE_CHILD_PROTOCOL_V1,
  childCommandDescriptorV1,
  defineChildCommandHandlersV1,
  dispatchChildCommandV1,
  isSafeChildDiagnosticPhaseV1,
} from './child-protocol.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';
import {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_PROBE_ACTORS_V1,
  RFC64_PRIVATE_RUNTIME_ACTORS_V1,
  RFC64_PRIVATE_RUNTIME_ROLES_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
  RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1,
} from './scenario-actors.ts';

const PROTOCOL_TEST_DIGEST = `0x${'ab'.repeat(32)}`;
const VALID_CHILD_COMMANDS = Object.freeze({
  dial: Object.freeze({
    cmd: 'dial',
    multiaddr: '/ip4/127.0.0.1/tcp/1/p2p/test',
    peerId: 'test-peer',
  }),
  publish: Object.freeze({ cmd: 'publish' }),
  'publish-update': Object.freeze({ cmd: 'publish-update' }),
  'wait-bootstrap': Object.freeze({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: PROTOCOL_TEST_DIGEST,
    timeoutMs: 1_000,
  }),
  inspect: Object.freeze({ cmd: 'inspect', expectedHeadDigest: PROTOCOL_TEST_DIGEST }),
  'inspect-persisted': Object.freeze({ cmd: 'inspect-persisted' }),
  'sync-denied': Object.freeze({ cmd: 'sync-denied', providerPeerIds: ['test-peer'] }),
  'revoke-receiver': Object.freeze({ cmd: 'revoke-receiver' }),
  'observe-receiver-revocation': Object.freeze({ cmd: 'observe-receiver-revocation' }),
  stop: Object.freeze({ cmd: 'stop' }),
});

test('one actor model derives every scenario role and evidence domain', () => {
  assert.deepEqual(RFC64_PRIVATE_RUNTIME_ROLES_V1, [
    'owner',
    'provider2',
    'receiver',
    'outsider',
  ]);
  assert.deepEqual(
    RFC64_PRIVATE_PROBE_ACTORS_V1.map(({ role, processId }) => ({ role, processId })),
    RFC64_PRIVATE_RUNTIME_ROLES_V1.map((role) => ({ role, processId: `probe-${role}` })),
  );
  assert.deepEqual(RFC64_PRIVATE_RUNTIME_ACTORS_V1.map(({ processId }) => processId), [
    'owner',
    'provider2',
    'receiver-seed',
    'receiver',
    'owner-revoker',
    'outsider',
    'receiver-restart',
  ]);
  assert.deepEqual(
    RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
    RFC64_PRIVATE_RUNTIME_ACTORS_V1.map(({ processId }) => processId),
  );
  assert.deepEqual(RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1, [
    'provider2',
    'receiver-seed',
    'receiver',
  ]);
  assert.deepEqual(RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1, [
    'probe-owner',
    'probe-provider2',
    'probe-receiver',
    'probe-outsider',
    'owner',
    'provider2',
    'receiver-seed',
    'receiver',
    'owner-revoker',
    'outsider',
    'receiver-restart',
  ]);
  assert.equal(
    RFC64_PRIVATE_RUNTIME_ACTORS_V1.some((actor) => 'rpcAccounting' in actor),
    false,
  );
});

test('child protocol table classifies every request, response, and safe phase', async () => {
  for (const descriptor of Object.values(RFC64_PRIVATE_CHILD_PROTOCOL_V1)) {
    assert.equal(childCommandDescriptorV1(VALID_CHILD_COMMANDS[descriptor.command]), descriptor);
    assert.equal(isSafeChildDiagnosticPhaseV1(descriptor.responseEvent), true);
    assert.deepEqual(Object.keys(descriptor), ['command', 'responseEvent', 'validate']);
  }
  assert.equal(isSafeChildDiagnosticPhaseV1(
    RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready,
  ), true);
  assert.equal(isSafeChildDiagnosticPhaseV1(
    RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.commandError,
  ), false);
  assert.throws(() => childCommandDescriptorV1({ cmd: 'unknown' }), /unknown/u);
  const handlers = defineChildCommandHandlersV1(Object.fromEntries(
    Object.keys(RFC64_PRIVATE_CHILD_PROTOCOL_V1).map((command) => [command, () => ({})]),
  ));
  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(RFC64_PRIVATE_CHILD_PROTOCOL_V1).sort());
  assert.throws(() => defineChildCommandHandlersV1({ inspect: () => ({}) }), /exactly cover/u);
  for (const [command, descriptor] of Object.entries(RFC64_PRIVATE_CHILD_PROTOCOL_V1)) {
    if (command === 'stop') continue;
    const emitted = [];
    await dispatchChildCommandV1(
      handlers,
      { ...VALID_CHILD_COMMANDS[command], requestId: `parity:${command}` },
      (...args) => emitted.push(args),
    );
    assert.deepEqual(emitted, [[descriptor.responseEvent, `parity:${command}`, {}]]);
  }
  const stopEmitted = [];
  await dispatchChildCommandV1(
    handlers,
    { ...VALID_CHILD_COMMANDS.stop, requestId: 'parity:stop' },
    (...args) => stopEmitted.push(args),
  );
  assert.deepEqual(stopEmitted, []);
  for (const malformed of [
    { cmd: 'dial', multiaddr: '/ip4/127.0.0.1/tcp/1' },
    { cmd: 'publish', unexpected: true },
    { cmd: 'wait-bootstrap', expectedHeadDigest: 'not-a-digest', timeoutMs: 1_000 },
    { cmd: 'wait-bootstrap', expectedHeadDigest: PROTOCOL_TEST_DIGEST, timeoutMs: 999 },
    { cmd: 'inspect', expectedHeadDigest: 'not-a-digest' },
    { cmd: 'sync-denied', providerPeerIds: [] },
  ]) {
    assert.throws(() => childCommandDescriptorV1(malformed), TypeError);
  }
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
