// Pure validation for the context-graph selection on a Kafka endpoint
// registration. Caller must pass exactly one of `contextGraphId` (named
// shared CG) or `useLocalCg: true` (the node-local `kafka-local` free CG).
// Neither and both are hard errors. No DKG dependency: the route handler
// maps a thrown error to a 400 response. See ADR-0004.

const BOTH_OPTIONS_HINT =
  'Pass exactly one of "contextGraphId" (publish into a named shared CG) ' +
  'or "useLocalCg": true (publish into the local "kafka-local" free CG).';

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
  const hasLocal = input.useLocalCg != null;

  if (hasCg && hasLocal) {
    throw new Error(
      `"contextGraphId" and "useLocalCg" are mutually exclusive. ${BOTH_OPTIONS_HINT}`,
    );
  }

  if (hasLocal && typeof input.useLocalCg !== 'boolean') {
    throw new Error('"useLocalCg" must be a boolean (true).');
  }

  if (input.useLocalCg === true) {
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
    return { kind: 'shared', contextGraphId: trimmed };
  }

  throw new Error(`Missing context-graph selection. ${BOTH_OPTIONS_HINT}`);
}
