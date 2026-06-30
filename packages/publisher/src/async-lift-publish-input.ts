import type {
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
} from './lift-job.js';

export interface LiftPublishInputWithOptionalMetadata {
  readonly request: LiftPublishSnapshotRequest;
  readonly metadata?: LiftPublishRequestMetadata;
}

export interface NormalizedLiftPublishInput {
  readonly request: LiftPublishSnapshotRequest;
  readonly metadata: LiftPublishRequestMetadata;
}

export function normalizeLiftPublishInput(
  input: LiftPublishInputWithOptionalMetadata,
  errorContext: string,
): NormalizedLiftPublishInput {
  if (input.metadata) {
    return { request: input.request, metadata: input.metadata };
  }
  if (hasInlineLiftMetadata(input.request)) {
    return {
      request: input.request,
      metadata: {
        scope: input.request.scope,
        transitionType: input.request.transitionType,
        authority: input.request.authority,
      },
    };
  }
  throw new Error(`${errorContext} requires request metadata for non-raw snapshot requests`);
}

function hasInlineLiftMetadata(
  request: LiftPublishSnapshotRequest,
): request is LiftPublishSnapshotRequest & LiftPublishRequestMetadata {
  const maybe = request as Partial<LiftPublishRequestMetadata>;
  return Boolean(maybe.authority && maybe.scope && maybe.transitionType);
}
