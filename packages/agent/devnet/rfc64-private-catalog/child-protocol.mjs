// SPDX-License-Identifier: Apache-2.0

const COMMAND_DESCRIPTORS = Object.freeze([
  descriptor('dial', 'dialed', validateDialCommandV1),
  descriptor('publish', 'published', validateNoPayloadCommandV1),
  descriptor('publish-update', 'published', validateNoPayloadCommandV1),
  descriptor('wait-bootstrap', 'bootstrap-applied', validateWaitBootstrapCommandV1),
  descriptor('inspect', 'inspection', validateInspectCommandV1),
  descriptor('inspect-persisted', 'persisted-inspection', validateInspectCommandV1),
  descriptor('sync-denied', 'sync-denial-result', validateSyncDeniedCommandV1),
  descriptor('revoke-receiver', 'receiver-revoked', validateNoPayloadCommandV1),
  descriptor(
    'observe-receiver-revocation',
    'revocation-observed',
    validateNoPayloadCommandV1,
  ),
  descriptor('stop', 'stopping', validateNoPayloadCommandV1),
]);

export const RFC64_PRIVATE_CHILD_PROTOCOL_V1 = Object.freeze(Object.fromEntries(
  COMMAND_DESCRIPTORS.map((entry) => [entry.command, entry]),
));

export const RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1 = Object.freeze({
  bootFailed: 'boot-failed',
  commandError: 'command-error',
  ready: 'ready',
});

const SAFE_DIAGNOSTIC_PHASES = new Set([
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready,
  ...COMMAND_DESCRIPTORS.map(({ responseEvent }) => responseEvent),
]);

/** Validate a parent-to-child request against the single canonical command table. */
export function childCommandDescriptorV1(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('RFC-64 private child command must be an object');
  }
  const descriptor = RFC64_PRIVATE_CHILD_PROTOCOL_V1[command.cmd];
  if (descriptor === undefined) {
    throw new TypeError(`unknown RFC-64 private child command ${String(command.cmd)}`);
  }
  if (
    command.requestId !== undefined
    && (
      typeof command.requestId !== 'string'
      || command.requestId.length === 0
      || command.requestId.length > 128
    )
  ) {
    throw new TypeError('RFC-64 private child requestId must be a bounded string');
  }
  descriptor.validate(command);
  return descriptor;
}

/** Snapshot a complete child handler table against the canonical descriptors. */
export function defineChildCommandHandlersV1(handlers) {
  if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new TypeError('RFC-64 private child handlers must be a plain object');
  }
  const expected = Object.keys(RFC64_PRIVATE_CHILD_PROTOCOL_V1).sort();
  const actual = Object.keys(handlers).sort();
  if (
    actual.length !== expected.length
    || actual.some((command, index) => command !== expected[index])
    || actual.some((command) => typeof handlers[command] !== 'function')
  ) {
    throw new TypeError('RFC-64 private child handlers must exactly cover the protocol table');
  }
  return Object.freeze(Object.fromEntries(expected.map((command) => [
    command,
    handlers[command],
  ])));
}

/** Dispatch one command and emit only the response declared by its descriptor. */
export async function dispatchChildCommandV1(handlers, command, emitResponse) {
  const descriptor = childCommandDescriptorV1(command);
  const result = await handlers[descriptor.command](command);
  if (descriptor.command !== 'stop') {
    emitResponse(descriptor.responseEvent, command.requestId, result);
  }
  return Object.freeze({ descriptor, result });
}

export function isSafeChildDiagnosticPhaseV1(value) {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_PHASES.has(value);
}

function descriptor(command, responseEvent, validate) {
  return Object.freeze({ command, responseEvent, validate });
}

function validateNoPayloadCommandV1(command) {
  assertExactCommandKeysV1(command, []);
}

function validateDialCommandV1(command) {
  assertExactCommandKeysV1(command, ['multiaddr', 'peerId']);
  assertBoundedStringV1(command.multiaddr, 'dial multiaddr', 512);
  assertBoundedStringV1(command.peerId, 'dial peerId', 128);
}

function validateWaitBootstrapCommandV1(command) {
  assertExactCommandKeysV1(command, [
    'expectedHeadDigest',
    'expectedMemory?',
    'timeoutMs',
  ]);
  assertDigestV1(command.expectedHeadDigest, 'wait-bootstrap expectedHeadDigest');
  if (
    command.expectedMemory !== undefined
    && command.expectedMemory !== 'finalized-vm-v1'
  ) {
    throw new TypeError('wait-bootstrap expectedMemory is unsupported');
  }
  if (
    !Number.isSafeInteger(command.timeoutMs)
    || command.timeoutMs < 1_000
    || command.timeoutMs > 120_000
  ) {
    throw new TypeError('wait-bootstrap timeoutMs must be a bounded safe integer');
  }
}

function validateInspectCommandV1(command) {
  assertExactCommandKeysV1(command, ['expectedHeadDigest?']);
  if (command.expectedHeadDigest !== undefined) {
    assertDigestV1(command.expectedHeadDigest, 'inspect expectedHeadDigest');
  }
}

function validateSyncDeniedCommandV1(command) {
  assertExactCommandKeysV1(command, ['providerPeerIds']);
  if (
    !Array.isArray(command.providerPeerIds)
    || command.providerPeerIds.length === 0
    || command.providerPeerIds.length > 8
    || command.providerPeerIds.some((peerId) => (
      typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 128
    ))
    || new Set(command.providerPeerIds).size !== command.providerPeerIds.length
  ) {
    throw new TypeError('sync-denied providerPeerIds must be unique bounded strings');
  }
}

function assertExactCommandKeysV1(command, payloadKeys) {
  const required = payloadKeys.filter((key) => !key.endsWith('?'));
  const allowed = new Set([
    'cmd',
    'requestId',
    ...payloadKeys.map((key) => key.replace(/\?$/u, '')),
  ]);
  if (
    Object.keys(command).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(command, key))
  ) {
    throw new TypeError(`RFC-64 private ${command.cmd} command has invalid fields`);
  }
}

function assertBoundedStringV1(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a bounded string`);
  }
}

function assertDigestV1(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase bytes32 digest`);
  }
}
