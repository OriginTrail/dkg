// OT-RFC-27 script support: the marketplace's operations as transaction steps,
// built with the shapes, digests and request builders of test/helpers: a
// position, a Conviction Account opted in, an assignment with the buyer key's
// EIP-712 consent, plan periods funded from an account or a wallet, top-ups,
// revocations, and receipt batches of requests signed by session keys.

import type { HDNodeWallet, Signer } from 'ethers';

import type { Domain, Terms } from '../../test/helpers/conviction-service';
import {
  CLASS_INFERENCE,
  SERVICE_ASSIGNMENT_TYPES,
  bucket,
  bucketId,
  domainOf,
  requestOf,
  walletRequestOf,
} from '../../test/helpers/conviction-service';
import type { ReceiptGroup } from '../../test/helpers/query-inference';
import { queryInferenceDomain, signedItems } from '../../test/helpers/query-inference';

import type { Contracts } from './contracts';
import { fmt } from './report';
import { StepResult, TxRunner } from './tx';

/** The seller's ask per unit, which the buyer accepts: 0.001 TRAC. */
export const UNIT_ASK = 10n ** 15n;
/** Each bucket's price cap per unit. */
export const PRICE_CAP = 10n ** 16n;
/** The one bucket of every period here: an inference bucket of index 0. */
export const BUCKET0 = bucketId(0);

const inference = (value: bigint) => [bucket(0, CLASS_INFERENCE, value, PRICE_CAP)];

/** Steps that need an earlier step, and what makes them done already on chain. */
export type StepOpts = { needs?: string[]; done?: string };

export class Marketplace {
  private qiDomain?: Domain;
  private ssDomain?: Domain;

  constructor(
    readonly c: Contracts,
    readonly tx: TxRunner,
  ) {}

  async approve(key: string, who: string, holder: Signer, spender: string, amount: bigint, what: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.run({
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
  async stake(prefix: string, owner: Signer, node: bigint, amount: bigint, done?: string): Promise<StepResult> {
    await this.approve(`${prefix}.approve-staking`, 'owner', owner, await this.c.sv10.getAddress(), amount, 'StakingV10', { done });
    return this.tx.run({
      key: `${prefix}.stake`,
      label: `owner: createConviction(node ${node}, ${fmt(amount)} TRAC, tier 0)`,
      role: 'owner',
      signer: owner,
      to: await this.c.snft.getAddress(),
      data: this.c.snft.interface.encodeFunctionData('createConviction', [node, amount, 0]),
      needs: [`${prefix}.approve-staking`],
      done,
    });
  }

  /** A new Conviction Account of `committed` TRAC, with no designated node, under the Hub's PublishingConviction. */
  async createAccount(prefix: string, owner: Signer, committed: bigint, done?: string): Promise<StepResult> {
    const nft = await this.c.nft.getAddress();
    await this.approve(`${prefix}.approve-account`, 'owner', owner, nft, committed, 'DKGPublishingConvictionNFT', { done });
    return this.tx.run({
      key: `${prefix}.create-account`,
      label: `owner: createAccount(${fmt(committed)} TRAC, no designated node)`,
      role: 'owner',
      signer: owner,
      to: nft,
      data: this.c.nft.interface.encodeFunctionData('createAccount', [committed, 0]),
      needs: [`${prefix}.approve-account`],
      done,
    });
  }

  async optIn(key: string, owner: Signer, accountId: bigint | undefined, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.run({
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
   * The owner assigns `assignee` over the account, consenting by sending the
   * transaction; the assignee consents by an EIP-712 signature over the same
   * terms, at the account's current nonce. Without an account yet (a dry run
   * of a new run), the step is only listed.
   */
  async assign(
    key: string,
    label: string,
    owner: Signer,
    account: { id: bigint; expiresAt: bigint } | undefined,
    assignee: HDNodeWallet,
    maxCostPerPeriod: bigint,
    opts: StepOpts = {},
  ): Promise<StepResult & { terms?: Terms }> {
    let data = '0x';
    let terms: Terms | undefined;
    if (account) {
      terms = {
        accountId: account.id,
        assignee: assignee.address,
        maxCostPerPeriod,
        expiresAt: account.expiresAt,
        nonce: await this.c.cssvc.assignmentNonce(account.id),
      };
      this.ssDomain ??= await domainOf(this.c.ss);
      const consent = await assignee.signTypedData(this.ssDomain, SERVICE_ASSIGNMENT_TYPES, terms);
      data = this.c.ss.interface.encodeFunctionData('assign', [terms, '0x', consent]);
    }
    const r = await this.tx.run({ key, label, role: 'owner', signer: owner, to: await this.c.ss.getAddress(), data, ...opts });
    return { ...r, terms };
  }

  async revoke(key: string, owner: Signer, accountId: bigint, assignee: string, what: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.run({
      key,
      label: `owner: revoke ${what}`,
      role: 'owner',
      signer: owner,
      to: await this.c.ss.getAddress(),
      data: this.c.ss.interface.encodeFunctionData('revoke', [accountId, assignee]),
      ...opts,
    });
  }

  /** A plan period of `epoch` funded from the account by the assigned buyer key: no TRAC moves. */
  async fundFromConviction(
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
    const request = requestOf(accountId ?? 0n, epoch, { sessionKey, planDigest, buckets: inference(value) });
    return this.tx.run({
      key,
      label: `${who}: fundFromConviction(account ${accountId ?? '<new account>'}, epoch ${epoch}, ${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: await this.c.ss.getAddress(),
      data: accountId === undefined ? '0x' : this.c.ss.interface.encodeFunctionData('fundFromConviction', [request]),
      ...opts,
    });
  }

  /** A plan period of `epoch` paid from the buyer's wallet into the vault: the approval, then the funding. */
  async fundFromWallet(
    prefix: string,
    who: string,
    buyer: Signer,
    epoch: bigint,
    sessionKey: string,
    value: bigint,
    planDigest: string,
    done?: string,
  ): Promise<StepResult> {
    const ssw = await this.c.ssw.getAddress();
    await this.approve(`${prefix}.approve-wallet`, who, buyer, ssw, value, 'ServiceSubscriptionsWallet', { done });
    return this.tx.run({
      key: `${prefix}.fund-wallet-period`,
      label: `${who}: fundFromWallet(epoch ${epoch}, ${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: ssw,
      data: this.c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequestOf(epoch, { sessionKey, planDigest, buckets: inference(value) })]),
      needs: [`${prefix}.approve-wallet`],
      done,
    });
  }

  /** The topUpFromConviction call adding `value` to bucket 0 of `subscriptionId`, as calldata. */
  topUpData(subscriptionId: string, value: bigint, planDigest: string): string {
    return this.c.ss.interface.encodeFunctionData('topUpFromConviction', [subscriptionId, inference(value), planDigest]);
  }

  async topUp(key: string, who: string, buyer: Signer, subscriptionId: string, value: bigint, planDigest: string, opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.run({
      key,
      label: `${who}: topUpFromConviction(the account period, +${fmt(value)} TRAC)`,
      role: who,
      signer: buyer,
      to: await this.c.ss.getAddress(),
      data: this.topUpData(subscriptionId, value, planDigest),
      ...opts,
    });
  }

  /**
   * `count` requests of bucket 0 of `subscriptionId`, `units` units each at
   * UNIT_ASK, signed by the period's session key, as the receipts of one
   * group of a batch, completed when issued.
   */
  async group(session: HDNodeWallet, subscriptionId: string, seller: bigint, firstNonce: bigint, count: number, units: bigint, issuedAt: bigint): Promise<ReceiptGroup> {
    this.qiDomain ??= await queryInferenceDomain(this.c.qis);
    const { items } = signedItems({
      domain: this.qiDomain,
      wallet: session,
      subscriptionId,
      bucketId: BUCKET0,
      seller,
      firstNonce,
      count,
      units,
      ask: UNIT_ASK,
      issuedAt,
    });
    return { subscriptionId, bucketIndex: 0n, items };
  }

  async batch(key: string, label: string, seller: Signer, groups: ReceiptGroup[], opts: StepOpts = {}): Promise<StepResult> {
    return this.tx.run({
      key,
      label: `seller: submitReceiptBatch (${label})`,
      role: 'seller',
      signer: seller,
      to: await this.c.qs.getAddress(),
      data: this.c.qs.interface.encodeFunctionData('submitReceiptBatch', [groups]),
      ...opts,
    });
  }
}
