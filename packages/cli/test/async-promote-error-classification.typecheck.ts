import type { PromoteFailureDisposition, PromoteStepName } from '@origintrail-official/dkg-publisher';
import type {
  ClassifiedPromoteError,
  diagnosticPromoteStage,
} from '../src/daemon/worker/async-promote-error-classification.js';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type RetryDiagnostic = Extract<PromoteFailureDisposition, { retryable: true }>['diagnostic'];
type TerminalDiagnostic = Extract<PromoteFailureDisposition, { retryable: false }>['diagnostic'];

export type PublisherUnionIsPreserved = AssertTrue<
  PromoteFailureDisposition extends ClassifiedPromoteError ? true : false
>;
export type RetryDiagnosticCannotBeFatal = AssertFalse<{
  classification: 'fatal'; retryable: false; diagnostic: RetryDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type TerminalDiagnosticCannotRetry = AssertFalse<{
  classification: 'transient'; retryable: true; diagnostic: TerminalDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type FallbackHasNoPublisherDiagnostic = AssertFalse<{
  classification: 'cap_exceeded'; retryable: false; diagnostic: RetryDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type ProseFallbackRemainsSupported = AssertTrue<{
  classification: 'cap_exceeded'; retryable: false;
} extends ClassifiedPromoteError ? true : false>;

// The stage that reaches the operator log line is the producer-owned literal
// union or the explicit fallback — never an open `string`. This is the CI-run
// check (`pnpm --filter cli test:types`) that keeps the publisher tuple and the
// CLI's diagnostic surface in lockstep at the type level.
type DiagnosticStage = ReturnType<typeof diagnosticPromoteStage>;
export type StageIsProducerOwnedOrUnknown = AssertTrue<
  DiagnosticStage extends PromoteStepName | 'unknown' ? true : false
>;
export type StageIsNotOpenString = AssertFalse<string extends DiagnosticStage ? true : false>;
