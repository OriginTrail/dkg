// Pure validation for the context-graph selection on a Kafka endpoint
// registration. Caller must pass exactly one of `contextGraphId` (named
// shared CG) or `useLocalCg: true` (the node-local kafka-local free CG).
// Neither and both are hard errors. No DKG client dependency: the route
// handler maps a thrown error to a 400 response. The local-cg constant
// imports below are just string literals — no I/O. See ADR-0004.

import {
  KAFKA_LOCAL_CG_BARE_ID,
  KAFKA_LOCAL_CG_ID_PREFIX,
} from './local-cg.js';

const BOTH_OPTIONS_HINT =
  'Pass exactly one of "contextGraphId" (publish into a named shared CG) ' +
  'or "useLocalCg": true (publish into the local kafka-local free CG).';

export interface KafkaContextGraphSelectionInput {
  contextGraphId?: unknown;
  useLocalCg?: unknown;
}

export type KafkaContextGraphSelection =
  | { kind: 'shared'; contextGraphId: string }
  | { kind: 'local' };

export function validateContextGraphSelection(
  input: KafkaContextGraphSelectionInput,
): KafkaContextGraphSelection {
  const hasCg = input.contextGraphId != null;
  const localValue = input.useLocalCg;

  // Type-check `useLocalCg` first so that explicit non-boolean values like `0`
  // or `'true'` always fail with a type error, regardless of whether a
  // `contextGraphId` is also present. Coercion would silently mask caller bugs.
  if (
    localValue !== undefined &&
    localValue !== null &&
    typeof localValue !== 'boolean'
  ) {
    throw new Error('"useLocalCg" must be a boolean (true).');
  }

  // Treat `useLocalCg: false` as equivalent to omission (matches typical
  // JSON-default serialization patterns where a client emits all fields with
  // their defaults). Only `useLocalCg === true` is a positive selection.
  const wantsLocal = localValue === true;

  if (hasCg && wantsLocal) {
    throw new Error(
      `"contextGraphId" and "useLocalCg" are mutually exclusive. ${BOTH_OPTIONS_HINT}`,
    );
  }

  if (wantsLocal) {
    return { kind: 'local' };
  }

  if (hasCg) {
    if (typeof input.contextGraphId !== 'string') {
      throw new Error('"contextGraphId" must be a string.');
    }
    const trimmed = input.contextGraphId.trim();
    if (trimmed.length === 0) {
      throw new Error('"contextGraphId" must be a non-empty string.');
    }
    // Reject both the bare reserved id and any per-node prefixed form
    // (`kafka-local-{peerId}`). The prefix space is owned by the local-CG
    // ensurer; letting a caller smuggle one of those ids through the shared
    // path would bypass the lazy-create gate and risk publishing into another
    // node's local CG.
    if (
      trimmed === KAFKA_LOCAL_CG_BARE_ID ||
      trimmed.startsWith(KAFKA_LOCAL_CG_ID_PREFIX)
    ) {
      throw new Error(
        `"contextGraphId" cannot be "${trimmed}" — the "${KAFKA_LOCAL_CG_BARE_ID}" prefix is reserved for per-node local free CGs. Use "useLocalCg": true instead.`,
      );
    }
    return { kind: 'shared', contextGraphId: trimmed };
  }

  throw new Error(`Missing context-graph selection. ${BOTH_OPTIONS_HINT}`);
}
