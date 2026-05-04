// Pure validation for the context-graph selection on a Kafka endpoint
// registration. The caller must pass exactly one of `contextGraphId` (publish
// into a named shared CG) or `useLocalCg: true` (publish into the node-local
// `kafka-local` free CG). Passing neither — or both — is a hard error.
//
// This module is pure: input in, validated/normalized output or thrown error
// out. It MUST NOT take a DKG client dependency; the calling layer is the
// route handler in `packages/cli/src/daemon/routes/kafka.ts`, which maps the
// thrown error to a 400 response.
//
// See ADR-0004: explicit local-vs-shared CG choice. The API rejects implicit
// defaults so the caller can never accidentally publish into the wrong place.

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
  const hasCg = input.contextGraphId !== undefined && input.contextGraphId !== null;
  const hasLocal = input.useLocalCg !== undefined && input.useLocalCg !== null;

  if (hasCg && hasLocal) {
    throw new Error(
      `"contextGraphId" and "useLocalCg" are mutually exclusive. ${BOTH_OPTIONS_HINT}`,
    );
  }

  if (hasLocal) {
    if (typeof input.useLocalCg !== 'boolean') {
      throw new Error('"useLocalCg" must be a boolean (true).');
    }
    if (input.useLocalCg === true) {
      return { kind: 'local' };
    }
    // useLocalCg: false collapses to "no CG selected" — fall through to the
    // missing-field error below so the caller sees the same actionable message
    // they would have seen if they had omitted both fields entirely.
  }

  if (hasCg) {
    if (typeof input.contextGraphId !== 'string') {
      throw new Error('"contextGraphId" must be a string.');
    }
    const trimmed = input.contextGraphId.trim();
    if (trimmed.length === 0) {
      throw new Error('"contextGraphId" must be a non-empty string.');
    }
    return { kind: 'shared', contextGraphId: input.contextGraphId };
  }

  throw new Error(
    `Missing context-graph selection. ${BOTH_OPTIONS_HINT}`,
  );
}
