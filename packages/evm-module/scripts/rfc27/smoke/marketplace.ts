// The smoke test's marketplace operations, as transaction steps, built with the
// shapes, digests and request builders of test/helpers: a
// position, a Conviction Account opted in, a grant with the buyer's
// EIP-712 consent, subscriptions funded from an account or a wallet, top-ups,
// revocations, and receipt batches of requests signed by session keys.

import type { HDNodeWallet, Signer } from 'ethers';

import type { Domain, Terms } from '../../../test/helpers/conviction-service';
import { BUYER_GRANT_TYPES, domainOf, requestOf, walletRequestOf } from '../../../test/helpers/conviction-service';
import type { ReceiptGroup } from '../../../test/helpers/query-inference';
import { queryInferenceDomain, signedItems } from '../../../test/helpers/query-inference';

import type { Contracts } from '../contracts';
import { SERVICE0, UNIT_PRICE, inference } from '../plans';
import { fmt } from '../report';
import { SmokeTx, Step, StepResult } from './tx';

/** Steps that need an earlier step, and what makes them done already on chain. */
export type StepOpts = Pick<Step, 'needs' | 'done' | 'expected' | 'stakeFactor18'>;

export class Marketplace {
  private qiDomain?: Domain;
  private ssDomain?: Domain;

  constructor(
    readonly c: Contracts,
    readonly tx: SmokeTx,
  ) {}

  async approve(key: string, who: string, holder: Signer, spender: string, amount: bigint, what: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.step({
      key,
      label: `${who}: approve ${what} for ${fmt(amount)} TRAC`,
      role: who,
      signer: holder,
      to: await this.c.token.getAddress(),
      data: this.c.token.interface.encodeFunctionData('approve', [spender, amount]),
      ...opts,
    });
  }

  /** A position of `amount` TRAC on `node` at tier 0, which has no lock, so it can withdraw at any time. */
  async stake(prefix: string, owner: Signer, node: bigint, amount: bigint, opts: StepOpts = {}): Promise<StepResult> {
    await this.approve(`${prefix}.approve-staking`, 'owner', owner, await this.c.sv10.getAddress(), amount, 'StakingV10', { done: opts.done });
    return this.tx.step({
      key: `${prefix}.stake`,
      label: `owner: createConviction(node ${node}, ${fmt(amount)} TRAC, tier 0)`,
      role: 'owner',
      signer: owner,
      to: await this.c.snft.getAddress(),
      data: this.c.snft.interface.encodeFunctionData('createConviction', [node, amount, 0]),
      needs: [`${prefix}.approve-staking`],
      ...opts,
    });
  }

  /** A new Conviction Account of `committed` TRAC, with no designated node, under the Hub's PublishingConviction. */
  async createAccount(prefix: string, owner: Signer, committed: bigint, opts: StepOpts = {}): Promise<StepResult> {
    const nft = await this.c.nft.getAddress();
    await this.approve(`${prefix}.approve-account`, 'owner', owner, nft, committed, 'DKGPublishingConvictionNFT', { done: opts.done });
    return this.tx.step({
      key: `${prefix}.create-account`,
      label: `owner: createAccount(${fmt(committed)} TRAC, no designated node)`,
      role: 'owner',
      signer: owner,
      to: nft,
      data: this.c.nft.interface.encodeFunctionData('createAccount', [committed, 0]),
      needs: [`${prefix}.approve-account`],
      ...opts,
    });
  }

  async optIn(key: string, owner: Signer, accountId: bigint | undefined, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.step({
      key,
      label: `owner: setServiceSpending(${accountId ?? '<new account>'}, true)`,
      role: 'owner',
      signer: owner,
      to: await this.c.ss.getAddress(),
      data: accountId === undefined ? '0x' : this.c.ss.interface.encodeFunctionData('setServiceSpending', [accountId, true]),
      ...opts,
    });
  }

  /**
   * The owner grants `buyer` over the account, consenting by sending the
   * transaction; the buyer consents by an EIP-712 signature over the same
   * terms, at the account's current nonce. Without an account yet (a dry run
   * of a new run), the step is only listed.
   */
  async addBuyer(
    key: string,
    label: string,
    owner: Signer,
    account: { id: bigint; expiresAt: bigint } | undefined,
    buyer: HDNodeWallet,
    maxCostPerEpoch: bigint,
    opts: StepOpts = {},
  ): Promise<StepResult & { terms?: Terms }> {
    let data = '0x';
    let terms: Terms | undefined;
    if (account) {
      terms = {
        accountId: account.id,
        buyer: buyer.address,
        maxCostPerEpoch,
        expiresAt: account.expiresAt,
        nonce: await this.c.sss.grantNonce(account.id),
      };
      this.ssDomain ??= await domainOf(this.c.ss);
      const consent = await buyer.signTypedData(this.ssDomain, BUYER_GRANT_TYPES, terms);
      data = this.c.ss.interface.encodeFunctionData('addBuyer', [terms, '0x', consent]);
    }
    const r = await this.tx.step({ key, label, role: 'owner', signer: owner, to: await this.c.ss.getAddress(), data, ...opts });
    return { ...r, terms };
  }

  async removeBuyer(key: string, owner: Signer, accountId: bigint, buyer: string, what: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.step({
      key,
      label: `owner: revoke ${what}`,
      role: 'owner',
      signer: owner,
      to: await this.c.ss.getAddress(),
      data: this.c.ss.interface.encodeFunctionData('removeBuyer', [accountId, buyer]),
      ...opts,
    });
  }

  /** A subscription of `epoch` funded from the account by the added buyer: no TRAC moves. */
  async fundFromAccount(
    key: string,
    who: string,
    buyer: Signer,
    accountId: bigint | undefined,
    epoch: bigint,
    sessionKey: string,
    value: bigint,
    planDigest: string,
    opts: StepOpts = {},
  ): Promise<StepResult> {
    const request = requestOf(accountId ?? 0n, epoch, { sessionKey, planDigest, budgets: inference(value) });
    return this.tx.step({
      key,
      label: `${who}: fundFromAccount(account ${accountId ?? '<new account>'}, epoch ${epoch}, ${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: await this.c.ss.getAddress(),
      data: accountId === undefined ? '0x' : this.c.ss.interface.encodeFunctionData('fundFromAccount', [request]),
      ...opts,
    });
  }

  /** A subscription of `epoch` paid from the buyer's wallet into the vault: the approval, then the funding. */
  async fundFromWallet(
    prefix: string,
    who: string,
    buyer: Signer,
    epoch: bigint,
    sessionKey: string,
    value: bigint,
    planDigest: string,
    opts: StepOpts = {},
  ): Promise<StepResult> {
    const ssw = await this.c.ssw.getAddress();
    await this.approve(`${prefix}.approve-wallet`, who, buyer, ssw, value, 'ServiceSubscriptionsWallet', { done: opts.done });
    return this.tx.step({
      key: `${prefix}.fund-wallet-subscription`,
      label: `${who}: fundFromWallet(epoch ${epoch}, ${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: ssw,
      data: this.c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequestOf(epoch, { sessionKey, planDigest, budgets: inference(value) })]),
      needs: [`${prefix}.approve-wallet`],
      ...opts,
    });
  }

  /** The topUpFromAccount call adding `value` to budget 0 of `subscriptionId`, as calldata. */
  topUpData(subscriptionId: string, value: bigint, planDigest: string): string {
    return this.c.ss.interface.encodeFunctionData('topUpFromAccount', [subscriptionId, inference(value), planDigest]);
  }

  async topUp(key: string, who: string, buyer: Signer, subscriptionId: string, value: bigint, planDigest: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.step({
      key,
      label: `${who}: topUpFromAccount(the account subscription, +${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: await this.c.ss.getAddress(),
      data: this.topUpData(subscriptionId, value, planDigest),
      ...opts,
    });
  }

  /**
   * `count` requests of budget 0 of `subscriptionId`, `units` units each at
   * UNIT_PRICE, signed by the subscription's session key, as the receipts of one
   * group of a batch, completed when issued. The group lands whole or not at
   * all: a seller keeps its receipts rather than spend their nonces for less.
   */
  async group(session: HDNodeWallet, subscriptionId: string, seller: bigint, firstNonce: bigint, count: number, units: bigint, issuedAt: bigint): Promise<ReceiptGroup> {
    this.qiDomain ??= await queryInferenceDomain(this.c.qis);
    const { items } = signedItems({
      domain: this.qiDomain,
      wallet: session,
      subscriptionId,
      serviceId: SERVICE0,
      seller,
      firstNonce,
      count,
      units,
      price: UNIT_PRICE,
      issuedAt,
    });
    return { subscriptionId, budgetIndex: 0n, minCounted: BigInt(count) * units * UNIT_PRICE, items };
  }

  /** The submitReceiptBatch call of `groups`, as calldata. */
  batchData(groups: ReceiptGroup[]): string {
    return this.c.qs.interface.encodeFunctionData('submitReceiptBatch', [groups]);
  }

  async batch(key: string, label: string, seller: Signer, groups: ReceiptGroup[], opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.step({
      key,
      label: `seller: submitReceiptBatch (${label})`,
      role: 'seller',
      signer: seller,
      to: await this.c.qs.getAddress(),
      data: this.batchData(groups),
      ...opts,
    });
  }
}
