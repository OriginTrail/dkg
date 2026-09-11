// SPDX-License-Identifier: Apache-2.0

const COMMAND_DESCRIPTORS = Object.freeze([
  descriptor('dial', 'dialed'),
  descriptor('publish', 'published'),
  descriptor('publish-update', 'published'),
  descriptor('wait-bootstrap', 'bootstrap-applied'),
  descriptor('inspect', 'inspection'),
  descriptor('inspect-persisted', 'persisted-inspection'),
  descriptor('sync-denied', 'sync-denial-result'),
  descriptor('revoke-receiver', 'receiver-revoked'),
  descriptor('stop', 'stopping'),
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
  return descriptor;
}

export function isSafeChildDiagnosticPhaseV1(value) {
  return typeof value === 'string' && SAFE_DIAGNOSTIC_PHASES.has(value);
}

function descriptor(command, responseEvent) {
  return Object.freeze({ command, responseEvent });
}
