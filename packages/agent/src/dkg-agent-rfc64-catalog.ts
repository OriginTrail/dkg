// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 public author-catalog wiring, extracted as a DKGAgent mixin
 * holder. Methods take `this: DKGAgent` so cross-mixin calls resolve against
 * the composed class.
 *
 * Responsibilities:
 *   - construct + start {@link Rfc64PublicCatalogServiceV1} on the production
 *     router during `start()` (dormant when no `dataDir` opened the RFC-64
 *     persistence), and drain + close it during `stop()`;
 *   - expose the author path (produce + durably stage + best-effort announce a
 *     genesis head) and the accepted-open-policy seed used by both sides;
 *   - expose read-only observability for tests / evidence.
 *
 * Gate-1 boundary: staging a fetched head is the terminal step. Nothing here
 * admits candidate rows or activates KA / SWM / VM state.
 */

import {
  createOperationContext,
  type OperationContext,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SubGraphNameV1,
  type TimestampMsV1,
  type DecimalU64V1,
  type AuthorCatalogScopeV1,
  type CountV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { Rfc64AuthorCatalogEip191SignerV1 } from './rfc64/author-catalog-producer.js';
import type { AcceptedOpenCatalogPolicyV1 } from './rfc64/open-catalog-policy-v1.js';
import {
  Rfc64PublicCatalogServiceV1,
  type PublishOpenAuthorCatalogGenesisResultV1,
  type Rfc64PublicCatalogServiceStatsV1,
} from './rfc64/public-catalog-service-v1.js';

/**
 * Gate-1 simplification: a genesis head carries a placeholder catalog-issuer
 * delegation digest. The transport verifies generic envelope cryptography, not
 * issuer delegation, so this does not weaken any Gate-1 check; real
 * delegation-authority binding lands in a later phase.
 */
export const RFC64_GATE1_PLACEHOLDER_DELEGATION_DIGEST_V1 =
  `0x${'11'.repeat(32)}` as Digest32V1;

/** Minimal EIP-191 EOA signer (ethers.Wallet-compatible) for author-catalog objects. */
export interface Rfc64OpenCatalogAuthorSignerV1 {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<string>;
}

export interface AcceptOpenContextGraphPolicyInputV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownerAddress: EvmAddressV1;
  readonly ownerAuthorityEra?: DecimalU64V1;
  readonly issuedAt?: TimestampMsV1;
  readonly effectiveAt?: TimestampMsV1;
}

export interface PublishOpenAuthorCatalogGenesisParamsV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  /** The EOA that authors and owns the open CG (also the open-policy owner). */
  readonly author: Rfc64OpenCatalogAuthorSignerV1;
  /** Peers to announce head availability to (best-effort hints). */
  readonly peers: readonly string[];
  /** Head object timestamp; defaults to now. */
  readonly issuedAt?: TimestampMsV1;
  /** Open-policy timestamps; MUST match on every party (default '0'). */
  readonly policyIssuedAt?: TimestampMsV1;
  readonly policyEffectiveAt?: TimestampMsV1;
  readonly ownerAuthorityEra?: DecimalU64V1;
  readonly catalogIssuerDelegationDigest?: Digest32V1;
}

export interface Rfc64StagedAuthorCatalogHeadRefV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

export class Rfc64CatalogMethods extends DKGAgentBase {
  /**
   * Construct + start the public catalog service on the production router.
   * No-op when RFC-64 persistence is dormant (no `dataDir`) or already started.
   */
  startRfc64PublicCatalogServiceV1(this: DKGAgent, ctx: OperationContext): void {
    if (this.rfc64PublicCatalogServiceV1 !== undefined) return;
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return;
    const service = new Rfc64PublicCatalogServiceV1({
      router: this.router,
      controlObjects: persistence.controlObjects,
    });
    service.start();
    this.rfc64PublicCatalogServiceV1 = service;
    this.log.info(ctx, 'RFC-64 public author-catalog transport started');
  }

  /** Stop serving and drain in-flight receiver work. Idempotent + undefined-safe. */
  async closeRfc64PublicCatalogServiceV1(this: DKGAgent): Promise<void> {
    const service = this.rfc64PublicCatalogServiceV1;
    this.rfc64PublicCatalogServiceV1 = undefined;
    await service?.close();
  }

  /**
   * Accept the CG's open (accessPolicy=0) current policy into the authorizer.
   * Author and receiver each call this from independently-held CG identity
   * facts — the accepted digest, not the untrusted wire hint, gates operations.
   */
  acceptOpenContextGraphPolicyV1(
    this: DKGAgent,
    input: AcceptOpenContextGraphPolicyInputV1,
  ): AcceptedOpenCatalogPolicyV1 {
    return this.requireRfc64PublicCatalogServiceV1().acceptOpenPolicy(input);
  }

  /**
   * Author path: accept the CG's open policy, produce a signed genesis head,
   * durably stage its immutable objects, then best-effort announce availability.
   */
  async publishOpenAuthorCatalogGenesisV1(
    this: DKGAgent,
    params: PublishOpenAuthorCatalogGenesisParamsV1,
  ): Promise<PublishOpenAuthorCatalogGenesisResultV1> {
    const service = this.requireRfc64PublicCatalogServiceV1();
    const authorAddress = params.author.address.toLowerCase() as EvmAddressV1;
    const policy = service.acceptOpenPolicy({
      networkId: params.networkId,
      contextGraphId: params.contextGraphId,
      ownerAddress: authorAddress,
      ownerAuthorityEra: params.ownerAuthorityEra,
      issuedAt: params.policyIssuedAt,
      effectiveAt: params.policyEffectiveAt,
    });
    const scope: AuthorCatalogScopeV1 = {
      networkId: params.networkId,
      contextGraphId: params.contextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: params.subGraphName ?? null,
      authorAddress,
      era: '0' as DecimalU64V1,
      bucketCount: '1' as CountV1,
    };
    const signer: Rfc64AuthorCatalogEip191SignerV1 = {
      issuer: authorAddress,
      signDigest: (objectDigest) => params.author.signMessage(objectDigest),
    };
    return service.publishOpenAuthorCatalogGenesis({
      scope,
      signer,
      catalogIssuerDelegationDigest:
        params.catalogIssuerDelegationDigest ?? RFC64_GATE1_PLACEHOLDER_DELEGATION_DIGEST_V1,
      issuedAt: params.issuedAt ?? (Date.now().toString() as TimestampMsV1),
      policy,
      peers: params.peers,
    });
  }

  /**
   * Read a head back from the control-object store by its exact digests — the
   * "durably staged the exact head" proof. Returns null when not staged.
   */
  async readRfc64StagedAuthorCatalogHeadV1(
    this: DKGAgent,
    ref: Rfc64StagedAuthorCatalogHeadRefV1,
  ): Promise<Digest32V1 | null> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return null;
    const stored = await persistence.controlObjects.getVerifiedObject({
      objectDigest: ref.objectDigest,
      signatureVariantDigest: ref.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    return stored === null ? null : (stored.envelope.objectDigest as Digest32V1);
  }

  /** Await the receiver scheduler draining all queued + in-flight fetch/stage work. */
  whenRfc64PublicCatalogReceiverIdleV1(this: DKGAgent): Promise<void> {
    const service = this.rfc64PublicCatalogServiceV1;
    return service === undefined ? Promise.resolve() : service.whenReceiverIdle();
  }

  rfc64PublicCatalogStatsV1(this: DKGAgent): Rfc64PublicCatalogServiceStatsV1 | null {
    return this.rfc64PublicCatalogServiceV1?.stats() ?? null;
  }

  private requireRfc64PublicCatalogServiceV1(this: DKGAgent): Rfc64PublicCatalogServiceV1 {
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error(
        'RFC-64 public catalog service is not available (agent not started or no dataDir)',
      );
    }
    return service;
  }
}
