// SPDX-License-Identifier: Apache-2.0

/** Closed accepted-authority catalog recovery policies and their retry budgets. */
import type {
  Rfc64CatalogReplayRecoveryResultV1,
  Rfc64CatalogReplayRecoveryStatusV1,
} from './catalog-replay-recovery-runtime-v1.js';

const RFC64_AUTHORITY_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1 = Object.freeze([
  250,
  1_000,
  4_000,
]);
/**
 * A join-approved replica can accept its policy before its providers have the
 * roster that names it. Only that replica keeps asking for this long.
 */
const RFC64_JOIN_DERIVED_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1 = Object.freeze([
  ...RFC64_AUTHORITY_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1,
  15_000,
  30_000,
  60_000,
  120_000,
  240_000,
]);
export type Rfc64AuthorityAcceptedCatalogRecoveryPolicyV1 =
  | 'public'
  | 'private'
  | 'private-join';
interface Rfc64AuthorityAcceptedCatalogRecoveryPlanV1 {
  readonly retryDelays: readonly number[];
  readonly isComplete: (
    replay: Readonly<Rfc64CatalogReplayRecoveryResultV1>,
    readStatus: () => Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null,
  ) => boolean;
}
const rfc64AuthorityAcceptedCatalogRecoveryStatusIsCompleteV1 = (
  status: Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null,
): boolean => status?.failed !== true && status?.unverified !== true;
export const RFC64_AUTHORITY_ACCEPTED_CATALOG_RECOVERY_PLANS_V1: Readonly<Record<
  Rfc64AuthorityAcceptedCatalogRecoveryPolicyV1,
  Rfc64AuthorityAcceptedCatalogRecoveryPlanV1
>> = Object.freeze({
  public: Object.freeze({
    retryDelays: RFC64_AUTHORITY_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1,
    isComplete: () => true,
  }),
  private: Object.freeze({
    retryDelays: RFC64_AUTHORITY_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1,
    isComplete: (
      _replay: Readonly<Rfc64CatalogReplayRecoveryResultV1>,
      readStatus: () => Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null,
    ) => rfc64AuthorityAcceptedCatalogRecoveryStatusIsCompleteV1(readStatus()),
  }),
  'private-join': Object.freeze({
    retryDelays: RFC64_JOIN_DERIVED_CATALOG_RECOVERY_RETRY_DELAYS_MS_V1,
    isComplete: (
      replay: Readonly<Rfc64CatalogReplayRecoveryResultV1>,
      readStatus: () => Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null,
    ) => {
      const replayComplete = rfc64AuthorityAcceptedCatalogRecoveryStatusIsCompleteV1(
        readStatus(),
      );
      return replay.requested > 0 && replayComplete;
    },
  }),
});
