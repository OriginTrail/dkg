// Conviction Account service spending (OT-RFC-27) end to end: the allowance a
// subscription shares with publishing through the real KnowledgeAssetsLifecycle,
// on ServiceSubscriptions and ServiceSubscriptionsStorage registered in the Hub, on
// the real account stack, with a staked node to publish to.
//
// The opt-in and the grants are in v10-conviction-service-grants.test.ts,
// and funding in v10-conviction-service-funding.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { eventsOf } from './helpers/account-stack';
import { TRAC, Terms } from './helpers/conviction-service';
import { ServiceHelpers, ServiceStack, deployServiceStack, serviceHelpers } from './helpers/conviction-service-stack';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import { getDefaultKACreator, getDefaultPublishingNode, getDefaultReceivingNodes } from './helpers/setup-helpers';
import { DEFAULT_CHAIN_ID, buildPublishParams, packReservedKaId } from './helpers/v10-ka-helpers';

const MIN_STAKE = ethers.parseEther('50000');
// No discount, so a cost equals its value; the window allowance is 1,000 TRAC.
const SMALL = 12_000n * TRAC + 5n;
// A limit that no test of the spend itself reaches.
const WIDE: Partial<Terms> = { maxCostPerEpoch: 50_000n * TRAC };

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
  let buyer2: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    epLen = await f.Chronos.epochLength();
    lock = await f.Params.publishingConvictionEpochs();
    owner = f.accounts[20];
    buyer = f.accounts[21];
    buyer2 = f.accounts[25];
    h = serviceHelpers({ f, owner, buyer, epLen, lock });
  });

  // -------------------------------------------------------------------------
  // Shared allowance
  // -------------------------------------------------------------------------

  describe('shared allowance', () => {
    const stakeV10 = async (staker: SignerWithAddress, identityId: number, amount: bigint) => {
      await f.Token.mint(staker.address, amount);
      await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), amount);
      await f.StakingNFT.connect(staker).createConviction(identityId, amount, 1);
    };

    const standUpNodes = async () => {
      const publishingNode = getDefaultPublishingNode(f.accounts);
      const receivingNodes = getDefaultReceivingNodes(f.accounts);
      const { identityId: publisherIdentityId } = await createProfile(f.Profile, publishingNode);
      const receiverProfiles = await createProfiles(f.Profile, receivingNodes);
      const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
      await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
      for (let i = 0; i < receivingNodes.length; i++) {
        await stakeV10(receivingNodes[i].operational, receiverProfiles[i].identityId, MIN_STAKE);
      }
      return { receivingNodes, publisherIdentityId, receiverIdentityIds };
    };

    it('publishing and services spend one window allowance, first come first served; a publish that finds it spent pays directly', async () => {
      const nodes = await standUpNodes();
      const agent = getDefaultKACreator(f.accounts);
      const { accountId } = await h.openAccount({ committed: SMALL, limits: WIDE });
      await f.NFT.connect(owner).registerAgent(accountId, agent.address);
      await f.ContextGraphs.connect(agent).createContextGraph([], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash);
      const cgId = await f.ContextGraphStorage.getLatestContextGraphId();
      const B = SMALL / lock;
      let kaNumber = 0;

      const publish = async (tokenAmount: bigint) => {
        kaNumber += 1;
        await f.Token.mint(agent.address, tokenAmount);
        await f.Token.connect(agent).approve(await f.KAL.getAddress(), tokenAmount);
        const p = await buildPublishParams({
          chainId: DEFAULT_CHAIN_ID,
          kav10Address: await f.KAL.getAddress(),
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: agent,
          contextGraphId: cgId,
          merkleRoot: ethers.id(`shared-${kaNumber}`),
          knowledgeAssetsAmount: 1,
          byteSize: 1000,
          epochs: Number(lock),
          tokenAmount,
          isImmutable: false,
          publishOperationId: `shared-op-${kaNumber}`,
          reservedKaId: packReservedKaId(agent.address, kaNumber),
        });
        return (await (await f.KAL.connect(agent).publish(p)).wait())!;
      };

      const p1 = await publish(100n * TRAC);
      expect(await eventsOf(p1, f.PC, 'CostCovered')).to.have.length(1);
      expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(100n * TRAC);

      await h.fund(await h.inference(accountId, 300n * TRAC));
      expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(400n * TRAC);
      const now = await h.epochNow();
      expect(await f.QIS.accountFunding(now)).to.equal(300n * TRAC);

      await publish(200n * TRAC);
      expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(600n * TRAC);

      await h.fund(await h.inference(accountId, B - 600n * TRAC, { epoch: await h.epochNext() }));
      expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(B);
      expect(await f.QIS.accountFunding(now + 1n)).to.equal(B - 600n * TRAC);

      // The window is spent and there is no top-up buffer: the publish falls
      // through to direct spend from the agent's wallet, and a funding is refused.
      const balance = await f.Token.balanceOf(agent.address);
      const p3 = await publish(50n * TRAC);
      expect(await eventsOf(p3, f.PC, 'CostCovered')).to.have.length(0);
      expect(balance + 50n * TRAC - (await f.Token.balanceOf(agent.address))).to.equal(50n * TRAC);
      expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(B);
      await h.addBuyerAs(await h.termsFor(accountId, buyer2.address, WIDE), buyer2);
      await expect(f.SS.connect(buyer2).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'InsufficientAllowance')
        .withArgs(accountId, await f.Chronos.getCurrentEpoch(), TRAC, 0n);
    });
  });
});
