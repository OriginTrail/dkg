// SPDX-License-Identifier: Apache-2.0

/** Runtime variant used only for identity probing and a graceful receipt. */
export function createProbeRuntimeV1(created) {
  return Object.freeze({ kind: 'probe', ...created });
}

/** Finalized runtime variant with all command dependencies bound at boot. */
export function createFinalizedRuntimeV1(created, input) {
  return Object.freeze({
    kind: 'run',
    ...created,
    initialFinalizedAuthority: input.initialFinalizedAuthority,
    peerIds: Object.freeze({ ...input.peerIds }),
    publication: input.role === 'owner' ? createOwnerPublicationStateV1() : null,
  });
}

export function assertFinalizedRuntimeV1(context) {
  if (context.kind !== 'run') throw new Error('command requires a finalized runtime');
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
