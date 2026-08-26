// SPDX-License-Identifier: Apache-2.0

/**
 * Focused DKGAgent facade for current-head discovery plus durable receiver
 * synchronization. Keeping the orchestration here prevents the catalog
 * lifecycle/authoring mixin from becoming the home for every RFC-64 workflow.
 */

import {
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import type {
  Rfc64PublicCatalogCurrentHeadScopeV1,
} from './rfc64/public-catalog-current-head-discovery-v1.js';
import type {
  Rfc64CatalogReconciliationTerminalReasonV1,
} from './rfc64/public-catalog-reconciliation-failure-v1.js';

export class Rfc64CatalogSynchronizationErrorV1 extends Error {
  constructor(
    readonly terminalReason: Rfc64CatalogReconciliationTerminalReasonV1 | null,
    readonly code: string | null,
  ) {
    super(
      'RFC-64 current catalog head reconciliation failed'
      + ` (${terminalReason ?? code ?? 'unknown'})`,
    );
    this.name = 'Rfc64CatalogSynchronizationErrorV1';
  }
}

/** Explicit provider + independently accepted public-root scope for a cold pull. */
export interface SynchronizeRfc64PublicCatalogFromProviderParamsV1 {
  readonly remotePeerId: string;
  readonly scope: Rfc64PublicCatalogCurrentHeadScopeV1;
  readonly signal?: AbortSignal;
}

/** Exact durable postcondition of a successful provider synchronization. */
export interface SynchronizeRfc64PublicCatalogFromProviderResultV1
  extends AppliedCatalogHeadSnapshotV1 {
  readonly providerPeerId: string;
  readonly signatureVariantDigest: Digest32V1;
}

export interface SynchronizeRfc64CatalogFromProvidersParamsV1 {
  readonly remotePeerIds: readonly string[];
  readonly scope: Rfc64PublicCatalogCurrentHeadScopeV1;
  readonly signal?: AbortSignal;
}

export interface SynchronizeRfc64CatalogFromProvidersResultV1
  extends AppliedCatalogHeadSnapshotV1 {
  readonly providerPeerIds: readonly string[];
  readonly appliedProviderPeerId: string | null;
  readonly providerAttempts: number;
  readonly signatureVariantDigest: Digest32V1;
}

export class Rfc64CatalogSyncMethods extends DKGAgentBase {
  /**
   * Pull one provider's authenticated current public-root head and run it
   * through the ordinary durable receiver. `null` means the provider has no
   * applied head for the accepted scope. A non-null return proves the exact
   * discovered head is now the receiver's durable applied-head post-read.
   */
  async synchronizeRfc64PublicCatalogFromProviderV1(
    this: DKGAgent,
    params: SynchronizeRfc64PublicCatalogFromProviderParamsV1,
  ): Promise<SynchronizeRfc64PublicCatalogFromProviderResultV1 | null> {
    const providerPeerId = params.remotePeerId;
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 public catalog service is not started');
    }
    // Preserve the established single-provider contract: discovery failures
    // propagate unchanged, and receiver failures are translated below from
    // the durable reconciliation registry. The multi-provider API deliberately
    // retains AggregateError/failover semantics instead.
    const synchronized = await service.synchronizeCurrentCatalogHead({
      remotePeerId: providerPeerId,
      scope: params.scope,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    if (synchronized === null) return null;
    const catalogScope = deriveAuthorCatalogScopeFromHeadV1(
      synchronized.head.envelope.payload,
    );
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
    const applied = this.rfc64PersistenceV1?.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      synchronized.announcement.authorAddress,
    ) ?? null;
    if (
      applied === null
      || applied.currentCatalogHeadDigest
        !== synchronized.announcement.catalogHeadObjectDigest
      || applied.catalogVersion !== synchronized.announcement.catalogVersion
    ) {
      const failure = this.rfc64PublicCatalogReconciliationFailuresV1.readCurrentAttempt(
        synchronized.announcement.catalogHeadObjectDigest,
      );
      if (failure !== null) {
        throw new Rfc64CatalogSynchronizationErrorV1(
          failure.terminalReason,
          failure.errorCode,
        );
      }
      throw new Error(
        'RFC-64 current public catalog head did not reach its durable applied postcondition',
      );
    }
    return Object.freeze({
      ...applied,
      providerPeerId,
      signatureVariantDigest: synchronized.announcement.signatureVariantDigest,
    });
  }

  /** Bounded multi-provider discovery and exact-head failover. */
  async synchronizeRfc64CatalogFromProvidersV1(
    this: DKGAgent,
    params: SynchronizeRfc64CatalogFromProvidersParamsV1,
  ): Promise<SynchronizeRfc64CatalogFromProvidersResultV1 | null> {
    const scope = params.scope;
    const signal = params.signal;
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 public catalog service is not started');
    }
    const synchronized = await service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: params.remotePeerIds,
      scope,
      ...(signal === undefined ? {} : { signal }),
    });
    if (synchronized === null) return null;
    if (
      synchronized.completionOutcome !== 'applied'
      && synchronized.completionOutcome !== 'already-applied'
    ) {
      throw new Error(
        'RFC-64 current catalog head synchronization did not complete successfully'
        + ` (${synchronized.completionOutcome})`,
      );
    }
    const catalogScope = deriveAuthorCatalogScopeFromHeadV1(
      synchronized.current.head.envelope.payload,
    );
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
    const applied = this.rfc64PersistenceV1?.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      synchronized.current.announcement.authorAddress,
    ) ?? null;
    if (
      applied === null
      || applied.currentCatalogHeadDigest
        !== synchronized.current.announcement.catalogHeadObjectDigest
      || applied.catalogVersion !== synchronized.current.announcement.catalogVersion
    ) {
      const failure = this.rfc64PublicCatalogReconciliationFailuresV1.readCurrentAttempt(
        synchronized.current.announcement.catalogHeadObjectDigest,
      );
      if (failure !== null) {
        throw new Rfc64CatalogSynchronizationErrorV1(
          failure.terminalReason,
          failure.errorCode,
        );
      }
      throw new Error(
        'RFC-64 current public catalog head did not reach its durable applied postcondition',
      );
    }
    return Object.freeze({
      ...applied,
      providerPeerIds: synchronized.providerPeerIds,
      appliedProviderPeerId: synchronized.appliedProviderPeerId,
      providerAttempts: synchronized.providerAttempts,
      signatureVariantDigest: synchronized.current.announcement.signatureVariantDigest,
    });
  }
}
