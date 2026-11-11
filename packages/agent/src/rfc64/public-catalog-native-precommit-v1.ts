// SPDX-License-Identifier: Apache-2.0

/**
 * The public catalog receiver's applied-head precommit contract: the plan the
 * receiver hands its barrier after activation, the lifecycle the barrier
 * returns, and the barrier's optional row-independent half that the receiver
 * asks before activation. The receiver re-exports every type here.
 */

import type {
  AuthorCatalogScopeV1,
  Digest32V1,
  VerifiedCatalogSealBindingV1,
} from '@origintrail-official/dkg-core';

import type { VerifiedAuthorCatalogRowAuthorshipV1 } from './catalog-row-authorship.js';
import type { Rfc64PublicCatalogNativeCommittedHeadTokenV1 } from
  './public-catalog-native-committed-head-token-v1.js';

/** Process-local verified row capabilities withheld from serializable receiver evidence. */
export interface Rfc64PublicCatalogNativePrecommitRowPlanV1 {
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipV1;
  readonly sealBinding: VerifiedCatalogSealBindingV1;
  /** Exact graph-neutral digest of the verified projection activated into SWM. */
  readonly publicQuadsDigest: string;
}

/** Generic same-process barrier plan executed after semantic post-read and before head CAS. */
export interface Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 {
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  /** Exact accepted-current generation that authorized every fetched byte. */
  readonly policyDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryDigest: Digest32V1;
  /** Strictly increasing by mathematical KA ID. */
  readonly rows: readonly Readonly<Rfc64PublicCatalogNativePrecommitRowPlanV1>[];
}

/** The part of the plan that holds no row, known before any SWM mutation. */
export type Rfc64PublicCatalogNativeAdmissionPlanV1 = Pick<
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1,
  'catalogScope' | 'policyDigest' | 'catalogHeadDigest'
>;

/**
 * The row-independent half of an applied-head precommit. The receiver asks it
 * once the head has verified and before the boundary lease or any SWM
 * mutation, so a head this node cannot apply is refused with nothing to
 * restore. The precommit itself still runs after activation as the final
 * barrier, and keeps its rollback for refusals that depend on the rows.
 */
export interface Rfc64PublicCatalogNativeAdmissionHandlerV1 {
  (
    plan: Readonly<Rfc64PublicCatalogNativeAdmissionPlanV1>,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Side effects that become durable only when the catalog head CAS succeeds. */
export interface Rfc64PublicCatalogNativePrecommitTransactionV1 {
  /** Finalize rollback-capable side effects after the exact head is durable. */
  commit(): void | Promise<void>;
  rollback(cause?: unknown): Promise<void>;
}

/** Neutral operation-owned extension returned only after post-head work settles. */
export type Rfc64PublicCatalogNativePostHeadExtensionV1 =
  Readonly<Record<string, unknown>>;

/** A rollback-capable primary precommit, before any post-head coordination. */
export interface Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1 {
  (
    plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
    signal: AbortSignal,
  ): Promise<void | Rfc64PublicCatalogNativePrecommitTransactionV1>;
  /** This precommit's row-independent half, for a coordinator to forward. */
  readonly admit?: Rfc64PublicCatalogNativeAdmissionHandlerV1;
}

/**
 * Explicit two-domain lifecycle returned by a precommit coordinator.
 * `transaction` owns only rollback-capable work. `afterAppliedHead` runs after
 * the head, transaction, and durable post-read are final; a failure is
 * reported without predecessor rollback and an exact replay retries the hook.
 */
export interface Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<
  TPostHeadExtension extends object = Rfc64PublicCatalogNativePostHeadExtensionV1,
> {
  readonly kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1';
  readonly transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 | null;
  readonly afterAppliedHead: ((
    committedHead: Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1>,
  ) => void
    | TPostHeadExtension
    | Promise<void | TPostHeadExtension>) | null;
}

/** Backward-compatible root receiver result plus the explicit post-head lifecycle. */
export type Rfc64PublicCatalogNativeBeforeAppliedHeadCommitResultV1<
  TPostHeadExtension extends object = Rfc64PublicCatalogNativePostHeadExtensionV1,
> =
  | void
  | Rfc64PublicCatalogNativePrecommitTransactionV1
  | Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<TPostHeadExtension>;

export interface Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1<
  TPostHeadExtension extends object = Rfc64PublicCatalogNativePostHeadExtensionV1,
> {
  (
    plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
    signal: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitResultV1<TPostHeadExtension>>;
  /** Asked before the boundary lease and any SWM mutation; see its type. */
  readonly admit?: Rfc64PublicCatalogNativeAdmissionHandlerV1;
}
