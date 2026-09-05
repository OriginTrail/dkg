import {
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
  type PromoteFailureDisposition,
  type PromoteReplaySafeErrorDiagnostic,
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
type GenericRetryableGuardStaysInternal = AssertFalse<
  'isPromoteRetryableFailure' extends keyof PublisherApi ? true : false
>;
type GenericRetryableMarkerCodeStaysInternal = AssertFalse<
  'PROMOTE_RETRYABLE_FAILURE_CODE' extends keyof PublisherApi ? true : false
>;
type GenericRetryableDiagnosticStaysInternal = AssertFalse<
  'getPromoteRetryableFailureDiagnostic' extends keyof PublisherApi ? true : false
>;
type PostCommitMarkerCodeStaysInternal = AssertFalse<
  'PROMOTE_POST_COMMIT_FAILURE_CODE' extends keyof PublisherApi ? true : false
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

// Compile the narrow package-root surface: the pre-existing replay-safe
// compatibility API plus the new producer and aggregate-consumer boundaries.
void [
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  getPromoteFailureDisposition,
  getPromoteReplaySafeErrorDiagnostic,
  isPromoteReplaySafeError,
];
type PublicPromoteFailureDisposition = PromoteFailureDisposition;
type PublicPromoteReplaySafeErrorDiagnostic = PromoteReplaySafeErrorDiagnostic;

export type {
  PromoteFailureDispositionIsPublic,
  PromotePostCommitBoundaryIsPublic,
  LegacyReplaySafeGuardRemainsPublic,
  LegacyReplaySafeDiagnosticRemainsPublic,
  GenericRetryableGuardStaysInternal,
  GenericRetryableMarkerCodeStaysInternal,
  GenericRetryableDiagnosticStaysInternal,
  PostCommitMarkerCodeStaysInternal,
  ReplaySafeUnwrapperStaysAbsent,
  ReplaySafeCertifierStaysInternal,
  ReplaySafeConstructorStaysInternal,
  ReplaySafeCodeStaysInternal,
  ReplaySafetyDeepModuleStaysClosed,
  ArbitraryPublisherImplementationStaysClosed,
  LegacyWorkspaceResolutionSubpathRemainsAvailable,
  PublicPromoteFailureDisposition,
  PublicPromoteReplaySafeErrorDiagnostic,
};
