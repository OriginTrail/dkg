import {
  PROMOTE_POST_COMMIT_FAILURE_CODE,
  PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME,
  PROMOTE_RETRYABLE_FAILURE_CODE,
  PROMOTE_RETRYABLE_FAILURE_ERROR_NAME,
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
  getPromoteReplaySafeErrorDiagnostic,
  getPromoteRetryableFailureDiagnostic,
  isPromoteReplaySafeError,
  isPromoteRetryableFailure,
  type PromoteFailureDisposition,
  type PromotePostCommitFailureDiagnostic,
  type PromoteReplaySafeErrorDiagnostic,
  type PromoteRetryableFailureDiagnostic,
  type PromoteRetryableFailureMarker,
} from '@origintrail-official/dkg-publisher';

type PublisherApi = typeof import('../../src/index.js');

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

type PromoteFailureDispositionIsPublic = AssertTrue<
  'getPromoteFailureDisposition' extends keyof PublisherApi ? true : false
>;
type PromotePostCommitBoundaryIsPublic = AssertTrue<
  'createPromotePostCommitFailure' extends keyof PublisherApi ? true : false
>;
type LegacyReplaySafeGuardRemainsPublic = AssertTrue<
  'isPromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type LegacyReplaySafeDiagnosticRemainsPublic = AssertTrue<
  'getPromoteReplaySafeErrorDiagnostic' extends keyof PublisherApi ? true : false
>;
type LegacyRetryableGuardRemainsPublic = AssertTrue<
  'isPromoteRetryableFailure' extends keyof PublisherApi ? true : false
>;
type LegacyRetryableMarkerCodeRemainsPublic = AssertTrue<
  'PROMOTE_RETRYABLE_FAILURE_CODE' extends keyof PublisherApi ? true : false
>;
type ReplaySafeUnwrapperStaysAbsent = AssertFalse<
  'unwrapPromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ReplaySafeCertifierStaysInternal = AssertFalse<
  'classifyExactSwmGraphReplaceFailure' extends keyof PublisherApi ? true : false
>;
type ReplaySafeConstructorStaysInternal = AssertFalse<
  'PromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ReplaySafeCodeStaysInternal = AssertFalse<
  'PROMOTE_REPLAY_SAFE_ERROR_CODE' extends keyof PublisherApi ? true : false
>;
// @ts-expect-error Producer certification must not be importable as a package subpath.
type ReplaySafetyDeepModuleStaysClosed = typeof import('@origintrail-official/dkg-publisher/dist/promote-replay-safety.js');
// @ts-expect-error Unlisted implementation modules remain private by default.
type ArbitraryPublisherImplementationStaysClosed = typeof import('@origintrail-official/dkg-publisher/dist/dkg-publisher.js');
type LegacyWorkspaceResolutionSubpathRemainsAvailable =
  typeof import('@origintrail-official/dkg-publisher/dist/workspace-resolution.js');

// Compile the source-compatible package-root surface, including both the new
// aggregate accessor and every replay-safety symbol published before it.
void [
  PROMOTE_POST_COMMIT_FAILURE_CODE,
  PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME,
  PROMOTE_RETRYABLE_FAILURE_CODE,
  PROMOTE_RETRYABLE_FAILURE_ERROR_NAME,
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
  getPromoteReplaySafeErrorDiagnostic,
  getPromoteRetryableFailureDiagnostic,
  isPromoteReplaySafeError,
  isPromoteRetryableFailure,
];
type PublicPromoteFailureDisposition = PromoteFailureDisposition;
type PublicPromotePostCommitFailureDiagnostic = PromotePostCommitFailureDiagnostic;
type PublicPromoteReplaySafeErrorDiagnostic = PromoteReplaySafeErrorDiagnostic;
type PublicPromoteRetryableFailureDiagnostic = PromoteRetryableFailureDiagnostic;
type PublicPromoteRetryableFailureMarker = PromoteRetryableFailureMarker;

export type {
  PromoteFailureDispositionIsPublic,
  PromotePostCommitBoundaryIsPublic,
  LegacyReplaySafeGuardRemainsPublic,
  LegacyReplaySafeDiagnosticRemainsPublic,
  LegacyRetryableGuardRemainsPublic,
  LegacyRetryableMarkerCodeRemainsPublic,
  ReplaySafeUnwrapperStaysAbsent,
  ReplaySafeCertifierStaysInternal,
  ReplaySafeConstructorStaysInternal,
  ReplaySafeCodeStaysInternal,
  ReplaySafetyDeepModuleStaysClosed,
  ArbitraryPublisherImplementationStaysClosed,
  LegacyWorkspaceResolutionSubpathRemainsAvailable,
  PublicPromoteFailureDisposition,
  PublicPromotePostCommitFailureDiagnostic,
  PublicPromoteReplaySafeErrorDiagnostic,
  PublicPromoteRetryableFailureDiagnostic,
  PublicPromoteRetryableFailureMarker,
};
