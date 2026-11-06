// The scenario's setup, run once from one machine before the beacons take over:
// the funder sends ETH to the sellers and ETH and TRAC to the buyers and owners,
// each owner opens its Conviction Account and opts it in, and each buyer is added
// with both parties' signatures. It sends only what is not there yet, so it can be
// run again; it must not be run while the beacons' timers are live, as it signs
// for the same buyers and owners. The funder sends plain transfers and nothing else.

import * as fs from 'fs';

import { ethers } from 'ethers';

import { BUYER_GRANT_TYPES } from '../../../test/helpers/conviction-service';

import { send } from './chain';
import type { Contracts, Log, Sender } from './chain';
import { BUYERS, GRANT_MAX_COST_TRAC, SELLERS, TRAC, sellerNamed } from './config';
import type { BuyerName } from './config';
import { buyerWallet, ownerWallet } from './keys';
import { publicFile, writePublicFile } from './public';
import { domainOfGrants } from './tick';
import type { TickDeps } from './tick';

const ETHER = 10n ** 18n;
const etherOf = (milli: number): bigint => (BigInt(Math.round(milli * 1_000)) * ETHER) / 1_000_000n;

/** The most the funder may spend, its own gas included. */
export const LIMIT_ETH = etherOf(60);
export const LIMIT_TRAC = 1_300_000n * TRAC;

/** Each key's ETH: enough for many weeks at the fees seen, with a bound on the fee in the driver. */
export const SELLER_ETH = etherOf(8);
export const BUYER_ETH = etherOf(1);
export const OWNER_ETH = etherOf(0.5);

/** A wallet buyer's TRAC: about 30 epochs of its subscriptions. */
export const WALLET_TRAC: Partial<Record<BuyerName, bigint>> = {
  'wallet-heavy': 25_000n * TRAC,
  'wallet-light': 10_000n * TRAC,
  'wallet-bursty': 15_000n * TRAC,
};

type Entry = { asset: 'eth' | 'trac'; to: string; amount: string; hash: string; feeWei: string };

/** What the funder has sent so far. */
class Journal {
  entries: Entry[] = [];

  constructor(private readonly file: string | undefined) {
    if (file && fs.existsSync(file)) this.entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry[];
  }

  add(e: Entry): void {
    this.entries.push(e);
    if (this.file) fs.writeFileSync(this.file, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
  }

  sentTo(asset: Entry['asset'], to: string): bigint {
    return this.entries.filter((e) => e.asset === asset && e.to === to).reduce((a, e) => a + BigInt(e.amount), 0n);
  }

  spent(): { eth: bigint; trac: bigint } {
    let eth = 0n;
    let trac = 0n;
    for (const e of this.entries) {
      eth += BigInt(e.feeWei) + (e.asset === 'eth' ? BigInt(e.amount) : 0n);
      if (e.asset === 'trac') trac += BigInt(e.amount);
    }
    return { eth, trac };
  }
}

export type SetupDeps = {
  provider: ethers.JsonRpcProvider;
  c: Contracts;
  seed: Uint8Array;
  funder: ethers.Signer;
  signerOf: (wallet: ethers.Wallet) => ethers.Signer;
  log: Log;
  sender: Sender;
  /** Without it, nothing is sent: the plan is only listed. */
  sendTransactions: boolean;
  journalFile?: string;
  publicOut: readonly string[];
};

export type SetupResult = { accountIds: Partial<Record<BuyerName, number>>; spentEth: bigint; spentTrac: bigint; complete: boolean };

const fmtEth = (wei: bigint): string => ethers.formatEther(wei);

export async function runSetup(d: SetupDeps): Promise<SetupResult> {
  const { c, provider, log, funder } = d;
  const journal = new Journal(d.journalFile);
  const funderAddress = await funder.getAddress();
  const tokenAddress = await c.token.getAddress();
  const accounts = BUYERS.filter((b) => b.account);

  // 1. What each key should have been sent.
  type Target = { who: string; to: string; eth: bigint; trac: bigint };
  const targets: Target[] = [];
  for (const s of SELLERS) targets.push({ who: s.name, to: s.address, eth: SELLER_ETH, trac: 0n });
  for (const b of BUYERS) targets.push({ who: `buyer ${b.name}`, to: buyerWallet(d.seed, b.name).address, eth: BUYER_ETH, trac: WALLET_TRAC[b.name] ?? 0n });
  for (const b of accounts) targets.push({ who: `owner ${b.name}`, to: ownerWallet(d.seed, b.name).address, eth: OWNER_ETH, trac: BigInt(b.account?.committedTrac ?? 0) * TRAC });

  const needs = await Promise.all(
    targets.map(async (t) => {
      const ethBalance = await provider.getBalance(t.to);
      const tracBalance = (await c.token.balanceOf(t.to)) as bigint;
      const accountDone = t.who.startsWith('owner ') && ((await c.nft.balanceOf(t.to)) as bigint) > 0n;
      const ethHas = ethBalance > journal.sentTo('eth', t.to) ? ethBalance : journal.sentTo('eth', t.to);
      const tracHas = tracBalance > journal.sentTo('trac', t.to) ? tracBalance : journal.sentTo('trac', t.to);
      return { ...t, ethNeed: t.eth > ethHas ? t.eth - ethHas : 0n, tracNeed: accountDone || t.trac <= tracHas ? 0n : t.trac - tracHas };
    }),
  );
  const planned = {
    eth: needs.reduce((a, n) => a + n.ethNeed, 0n),
    trac: needs.reduce((a, n) => a + n.tracNeed, 0n),
  };
  const already = journal.spent();
  const funderEth = await provider.getBalance(funderAddress);
  const funderTrac = (await c.token.balanceOf(funderAddress)) as bigint;
  log.event('setup-plan', {
    funder: funderAddress,
    funderEth: fmtEth(funderEth),
    funderTrac: fmtEth(funderTrac),
    alreadySpentEth: fmtEth(already.eth),
    alreadySpentTrac: fmtEth(already.trac),
    plannedEth: fmtEth(planned.eth),
    plannedTrac: fmtEth(planned.trac),
    limitEth: fmtEth(LIMIT_ETH),
    limitTrac: fmtEth(LIMIT_TRAC),
    sends: needs.filter((n) => n.ethNeed > 0n || n.tracNeed > 0n).map((n) => ({ who: n.who, to: n.to, eth: fmtEth(n.ethNeed), trac: fmtEth(n.tracNeed) })),
  });
  // Gas of the funder's own sends: well under this, at the fees bounded by the sender.
  const gasRoom = etherOf(1);
  if (already.eth + planned.eth + gasRoom > LIMIT_ETH) throw new Error(`the plan's ETH, ${fmtEth(already.eth + planned.eth)} plus gas, is over the limit of ${fmtEth(LIMIT_ETH)}`);
  if (already.trac + planned.trac > LIMIT_TRAC) throw new Error(`the plan's TRAC, ${fmtEth(already.trac + planned.trac)}, is over the limit of ${fmtEth(LIMIT_TRAC)}`);
  if (!d.sendTransactions) return { accountIds: {}, spentEth: already.eth, spentTrac: already.trac, complete: false };

  // 2. The funder's transfers, each checked against the limits with its own gas.
  const checkLimits = () => {
    const s = journal.spent();
    if (s.eth > LIMIT_ETH || s.trac > LIMIT_TRAC) throw new Error('over the limits: stopping');
  };
  for (const n of needs) {
    if (n.ethNeed > 0n) {
      const out = await send(d.sender, { label: `funder: ETH to ${n.who}`, signer: funder, to: n.to, data: '0x', value: n.ethNeed, fields: { to: n.to, eth: fmtEth(n.ethNeed) } });
      if (!out.sent) throw new Error(`the ETH send to ${n.who} did not go through`);
      journal.add({ asset: 'eth', to: n.to, amount: n.ethNeed.toString(), hash: out.receipt.hash, feeWei: out.receipt.fee.toString() });
      checkLimits();
    }
    if (n.tracNeed > 0n) {
      const data = new ethers.Interface(['function transfer(address,uint256) returns (bool)']).encodeFunctionData('transfer', [n.to, n.tracNeed]);
      const out = await send(d.sender, { label: `funder: TRAC to ${n.who}`, signer: funder, to: tokenAddress, data, fields: { to: n.to, trac: fmtEth(n.tracNeed) } });
      if (!out.sent) throw new Error(`the TRAC send to ${n.who} did not go through`);
      journal.add({ asset: 'trac', to: n.to, amount: n.tracNeed.toString(), hash: out.receipt.hash, feeWei: out.receipt.fee.toString() });
      checkLimits();
    }
  }

  // 3. Wallet buyers approve the wallet contract for what they hold.
  const walletContract = await c.ssw.getAddress();
  for (const b of BUYERS.filter((x) => x.pays === 'wallet')) {
    const wallet = buyerWallet(d.seed, b.name);
    const balance = (await c.token.balanceOf(wallet.address)) as bigint;
    if (((await c.token.allowance(wallet.address, walletContract)) as bigint) >= balance) continue;
    const out = await send(d.sender, { label: `${b.name}: approve the wallet contract`, signer: d.signerOf(wallet), to: tokenAddress, data: c.token.interface.encodeFunctionData('approve', [walletContract, balance]) });
    if (!out.sent) throw new Error(`${b.name}: the approval did not go through`);
  }

  // 4. Each account: created, opted in, and its buyer added.
  const accountIds: Partial<Record<BuyerName, number>> = {};
  const nft = await c.nft.getAddress();
  const ss = await c.ss.getAddress();
  const domain = await domainOfGrants({ provider, c } as TickDeps);
  for (let i = 0; i < accounts.length; i++) {
    const b = accounts[i];
    const owner = ownerWallet(d.seed, b.name);
    const ownerSigner = d.signerOf(owner);
    const buyer = buyerWallet(d.seed, b.name);
    const terms = b.account;
    if (!terms) continue;
    const committed = BigInt(terms.committedTrac) * TRAC;
    if (((await c.nft.balanceOf(owner.address)) as bigint) === 0n) {
      if (((await c.token.allowance(owner.address, nft)) as bigint) < committed) {
        const out = await send(d.sender, { label: `${b.name}: its owner approves the account NFT`, signer: ownerSigner, to: tokenAddress, data: c.token.interface.encodeFunctionData('approve', [nft, committed]) });
        if (!out.sent) throw new Error(`${b.name}: the owner's approval did not go through`);
      }
      const primary = sellerNamed(terms.primaryNode).identityId;
      const out = await send(d.sender, { label: `${b.name}: its owner creates the account`, signer: ownerSigner, to: nft, data: c.nft.interface.encodeFunctionData('createAccount', [committed, primary]), fields: { committedTrac: terms.committedTrac, primaryNode: primary } });
      if (!out.sent) throw new Error(`${b.name}: the account was not created`);
    }
    const accountId = (await c.nft.tokenOfOwnerByIndex(owner.address, 0)) as bigint;
    accountIds[b.name] = Number(accountId);
    const account = await c.pcs.getAccount(accountId);
    if (Number(account.discountBps) !== terms.discountBps) throw new Error(`${b.name}: account ${accountId} has discount ${account.discountBps}, not ${terms.discountBps}`);

    const spending = await c.sss.getServiceSpending(accountId);
    if ((spending.enabledAt as bigint) === 0n) {
      const out = await send(d.sender, { label: `${b.name}: its owner opts the account in`, signer: ownerSigner, to: ss, data: c.ss.interface.encodeFunctionData('setServiceSpending', [accountId, true]), fields: { accountId: accountId.toString() } });
      if (!out.sent) throw new Error(`${b.name}: the opt-in did not go through`);
    }

    const grant = await c.sss.getGrant(accountId, buyer.address);
    if ((grant.grantedAt as bigint) === 0n) {
      const grantTerms = {
        accountId,
        buyer: buyer.address,
        maxCostPerEpoch: BigInt(GRANT_MAX_COST_TRAC) * TRAC,
        expiresAt: account.expiresAtTimestamp as bigint,
        nonce: (await c.sss.grantNonce(accountId)) as bigint,
      };
      const ownerSignature = await owner.signTypedData(domain, BUYER_GRANT_TYPES, grantTerms);
      const buyerSignature = await buyer.signTypedData(domain, BUYER_GRANT_TYPES, grantTerms);
      // Anyone may submit, and a party that sends consents by sending: so another account's owner sends it, with both signatures.
      const submitter = ownerWallet(d.seed, accounts[(i + 1) % accounts.length].name);
      const out = await send(d.sender, {
        label: `${b.name}: its buyer is added, with both signatures`,
        signer: d.signerOf(submitter),
        to: ss,
        data: c.ss.interface.encodeFunctionData('addBuyer', [grantTerms, ownerSignature, buyerSignature]),
        fields: { accountId: accountId.toString(), submitter: submitter.address },
      });
      if (!out.sent) throw new Error(`${b.name}: the buyer was not added`);
    }
    log.event('account-ready', {
      buyer: b.name,
      accountId: accountId.toString(),
      discountBps: Number(account.discountBps),
      expiresAtTimestamp: Number(account.expiresAtTimestamp),
      expiresAtEpoch: Number(account.expiresAtEpoch),
    });
  }

  // 5. What the beacons and anyone following read.
  if (d.publicOut.length > 0) writePublicFile(publicFile(d.seed, accountIds), d.publicOut);

  const spent = journal.spent();
  log.event('setup-done', {
    spentEth: fmtEth(spent.eth),
    spentTrac: fmtEth(spent.trac),
    funderEthBefore: fmtEth(funderEth),
    funderEthAfter: fmtEth(await provider.getBalance(funderAddress)),
    funderTracBefore: fmtEth(funderTrac),
    funderTracAfter: fmtEth((await c.token.balanceOf(funderAddress)) as bigint),
    transfers: journal.entries.length,
  });
  return { accountIds, spentEth: spent.eth, spentTrac: spent.trac, complete: true };
}

