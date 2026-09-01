import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import {
  BaseContract,
  ContractTransactionReceipt,
  LogDescription,
  ethers,
} from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphWaiverStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  Token,
} from '../typechain';

const DEPOSIT = ethers.parseEther('100');
const COMMITTED_TRAC = ethers.parseEther('50000');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Params: ParametersStorage;
  Facade: ContextGraphs;
  CGS: ContextGraphStorage;
  Waiver: ContextGraphWaiverStorage;
  NFT: DKGPublishingConvictionNFT;
  CSS: ConvictionStakingStorage;
};

type WaivedRegistrationScenario = {
  caller: SignerWithAddress;
  selector?: 'coverage' | 'legacy';
  participantAgents?: string[];
  metadataBatchId?: bigint;
  accessPolicy: number;
  publishPolicy: number;
  publishAuthority: string;
  publishAuthorityAccountId: bigint;
  nameHash: string;
  coverageAccountId: bigint;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'ContextGraphWaiverStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
  ]);

  const accounts = await hre.ethers.getSigners();
  const HubContract = await hre.ethers.getContract<Hub>('Hub');
  await HubContract.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub: HubContract,
    Token: await hre.ethers.getContract<Token>('Token'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    CGS: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    Waiver: await hre.ethers.getContract<ContextGraphWaiverStorage>('ContextGraphWaiverStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
  };
}

async function eventsFrom(
  receipt: ContractTransactionReceipt,
  contract: BaseContract,
  eventName: string,
): Promise<LogDescription[]> {
  const address = (await contract.getAddress()).toLowerCase();
  const event = contract.interface.getEvent(eventName);
  if (!event) throw new Error(`Missing ${eventName} event in contract interface`);

  return receipt.logs
    .filter((log) => log.address.toLowerCase() === address && log.topics[0] === event.topicHash)
    .map((log) => contract.interface.parseLog({ topics: log.topics, data: log.data }))
    .filter((parsed): parsed is LogDescription => parsed !== null);
}

describe('@integration OT-RFC-53 — independent PCA registration coverage', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let TokenContract: Token;
  let Params: ParametersStorage;
  let Facade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let Waiver: ContextGraphWaiverStorage;
  let NFT: DKGPublishingConvictionNFT;
  let CSS: ConvictionStakingStorage;

  beforeEach(async () => {
    ({
      accounts,
      Hub: HubContract,
      Token: TokenContract,
      Params,
      Facade,
      CGS,
      Waiver,
      NFT,
      CSS,
    } = await loadFixture(deployFixture));
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(DEPOSIT);
  });

  async function createPca(
    owner: SignerWithAddress,
    amount: bigint = COMMITTED_TRAC,
  ): Promise<bigint> {
    await TokenContract.mint(owner.address, amount);
    await TokenContract.connect(owner).approve(await NFT.getAddress(), amount);
    await NFT.connect(owner).createAccount(amount, 0);
    return NFT.totalSupply();
  }

  async function assertWaivedRegistration(
    input: WaivedRegistrationScenario,
  ): Promise<bigint> {
    const {
      caller,
      selector = 'coverage',
      participantAgents = [],
      metadataBatchId = 0n,
      coverageAccountId,
      accessPolicy,
      publishPolicy,
      publishAuthority,
      publishAuthorityAccountId,
      nameHash,
    } = input;
    const latestBefore = await CGS.getLatestContextGraphId();
    const waivedBefore = await Waiver.waivedCgCount(coverageAccountId);
    const callerBalanceBefore = await TokenContract.balanceOf(caller.address);
    const cssBalanceBefore = await TokenContract.balanceOf(await CSS.getAddress());
    const committedBefore = (await NFT.accounts(coverageAccountId))[0];
    const deposit = await Params.contextGraphRegistrationDeposit();

    const connectedFacade = Facade.connect(caller);
    const createArgs = [
      participantAgents,
      metadataBatchId,
      accessPolicy,
      publishPolicy,
      publishAuthority,
      publishAuthorityAccountId,
      nameHash,
    ] as const;
    const tx = selector === 'legacy'
      ? await connectedFacade.createContextGraph(...createArgs)
      : await connectedFacade.createContextGraphWithPcaCoverage(
        ...createArgs,
        coverageAccountId,
      );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Context Graph registration transaction was not mined');
    const contextGraphId = await CGS.getLatestContextGraphId();
    expect(contextGraphId).to.equal(latestBefore + 1n);

    const createdEvents = await eventsFrom(receipt, CGS, 'ContextGraphCreated');
    const storageWaiverEvents = await eventsFrom(receipt, Waiver, 'RegistrationDepositWaived');
    const facadeWaiverEvents = await eventsFrom(
      receipt,
      Facade,
      'ContextGraphRegistrationDepositWaived',
    );
    expect(createdEvents).to.have.length(1);
    expect(storageWaiverEvents).to.have.length(1);
    expect(facadeWaiverEvents).to.have.length(1);
    expect(await eventsFrom(receipt, Facade, 'ContextGraphRegistrationDeposited')).to.have.length(0);

    const created = createdEvents[0].args;
    expect(created[0]).to.equal(contextGraphId);
    expect(created[1]).to.equal(caller.address);
    expect(created[2]).to.equal(nameHash);
    expect([...created[3]]).to.deep.equal(participantAgents);
    expect(created[4]).to.equal(metadataBatchId);
    expect(created[5]).to.equal(BigInt(accessPolicy));
    expect(created[6]).to.equal(BigInt(publishPolicy));
    expect(created[7]).to.equal(publishAuthority);
    expect(created[8]).to.equal(publishAuthorityAccountId);

    const storageWaiver = storageWaiverEvents[0].args;
    expect(storageWaiver[0]).to.equal(coverageAccountId);
    expect(storageWaiver[1]).to.equal(caller.address);
    expect(storageWaiver[2]).to.equal(waivedBefore + 1n);
    expect(storageWaiver[3]).to.equal(committedBefore / deposit);

    const facadeWaiver = facadeWaiverEvents[0].args;
    expect(facadeWaiver[0]).to.equal(contextGraphId);
    expect(facadeWaiver[1]).to.equal(coverageAccountId);
    expect(facadeWaiver[2]).to.equal(caller.address);

    expect(await Waiver.waivedCgCount(coverageAccountId)).to.equal(waivedBefore + 1n);
    expect(await CGS.getRegistrationEscrow(contextGraphId)).to.equal(0n);
    expect(await CGS.getContextGraphOwner(contextGraphId)).to.equal(caller.address);
    expect(await CGS.getAccessPolicy(contextGraphId)).to.equal(BigInt(accessPolicy));
    const storedPublishPolicy = await CGS.getPublishPolicy(contextGraphId);
    expect(storedPublishPolicy[0]).to.equal(BigInt(publishPolicy));
    expect(storedPublishPolicy[1]).to.equal(publishAuthority);
    expect(await CGS.getPublishAuthorityAccountId(contextGraphId)).to.equal(
      publishAuthorityAccountId,
    );
    const storedGraph = await CGS.getContextGraph(contextGraphId);
    expect([...storedGraph.participantAgents]).to.deep.equal(participantAgents);
    expect(storedGraph.metadataBatchId).to.equal(metadataBatchId);
    expect(await TokenContract.balanceOf(caller.address)).to.equal(callerBalanceBefore);
    expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBalanceBefore);
    expect((await NFT.accounts(coverageAccountId))[0]).to.equal(committedBefore);
    return contextGraphId;
  }

  async function assertPaidRegistration(
    caller: SignerWithAddress,
    coverageAccountId: bigint,
  ): Promise<bigint> {
    const deposit = await Params.contextGraphRegistrationDeposit();
    await TokenContract.mint(caller.address, deposit);
    await TokenContract.connect(caller).approve(await Facade.getAddress(), deposit);
    const callerBalanceBefore = await TokenContract.balanceOf(caller.address);
    const cssBalanceBefore = await TokenContract.balanceOf(await CSS.getAddress());
    const waivedBefore = await Waiver.waivedCgCount(coverageAccountId);
    const latestBefore = await CGS.getLatestContextGraphId();
    const nameHash = ethers.keccak256(
      ethers.toUtf8Bytes(`paid-${caller.address}-${coverageAccountId}-${latestBefore}`),
    );

    const tx = await Facade.connect(caller).createContextGraphWithPcaCoverage(
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
      nameHash,
      coverageAccountId,
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Context Graph paid registration transaction was not mined');
    const contextGraphId = await CGS.getLatestContextGraphId();
    expect(contextGraphId).to.equal(latestBefore + 1n);

    const depositEvents = await eventsFrom(receipt, Facade, 'ContextGraphRegistrationDeposited');
    expect(depositEvents).to.have.length(1);
    expect(depositEvents[0].args[0]).to.equal(contextGraphId);
    expect(depositEvents[0].args[1]).to.equal(caller.address);
    expect(depositEvents[0].args[2]).to.equal(deposit);
    expect(await eventsFrom(receipt, Facade, 'ContextGraphRegistrationDepositWaived')).to.have.length(0);
    expect(await eventsFrom(receipt, Waiver, 'RegistrationDepositWaived')).to.have.length(0);
    expect(await eventsFrom(receipt, CGS, 'ContextGraphCreated')).to.have.length(1);

    expect(await Waiver.waivedCgCount(coverageAccountId)).to.equal(waivedBefore);
    expect(await CGS.getRegistrationEscrow(contextGraphId)).to.equal(deposit);
    expect(await TokenContract.balanceOf(caller.address)).to.equal(callerBalanceBefore - deposit);
    expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBalanceBefore + deposit);
    expect(await CGS.getAccessPolicy(contextGraphId)).to.equal(0n);
    const storedPublishPolicy = await CGS.getPublishPolicy(contextGraphId);
    expect(storedPublishPolicy[0]).to.equal(1n);
    expect(storedPublishPolicy[1]).to.equal(ethers.ZeroAddress);
    expect(await CGS.getPublishAuthorityAccountId(contextGraphId)).to.equal(0n);
    return contextGraphId;
  }

  it('pins version and preserves the legacy selector and PCA-authority waiver behavior', async () => {
    const legacySignature =
      'createContextGraph(address[],uint256,uint8,uint8,address,uint256,bytes32)';
    const coverageSignature =
      'createContextGraphWithPcaCoverage(address[],uint256,uint8,uint8,address,uint256,bytes32,uint256)';
    expect(Facade.interface.getFunction(legacySignature)?.selector).to.equal('0x73e9ea27');
    expect(Facade.interface.getFunction(coverageSignature)?.selector).to.equal('0x7f8cdbe8');
    expect(ethers.id(legacySignature).slice(0, 10)).to.equal('0x73e9ea27');
    expect(ethers.id(coverageSignature).slice(0, 10)).to.equal('0x7f8cdbe8');
    expect(await Facade.version()).to.equal('10.0.5');

    const owner = accounts[1];
    const agent = accounts[2];
    const accountId = await createPca(owner);
    await NFT.connect(owner).registerAgent(accountId, agent.address);
    await assertWaivedRegistration({
      caller: agent,
      selector: 'legacy',
      coverageAccountId: accountId,
      accessPolicy: 0,
      publishPolicy: 0,
      publishAuthority: owner.address,
      publishAuthorityAccountId: accountId,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes('legacy-pca-curated')),
    });
  });

  for (const testCase of [
    { accessPolicy: 0, relation: 'owner' as const },
    { accessPolicy: 1, relation: 'agent' as const },
  ]) {
    it(`waives an open accessPolicy=${testCase.accessPolicy} graph for the PCA ${testCase.relation} without storing authority`, async () => {
      const owner = accounts[1];
      const caller = testCase.relation === 'owner' ? owner : accounts[2];
      const accountId = await createPca(owner);
      if (testCase.relation === 'agent') {
        await NFT.connect(owner).registerAgent(accountId, caller.address);
      }
      const nameHash = ethers.keccak256(
        ethers.toUtf8Bytes(`open-${testCase.accessPolicy}-${testCase.relation}`),
      );
      const useSentinelGraphFields = testCase.accessPolicy === 0;
      const contextGraphId = await assertWaivedRegistration({
        caller,
        coverageAccountId: accountId,
        participantAgents: useSentinelGraphFields ? [accounts[8].address] : [],
        metadataBatchId: useSentinelGraphFields ? 42n : 0n,
        accessPolicy: testCase.accessPolicy,
        publishPolicy: 1,
        publishAuthority: ethers.ZeroAddress,
        publishAuthorityAccountId: 0n,
        nameHash,
      });
      expect(await Facade.isAuthorizedPublisher(contextGraphId, accounts[9].address)).to.equal(true);
    });
  }

  it('keeps EOA curator authority independent from agent-supplied PCA coverage', async () => {
    const coverageOwner = accounts[1];
    const creator = accounts[2];
    const otherCoverageAgent = accounts[3];
    const publishAuthority = accounts[4];
    const accountId = await createPca(coverageOwner);
    await NFT.connect(coverageOwner).registerAgent(accountId, creator.address);
    await NFT.connect(coverageOwner).registerAgent(accountId, otherCoverageAgent.address);
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes('eoa-authority-independent-coverage'));

    const contextGraphId = await assertWaivedRegistration({
      caller: creator,
      coverageAccountId: accountId,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: publishAuthority.address,
      publishAuthorityAccountId: 0n,
      nameHash,
    });

    expect(await Facade.isAuthorizedPublisher(contextGraphId, publishAuthority.address)).to.equal(true);
    for (const unrelatedCoveragePrincipal of [coverageOwner, otherCoverageAgent]) {
      expect(
        await Facade.isAuthorizedPublisher(contextGraphId, unrelatedCoveragePrincipal.address),
      ).to.equal(false);
      await expect(
        Facade.connect(unrelatedCoveragePrincipal).addParticipantAgent(
          contextGraphId,
          accounts[8].address,
        ),
      )
        .to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority')
        .withArgs(contextGraphId, unrelatedCoveragePrincipal.address);
    }
  });

  it('keeps PCA curator authority and coverage accounting on their distinct accounts', async () => {
    const coverageOwner = accounts[1];
    const creator = accounts[2];
    const otherCoverageAgent = accounts[3];
    const authorityOwner = accounts[4];
    const authorityAgent = accounts[5];
    const coverageAccountId = await createPca(coverageOwner);
    const authorityAccountId = await createPca(authorityOwner);
    await NFT.connect(coverageOwner).registerAgent(coverageAccountId, creator.address);
    await NFT.connect(coverageOwner).registerAgent(coverageAccountId, otherCoverageAgent.address);
    await NFT.connect(authorityOwner).registerAgent(authorityAccountId, authorityAgent.address);
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes('pca-authority-independent-coverage'));

    const contextGraphId = await assertWaivedRegistration({
      caller: creator,
      coverageAccountId,
      accessPolicy: 0,
      publishPolicy: 0,
      publishAuthority: authorityOwner.address,
      publishAuthorityAccountId: authorityAccountId,
      nameHash,
    });

    expect(await Waiver.waivedCgCount(authorityAccountId)).to.equal(0n);
    expect(await Facade.isAuthorizedPublisher(contextGraphId, authorityOwner.address)).to.equal(true);
    expect(await Facade.isAuthorizedPublisher(contextGraphId, authorityAgent.address)).to.equal(true);
    for (const unrelatedCoveragePrincipal of [coverageOwner, otherCoverageAgent]) {
      expect(
        await Facade.isAuthorizedPublisher(contextGraphId, unrelatedCoveragePrincipal.address),
      ).to.equal(false);
      await expect(
        Facade.connect(unrelatedCoveragePrincipal).addParticipantAgent(
          contextGraphId,
          accounts[8].address,
        ),
      )
        .to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority')
        .withArgs(contextGraphId, unrelatedCoveragePrincipal.address);
    }
  });

  it('charges the configured deposit for zero-backed and nonexistent coverage IDs', async () => {
    const caller = accounts[1];
    await assertPaidRegistration(caller, 0n);
    await assertPaidRegistration(caller, 999_999n);
  });

  it('charges when the caller is registered to a different PCA than the supplied coverage ID', async () => {
    const ownerA = accounts[1];
    const ownerB = accounts[2];
    const caller = accounts[3];
    const accountA = await createPca(ownerA);
    const accountB = await createPca(ownerB);
    await NFT.connect(ownerB).registerAgent(accountB, caller.address);
    expect(await NFT.agentToAccountId(caller.address)).to.equal(accountB);
    await assertPaidRegistration(caller, accountA);
  });

  it('charges for an under-floor coverage PCA', async () => {
    const caller = accounts[1];
    const accountId = await createPca(caller, ethers.parseEther('10000'));
    await assertPaidRegistration(caller, accountId);
  });

  it('charges for an expired coverage PCA', async () => {
    const caller = accounts[1];
    const accountId = await createPca(caller);
    const expiresAtTimestamp = (await NFT.accounts(accountId))[4];
    await time.increaseTo(Number(expiresAtTimestamp) + 1);
    await assertPaidRegistration(caller, accountId);
  });

  it('charges for a fully swept coverage PCA', async () => {
    const caller = accounts[1];
    const accountId = await createPca(caller);
    const expiresAtTimestamp = (await NFT.accounts(accountId))[4];
    await time.increaseTo(Number(expiresAtTimestamp) + 1);
    await NFT.connect(caller).settle(accountId);
    expect((await NFT.accounts(accountId))[8]).to.equal(true);
    await assertPaidRegistration(caller, accountId);
  });

  it('charges after the coverage PCA quota is exhausted', async () => {
    const deposit = ethers.parseEther('25000');
    await Params.connect(accounts[0]).setContextGraphRegistrationDeposit(deposit);
    const caller = accounts[1];
    const accountId = await createPca(caller);

    for (let index = 0; index < 2; index++) {
      const nameHash = ethers.keccak256(ethers.toUtf8Bytes(`quota-waiver-${index}`));
      await assertWaivedRegistration({
        caller,
        coverageAccountId: accountId,
        accessPolicy: 0,
        publishPolicy: 1,
        publishAuthority: ethers.ZeroAddress,
        publishAuthorityAccountId: 0n,
        nameHash,
      });
    }
    expect(await Waiver.waivedCgCount(accountId)).to.equal(2n);
    await assertPaidRegistration(caller, accountId);
  });

  it('fails closed to a paid registration when waiver storage is unavailable', async () => {
    const caller = accounts[1];
    const accountId = await createPca(caller);
    await HubContract.connect(accounts[0]).removeContractByName('ContextGraphWaiverStorage');
    await assertPaidRegistration(caller, accountId);
  });

  it('rolls back graph creation when failed coverage reaches an unapproved deposit', async () => {
    const coverageOwner = accounts[1];
    const caller = accounts[2];
    const accountId = await createPca(coverageOwner);
    await TokenContract.mint(caller.address, DEPOSIT);
    const latestBefore = await CGS.getLatestContextGraphId();
    const waivedBefore = await Waiver.waivedCgCount(accountId);
    const callerBalanceBefore = await TokenContract.balanceOf(caller.address);
    const cssBalanceBefore = await TokenContract.balanceOf(await CSS.getAddress());

    await expect(
      Facade.connect(caller).createContextGraphWithPcaCoverage(
        [],
        0,
        0,
        1,
        ethers.ZeroAddress,
        0,
        ethers.ZeroHash,
        accountId,
      ),
    )
      .to.be.revertedWithCustomError(Facade, 'TooLowAllowance')
      .withArgs(await TokenContract.getAddress(), 0, DEPOSIT);

    expect(await CGS.getLatestContextGraphId()).to.equal(latestBefore);
    expect(await Waiver.waivedCgCount(accountId)).to.equal(waivedBefore);
    expect(await TokenContract.balanceOf(caller.address)).to.equal(callerBalanceBefore);
    expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBalanceBefore);
  });
});
