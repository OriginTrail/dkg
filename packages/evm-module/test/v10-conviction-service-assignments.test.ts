// Conviction Account service spending (OT-RFC-27) end to end: the owner's opt-in
// and the assignment of buyer keys, on ServiceSubscriptions and
// ConvictionServiceStorage registered in the Hub, on the real account stack.
//
// Groups:
//   - opt-in: owner only, an account that 10.0.8 or 10.1.0 scheduled, an
//     expired account, a wired treasury, a repeated switch, and an account a
//     build older than 10.0.8 created;
//   - assign: consent by sending or by signature (EOA and ERC-1271), the nonce,
//     replay, the domain, every invalid term, a transferred NFT, high-s and
//     compact signatures, and the separation from publishing agents;
//   - a sale of the account NFT: the former owner's opt-in and assignments
//     fund and top up nothing, also once the new owner opts in, and the new
//     owner assigns afresh;
//   - revoke, and advancing the nonce;
//   - caps update: owner only, live assignments only, a valid and changed limit
//     and expiry, usage and nonces kept, applied from the next funding in both
//     directions, a paused account, and terms signed before an update.
//
// Funding is in v10-conviction-service-funding.test.ts, and the allowance shared
// with publishing in v10-conviction-service-publishing.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionResponse, ethers } from 'ethers';
import hre from 'hardhat';

import { MockERC1271Wallet } from '../typechain';
import { blockTime, eventsOf } from './helpers/account-stack';
import {
  CLASS_INFERENCE,
  Caps,
  DAY,
  TRAC,
  Terms,
  bucket,
  capsOf,
  compact,
  costOf,
  domainOf,
  highS,
  signTerms,
  writeLegacyAccount,
} from './helpers/conviction-service';
import { ServiceHelpers, ServiceStack, deployServiceStack, serviceHelpers } from './helpers/conviction-service-stack';
import { deployScheduleHarness } from './helpers/scheduled-accounts';
import { DEFAULT_CHAIN_ID } from './helpers/v10-ka-helpers';

// No discount, so a cost equals its value; the window allowance is 1,000 TRAC.
const SMALL = 12_000n * TRAC + 5n;
// A limit that no test of the draw itself reaches.
const WIDE: Partial<Terms> = { maxCostPerPeriod: 50_000n * TRAC };

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployServiceStack();
}

describe('@integration Conviction Account service spending (ServiceSubscriptions)', function () {
  let f: ServiceStack;
  let h: ServiceHelpers;

  let epLen: bigint;
  let lock: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let relayer: SignerWithAddress;
  let newOwner: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    epLen = await f.Chronos.epochLength();
    lock = await f.Params.publishingConvictionEpochs();
    owner = f.accounts[20];
    buyer = f.accounts[21];
    stranger = f.accounts[22];
    relayer = f.accounts[23];
    newOwner = f.accounts[24];
    buyer2 = f.accounts[25];
    treasury = f.accounts[28];
    h = serviceHelpers({ f, owner, buyer, epLen, lock });
  });

  // -------------------------------------------------------------------------
  // Opt-in
  // -------------------------------------------------------------------------

  describe('opt-in', () => {
    it('an account that 10.0.8 or 10.1.0 scheduled reverts EmissionAlreadyScheduled; a use-time account switches on', async () => {
      const harness = await deployScheduleHarness(f.Hub);
      const scheduled = await h.createAccountFor();
      await harness.scheduleInFull(scheduled.accountId);
      await expect(f.SS.connect(owner).setServiceSpending(scheduled.accountId, true))
        .to.be.revertedWithCustomError(f.SS, 'EmissionAlreadyScheduled')
        .withArgs(scheduled.accountId);
      expect((await f.CSS.getServiceSpending(scheduled.accountId)).enabledAt).to.equal(0n);

      const { accountId } = await h.createAccountFor();
      expect((await f.PCS.getAccount(accountId)).lastSettledWindow).to.equal(0n);
      await expect(f.SS.connect(owner).setServiceSpending(accountId, true))
        .to.emit(f.SS, 'ServiceSpendingSet')
        .withArgs(accountId, true);
    });

    describe('a use-time account', () => {
      it('is owner only, in both directions', async () => {
        const { accountId } = await h.createAccountFor();
        for (const caller of [stranger, buyer, f.accounts[0]]) {
          await expect(f.SS.connect(caller).setServiceSpending(accountId, true))
            .to.be.revertedWithCustomError(f.SS, 'NotAccountOwner')
            .withArgs(accountId, caller.address);
        }
        await f.SS.connect(owner).setServiceSpending(accountId, true);
        await expect(f.SS.connect(stranger).setServiceSpending(accountId, false))
          .to.be.revertedWithCustomError(f.SS, 'NotAccountOwner')
          .withArgs(accountId, stranger.address);
        // An id the NFT never minted has no owner.
        await expect(f.SS.connect(owner).setServiceSpending(424242n, true))
          .to.be.revertedWithCustomError(f.NFT, 'ERC721NonexistentToken')
          .withArgs(424242n);
      });

      it('switching on records the block time; switching off records 0, keeps the assignments and pauses funding', async () => {
        const { accountId } = await h.createAccountFor();
        const on = await f.SS.connect(owner).setServiceSpending(accountId, true);
        await expect(on).to.emit(f.SS, 'ServiceSpendingSet').withArgs(accountId, true);
        expect(h.plain(await f.CSS.getServiceSpending(accountId))).to.deep.equal({
          enabledAt: await blockTime((await on.wait())!),
          owner: owner.address,
        });
        const terms = await h.termsFor(accountId, buyer.address);
        await h.assignAs(terms, buyer);

        await expect(f.SS.connect(owner).setServiceSpending(accountId, false))
          .to.emit(f.SS, 'ServiceSpendingSet')
          .withArgs(accountId, false);
        expect(h.plain(await f.CSS.getServiceSpending(accountId))).to.deep.equal({ enabledAt: 0n, owner: ethers.ZeroAddress });
        expect(await f.CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
        await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
          .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
          .withArgs(accountId);

        const again = await f.SS.connect(owner).setServiceSpending(accountId, true);
        expect((await f.CSS.getServiceSpending(accountId)).enabledAt).to.equal(await blockTime((await again.wait())!));
        await h.fund(await h.inference(accountId, TRAC));
      });

      it('an expired account reverts AccountExpired; switching off still works after expiry', async () => {
        const first = await h.createAccountFor();
        const second = await h.createAccountFor();
        await f.SS.connect(owner).setServiceSpending(second.accountId, true);
        const acct = await f.PCS.getAccount(first.accountId);
        await time.increaseTo(acct.expiresAtTimestamp);
        await expect(f.SS.connect(owner).setServiceSpending(first.accountId, true))
          .to.be.revertedWithCustomError(f.SS, 'AccountExpired')
          .withArgs(first.accountId, acct.expiresAtEpoch);
        await expect(f.SS.connect(owner).setServiceSpending(second.accountId, false))
          .to.emit(f.SS, 'ServiceSpendingSet')
          .withArgs(second.accountId, false);
      });

      it('a wired treasury reverts ServiceFundingPausedTreasuryWired; switching off still works', async () => {
        const first = await h.createAccountFor();
        const second = await h.createAccountFor();
        await f.SS.connect(owner).setServiceSpending(second.accountId, true);
        await f.Params.setProtocolTreasury(treasury.address);
        await expect(f.SS.connect(owner).setServiceSpending(first.accountId, true))
          .to.be.revertedWithCustomError(f.SS, 'ServiceFundingPausedTreasuryWired')
          .withArgs(treasury.address);
        await expect(f.SS.connect(owner).setServiceSpending(second.accountId, false))
          .to.emit(f.SS, 'ServiceSpendingSet')
          .withArgs(second.accountId, false);
        await f.Params.setProtocolTreasury(ethers.ZeroAddress);
        await f.SS.connect(owner).setServiceSpending(first.accountId, true);
      });

      it('a repeated switch reverts ServiceSpendingUnchanged', async () => {
        const { accountId } = await h.createAccountFor();
        await expect(f.SS.connect(owner).setServiceSpending(accountId, false))
          .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingUnchanged')
          .withArgs(accountId, false);
        await f.SS.connect(owner).setServiceSpending(accountId, true);
        await expect(f.SS.connect(owner).setServiceSpending(accountId, true))
          .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingUnchanged')
          .withArgs(accountId, true);
      });

      it('the opt-in books nothing and leaves the staker pool unchanged', async () => {
        const { accountId, createdAt } = await h.createAccountFor();
        const { first, last } = await h.spanOf(createdAt);
        const before = await h.poolSnapshot(first - 1n, last + 1n);
        const receipt = (await (await f.SS.connect(owner).setServiceSpending(accountId, true)).wait())!;
        expect(await eventsOf(receipt, f.PC, 'EmissionScheduled')).to.have.length(0);
        expect(await h.creditedRanges(receipt)).to.have.length(0);
        expect(await h.poolSnapshot(first - 1n, last + 1n)).to.deep.equal(before);
      });
    });

    it('an account a build older than 10.0.8 created opts in as a use-time account; the opt-in books nothing, and its funding books only closed windows', async () => {
      // Created by an older build a window and a third ago, with 111 TRAC of
      // window 0 already spent (and booked) under the older rules.
      await time.increase(2n * epLen);
      const synthId = 909n;
      const committed = 12_000n * TRAC + 5n;
      const createdAt = (await h.latest()) - epLen - epLen / 3n;
      const spent0 = 111n * TRAC;
      await writeLegacyAccount({
        pcs: f.PCS,
        nft: f.NFT,
        chronosEpochAt: (ts) => f.Chronos.epochAtTimestamp(ts),
        accountId: synthId,
        owner: owner.address,
        committed,
        createdAt,
        lock,
        epLen,
        spent: new Map<bigint, bigint>([[0n, spent0]]),
      });
      expect(await f.NFT.ownerOf(synthId)).to.equal(owner.address);
      expect((await f.PCS.getAccount(synthId)).lastSettledWindow).to.equal(0n);

      const optIn = (await (await f.SS.connect(owner).setServiceSpending(synthId, true)).wait())!;
      expect(await eventsOf(optIn, f.PC, 'EmissionScheduled')).to.have.length(0);
      expect(await h.creditedRanges(optIn)).to.have.length(0);
      expect((await f.PCS.getAccount(synthId)).lastSettledWindow).to.equal(0n);

      // Its first funding books window 0, which has closed, and draws window 1.
      await h.assignAs(await h.termsFor(synthId, buyer.address, WIDE), buyer);
      const { cost, receipt } = await h.fund(await h.inference(synthId, 10n * TRAC));
      const B = committed / lock;
      await expect(receipt).to.emit(f.PC, 'EmissionScheduled').withArgs(synthId, 0n, 1n, B - spent0, 0n);
      expect((await f.PCS.getAccount(synthId)).lastSettledWindow).to.equal(1n);
      expect(await f.PCS.windowSpent(synthId, 1n)).to.equal(cost);
      expect(await f.QIS.convictionDue((await h.epochNow()) + 1n)).to.equal(cost);
    });
  });

  // -------------------------------------------------------------------------
  // Assign
  // -------------------------------------------------------------------------

  describe('assign', () => {
    let accountId: bigint;

    beforeEach(async () => {
      ({ accountId } = await h.createAccountFor());
      await f.SS.connect(owner).setServiceSpending(accountId, true);
    });

    const expectAssigned = async (tx: ContractTransactionResponse, t: Terms, nonce: bigint) => {
      const digest = await f.SS.hashAssignment(t);
      await expect(tx)
        .to.emit(f.SS, 'ServiceAssigned')
        .withArgs(t.accountId, t.assignee, digest, t.maxCostPerPeriod, t.expiresAt, nonce);
      await expect(tx).to.emit(f.SS, 'AssignmentNonceAdvanced').withArgs(t.accountId, nonce + 1n);
      const a = await f.CSS.getAssignment(t.accountId, t.assignee);
      expect([a.maxCostPerPeriod, a.expiresAt]).to.deep.equal(Object.values(capsOf(t)));
      expect(a.assignedAt).to.equal(await blockTime((await tx.wait())!));
      expect(a.revokedAt).to.equal(0n);
      expect(a.nonce).to.equal(nonce);
      expect(a.owner).to.equal(await f.NFT.ownerOf(t.accountId));
      expect(await f.CSS.assignmentNonce(t.accountId)).to.equal(nonce + 1n);
      expect(await f.CSS.isAssignmentActive(t.accountId, t.assignee)).to.equal(true);
    };

    it("the owner sends, with the assignee's EOA signature", async () => {
      const t = await h.termsFor(accountId, buyer.address);
      await expectAssigned(await f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)), t, 0n);
      expect(await f.CSS.assigneeCount(accountId)).to.equal(1n);
      expect(await f.CSS.assigneeAt(accountId, 0n)).to.equal(buyer.address);
      expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);
    });

    it("the assignee sends, with the owner's signature", async () => {
      const t = await h.termsFor(accountId, buyer.address);
      await expectAssigned(await f.SS.connect(buyer).assign(t, await signTerms(owner, f.SS, t), '0x'), t, 0n);
    });

    it('a third party submits both signatures', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      await expectAssigned(
        await f.SS.connect(relayer).assign(t, await signTerms(owner, f.SS, t), await signTerms(buyer, f.SS, t)),
        t,
        0n,
      );
    });

    it('both parties may be ERC-1271 wallets, and a wallet assignee funds as itself', async () => {
      const ownerKey = f.accounts[26];
      const buyerKey = f.accounts[27];
      const Wallet = await hre.ethers.getContractFactory('MockERC1271Wallet');
      const ownerWallet = (await Wallet.deploy(ownerKey.address)) as unknown as MockERC1271Wallet;
      const buyerWallet = (await Wallet.deploy(buyerKey.address)) as unknown as MockERC1271Wallet;
      const ownerWalletAddress = await ownerWallet.getAddress();
      const buyerWalletAddress = await buyerWallet.getAddress();
      await f.NFT.connect(owner).transferFrom(owner.address, ownerWalletAddress, accountId);
      // The opt-in is the former owner's: the wallet, now the owner, opts in itself.
      await f.SS.connect(await h.impersonate(ownerWalletAddress)).setServiceSpending(accountId, true);

      const t = await h.termsFor(accountId, buyerWalletAddress);
      const ownerSig = await signTerms(ownerKey, f.SS, t);
      const buyerSig = await signTerms(buyerKey, f.SS, t);

      // The wallet's answer decides: a refusal, or another key's signature, is a bad signature.
      await ownerWallet.setForceFailure(true);
      await expect(f.SS.connect(relayer).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(ownerWalletAddress);
      await ownerWallet.setForceFailure(false);
      await expect(f.SS.connect(relayer).assign(t, ownerSig, await signTerms(stranger, f.SS, t)))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(buyerWalletAddress);

      await expectAssigned(await f.SS.connect(relayer).assign(t, ownerSig, buyerSig), t, 0n);

      const wallet = await h.impersonate(buyerWalletAddress);
      const { cost } = await h.fund(await h.inference(accountId, 10n * TRAC), wallet);
      expect(cost).to.equal(costOf(10n * TRAC, 3_000n));
    });

    it('an address with code that does not answer ERC-1271 cannot consent by signature', async () => {
      const contractParty = await f.PCS.getAddress();
      const t = await h.termsFor(accountId, contractParty);
      await expect(f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(contractParty);
    });

    it('self-assignment: an owner that sends consents in both roles, and funds as its own buyer key', async () => {
      const t = await h.termsFor(accountId, owner.address);
      const sig = await signTerms(owner, f.SS, t);
      await expect(f.SS.connect(owner).assign(t, sig, '0x'))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expect(f.SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expectAssigned(await f.SS.connect(owner).assign(t, '0x', '0x'), t, 0n);
      await h.fund(await h.inference(accountId, TRAC), owner);
    });

    it('a wrong nonce reverts InvalidAssignmentNonce', async () => {
      const t = await h.termsFor(accountId, buyer.address, { nonce: 1n });
      await expect(f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)))
        .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 0n, 1n);
    });

    it('a used signature cannot be replayed: the nonce has moved on', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, f.SS, t);
      const buyerSig = await signTerms(buyer, f.SS, t);
      await f.SS.connect(relayer).assign(t, ownerSig, buyerSig);
      for (const sender of [relayer, owner]) {
        await expect(f.SS.connect(sender).assign(t, sender === owner ? '0x' : ownerSig, buyerSig))
          .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentNonce')
          .withArgs(accountId, 1n, 0n);
      }
    });

    it('a signature for another chain id or another verifying contract does not verify', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      const domain = await domainOf(f.SS);
      for (const other of [
        { ...domain, chainId: DEFAULT_CHAIN_ID + 1n },
        { ...domain, verifyingContract: await f.PCS.getAddress() },
        { ...domain, name: 'KnowledgeAssetsLifecycle' },
        { ...domain, version: '2' },
      ]) {
        await expect(f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t, other)))
          .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
          .withArgs(buyer.address);
        await expect(f.SS.connect(buyer).assign(t, await signTerms(owner, f.SS, t, other), '0x'))
          .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
          .withArgs(owner.address);
      }
    });

    it('refuses expired terms and every invalid term, and admits the bounds', async () => {
      const now = await h.latest();
      const cases: Array<[Partial<Terms>, string]> = [
        [{ assignee: ethers.ZeroAddress }, 'assignee'],
        [{ maxCostPerPeriod: 0n }, 'maxCostPerPeriod'],
        [{ expiresAt: now }, 'expiresAt'],
        [{ expiresAt: 0n }, 'expiresAt'],
      ];
      for (const [overrides, reason] of cases) {
        const t = await h.termsFor(accountId, buyer.address, overrides);
        await expect(f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)), reason)
          .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentTerms')
          .withArgs(reason);
      }
      // A limit of 1 wei, and an expiry just after the block time.
      const t = await h.termsFor(accountId, buyer.address, { maxCostPerPeriod: 1n, expiresAt: (await h.latest()) + 100n });
      await expectAssigned(await f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)), t, 0n);
    });

    it('an account that has not opted in, or has switched off, reverts ServiceSpendingDisabled', async () => {
      const other = await h.createAccountFor();
      const t = await h.termsFor(other.accountId, buyer.address);
      await expect(f.SS.connect(owner).assign(t, '0x', await signTerms(buyer, f.SS, t)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(other.accountId);
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      const u = await h.termsFor(accountId, buyer.address);
      await expect(f.SS.connect(owner).assign(u, '0x', await signTerms(buyer, f.SS, u)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
    });

    it("after an NFT transfer the previous owner's signature fails, and its opt-in and assignments fund nothing", async () => {
      await h.assignAs(await h.termsFor(accountId, buyer.address), buyer);
      await f.NFT.connect(owner).transferFrom(owner.address, newOwner.address, accountId);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);

      await f.SS.connect(newOwner).setServiceSpending(accountId, true);
      const t = await h.termsFor(accountId, buyer2.address);
      await expect(f.SS.connect(buyer2).assign(t, await signTerms(owner, f.SS, t), '0x'))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(newOwner.address);

      // The stored assignment is still there, but its consent was the former owner's.
      expect(await f.CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'AssignedByFormerOwner')
        .withArgs(accountId, buyer.address);

      for (const call of [
        f.SS.connect(owner).revoke(accountId, buyer.address),
        f.SS.connect(owner).setServiceSpending(accountId, false),
        f.SS.connect(owner).advanceAssignmentNonce(accountId),
      ]) {
        await expect(call).to.be.revertedWithCustomError(f.SS, 'NotAccountOwner').withArgs(accountId, owner.address);
      }
      await expectAssigned(await f.SS.connect(buyer2).assign(t, await signTerms(newOwner, f.SS, t), '0x'), t, 1n);
      await h.fund(await h.inference(accountId, TRAC), buyer2);
      await f.SS.connect(newOwner).revoke(accountId, buyer.address);
    });

    it('rejects a high-s signature and malformed ones, and accepts the low-s twin in its 64-byte compact form', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      const sig = await signTerms(buyer, f.SS, t);
      const digest = await f.SS.hashAssignment(t);
      const malleated = highS(sig);
      // The malleated twin recovers to the same key with solady, which checks
      // no s (shown through a wallet that recovers with it), so only the s
      // check refuses it. ethers itself refuses to parse it.
      const Wallet = await hre.ethers.getContractFactory('MockERC1271Wallet');
      const probe = (await Wallet.deploy(buyer.address)) as unknown as MockERC1271Wallet;
      expect(await probe.isValidSignature(digest, malleated)).to.equal('0x1626ba7e');
      for (const bad of [
        malleated,
        ethers.concat([sig, '0x00']),
        ethers.dataSlice(sig, 0, 63),
        ethers.concat([ethers.dataSlice(sig, 0, 64), '0x1d']),
      ]) {
        await expect(f.SS.connect(owner).assign(t, '0x', bad))
          .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
          .withArgs(buyer.address);
      }
      await expectAssigned(await f.SS.connect(owner).assign(t, '0x', compact(sig)), t, 0n);
    });

    it('a party that sends the transaction must not also sign', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, f.SS, t);
      const buyerSig = await signTerms(buyer, f.SS, t);
      await expect(f.SS.connect(owner).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expect(f.SS.connect(buyer).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidConsentSignature')
        .withArgs(buyer.address);
    });

    it('an empty signature from a party that does not send reverts ConsentMissing', async () => {
      const t = await h.termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, f.SS, t);
      const buyerSig = await signTerms(buyer, f.SS, t);
      await expect(f.SS.connect(relayer).assign(t, '0x', buyerSig))
        .to.be.revertedWithCustomError(f.SS, 'ConsentMissing')
        .withArgs(owner.address);
      await expect(f.SS.connect(relayer).assign(t, ownerSig, '0x'))
        .to.be.revertedWithCustomError(f.SS, 'ConsentMissing')
        .withArgs(buyer.address);
      await expect(f.SS.connect(owner).assign(t, '0x', '0x'))
        .to.be.revertedWithCustomError(f.SS, 'ConsentMissing')
        .withArgs(buyer.address);
    });

    it('a publishing agent registration grants no service spending, and an assignment grants no publishing', async () => {
      await f.NFT.connect(owner).registerAgent(accountId, buyer2.address);
      await expect(f.SS.connect(buyer2).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'NotAssigned')
        .withArgs(accountId, buyer2.address);
      await h.assignAs(await h.termsFor(accountId, buyer.address), buyer);
      expect(await f.PCS.agentToAccountId(buyer.address)).to.equal(0n);
      expect(await f.NFT.isAgent(accountId, buyer.address)).to.equal(false);
    });

    it('a new assignment of the same assignee replaces its terms and counts its usage from zero', async () => {
      await h.assignAs(await h.termsFor(accountId, buyer.address), buyer);
      await h.fund(await h.inference(accountId, 10n * TRAC));
      await h.fund(await h.inference(accountId, 10n * TRAC, { epoch: await h.epochNext() }));
      expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(2n);

      const t = await h.termsFor(accountId, buyer.address, { maxCostPerPeriod: 5n * TRAC });
      await expectAssigned(await h.assignAs(t, buyer), t, 1n);
      expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);
      expect(await f.CSS.assigneeCount(accountId)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // A sale of the account
  // -------------------------------------------------------------------------

  describe('a sale of the account NFT', () => {
    let accountId: bigint;
    let p: string;

    beforeEach(async () => {
      ({ accountId } = await h.openAccount());
      ({ subscriptionId: p } = await h.fund(await h.inference(accountId, 10n * TRAC)));
      await f.NFT.connect(owner).transferFrom(owner.address, newOwner.address, accountId);
    });

    it("leaves the former owner's buyer key unable to fund or top up from the new owner's allowance", async () => {
      const { window } = await f.SS.currentWindowAllowance(accountId);
      const spent = await f.PCS.windowSpent(accountId, window);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, 900n * TRAC, { epoch: await h.epochNext() })))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await expect(f.SS.connect(buyer).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, 900n * TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      expect(await f.PCS.windowSpent(accountId, window)).to.equal(spent);
    });

    it('switching spending on again does not revive the assignments the former owner made', async () => {
      await expect(f.SS.connect(newOwner).setServiceSpending(accountId, true))
        .to.emit(f.SS, 'ServiceSpendingSet')
        .withArgs(accountId, true);
      expect((await f.CSS.getServiceSpending(accountId)).owner).to.equal(newOwner.address);
      const refused = async () => {
        await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, 900n * TRAC, { epoch: await h.epochNext() })))
          .to.be.revertedWithCustomError(f.SS, 'AssignedByFormerOwner')
          .withArgs(accountId, buyer.address);
        await expect(f.SS.connect(buyer).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
          .to.be.revertedWithCustomError(f.SS, 'AssignedByFormerOwner')
          .withArgs(accountId, buyer.address);
      };
      await refused();
      await expect(
        f.SS.connect(newOwner).updateAssignmentCaps(accountId, buyer.address, {
          maxCostPerPeriod: 2_000n * TRAC,
          expiresAt: (await h.latest()) + 500n * DAY,
        }),
      )
        .to.be.revertedWithCustomError(f.SS, 'AssignedByFormerOwner')
        .withArgs(accountId, buyer.address);

      // Off and on again: still nothing.
      await f.SS.connect(newOwner).setServiceSpending(accountId, false);
      await f.SS.connect(newOwner).setServiceSpending(accountId, true);
      await refused();
    });

    it('the new owner opts in and assigns afresh, and its buyer key funds and tops up', async () => {
      await f.SS.connect(newOwner).setServiceSpending(accountId, true);
      const t = await h.termsFor(accountId, buyer.address);
      await f.SS.connect(newOwner).assign(t, '0x', await signTerms(buyer, f.SS, t));
      expect((await f.CSS.getAssignment(accountId, buyer.address)).owner).to.equal(newOwner.address);
      const { subscriptionId: q } = await h.fund(await h.inference(accountId, TRAC, { epoch: await h.epochNext() }));
      await f.SS.connect(buyer).topUpFromConviction(q, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
      expect((await f.CSS.getSubscription(q)).value).to.equal(2n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  describe('revoke', () => {
    let accountId: bigint;

    beforeEach(async () => {
      ({ accountId } = await h.openAccount());
    });

    it('is owner only', async () => {
      for (const caller of [buyer, stranger]) {
        await expect(f.SS.connect(caller).revoke(accountId, buyer.address))
          .to.be.revertedWithCustomError(f.SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
    });

    it('is immediate for new periods, records the time and advances the nonce', async () => {
      await h.fund(await h.inference(accountId, TRAC));
      const tx = await f.SS.connect(owner).revoke(accountId, buyer.address);
      await expect(tx).to.emit(f.SS, 'ServiceRevoked').withArgs(accountId, buyer.address);
      await expect(tx).to.emit(f.SS, 'AssignmentNonceAdvanced').withArgs(accountId, 2n);
      expect((await f.CSS.getAssignment(accountId, buyer.address)).revokedAt).to.equal(
        await blockTime((await tx.wait())!),
      );
      expect(await f.CSS.isAssignmentActive(accountId, buyer.address)).to.equal(false);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC, { epoch: await h.epochNext() })))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
      await expect(f.SS.connect(owner).revoke(accountId, buyer.address))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
      await expect(f.SS.connect(owner).revoke(accountId, stranger.address))
        .to.be.revertedWithCustomError(f.SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
    });

    it('terms signed but not yet submitted no longer assign', async () => {
      const t = await h.termsFor(accountId, buyer2.address);
      const sig = await signTerms(buyer2, f.SS, t);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await expect(f.SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 2n, 1n);
    });

    it('a funded period keeps its record and its buckets', async () => {
      const { subscriptionId } = await h.fund(await h.inference(accountId, 10n * TRAC));
      const record = h.plain(await f.CSS.getSubscription(subscriptionId));
      const buckets = (await f.CSS.getBuckets(subscriptionId)).map(h.plain);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      expect(h.plain(await f.CSS.getSubscription(subscriptionId))).to.deep.equal(record);
      expect((await f.CSS.getBuckets(subscriptionId)).map(h.plain)).to.deep.equal(buckets);
      expect(await f.CSS.subscriptionExists(subscriptionId)).to.equal(true);
    });

    it('works while service spending is off, and only a new assign renews the assignee', async () => {
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      const t = await h.termsFor(accountId, buyer.address);
      await h.assignAs(t, buyer);
      const a = await f.CSS.getAssignment(accountId, buyer.address);
      expect(a.revokedAt).to.equal(0n);
      expect(a.nonce).to.equal(2n);
      await h.fund(await h.inference(accountId, TRAC));
    });

    it('advanceAssignmentNonce is owner only, keeps the assignments, and terms signed at the old nonce then fail', async () => {
      const t = await h.termsFor(accountId, buyer2.address);
      const sig = await signTerms(buyer2, f.SS, t);
      for (const caller of [buyer, stranger]) {
        await expect(f.SS.connect(caller).advanceAssignmentNonce(accountId))
          .to.be.revertedWithCustomError(f.SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
      await expect(f.SS.connect(owner).advanceAssignmentNonce(accountId))
        .to.emit(f.SS, 'AssignmentNonceAdvanced')
        .withArgs(accountId, 2n);
      await expect(f.SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 2n, 1n);
      expect(await f.CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Caps update
  // -------------------------------------------------------------------------

  describe('caps update', () => {
    let accountId: bigint;
    let terms: Terms;
    const CAPS: Partial<Terms> = { maxCostPerPeriod: 50n * TRAC };

    beforeEach(async () => {
      ({ accountId, terms } = await h.openAccount({ committed: SMALL, caps: CAPS }));
    });

    const capsWith = (overrides: Partial<Caps> = {}): Caps => ({ ...capsOf(terms), ...overrides });
    const update = (caps: Caps, sender: SignerWithAddress = owner, assignee: string = buyer.address) =>
      f.SS.connect(sender).updateAssignmentCaps(accountId, assignee, caps);
    const capsTuple = async () => {
      const a = await f.CSS.getAssignment(accountId, buyer.address);
      return [a.maxCostPerPeriod, a.expiresAt];
    };

    it('is owner only: the assignee and anyone else revert NotAccountOwner', async () => {
      for (const caller of [buyer, stranger, relayer]) {
        await expect(update(capsWith({ maxCostPerPeriod: 45n * TRAC }), caller))
          .to.be.revertedWithCustomError(f.SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
    });

    it('needs a live assignment: NotAssigned and AssignmentRevoked', async () => {
      await expect(update(capsWith(), owner, stranger.address))
        .to.be.revertedWithCustomError(f.SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await expect(update(capsWith({ maxCostPerPeriod: 45n * TRAC })))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
    });

    it('an expired assignment reverts AssignmentExpired, so a later expiry never revives it', async () => {
      await time.increaseTo(terms.expiresAt);
      await expect(update(capsWith({ expiresAt: terms.expiresAt + 30n * DAY })))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);
    });

    it('validates the caps by the rules of assign, and reverts CapsUnchanged for the caps it holds', async () => {
      const now = await h.latest();
      const cases: Array<[Partial<Caps>, string]> = [
        [{ maxCostPerPeriod: 0n }, 'maxCostPerPeriod'],
        [{ expiresAt: now }, 'expiresAt'],
      ];
      for (const [overrides, reason] of cases) {
        await expect(update(capsWith(overrides)), reason)
          .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentTerms')
          .withArgs(reason);
      }
      await expect(update(capsWith()))
        .to.be.revertedWithCustomError(f.SS, 'CapsUnchanged')
        .withArgs(accountId, buyer.address);
      // Either limit is a change, the expiry included.
      await update(capsWith({ expiresAt: terms.expiresAt + 1n }));
      await update(capsWith({ maxCostPerPeriod: 49n * TRAC, expiresAt: terms.expiresAt + 1n }));
    });

    it('keeps the usage, assignedAt, the assignment nonce and the account nonce', async () => {
      await h.fund(await h.inference(accountId, 30n * TRAC));
      await h.fund(await h.inference(accountId, 20n * TRAC, { epoch: await h.epochNext() }));
      await time.increase(epLen);
      await h.fund(await h.inference(accountId, 10n * TRAC, { epoch: await h.epochNext() }));
      const before = await f.CSS.getAssignment(accountId, buyer.address);
      const usage = h.plain(await f.CSS.getUsage(accountId, buyer.address));
      expect(usage).to.deep.equal({ periods: 3n });
      const nonce = await f.CSS.assignmentNonce(accountId);

      const caps = capsWith({ maxCostPerPeriod: 40n * TRAC });
      await update(caps);

      expect(h.plain(await f.CSS.getUsage(accountId, buyer.address))).to.deep.equal(usage);
      const after = await f.CSS.getAssignment(accountId, buyer.address);
      expect([after.assignedAt, after.revokedAt, after.nonce]).to.deep.equal([before.assignedAt, 0n, before.nonce]);
      expect(await f.CSS.assignmentNonce(accountId)).to.equal(nonce);
      expect(await capsTuple()).to.deep.equal(Object.values(caps));
      expect(await f.CSS.assigneeCount(accountId)).to.equal(1n);
    });

    it('applies from the next funding: a raised cap admits what the old cap refused, a lowered cap refuses what it admitted', async () => {
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, 60n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 50n * TRAC, 60n * TRAC);
      await update(capsWith({ maxCostPerPeriod: 80n * TRAC }));
      await h.fund(await h.inference(accountId, 60n * TRAC));

      await update(capsWith({ maxCostPerPeriod: 40n * TRAC }));
      const next = await h.epochNext();
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, 45n * TRAC, { epoch: next })))
        .to.be.revertedWithCustomError(f.SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 40n * TRAC, 45n * TRAC);
      await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: next }));
    });

    it('works while service spending is off, and the new caps hold once it is back on', async () => {
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await update(capsWith({ maxCostPerPeriod: 20n * TRAC }));
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, 25n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 20n * TRAC, 25n * TRAC);
      await h.fund(await h.inference(accountId, 20n * TRAC));
    });

    it('a funded period keeps its record', async () => {
      const { subscriptionId } = await h.fund(await h.inference(accountId, 40n * TRAC));
      const record = h.plain(await f.CSS.getSubscription(subscriptionId));
      await update(capsWith({ maxCostPerPeriod: 10n * TRAC }));
      expect(h.plain(await f.CSS.getSubscription(subscriptionId))).to.deep.equal(record);
    });

    it('CapsUpdated carries the new caps', async () => {
      const caps = capsWith({ maxCostPerPeriod: 30n * TRAC, expiresAt: terms.expiresAt - DAY });
      await expect(update(caps))
        .to.emit(f.SS, 'CapsUpdated')
        .withArgs(accountId, buyer.address, ...Object.values(caps));
    });

    it('terms signed before an update still assign and reset the usage; after advanceAssignmentNonce they fail', async () => {
      const t = await h.termsFor(accountId, buyer.address, { maxCostPerPeriod: 70n * TRAC });
      const sig = await signTerms(buyer, f.SS, t);
      await h.fund(await h.inference(accountId, 30n * TRAC));
      await update(capsWith({ maxCostPerPeriod: 45n * TRAC }));
      expect(await f.CSS.assignmentNonce(accountId)).to.equal(t.nonce);
      await f.SS.connect(owner).assign(t, '0x', sig);
      expect((await f.CSS.getAssignment(accountId, buyer.address)).maxCostPerPeriod).to.equal(70n * TRAC);
      expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);

      const next = await h.termsFor(accountId, buyer.address, { maxCostPerPeriod: 80n * TRAC });
      const nextSig = await signTerms(buyer, f.SS, next);
      await update(capsWith({ maxCostPerPeriod: 35n * TRAC, expiresAt: next.expiresAt }));
      await f.SS.connect(owner).advanceAssignmentNonce(accountId);
      await expect(f.SS.connect(owner).assign(next, '0x', nextSig))
        .to.be.revertedWithCustomError(f.SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, next.nonce + 1n, next.nonce);
    });
  });
});
