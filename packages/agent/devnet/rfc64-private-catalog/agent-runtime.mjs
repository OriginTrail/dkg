// SPDX-License-Identifier: Apache-2.0

/** Validate the exact probe boundary before creating any process resources. */
export function assertProbeRuntimeFactoryInputV1(input) {
  assertExactObjectKeysV1(input, ['dataDir', 'faultProfile', 'role'], 'probe runtime');
  assertRuntimeRoleV1(input.role);
}

/** Validate the exact finalized boundary before creating any process resources. */
export function assertFinalizedRuntimeFactoryInputV1(input) {
  assertExactObjectKeysV1(
    input,
    ['dataDir', 'faultProfile', 'manifest', 'role'],
    'finalized runtime',
  );
  assertRuntimeRoleV1(input.role);
  if (
    input.manifest === null
    || typeof input.manifest !== 'object'
    || Array.isArray(input.manifest)
  ) {
    throw new TypeError('finalized runtime requires a manifest');
  }
}

/** Runtime variant used only for identity probing and a graceful receipt. */
export function createProbeRuntimeV1(created, { role }) {
  assertRuntimeRoleV1(role);
  if (
    created === null
    || typeof created !== 'object'
    || !hasExactOwnKeysV1(created, ['agent', 'faultProfile'])
    || created.agent === null
    || typeof created.agent !== 'object'
  ) {
    throw new TypeError('probe runtime requires only probe agent resources');
  }
  return Object.freeze({ ...created, kind: 'probe', role });
}

/** Finalized runtime variant with all command dependencies bound at boot. */
export function createFinalizedRuntimeV1(created, input) {
  if (
    input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || !hasExactOwnKeysV1(input, ['initialFinalizedAuthority', 'peerIds', 'role'])
  ) {
    throw new TypeError('finalized runtime requires exact runtime bindings');
  }
  assertRuntimeRoleV1(input.role);
  if (
    created === null
    || typeof created !== 'object'
    || !hasExactOwnKeysV1(created, ['agent', 'chainAdapter', 'faultProfile', 'rpc'])
    || created.agent === null
    || typeof created.agent !== 'object'
    || created.chainAdapter === null
    || typeof created.chainAdapter !== 'object'
    || created.rpc === null
    || typeof created.rpc !== 'object'
  ) {
    throw new TypeError('finalized runtime requires agent, chain adapter, and RPC resources');
  }
  return Object.freeze({
    ...created,
    kind: 'run',
    role: input.role,
    initialFinalizedAuthority: input.initialFinalizedAuthority,
    peerIds: Object.freeze({ ...input.peerIds }),
    publication: input.role === 'owner' ? createOwnerPublicationStateV1() : null,
  });
}

export function assertFinalizedRuntimeV1(context) {
  if (context.kind !== 'run') throw new Error('command requires a finalized runtime');
}

function assertRuntimeRoleV1(role) {
  if (!['owner', 'provider2', 'receiver', 'outsider'].includes(role)) {
    throw new TypeError('RFC-64 private runtime role is invalid');
  }
}

function hasExactOwnKeysV1(value, expectedKeys) {
  return Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function assertExactObjectKeysV1(input, expectedKeys, label) {
  if (
    input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || !hasExactOwnKeysV1(input, expectedKeys)
  ) {
    throw new TypeError(`${label} requires its exact runtime inputs`);
  }
}

/** Explicit owner-only baseline publication state machine. */
export function createOwnerPublicationStateV1() {
  let state = Object.freeze({ kind: 'empty' });
  return Object.freeze({
    beginBaseline() {
      if (state.kind !== 'empty') throw new Error('catalog baseline already published');
      state = Object.freeze({ kind: 'publishing-baseline' });
    },
    commitBaseline(scope, assets) {
      if (state.kind !== 'publishing-baseline') {
        throw new Error('catalog baseline publication was not started');
      }
      state = Object.freeze({ kind: 'baseline', scope, assets: Object.freeze([...assets]) });
    },
    requireBaseline() {
      if (state.kind !== 'baseline') {
        throw new Error('catalog update requires a published finalized-VM baseline');
      }
      return state;
    },
  });
}
