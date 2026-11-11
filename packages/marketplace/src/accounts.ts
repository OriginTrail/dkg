// SPDX-License-Identifier: Apache-2.0

/**
 * An account owner's actions on a Conviction Account the node owns, and the
 * buyer wallet's consent to a grant (OT-RFC-27). Each action is sent from
 * the owner, one of the node's wallets; for an account that a browser wallet
 * owns, that wallet sends it, and the node gives only its consent.
 *
 * Both parties consent to one grant, `BuyerGrant` at the account's current
 * grant nonce, and a party that sends `addBuyer` consents by sending it, with
 * an empty signature. So a node that owns its account and is its own buyer
 * sends one transaction with two empty signatures; a node wallet that is not
 * the owner signs its consent; and any other buyer brings its signature.
 *
 * An old account, one that `PublishingConviction` 10.0.8 or 10.1.0 scheduled
 * in full, cannot opt in (`EmissionAlreadyScheduled`): the way on is a new
 * account (`POST /api/pca`), opted in, with the buyer wallet added.
 */
import { ethers } from 'ethers';
import type { BuyerGrantTerms, BuyerLimits, TxResult } from '@origintrail-official/dkg-chain';
import { MarketplaceRefusal, type Buyer } from './buyer.js';

export interface GrantRequest {
  /** By default the buyer wallet. */
  buyer?: string;
  maxCostPerEpoch: bigint;
  expiresAt: number;
  /** The buyer's consent, needed only from a buyer that is not one of the node's wallets. */
  buyerSignature?: string;
}

const isNodeWallet = (buyer: Buyer, address: string) => buyer.nodeWallets.some((w) => w.toLowerCase() === address.toLowerCase());

/** The account's owner, when it is one of the node's wallets; refused as the contracts refuse another sender. */
async function nodeOwner(buyer: Buyer, accountId: bigint): Promise<string> {
  const info = await buyer.chain.getPublishingConvictionAccountInfo(accountId);
  if (!info) throw new MarketplaceRefusal('ERC721NonexistentToken', [String(accountId)]);
  if (!isNodeWallet(buyer, info.owner)) throw new MarketplaceRefusal('NotAccountOwner', [String(accountId), info.owner]);
  return ethers.getAddress(info.owner);
}

export async function setServiceSpending(buyer: Buyer, accountId: bigint, enabled: boolean): Promise<TxResult> {
  return buyer.chain.setServiceSpending(accountId, enabled, { from: await nodeOwner(buyer, accountId) });
}

export async function addBuyer(buyer: Buyer, accountId: bigint, request: GrantRequest): Promise<TxResult> {
  const owner = await nodeOwner(buyer, accountId);
  const terms: BuyerGrantTerms = {
    accountId,
    buyer: ethers.getAddress(request.buyer ?? buyer.buyerWallet),
    maxCostPerEpoch: request.maxCostPerEpoch,
    expiresAt: request.expiresAt,
    nonce: await buyer.chain.grantNonce(accountId),
  };
  let buyerSignature = request.buyerSignature ?? '0x';
  if (request.buyerSignature === undefined && terms.buyer !== owner) {
    if (!isNodeWallet(buyer, terms.buyer)) throw new MarketplaceRefusal('ConsentMissing', [terms.buyer]);
    buyerSignature = (await buyer.chain.signBuyerGrant(terms)).signature;
  }
  return buyer.chain.addBuyer(terms, '0x', buyerSignature, { from: owner });
}

export async function setBuyerLimits(buyer: Buyer, accountId: bigint, grantee: string, limits: BuyerLimits): Promise<TxResult> {
  return buyer.chain.setBuyerLimits(accountId, grantee, limits, { from: await nodeOwner(buyer, accountId) });
}

export async function removeBuyer(buyer: Buyer, accountId: bigint, grantee: string): Promise<TxResult> {
  return buyer.chain.removeBuyer(accountId, grantee, { from: await nodeOwner(buyer, accountId) });
}

/**
 * The buyer wallet's consent to a grant on the account at its current nonce,
 * for the owner's browser wallet to send with `addBuyer`. Sends nothing.
 */
export async function buyerConsent(buyer: Buyer, accountId: bigint, limits: BuyerLimits) {
  if (!(await buyer.chain.getPublishingConvictionAccountInfo(accountId))) {
    throw new MarketplaceRefusal('ERC721NonexistentToken', [String(accountId)]);
  }
  const terms: BuyerGrantTerms = { accountId, buyer: buyer.buyerWallet, ...limits, nonce: await buyer.chain.grantNonce(accountId) };
  const { digest, signature } = await buyer.chain.signBuyerGrant(terms);
  return {
    terms: {
      accountId: accountId.toString(),
      buyer: terms.buyer,
      maxCostPerEpoch: terms.maxCostPerEpoch.toString(),
      expiresAt: terms.expiresAt,
      nonce: terms.nonce.toString(),
    },
    digest,
    buyerSignature: signature,
  };
}
