import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  Hub,
  Token,
} from '../../typechain';

/**
 * Unit tests for the ContextGraphs facade — Phase 7 Task 3 rewrite.
 *
 * Scope:
 *   - createContextGraph (new 7-arg signature: hosting nodes + participant agents
 *     + PCA accountId, with msg.sender defaulting on curated policy)
 *   - isAuthorizedPublisher 3-curator-type model (EOA / Safe / PCA) including
 *     the N17 regression: the function must check the `publisher` parameter,
 *     not a recovered node signer
 *   - Governance mutators — ownership / curator gating, auto-rotation on
 *     NFT transfer, bounds enforcement
 *
 * Notes:
 *   - H5 is satisfied by deletion: there is no digest in the facade, no
 *     signature verification to test.
 *   - addBatchToContextGraph and verifyTripleInclusion were removed in
 *     Phase 0b. This test file does not exercise them — compile will fail
 *     if any call site is resurrected.
 *   - The PCA branch exercises a real DKGPublishingConvictionNFT deployed in
 *     the fixture; the Hub-not-registered cross-phase coupling is covered by
 *     a skipped integration test (Phase 8 handles it).
 */
describe('@unit ContextGraphs (facade)', () => {
  let accounts: SignerWithAddress[];
  let Facade: ContextGraphs;
  let Storage: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let HubContract: Hub;
  // Sentinel EOA registered as a Hub contract so tests can reach storage's
  // `onlyContracts`-gated methods (e.g. deactivateContextGraph) without
  // going through the full publish flow.
  let storageOp: SignerWithAddress;

  type Fixture = {
    accounts: SignerWithAddress[];
    Facade: ContextGraphs;
    Storage: ContextGraphStorage;
    NFT: DKGPublishingConvictionNFT;
    TokenContract: Token;
    HubContract: Hub;
  };

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'ContextGraphs',
      'ContextGraphStorage',
      'DKGPublishingConvictionNFT',
      'Token',
    ]);
    const signers = await hre.ethers.getSigners();
    const HubContract = await hre.ethers.getContract<Hub>('Hub');
    const Facade = await hre.ethers.getContract<ContextGraphs>('ContextGraphs');
    const Storage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const TokenContract = await hre.ethers.getContract<Token>('Token');

    // Register a sentinel signer as a Hub contract so `onlyContracts` paths
    // on storage are reachable from tests that need them.
    await HubContract.setContractAddress('TestContextGraphStorageOperator', signers[19].address);

    return { accounts: signers, Facade, Storage, NFT, TokenContract, HubContract };
  }

  beforeEach(async () => {
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    Facade = f.Facade;
    Storage = f.Storage;
    NFT = f.NFT;
    TokenContract = f.TokenContract;
    HubContract = f.HubContract;
    storageOp = accounts[19];
  });

  // -------------------------------------------------------------------------
  // Reusable helpers
  // -------------------------------------------------------------------------
  const hosts = (): bigint[] => [10n, 20n, 30n];
  const noAgents = (): string[] => [];

  /**
   * Curated CG with a simple EOA authority. Mints to accounts[0].
   */
  async function createCuratedCG(
    caller: SignerWithAddress,
    authority: string,
    accountId: bigint = 0n,
  ): Promise<bigint> {
    await Facade.connect(caller).createContextGraph(
      hosts(),
      noAgents(),
      2,            // requiredSignatures
      0,            // metadataBatchId
      0,            // publishPolicy = curated
      authority,
      accountId,
    );
    return Storage.getLatestContextGraphId();
  }

  /**
   * Open-policy CG. Mints to caller.
   */
  async function createOpenCG(caller: SignerWithAddress): Promise<bigint> {
    await Facade.connect(caller).createContextGraph(
      hosts(),
      noAgents(),
      2,
      0,
      1,                        // publishPolicy = open
      ethers.ZeroAddress,
      0,
    );
    return Storage.getLatestContextGraphId();
  }

  /**
   * Set up a PCA account on DKGPublishingConvictionNFT and return its
   * accountId. `funder` must have sufficient TRAC balance (deployer = accounts[0]
   * gets the initial supply from the Token deploy script).
   */
  async function createPCAAccount(funder: SignerWithAddress, amountEth: string = '60000'): Promise<bigint> {
    const amount = ethers.parseEther(amountEth);
    await TokenContract.connect(funder).approve(await NFT.getAddress(), amount);
    const tx = await NFT.connect(funder).createAccount(amount);
    await tx.wait();
    // NFT tokenIds mirror accountIds (both start at 1).
    const balance = await NFT.balanceOf(funder.address);
    return NFT.tokenOfOwnerByIndex(funder.address, balance - 1n);
  }

  // =========================================================================
  // createContextGraph
  // =========================================================================
  describe('createContextGraph', () => {
    it('mints an ERC-721 to msg.sender on a happy curated call', async () => {
      const authority = accounts[5].address;
      const caller = accounts[0];

      await expect(
        Facade.connect(caller).createContextGraph(
          hosts(), noAgents(), 2, 0, 0, authority, 0,
        ),
      )
        .to.emit(Storage, 'ContextGraphCreated');

      expect(await Storage.ownerOf(1)).to.equal(caller.address);
      expect(await Storage.balanceOf(caller.address)).to.equal(1);
    });

    it('returns the new contextGraphId from the facade', async () => {
      const authority = accounts[5].address;
      const cgId = await Facade
        .connect(accounts[0])
        .createContextGraph.staticCall(hosts(), noAgents(), 2, 0, 0, authority, 0);
      expect(cgId).to.equal(1);
    });

    it('writes all fields into storage correctly', async () => {
      // Set up a real PCA account so the coherence check
      // (authority == ownerOf(accountId)) passes. accounts[0] has the
      // initial TRAC supply and becomes the NFT owner.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      const authority = accounts[0].address;
      const agents = [accounts[3].address, accounts[4].address];
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), agents, 2, 42, 0, authority, pcaAccountId,
      );

      // pcaAccountId is 1 (first NFT mint) and the PCA CG takes token id 1
      // as well (first CG mint). The two ERC-721 registries are independent,
      // so both can reuse id 1.
      const cgId = 1n;
      const cg = await Storage.getContextGraph(cgId);
      expect(cg.owner_).to.equal(accounts[0].address);
      expect(cg.hostingNodes).to.deep.equal(hosts());
      expect(cg.participantAgents).to.deep.equal(agents);
      expect(cg.requiredSignatures).to.equal(2);
      expect(cg.metadataBatchId).to.equal(42);
      expect(cg.active).to.be.true;
      expect(cg.publishPolicy).to.equal(0);
      expect(cg.publishAuthority).to.equal(authority);
      expect(cg.publishAuthorityAccountId).to.equal(pcaAccountId);
    });

    it('defaults authority to msg.sender when curated + zero authority passed', async () => {
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 0, ethers.ZeroAddress, 0,
      );
      const policy = await Storage.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(accounts[0].address);
    });

    it('does NOT default authority for open policy (must stay zero)', async () => {
      // Open + zero authority + zero accountId is valid. The defaulting
      // branch is curated-only.
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 0,
      );
      const policy = await Storage.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(1);
      expect(policy.publishAuthority).to.equal(ethers.ZeroAddress);
    });

    it('assigns incrementing contextGraphIds across calls', async () => {
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 0,
      );
      await Facade.connect(accounts[1]).createContextGraph(
        hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 0,
      );
      expect(await Storage.getLatestContextGraphId()).to.equal(2);
      expect(await Storage.ownerOf(1)).to.equal(accounts[0].address);
      expect(await Storage.ownerOf(2)).to.equal(accounts[1].address);
    });

    // --- Validation (storage-level reverts bubble through the facade) ---
    it('reverts on empty hosting nodes', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [], noAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on zero hosting node id', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [0n, 10n], noAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on unsorted hosting nodes', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [30n, 10n, 20n], noAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on duplicate hosting nodes', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [10n, 10n, 20n], noAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when hosting nodes exceed MAX_HOSTING_NODES', async () => {
      const nodes = Array.from({ length: 65 }, (_, i) => BigInt(i + 1));
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          nodes, noAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('accepts empty participantAgents (ALLOWED by design)', async () => {
      // Empty allow-list is explicitly supported: ContextGraphStorage does
      // not enforce a non-empty participantAgents list.
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), [], 2, 0, 0, accounts[5].address, 0,
      );
      expect(await Storage.getParticipantAgents(1)).to.deep.equal([]);
    });

    it('reverts on duplicate participant agent', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(),
          [accounts[3].address, accounts[3].address],
          1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'AgentParticipantAlreadyExists');
    });

    it('reverts on zero participant agent address', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(),
          [accounts[3].address, ethers.ZeroAddress],
          1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when participant agents exceed MAX_PARTICIPANT_AGENTS', async () => {
      const agents = Array.from({ length: 257 }, (_, i) =>
        ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')),
      );
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [10n], agents, 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when requiredSignatures > hostingNodes.length', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          [10n, 20n], noAgents(), 3, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when requiredSignatures == 0', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 0, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on invalid publishPolicy (>1)', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 2, accounts[5].address, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('curated + accountId != 0 (PCA) with coherent authority is valid', async () => {
      // PCA curator type: the authority MUST equal ownerOf(accountId) in
      // the NFT (see _validatePCACoherence — closes a silent-broadening
      // vector). Set up a real PCA account with accounts[0] as the owner.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 0, accounts[0].address, pcaAccountId,
      );
      const cgId = 1n;
      const policy = await Storage.getPublishPolicy(cgId);
      expect(policy.publishAuthority).to.equal(accounts[0].address);
      expect(await Storage.getPublishAuthorityAccountId(cgId)).to.equal(pcaAccountId);
    });

    it('curated + accountId == 0 (EOA/Safe) with non-zero authority is valid', async () => {
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 0, accounts[5].address, 0,
      );
      expect(await Storage.getPublishAuthorityAccountId(1)).to.equal(0);
    });

    // Strict-reject invariants on open policy
    it('reverts on open policy with non-zero publishAuthority', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 1, accounts[5].address, 0,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on open policy with non-zero publishAuthorityAccountId', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 99,
        ),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });
  });

  // =========================================================================
  // PCA coherence validation (Codex followup — MEDIUM)
  // =========================================================================
  //
  // Validates the facade-level (publishAuthority, publishAuthorityAccountId)
  // coherence gate that closes the "silent broadening" authorization vector
  // where a mismatched pair would stack EOA + PCA curators on the same CG.
  //
  // The gate fires on every write path that touches PCA config: create,
  // updatePublishPolicy, updatePublishAuthority.
  describe('PCA coherence validation', () => {
    it('create: happy path — authority matches ownerOf(accountId)', async () => {
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 0, accounts[0].address, pcaAccountId,
        ),
      ).to.emit(Storage, 'ContextGraphCreated');
    });

    it('create: reverts with PCAAuthorityMismatch when authority is not the NFT owner', async () => {
      // accounts[0] owns the PCA NFT at pcaAccountId. accounts[5] is the
      // claimed authority but does NOT own the NFT. Mismatched pair must
      // be rejected.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 0, accounts[5].address, pcaAccountId,
        ),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAuthorityMismatch')
        .withArgs(pcaAccountId, accounts[5].address, accounts[0].address);
    });

    it('create: reverts with PCAAccountDoesNotExist on unminted accountId', async () => {
      // accountId 999 has never been minted — ownerOf(999) reverts with
      // OZ ERC721NonexistentToken, which the facade catches and rethrows
      // as PCAAccountDoesNotExist.
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 0, accounts[0].address, 999,
        ),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAccountDoesNotExist')
        .withArgs(999);
    });

    it('create: accountId == 0 skips the coherence check (non-PCA EOA)', async () => {
      // Any authority, accountId=0: coherence is skipped, storage's
      // EOA/Safe curator path stores the authority verbatim.
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 0, accounts[5].address, 0,
        ),
      ).to.emit(Storage, 'ContextGraphCreated');
    });

    it('create: open policy with accountId 0 still works (unaffected by gate)', async () => {
      await expect(
        Facade.connect(accounts[0]).createContextGraph(
          hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.emit(Storage, 'ContextGraphCreated');
    });

    it('updatePublishPolicy: reverts with PCAAuthorityMismatch on mismatched pair', async () => {
      await createOpenCG(accounts[0]);
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      // CG owner is accounts[0]. Try to switch to PCA with the wrong
      // authority (accounts[5] does not own the NFT).
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[5].address, pcaAccountId),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAuthorityMismatch')
        .withArgs(pcaAccountId, accounts[5].address, accounts[0].address);
    });

    it('updatePublishPolicy: reverts with PCAAccountDoesNotExist on unminted accountId', async () => {
      await createOpenCG(accounts[0]);
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address, 999),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAccountDoesNotExist')
        .withArgs(999);
    });

    it('updatePublishAuthority: reverts with PCAAuthorityMismatch on mismatched pair', async () => {
      // Start with an EOA curated CG; try to rotate to a PCA pair where
      // the new authority does not own the NFT.
      await createCuratedCG(accounts[0], accounts[5].address);
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await expect(
        Facade.connect(accounts[0]).updatePublishAuthority(1, accounts[5].address, pcaAccountId),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAuthorityMismatch')
        .withArgs(pcaAccountId, accounts[5].address, accounts[0].address);
    });

    it('updatePublishAuthority: reverts with PCAAccountDoesNotExist on unminted accountId', async () => {
      await createCuratedCG(accounts[0], accounts[5].address);
      await expect(
        Facade.connect(accounts[0]).updatePublishAuthority(1, accounts[0].address, 999),
      )
        .to.be.revertedWithCustomError(Facade, 'PCAAccountDoesNotExist')
        .withArgs(999);
    });

    it('updatePublishAuthority: accountId=0 skip still allows EOA rotation', async () => {
      // Regression: make sure the gate doesn't false-trip on plain EOA
      // rotations (accountId == 0 short-circuits before any Hub lookup).
      await createCuratedCG(accounts[0], accounts[5].address);
      await expect(
        Facade.connect(accounts[0]).updatePublishAuthority(1, accounts[6].address, 0),
      )
        .to.emit(Storage, 'PublishAuthorityUpdated')
        .withArgs(1, accounts[6].address, 0);
    });
  });

  // =========================================================================
  // isAuthorizedPublisher — 3-curator-type core security tests
  // =========================================================================
  describe('isAuthorizedPublisher', () => {
    // ------------------------ Bounds & liveness ------------------------
    describe('bounds and liveness', () => {
      it('returns false for cgId == 0', async () => {
        expect(await Facade.isAuthorizedPublisher(0, accounts[0].address)).to.be.false;
      });

      it('returns false for cgId > latest', async () => {
        await createOpenCG(accounts[0]);
        expect(await Facade.isAuthorizedPublisher(999, accounts[0].address)).to.be.false;
      });

      it('returns false when the CG is deactivated, regardless of publisher', async () => {
        const cgId = await createOpenCG(accounts[0]);
        // Deactivate via the storage operator (sentinel Hub contract).
        await Storage.connect(storageOp).deactivateContextGraph(cgId);
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[1].address)).to.be.false;
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[5].address)).to.be.false;
      });
    });

    // ------------------------ Open CG ------------------------
    describe('open CG', () => {
      it('authorizes any non-zero principal', async () => {
        const cgId = await createOpenCG(accounts[0]);
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[1].address)).to.be.true;
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[9].address)).to.be.true;
      });

      it('rejects the zero address', async () => {
        const cgId = await createOpenCG(accounts[0]);
        expect(await Facade.isAuthorizedPublisher(cgId, ethers.ZeroAddress)).to.be.false;
      });
    });

    // ------------------------ Curated EOA ------------------------
    describe('curated EOA curator type', () => {
      let cgId: bigint;
      let authority: SignerWithAddress;

      beforeEach(async () => {
        authority = accounts[5];
        cgId = await createCuratedCG(accounts[0], authority.address);
      });

      it('authorizes the exact authority address', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, authority.address)).to.be.true;
      });

      it('rejects any other address', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[6].address)).to.be.false;
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[9].address)).to.be.false;
      });

      it('rejects the zero address', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, ethers.ZeroAddress)).to.be.false;
      });
    });

    // ------------------------ Curated Safe (simulated) ------------------------
    describe('curated Safe multisig curator type', () => {
      it('authorizes the Safe address (address equality)', async () => {
        // A Gnosis Safe executing a tx arrives at `isAuthorizedPublisher`
        // with `publisher == safeAddress`. Address equality transparently
        // covers the Safe case — no ERC-1271 required at this layer.
        //
        // Simulate: use an arbitrary address as the "Safe" authority. The
        // contract is address-equality based, so this is representative.
        const safeAddr = accounts[7].address;
        const cgId = await createCuratedCG(accounts[0], safeAddr);
        expect(await Facade.isAuthorizedPublisher(cgId, safeAddr)).to.be.true;
      });

      it('rejects non-Safe callers even when the Safe is the authority', async () => {
        const safeAddr = accounts[7].address;
        const cgId = await createCuratedCG(accounts[0], safeAddr);
        expect(await Facade.isAuthorizedPublisher(cgId, accounts[8].address)).to.be.false;
      });
    });

    // ------------------------ Curated PCA ------------------------
    describe('curated PCA curator type', () => {
      let pcaOwner: SignerWithAddress;
      let agent: SignerWithAddress;
      let unrelated: SignerWithAddress;
      let pcaAccountId: bigint;
      let cgId: bigint;

      beforeEach(async () => {
        pcaOwner = accounts[0];        // deployer has TRAC
        agent = accounts[3];
        unrelated = accounts[4];

        pcaAccountId = await createPCAAccount(pcaOwner, '60000');
        await NFT.connect(pcaOwner).registerAgent(pcaAccountId, agent.address);

        // The CG is minted to a separate wallet (accounts[6]) so the
        // EOA/Safe branch never trivially matches the PCA owner. The
        // authority is set to `pcaOwner.address` (the PCA account-owner
        // marker per decision #22).
        cgId = await createCuratedCG(accounts[6], pcaOwner.address, pcaAccountId);
      });

      it('authorizes the PCA account owner via live ownerOf resolve', async () => {
        // In PCA mode the stored `publishAuthority` snapshot is IGNORED at
        // read time — the facade live-resolves `ownerOf(accountId)` on the
        // DKGPublishingConvictionNFT instead. Since `pcaOwner` still holds
        // the NFT in this fixture, live-resolve returns `pcaOwner.address`
        // and the check passes. See the `PCA transfer auth drift`
        // describe block for the post-transfer behavior.
        expect(await Facade.isAuthorizedPublisher(cgId, pcaOwner.address)).to.be.true;
      });

      it('authorizes a registered agent of that account via the PCA branch', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, agent.address)).to.be.true;
      });

      it('rejects an unregistered address', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, unrelated.address)).to.be.false;
      });

      it('rejects an agent registered under a DIFFERENT account', async () => {
        // Fund a second owner, create a second PCA, register a different
        // agent under it, and check the first CG still rejects it.
        const otherOwner = accounts[8];
        // Transfer some TRAC to otherOwner so they can createAccount.
        const amount = ethers.parseEther('60000');
        await TokenContract.connect(accounts[0]).transfer(otherOwner.address, amount);
        const otherAccountId = await createPCAAccount(otherOwner, '60000');
        const otherAgent = accounts[9];
        await NFT.connect(otherOwner).registerAgent(otherAccountId, otherAgent.address);

        // otherAgent is authorized for otherAccountId, NOT for pcaAccountId.
        expect(await Facade.isAuthorizedPublisher(cgId, otherAgent.address)).to.be.false;
      });

      it('rejects the zero address', async () => {
        expect(await Facade.isAuthorizedPublisher(cgId, ethers.ZeroAddress)).to.be.false;
      });

      it('N17 regression: checks the `publisher` parameter, not a recovered signer', async () => {
        // If the function were accidentally checking `msg.sender` or some
        // other recovered wallet, the outcome would not depend on the
        // `publisher` argument. Flipping the argument must flip the result.
        const legit = agent.address;
        const attacker = unrelated.address;
        expect(await Facade.isAuthorizedPublisher(cgId, legit)).to.be.true;
        expect(await Facade.isAuthorizedPublisher(cgId, attacker)).to.be.false;
      });

      it('rejects when CG has authority but accountId is zero and publisher is not the authority', async () => {
        // Curated EOA CG (accountId=0) must not fall through to the PCA
        // branch on a registered agent — the agent is not the authority
        // and there is no PCA linkage.
        const eoaOnlyCg = await createCuratedCG(accounts[1], accounts[5].address, 0n);
        expect(await Facade.isAuthorizedPublisher(eoaOnlyCg, agent.address)).to.be.false;
      });
    });

    // ------------------------ Cross-phase coupling (Phase 8) ------------------------
    // eslint-disable-next-line mocha/no-skipped-tests
    it.skip('gracefully degrades when DKGPublishingConvictionNFT is NOT registered in Hub (Phase 8 integration test)', async () => {
      // This test would require deregistering the NFT from the Hub mid-test
      // and verifying `isAuthorizedPublisher` returns false on the PCA
      // branch via the try/catch gracefulness path. Hub's set APIs do not
      // expose a clean deregistration primitive, and Phase 8 will cover
      // this via an integration test that exercises the full deploy flow
      // with Phase 6 omitted. See audit note on ContextGraphs.sol:250-259.
    });
  });

  // =========================================================================
  // PCA transfer auth drift (Codex HIGH regression)
  // =========================================================================
  //
  // Regression coverage for the Codex HIGH finding: in PCA curator mode the
  // stored `publishAuthority` is a CREATE-TIME snapshot and goes STALE the
  // moment the PCA NFT transfers. Before the fix, `isAuthorizedPublisher`
  // ran an unconditional `publisher == storedAuthority` match BEFORE the PCA
  // branch, so the old PCA owner (Alice) retained publishing authority after
  // transferring her PCA to Bob, and Bob was NOT recognized unless he self-
  // registered as an agent. The same stale snapshot also leaked through the
  // `onlyContextGraphOwnerOrAuthority` modifier for governance mutators.
  //
  // Fix: both read paths (`isAuthorizedPublisher` and `_isOwnerOrAuthority`)
  // now IGNORE the stored snapshot in PCA mode and live-resolve the current
  // NFT owner via `IDKGPublishingConvictionNFT.ownerOf(accountId)`.
  //
  // Each test here documents the regression it blocks. Transferring the PCA
  // NFT exercises the NFT contract's `_update` hook that clears agent
  // mappings, so agent-based authorization paths also update in lockstep.
  describe('PCA transfer auth drift', () => {
    let alice: SignerWithAddress;        // original PCA owner + initial authority
    let bob: SignerWithAddress;          // new PCA owner after transfer
    let carol: SignerWithAddress;        // agent registered under Alice's PCA
    let dave: SignerWithAddress;         // agent Bob registers post-transfer
    let stranger: SignerWithAddress;     // wholly unrelated wallet
    let cgHolder: SignerWithAddress;     // holds the CG NFT (independent of PCA owner)
    let pcaAccountId: bigint;
    let cgId: bigint;

    beforeEach(async () => {
      // accounts[0] is the deployer and has the full TRAC supply. Pick a
      // clean set of signers for the drift fixture — none of them (other
      // than the funder) holds a PCA at this point.
      alice = accounts[0];             // deployer; funds Bob and holds the initial PCA
      bob = accounts[5];
      carol = accounts[6];
      dave = accounts[7];
      stranger = accounts[9];
      cgHolder = accounts[0];          // simplest: Alice also holds the CG NFT

      // Mint a PCA for Alice.
      pcaAccountId = await createPCAAccount(alice, '60000');

      // Create a curated CG in PCA mode. cgHolder == alice here so the
      // transfer flow doesn't also need to move the CG token; we're
      // isolating the PCA drift specifically.
      cgId = await createCuratedCG(cgHolder, alice.address, pcaAccountId);
    });

    async function transferPCA(from: SignerWithAddress, to: SignerWithAddress) {
      // Standard ERC-721 transfer. DKGPublishingConvictionNFT inherits
      // from ERC721Enumerable, so `transferFrom` is available. The
      // contract's `_update` hook clears `_registeredAgents` and
      // `agentToAccountId` for pre-existing agents of this account.
      await NFT.connect(from).transferFrom(from.address, to.address, pcaAccountId);
    }

    // -------------------------------------------------------------------------
    // isAuthorizedPublisher
    // -------------------------------------------------------------------------

    it('old PCA owner (Alice) loses publish authority after transferring the PCA', async () => {
      // Pre-transfer: Alice is the PCA owner, so live-resolve returns her.
      expect(await Facade.isAuthorizedPublisher(cgId, alice.address)).to.be.true;

      // Transfer. Post-transfer: Alice no longer owns the PCA NFT, so
      // live-resolve returns Bob instead. Alice is not authorized.
      // REGRESSION: before the fix, the stored authority snapshot (= Alice)
      // passed the unconditional direct-equality check and returned true.
      await transferPCA(alice, bob);

      expect(await Facade.isAuthorizedPublisher(cgId, alice.address)).to.be.false;
    });

    it('new PCA owner (Bob) gains publish authority after transfer', async () => {
      // Pre-transfer: Bob is not the PCA owner, not an agent — no authority.
      expect(await Facade.isAuthorizedPublisher(cgId, bob.address)).to.be.false;

      await transferPCA(alice, bob);

      // Post-transfer: live-resolve returns Bob, so he is authorized even
      // though the STORED authority snapshot still reads Alice. REGRESSION:
      // before the fix, only the stored snapshot was consulted and Bob
      // was not recognized until he self-registered as an agent.
      expect(await Facade.isAuthorizedPublisher(cgId, bob.address)).to.be.true;
    });

    it('stranger is not authorized before or after PCA transfer', async () => {
      expect(await Facade.isAuthorizedPublisher(cgId, stranger.address)).to.be.false;

      await transferPCA(alice, bob);

      expect(await Facade.isAuthorizedPublisher(cgId, stranger.address)).to.be.false;
    });

    it('agents cleared on PCA transfer lose publish authority in lockstep', async () => {
      // Register Carol as an agent under Alice's PCA before the transfer.
      await NFT.connect(alice).registerAgent(pcaAccountId, carol.address);

      // Pre-transfer: Carol is a registered agent of pcaAccountId, so the
      // PCA branch authorizes her.
      expect(await Facade.isAuthorizedPublisher(cgId, carol.address)).to.be.true;

      // Transfer. The NFT contract's `_update` hook clears the agent
      // registrations for this token id (see DKGPublishingConvictionNFT.sol
      // _update branch), so `agentToAccountId[carol] == 0` post-transfer.
      await transferPCA(alice, bob);

      // Post-transfer: Carol's agent mapping was cleared, so she is no
      // longer authorized. Defense-in-depth: the facade's PCA branch
      // would ALSO reject her (live owner is Bob, not Carol), but this
      // test exercises the agent-clearing path specifically.
      expect(await Facade.isAuthorizedPublisher(cgId, carol.address)).to.be.false;
    });

    it('new PCA owner can register fresh agents post-transfer and they become authorized', async () => {
      // Start from the cleared-state fixture: register Carol, transfer,
      // confirm Carol was cleared.
      await NFT.connect(alice).registerAgent(pcaAccountId, carol.address);
      await transferPCA(alice, bob);
      expect(await Facade.isAuthorizedPublisher(cgId, carol.address)).to.be.false;

      // Bob is now the PCA owner; he registers Dave as a fresh agent.
      await NFT.connect(bob).registerAgent(pcaAccountId, dave.address);

      // Dave authorizes via the PCA-agent branch on live lookup.
      expect(await Facade.isAuthorizedPublisher(cgId, dave.address)).to.be.true;
      // Sanity: Bob himself is still authorized (live owner match).
      expect(await Facade.isAuthorizedPublisher(cgId, bob.address)).to.be.true;
    });

    // -------------------------------------------------------------------------
    // onlyContextGraphOwnerOrAuthority governance modifier
    // -------------------------------------------------------------------------

    it('old PCA owner cannot mutate participant-agent allow-list after transfer', async () => {
      // Pre-transfer: Alice is the PCA owner, so the modifier allows her
      // via the _isOwnerOrAuthority live-resolve branch. (She's ALSO the
      // CG token holder in this fixture, which would let her through
      // independently — to isolate the PCA-branch behavior we assert on
      // the post-transfer-as-stranger case below.)
      const newAgent1 = ethers.getAddress('0x' + 'ab'.repeat(20));
      await Facade.connect(alice).addParticipantAgent(cgId, newAgent1); // succeeds pre-transfer

      // Transfer PCA AND CG ownership to Bob so Alice has NO remaining
      // path into the modifier (neither CG owner nor PCA owner).
      await Storage.connect(alice).transferFrom(alice.address, bob.address, cgId);
      await transferPCA(alice, bob);

      // Post-transfer: Alice is neither the CG owner (Bob) nor the live
      // PCA owner (Bob) — the modifier must reject her. REGRESSION:
      // before the fix, the modifier read the STORED authority snapshot
      // (= Alice) and approved her, letting the old PCA owner mutate
      // governance on a PCA she no longer controlled.
      const newAgent2 = ethers.getAddress('0x' + 'cd'.repeat(20));
      await expect(
        Facade.connect(alice).addParticipantAgent(cgId, newAgent2),
      )
        .to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority')
        .withArgs(cgId, alice.address);
    });

    it('new PCA owner CAN mutate participant-agent allow-list after transfer', async () => {
      // Rotate both CG and PCA ownership to Bob.
      await Storage.connect(alice).transferFrom(alice.address, bob.address, cgId);
      await transferPCA(alice, bob);

      // Bob is now the CG NFT holder AND the live PCA owner. Either path
      // alone would admit him through the modifier; this test asserts the
      // aggregate effect: he can mutate the allow-list.
      const newAgent = ethers.getAddress('0x' + 'ef'.repeat(20));
      await expect(
        Facade.connect(bob).addParticipantAgent(cgId, newAgent),
      ).to.emit(Storage, 'AgentParticipantAdded').withArgs(cgId, newAgent);
      expect(await Storage.isParticipantAgent(cgId, newAgent)).to.be.true;
    });

    it('PCA registered agents are NOT granted governance rights (publishing only)', async () => {
      // Register Carol as an agent under Alice's PCA. Agents can publish
      // on behalf of the PCA, but they MUST NOT be able to mutate the
      // governance allow-list — that's owner-only.
      await NFT.connect(alice).registerAgent(pcaAccountId, carol.address);

      // Sanity: Carol IS authorized for publishing.
      expect(await Facade.isAuthorizedPublisher(cgId, carol.address)).to.be.true;

      // But the governance modifier rejects her — she's neither the CG
      // token holder (Alice in this fixture) nor the live PCA owner.
      // The _isOwnerOrAuthority helper explicitly only checks ownerOf(),
      // not the agent mapping, to enforce this separation.
      const someAgent = ethers.getAddress('0x' + '11'.repeat(20));
      await expect(
        Facade.connect(carol).addParticipantAgent(cgId, someAgent),
      )
        .to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority')
        .withArgs(cgId, carol.address);
    });

    it('CG token holder retains governance rights independent of PCA transfer', async () => {
      // Fixture variant: Charlie holds the CG NFT; Alice holds the PCA.
      // Transferring the PCA away from Alice must NOT affect Charlie's
      // owner-path governance authority.
      const charlie = accounts[8];

      // Set up a second PCA + CG pair so the beforeEach fixture state
      // doesn't interfere. Charlie gets the CG token; Alice (deployer)
      // still has TRAC, so we can mint a second PCA for her.
      const pcaId2 = await createPCAAccount(alice, '60000');
      const cgId2 = await createCuratedCG(charlie, alice.address, pcaId2);

      // Pre-transfer: Charlie can add a participant agent via the
      // owner-path; Alice can via the live-resolve PCA path.
      const agent1 = ethers.getAddress('0x' + '22'.repeat(20));
      await Facade.connect(charlie).addParticipantAgent(cgId2, agent1);
      expect(await Storage.isParticipantAgent(cgId2, agent1)).to.be.true;

      // Transfer Alice's PCA to Bob. Charlie's CG token is untouched.
      await NFT.connect(alice).transferFrom(alice.address, bob.address, pcaId2);

      // Post-transfer: Charlie is still the CG token holder, so the
      // owner branch of `_isOwnerOrAuthority` admits him unchanged.
      // (REGRESSION insurance: the fix must not accidentally gate the
      // owner path on PCA liveness.)
      const agent2 = ethers.getAddress('0x' + '33'.repeat(20));
      await expect(
        Facade.connect(charlie).addParticipantAgent(cgId2, agent2),
      ).to.emit(Storage, 'AgentParticipantAdded').withArgs(cgId2, agent2);
      expect(await Storage.isParticipantAgent(cgId2, agent2)).to.be.true;
    });
  });

  // =========================================================================
  // Governance: updatePublishPolicy
  // =========================================================================
  describe('updatePublishPolicy', () => {
    beforeEach(async () => {
      await createOpenCG(accounts[0]);
    });

    it('owner can switch open -> curated with authority', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[5].address, 0),
      ).to.emit(Storage, 'PublishPolicyUpdated');
      const policy = await Storage.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(accounts[5].address);
    });

    it('owner can switch open -> curated with PCA accountId', async () => {
      // PCA coherence requires authority == ownerOf(accountId). Set up
      // a real PCA account owned by accounts[0] (the NFT owner) and use
      // that accountId + address for the new PCA config.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await Facade.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address, pcaAccountId);
      expect(await Storage.getPublishAuthorityAccountId(1)).to.equal(pcaAccountId);
    });

    it('owner can switch curated -> open (clears authority and accountId)', async () => {
      // Intermediate PCA step needs a coherent (authority, accountId) pair.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await Facade.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address, pcaAccountId);
      await Facade.connect(accounts[0]).updatePublishPolicy(1, 1, ethers.ZeroAddress, 0);
      const policy = await Storage.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(1);
      expect(policy.publishAuthority).to.equal(ethers.ZeroAddress);
      expect(await Storage.getPublishAuthorityAccountId(1)).to.equal(0);
    });

    it('non-owner cannot call updatePublishPolicy (NotContextGraphOwner)', async () => {
      await expect(
        Facade.connect(accounts[5]).updatePublishPolicy(1, 0, accounts[5].address, 0),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwner');
    });

    it('reverts on open policy with non-zero authority (strict reject)', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 1, accounts[5].address, 0),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on open policy with non-zero accountId (strict reject)', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 1, ethers.ZeroAddress, 99),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on curated with zero authority', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishPolicy(1, 0, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });
  });

  // =========================================================================
  // Governance: updatePublishAuthority + NFT auto-rotation
  // =========================================================================
  describe('updatePublishAuthority', () => {
    beforeEach(async () => {
      // Start with a curated CG with accounts[5] as authority.
      await createCuratedCG(accounts[0], accounts[5].address);
    });

    it('owner can rotate the authority (EOA -> different EOA)', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishAuthority(1, accounts[6].address, 0),
      ).to.emit(Storage, 'PublishAuthorityUpdated')
        .withArgs(1, accounts[6].address, 0);
      expect((await Storage.getPublishPolicy(1)).publishAuthority).to.equal(accounts[6].address);
    });

    it('owner can switch EOA -> PCA via updatePublishAuthority', async () => {
      // PCA coherence requires authority == ownerOf(accountId). Set up
      // a real PCA owned by accounts[6] (the new rotated authority) so
      // the facade's coherence gate accepts the pair.
      const amount = ethers.parseEther('60000');
      await TokenContract.connect(accounts[0]).transfer(accounts[6].address, amount);
      const pcaAccountId = await createPCAAccount(accounts[6], '60000');
      await Facade.connect(accounts[0]).updatePublishAuthority(1, accounts[6].address, pcaAccountId);
      expect(await Storage.getPublishAuthorityAccountId(1)).to.equal(pcaAccountId);
    });

    it('non-owner cannot call updatePublishAuthority', async () => {
      await expect(
        Facade.connect(accounts[5]).updatePublishAuthority(1, accounts[6].address, 0),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwner');
    });

    it('reverts when setting zero authority on a curated CG', async () => {
      await expect(
        Facade.connect(accounts[0]).updatePublishAuthority(1, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('auto-rotates authority on NFT transfer when old owner was authority', async () => {
      // Create a fresh CG where the owner is also the authority (the
      // auto-rotation condition requires `publishAuthority == previousOwner`).
      // PCA coherence requires a real NFT account owned by the authority,
      // so mint one for accounts[0] and use its accountId here.
      const pcaAccountId = await createPCAAccount(accounts[0], '60000');
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 0, accounts[0].address, pcaAccountId,
      );
      const newCgId = await Storage.getLatestContextGraphId();

      // Pre-transfer snapshot.
      expect((await Storage.getPublishPolicy(newCgId)).publishAuthority).to.equal(accounts[0].address);
      expect(await Storage.getPublishAuthorityAccountId(newCgId)).to.equal(pcaAccountId);

      // Transfer the NFT: Storage._update should rotate authority to the
      // new owner and clear the PCA accountId.
      await Storage.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[7].address,
        newCgId,
      );
      const policy = await Storage.getPublishPolicy(newCgId);
      expect(policy.publishAuthority).to.equal(accounts[7].address);
      expect(await Storage.getPublishAuthorityAccountId(newCgId)).to.equal(0);
    });

    it('does NOT auto-rotate when authority is an external address', async () => {
      // CG#1 already has authority = accounts[5] (external). Transferring
      // should leave the authority untouched.
      await Storage.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[7].address,
        1,
      );
      expect((await Storage.getPublishPolicy(1)).publishAuthority).to.equal(accounts[5].address);
    });
  });

  // =========================================================================
  // Governance: setHostingNodes
  // =========================================================================
  describe('setHostingNodes', () => {
    beforeEach(async () => {
      await createOpenCG(accounts[0]);
    });

    it('owner can replace hosting nodes', async () => {
      const newNodes = [5n, 15n, 25n, 35n];
      await expect(
        Facade.connect(accounts[0]).setHostingNodes(1, newNodes),
      ).to.emit(Storage, 'HostingNodesSet').withArgs(1, newNodes);
      expect(await Storage.getHostingNodes(1)).to.deep.equal(newNodes);
    });

    it('reverts for non-owner (NotContextGraphOwner)', async () => {
      await expect(
        Facade.connect(accounts[5]).setHostingNodes(1, [99n]),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwner');
    });

    it('reverts on unsorted nodes', async () => {
      await expect(
        Facade.connect(accounts[0]).setHostingNodes(1, [30n, 10n, 20n]),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts on zero node id', async () => {
      await expect(
        Facade.connect(accounts[0]).setHostingNodes(1, [0n, 10n]),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when new list exceeds MAX_HOSTING_NODES', async () => {
      const nodes = Array.from({ length: 65 }, (_, i) => BigInt(i + 1));
      await expect(
        Facade.connect(accounts[0]).setHostingNodes(1, nodes),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when new size would break quorum (requiredSignatures=2)', async () => {
      // CG was created with requiredSignatures = 2, so shrinking to 1 node
      // is invalid.
      await expect(
        Facade.connect(accounts[0]).setHostingNodes(1, [42n]),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });
  });

  // =========================================================================
  // Governance: addParticipantAgent / removeParticipantAgent
  // =========================================================================
  describe('addParticipantAgent / removeParticipantAgent', () => {
    let authority: SignerWithAddress;
    let agent1: string;
    let agent2: string;
    let agent3: string;

    beforeEach(async () => {
      authority = accounts[5];
      await createCuratedCG(accounts[0], authority.address);
      agent1 = accounts[3].address;
      agent2 = accounts[4].address;
      agent3 = accounts[6].address;
    });

    it('owner can add participant agents', async () => {
      await expect(
        Facade.connect(accounts[0]).addParticipantAgent(1, agent1),
      ).to.emit(Storage, 'AgentParticipantAdded').withArgs(1, agent1);
      expect(await Storage.isParticipantAgent(1, agent1)).to.be.true;
    });

    it('curator (authority) can add participant agents', async () => {
      await Facade.connect(authority).addParticipantAgent(1, agent2);
      expect(await Storage.isParticipantAgent(1, agent2)).to.be.true;
    });

    it('stranger cannot add (NotContextGraphOwnerOrAuthority)', async () => {
      await expect(
        Facade.connect(accounts[9]).addParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority');
    });

    it('reverts on duplicate agent', async () => {
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent1);
      await expect(
        Facade.connect(accounts[0]).addParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(Storage, 'AgentParticipantAlreadyExists');
    });

    it('reverts on zero agent', async () => {
      await expect(
        Facade.connect(accounts[0]).addParticipantAgent(1, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('owner can remove a participant agent', async () => {
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent1);
      await expect(
        Facade.connect(accounts[0]).removeParticipantAgent(1, agent1),
      ).to.emit(Storage, 'AgentParticipantRemoved').withArgs(1, agent1);
      expect(await Storage.isParticipantAgent(1, agent1)).to.be.false;
    });

    it('curator can remove a participant agent', async () => {
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent1);
      await Facade.connect(authority).removeParticipantAgent(1, agent1);
      expect(await Storage.isParticipantAgent(1, agent1)).to.be.false;
    });

    it('stranger cannot remove a participant agent', async () => {
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent1);
      await expect(
        Facade.connect(accounts[9]).removeParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwnerOrAuthority');
    });

    it('remove reverts on nonexistent agent', async () => {
      await expect(
        Facade.connect(accounts[0]).removeParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(Storage, 'AgentParticipantNotFound');
    });

    it('remove preserves insertion order', async () => {
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent1);
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent2);
      await Facade.connect(accounts[0]).addParticipantAgent(1, agent3);
      await Facade.connect(accounts[0]).removeParticipantAgent(1, agent2);
      expect(await Storage.getParticipantAgents(1)).to.deep.equal([agent1, agent3]);
    });
  });

  // =========================================================================
  // Governance: updateQuorum
  // =========================================================================
  describe('updateQuorum', () => {
    beforeEach(async () => {
      // Create CG with 3 hosting nodes, requiredSignatures = 2.
      await Facade.connect(accounts[0]).createContextGraph(
        hosts(), noAgents(), 2, 0, 1, ethers.ZeroAddress, 0,
      );
    });

    it('owner can raise quorum within hosting nodes count', async () => {
      await expect(
        Facade.connect(accounts[0]).updateQuorum(1, 3),
      ).to.emit(Storage, 'QuorumUpdated').withArgs(1, 3);
      expect(await Storage.getContextGraphRequiredSignatures(1)).to.equal(3);
    });

    it('owner can lower quorum', async () => {
      await Facade.connect(accounts[0]).updateQuorum(1, 1);
      expect(await Storage.getContextGraphRequiredSignatures(1)).to.equal(1);
    });

    it('non-owner cannot update quorum', async () => {
      await expect(
        Facade.connect(accounts[5]).updateQuorum(1, 1),
      ).to.be.revertedWithCustomError(Facade, 'NotContextGraphOwner');
    });

    it('reverts when quorum > hostingNodes.length', async () => {
      await expect(
        Facade.connect(accounts[0]).updateQuorum(1, 4),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });

    it('reverts when quorum == 0', async () => {
      await expect(
        Facade.connect(accounts[0]).updateQuorum(1, 0),
      ).to.be.revertedWithCustomError(Storage, 'InvalidContextGraphConfig');
    });
  });

  // =========================================================================
  // registerKnowledgeCollection — Phase 8 entry point (facade wrapper)
  // =========================================================================
  //
  // Validates the thin facade wrapper over ContextGraphStorage.registerKCToContextGraph.
  // The wrapper is `onlyContracts`-gated at the facade layer and forwards to
  // storage, which also has its own `onlyContracts` gate — the ContextGraphs
  // facade itself is registered in Hub, so the forwarding call satisfies
  // storage's gate transparently.
  describe('registerKnowledgeCollection (facade wrapper)', () => {
    beforeEach(async () => {
      await createOpenCG(accounts[0]);
    });

    it('forwards to storage and writes the reverse + forward mappings', async () => {
      // `storageOp` (accounts[19]) is a Hub-registered sentinel, so it
      // passes the facade's `onlyContracts` gate. The facade then calls
      // storage, which also enforces `onlyContracts` — it accepts the
      // facade because ContextGraphs is itself registered in Hub via the
      // deploy script.
      await expect(
        Facade.connect(storageOp).registerKnowledgeCollection(1, 100),
      ).to.emit(Storage, 'KCRegisteredToContextGraph').withArgs(1, 100);

      expect(await Storage.kcToContextGraph(100)).to.equal(1);
      expect(await Storage.getContextGraphKCList(1)).to.deep.equal([100n]);
      expect(await Storage.getContextGraphKCCount(1)).to.equal(1);
    });

    it('reverts when caller is not a Hub contract (facade-level gate)', async () => {
      // A non-Hub EOA hits the facade's own `onlyContracts` gate and never
      // reaches storage. UnauthorizedAccess is raised by the Hub lib used
      // across the facade / storage contracts.
      await expect(
        Facade.connect(accounts[5]).registerKnowledgeCollection(1, 100),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });

    it('surfaces storage-level KCAlreadyRegisteredToContextGraph on double register', async () => {
      await Facade.connect(storageOp).registerKnowledgeCollection(1, 100);
      // Create a second CG and try to register the same kcId there.
      await createOpenCG(accounts[0]);
      await expect(
        Facade.connect(storageOp).registerKnowledgeCollection(2, 100),
      ).to.be.revertedWithCustomError(Storage, 'KCAlreadyRegisteredToContextGraph');
    });

    it('surfaces storage-level ContextGraphNotActive on inactive target', async () => {
      await Storage.connect(storageOp).deactivateContextGraph(1);
      await expect(
        Facade.connect(storageOp).registerKnowledgeCollection(1, 100),
      ).to.be.revertedWithCustomError(Storage, 'ContextGraphNotActive');
    });
  });

  // =========================================================================
  // H5 confirmation + Phase 0b cascade confirmation
  // =========================================================================
  describe('H5 and Phase 0b — removed surface confirmation', () => {
    // H5 is satisfied by deletion — no digest in the facade. There is no
    // signature verification to test, no digest to forge. This describe
    // block exists to document the invariant and verify that the
    // attestation surface is gone.

    it('facade exposes no signature-verification methods', async () => {
      // Query the contract interface fragments — none of the legacy
      // Merkle / attestation / digest entry points must exist.
      const fragments = Facade.interface.fragments;
      const fnNames = new Set(
        fragments
          .filter((f) => f.type === 'function')
          .map((f) => (f as ethers.FunctionFragment).name),
      );

      // H5: no verify / digest / signature entry points.
      expect(fnNames.has('verifyTripleInclusion')).to.be.false;
      expect(fnNames.has('verifyBatchInclusion')).to.be.false;

      // Phase 0b: the old attestation publish paths are gone.
      expect(fnNames.has('addBatchToContextGraph')).to.be.false;
    });
  });
});
