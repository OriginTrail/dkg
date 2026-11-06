// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27) on the DKGAgent facade:
 * thin wrappers over the optional `ConvictionServiceAdapter` methods of the
 * chain adapter, in the pattern of the Publishing Conviction facade
 * (`dkg-agent-registry.ts`). Assembled onto DKGAgent via applyMixins.
 *
 * - Each method answers `null` when the adapter lacks it (the no-chain
 *   adapter lacks them all), which the daemon answers 503.
 * - Nothing is caught: a contract refusal surfaces as the adapter's typed
 *   `ConvictionServiceRevertError`, classified by its `kind`, and a Hub
 *   without the service contracts as `ConvictionServiceUnavailableError`.
 * - Owner writes are sent by the primary operational wallet; consent and
 *   funding by the buyer key (`getConvictionServiceBuyerAddress`).
 */
import type {
  CaAssignment,
  CaAssignmentCaps,
  CaAssignmentTerms,
  CaContracts,
  CaEpochLabel,
  CaFundingRequest,
  CaPeriod,
  CaPeriodFunding,
  CaServiceStatus,
  CaWindowAllowance,
  TxResult,
} from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

export class ConvictionServiceFacadeMethods extends DKGAgentBase {
  /** True when the chain adapter exposes the service-spending surface (the Hub may still lack the contracts). */
  get supportsConvictionService(): boolean {
    return typeof this.chain.getConvictionServiceStatus === 'function';
  }

  /** The service contracts and the consent domain; `null` without the surface or the contracts. */
  async getConvictionServiceContracts(this: DKGAgent): Promise<CaContracts | null> {
    if (typeof this.chain.getConvictionServiceContracts !== 'function') return null;
    return this.chain.getConvictionServiceContracts();
  }

  /** The account's service-spending status, always read from the chain; `null` without the surface or for an unknown account. */
  async getConvictionServiceStatus(this: DKGAgent, accountId: bigint): Promise<CaServiceStatus | null> {
    if (typeof this.chain.getConvictionServiceStatus !== 'function') return null;
    return this.chain.getConvictionServiceStatus(accountId, { fresh: true });
  }

  async getConvictionServiceWindowAllowance(this: DKGAgent, accountId: bigint): Promise<CaWindowAllowance | null> {
    if (typeof this.chain.getConvictionServiceWindowAllowance !== 'function') return null;
    return this.chain.getConvictionServiceWindowAllowance(accountId);
  }

  /** The nonce the account's next assignment must carry. */
  async getConvictionServiceAssignmentNonce(this: DKGAgent, accountId: bigint): Promise<bigint | null> {
    if (typeof this.chain.getConvictionServiceAssignmentNonce !== 'function') return null;
    return this.chain.getConvictionServiceAssignmentNonce(accountId);
  }

  /** Owner: switch service spending on or off. */
  async setConvictionServiceSpending(this: DKGAgent, accountId: bigint, enabled: boolean): Promise<TxResult | null> {
    if (typeof this.chain.setConvictionServiceSpending !== 'function') return null;
    return this.chain.setConvictionServiceSpending(accountId, enabled);
  }

  /** The buyer key's EIP-712 consent to `terms`; sends nothing. */
  async signConvictionServiceConsent(
    this: DKGAgent,
    terms: CaAssignmentTerms,
  ): Promise<{ digest: string; signature: string } | null> {
    if (typeof this.chain.signConvictionServiceConsent !== 'function') return null;
    return this.chain.signConvictionServiceConsent(terms);
  }

  /** Submit an assignment as the owner or as the assignee, with the other party's signature. */
  async assignConvictionServiceBuyer(
    this: DKGAgent,
    terms: CaAssignmentTerms,
    signatures: { owner?: string; assignee?: string },
    sendAs: 'owner' | 'assignee',
  ): Promise<(TxResult & { digest: string }) | null> {
    if (typeof this.chain.assignConvictionServiceBuyer !== 'function') return null;
    return this.chain.assignConvictionServiceBuyer(terms, signatures, sendAs);
  }

  /** Owner: revoke an assignment, which also advances the assignment nonce. */
  async revokeConvictionServiceBuyer(
    this: DKGAgent,
    accountId: bigint,
    assignee: string,
  ): Promise<(TxResult & { nextNonce: bigint }) | null> {
    if (typeof this.chain.revokeConvictionServiceBuyer !== 'function') return null;
    return this.chain.revokeConvictionServiceBuyer(accountId, assignee);
  }

  /** Owner: replace a live assignment's caps, keeping its usage and nonce. */
  async updateConvictionServiceCaps(
    this: DKGAgent,
    accountId: bigint,
    assignee: string,
    caps: CaAssignmentCaps,
  ): Promise<TxResult | null> {
    if (typeof this.chain.updateConvictionServiceCaps !== 'function') return null;
    return this.chain.updateConvictionServiceCaps(accountId, assignee, caps);
  }

  /** Owner: advance the assignment nonce, so signed and unsubmitted terms no longer assign. */
  async advanceConvictionServiceNonce(this: DKGAgent, accountId: bigint): Promise<(TxResult & { nextNonce: bigint }) | null> {
    if (typeof this.chain.advanceConvictionServiceNonce !== 'function') return null;
    return this.chain.advanceConvictionServiceNonce(accountId);
  }

  async listConvictionServiceAssignments(
    this: DKGAgent,
    accountId: bigint,
  ): Promise<Array<{ assignee: string } & CaAssignment> | null> {
    if (typeof this.chain.listConvictionServiceAssignments !== 'function') return null;
    return this.chain.listConvictionServiceAssignments(accountId);
  }

  /** The accounts that have assigned `assignee`, each with that assignment. */
  async listConvictionServiceAccountsByAssignee(
    this: DKGAgent,
    assignee: string,
  ): Promise<Array<{ accountId: bigint; assignee: string } & CaAssignment> | null> {
    if (typeof this.chain.listConvictionServiceAccountsByAssignee !== 'function') return null;
    return this.chain.listConvictionServiceAccountsByAssignee(assignee);
  }

  async getConvictionServiceLabels(
    this: DKGAgent,
    accountId: bigint,
    fromEpoch: number,
    toEpoch: number,
  ): Promise<CaEpochLabel[] | null> {
    if (typeof this.chain.getConvictionServiceLabels !== 'function') return null;
    return this.chain.getConvictionServiceLabels(accountId, fromEpoch, toEpoch);
  }

  /** Buyer key: fund one plan period; a period id it already funded is answered with `existing: true`. */
  async fundServicePeriodFromConviction(this: DKGAgent, req: CaFundingRequest): Promise<CaPeriodFunding | null> {
    if (typeof this.chain.fundServicePeriodFromConviction !== 'function') return null;
    return this.chain.fundServicePeriodFromConviction(req);
  }

  async getServicePeriod(this: DKGAgent, subscriptionId: string): Promise<CaPeriod | null> {
    if (typeof this.chain.getServicePeriod !== 'function') return null;
    return this.chain.getServicePeriod(subscriptionId);
  }

  async listServicePeriods(
    this: DKGAgent,
    accountId: bigint,
    offset: number,
    limit: number,
  ): Promise<{ total: number; periods: CaPeriod[] } | null> {
    if (typeof this.chain.listServicePeriods !== 'function') return null;
    return this.chain.listServicePeriods(accountId, offset, limit);
  }

  /** The key that consents and funds as the assignee; `null` without the surface or when the node cannot sign for it. */
  getConvictionServiceBuyerAddress(this: DKGAgent): string | null {
    if (typeof this.chain.getConvictionServiceBuyerAddress !== 'function') return null;
    return this.chain.getConvictionServiceBuyerAddress();
  }
}
