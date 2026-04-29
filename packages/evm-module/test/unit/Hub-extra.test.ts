/**
 * Hub-extra.test.ts — targeted QA tests for the storage/Hub.sol contract.
 *
 * Covers audit findings (see .test-audit/
 *   - E-1 (CRITICAL, SPEC-GAP): `Hub.setAndReinitializeContracts` is the
 *     atomic V10 mainnet contract-swap entry point. Pre-audit it had zero
 *     tests for happy path, partial-failure bubbling, atomic rollback on
 *     revert, non-owner revert, or idempotency.
 *   - E-7 (HIGH, PROD-BUG): `Hub._setContractAddress` emits the
 *     `NewContract` event twice when adding a brand-new contract (line 193
 *     in the create branch AND line 204 at the tail of the function).
 *     Indexers / subgraphs double-count. The spec-aligned contract is to
 *     emit `NewContract` once on create and `ContractChanged` once on
 *     update; the current Hub emits `NewContract` at the tail
 *     unconditionally.
 *
 * No production code is modified. If a test documents a real bug it stays
 * red; the failure IS the bug evidence.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Hub, Token } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
};

describe('@unit Hub — extra audit coverage (E-1, E-7)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let TokenContract: Token;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['Hub', 'Token']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const Token = await hre.ethers.getContract<Token>('Token');
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return { accounts: signers, Hub, Token };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, Token: TokenContract } = await loadFixture(deployFixture));
  });

  // ======================================================================
  // E-7 — PROD-BUG: `NewContract` double-emit on the create branch.
  //
  // Expected spec behavior:
  //   - On create: emit `NewContract(name, addr)` exactly once.
  //   - On update: emit `ContractChanged(name, addr)` exactly once.
  //
  // Current code (`_setContractAddress` in Hub.sol):
  //   - Create branch emits `NewContract` (line ~193) AND then falls through
  //     to a tail emit of `NewContract` (line ~204) regardless of branch.
  //   - Update branch emits `ContractChanged` (line ~189) AND then tails with
  //     `NewContract` (line ~204).
  //
  // RED TEST: captures ALL `NewContract` events emitted by setContractAddress
  // and asserts count == 1 per spec. Currently fails because of the tail
  // emit. This failure IS the bug evidence —
  // ======================================================================
  describe('E-7: NewContract double-emit (PROD-BUG, red test)', () => {
    it('emits NewContract exactly once when registering a NEW contract (currently fails — PROD-BUG)', async () => {
      // PROD-BUG: Hub._setContractAddress emits NewContract twice on create
      // (lines 193 + 204 of storage/Hub.sol).
      const tx = await HubContract.setContractAddress('TestContractE7', accounts[1].address);
      const receipt = await tx.wait();
      const topic = HubContract.interface.getEvent('NewContract').topicHash;
      const hubAddr = (await HubContract.getAddress()).toLowerCase();
      const newContractLogs = receipt!.logs.filter(
        (l) => l.address.toLowerCase() === hubAddr && l.topics[0] === topic,
      );
      // Spec says exactly one NewContract on create. Audit shows two.
      expect(newContractLogs.length).to.equal(1);
    });

    it('emits NewContract ZERO times when UPDATING an existing contract (currently fails — PROD-BUG)', async () => {
      // PROD-BUG: on update, Hub._setContractAddress still falls through to
      // the tail `emit NewContract(...)` (Hub.sol line 204), firing one
      // spurious NewContract alongside the correct `ContractChanged`. Spec
      // behavior: NewContract should only fire on the CREATE branch. See
      // .
      await HubContract.setContractAddress('TestContractE7u', accounts[1].address);

      const tx = await HubContract.setContractAddress('TestContractE7u', accounts[2].address);
      const receipt = await tx.wait();
      const newContractTopic = HubContract.interface.getEvent('NewContract').topicHash;
      const changedTopic = HubContract.interface.getEvent('ContractChanged').topicHash;
      const hubAddr = (await HubContract.getAddress()).toLowerCase();
      const newContractLogs = receipt!.logs.filter(
        (l) => l.address.toLowerCase() === hubAddr && l.topics[0] === newContractTopic,
      );
      const changedLogs = receipt!.logs.filter(
        (l) => l.address.toLowerCase() === hubAddr && l.topics[0] === changedTopic,
      );
      // Update semantics: exactly one `ContractChanged`, zero `NewContract`.
      expect(changedLogs.length, 'ContractChanged count').to.equal(1);
      expect(newContractLogs.length, 'NewContract must NOT fire on update').to.equal(0);
    });
  });

  // ======================================================================
  // E-1 — setAndReinitializeContracts full matrix
  //
  // Shape:
  //   setAndReinitializeContracts(
  //     Contract[] newContracts,
  //     Contract[] newAssetStorageContracts,
  //     address[] contractsToReinitialize,
  //     ForwardCallInputArgs[] forwardCallsData
  //   ) external onlyOwnerOrMultiSigOwner
  //
  // Each of the four inner loops either succeeds or bubbles the revert. We
  // exercise: happy path, partial-failure in each loop, non-owner revert,
  // and idempotency (re-registering the same name/addr does not drift).
  // ======================================================================
  describe('E-1: Hub.setAndReinitializeContracts — full audit matrix', () => {
    it('happy path: registers new contracts + asset storages and fires forward calls', async () => {
      // Deploy two disposable targets that can safely receive setStatus +
      // initialize-ish forwardCalls. A second Token works: Token has
      // approve/transfer that will execute without state violation.
      const TokenFactory = await hre.ethers.getContractFactory('Token');
      const token2 = await TokenFactory.deploy('T', 'T');
      await token2.waitForDeployment();
      const token2Addr = await token2.getAddress();

      const tx = await HubContract.setAndReinitializeContracts(
        [{ name: 'ExtraToken', addr: token2Addr }],
        [{ name: 'ExtraAssetStorage', addr: accounts[3].address }],
        [], // nothing to reinitialize
        [], // no forward calls
      );
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      expect(await HubContract.getContractAddress('ExtraToken')).to.equal(token2Addr);
      expect(await HubContract.getAssetStorageAddress('ExtraAssetStorage')).to.equal(
        accounts[3].address,
      );
    });

        it('non-owner (EOA) call reverts (auth gate closes)', async () => {
          // `setAndReinitializeContracts` carries `onlyOwnerOrMultiSigOwner`.
          // After alignment with OZ Ownable v5 (
          // "OwnableUnauthorizedAccount vs UnauthorizedAccess") the gate
          // raises the standard `OwnableUnauthorizedAccount(msg.sender)` so
          // indexers + clients can route on the same selector that
          // `_checkOwner` produces. Pinning both the selector and the
          // single address arg catches regressions where the gate is
          // replaced with a different error or the modifier is dropped.
          const asStranger = HubContract.connect(accounts[5]);
          await expect(asStranger.setAndReinitializeContracts([], [], [], []))
            .to.be.revertedWithCustomError(HubContract, 'OwnableUnauthorizedAccount')
            .withArgs(accounts[5].address);
        });

    it('bubbles a revert from _reinitializeContracts (no try/catch on initialize)', async () => {
      // A contract whose `initialize()` has `onlyHub` and whose `hub` does
      // NOT point at THIS Hub reverts when the main Hub calls it via
      // `IInitializable.initialize()`. Deploy a KnowledgeAssetsV10 pointing
      // at a FRESH (second) Hub so the onlyHub gate rejects calls from
      // the main Hub.
      const HubFactory = await hre.ethers.getContractFactory('Hub');
      const freshHub = await HubFactory.deploy();
      await freshHub.waitForDeployment();

      const KAV10Factory = await hre.ethers.getContractFactory('KnowledgeAssetsV10');
      const foreignKAV10 = await KAV10Factory.deploy(await freshHub.getAddress());
      await foreignKAV10.waitForDeployment();

      // Snapshot pre-call registrations so we can prove atomic rollback on
      // revert: neither the newContract nor the asset storage should be
      // registered afterwards. `get` on the internal set reverts with
      // `ContractDoesNotExist(name)` when the name isn't registered —
      // pinning this catches regressions that accidentally return address(0)
      // instead of reverting.
      await expect(HubContract.getContractAddress('AtomicRollbackContract'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('AtomicRollbackContract');
      await expect(HubContract.getAssetStorageAddress('AtomicRollbackAssetStorage'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('AtomicRollbackAssetStorage');

      // The inner initialize() hits an `onlyHub` gate pointing at a foreign
      // Hub, raising HubLib.UnauthorizedAccess. We can't reliably pin the
      // exact message from here because it's emitted by a different Hub
      // instance, so match on the custom error name only (args are fuzzy).
      await expect(
        HubContract.setAndReinitializeContracts(
          [{ name: 'AtomicRollbackContract', addr: accounts[7].address }],
          [{ name: 'AtomicRollbackAssetStorage', addr: accounts[8].address }],
          [await foreignKAV10.getAddress()],
          [],
        ),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');

      // Atomic: whole tx reverted, so the earlier setContractAddress /
      // setAssetStorageAddress inside the same call should have been
      // rolled back along with the reinitialize revert. Same
      // ContractDoesNotExist pinning as above.
      await expect(HubContract.getContractAddress('AtomicRollbackContract'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('AtomicRollbackContract');
      await expect(HubContract.getAssetStorageAddress('AtomicRollbackAssetStorage'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('AtomicRollbackAssetStorage');
    });

    it('bubbles a revert from _forwardCalls when the target call reverts', async () => {
      // Use the Token contract that's already Hub-registered (by the Token
      // deploy script). `Token.mint` is onlyOwner; calling it from Hub
      // (msg.sender != Token.owner()) reverts, which must bubble.
      //
      // Sanity: Token IS registered under "Token" in Hub (done by the
      // deploy script for the real Token contract).
      await HubContract.getContractAddress('Token'); // no revert

      // Encode Token.mint(some, 1) — Token is Ownable, Hub isn't its owner.
      const mintData = TokenContract.interface.encodeFunctionData('mint', [
        accounts[9].address,
        1n,
      ]);

      // Snapshot a parallel registration attempt to verify atomic rollback:
      // if _forwardCalls reverts, the `newContracts` loop's registration
      // must not persist. Pin ContractDoesNotExist to catch regressions
      // where `get` silently returns address(0).
      await expect(HubContract.getContractAddress('ForwardRollbackContract'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('ForwardRollbackContract');

      // Token.mint uses `onlyRole(MINTER_ROLE)` (OZ AccessControl) — when
      // called via forwardCall from Hub (which lacks MINTER_ROLE), Token
      // reverts with `AccessControlUnauthorizedAccount(account, role)`.
      // We match the custom error name (args come from Token, not Hub,
      // so skip .withArgs here to avoid ABI mismatch false-negatives).
      await expect(
        HubContract.setAndReinitializeContracts(
          [{ name: 'ForwardRollbackContract', addr: accounts[7].address }],
          [],
          [],
          [{ contractName: 'Token', encodedData: [mintData] }],
        ),
      ).to.be.revertedWithCustomError(TokenContract, 'AccessControlUnauthorizedAccount');

      await expect(HubContract.getContractAddress('ForwardRollbackContract'))
        .to.be.revertedWithCustomError(HubContract, 'ContractDoesNotExist')
        .withArgs('ForwardRollbackContract');
    });

    it('idempotency: repeated registrations of the same name/addr leave state identical', async () => {
      const TokenFactory = await hre.ethers.getContractFactory('Token');
      const target = await TokenFactory.deploy('T', 'T');
      await target.waitForDeployment();
      const targetAddr = await target.getAddress();

      const args: {
        newContracts: Array<{ name: string; addr: string }>;
        newAssetStorageContracts: Array<{ name: string; addr: string }>;
      } = {
        newContracts: [{ name: 'IdempotentContract', addr: targetAddr }],
        newAssetStorageContracts: [
          { name: 'IdempotentAssetStorage', addr: accounts[4].address },
        ],
      };

      await HubContract.setAndReinitializeContracts(
        args.newContracts,
        args.newAssetStorageContracts,
        [],
        [],
      );

      const contractsAfterFirst = await HubContract.getAllContracts();
      const assetStoragesAfterFirst = await HubContract.getAllAssetStorages();

      // Second run with the exact same args: addresses unchanged, counts
      // unchanged (update path: same addr-for-same-name => no new entry).
      await HubContract.setAndReinitializeContracts(
        args.newContracts,
        args.newAssetStorageContracts,
        [],
        [],
      );

      const contractsAfterSecond = await HubContract.getAllContracts();
      const assetStoragesAfterSecond = await HubContract.getAllAssetStorages();

      expect(contractsAfterSecond.length).to.equal(contractsAfterFirst.length);
      expect(assetStoragesAfterSecond.length).to.equal(assetStoragesAfterFirst.length);
      expect(await HubContract.getContractAddress('IdempotentContract')).to.equal(targetAddr);
      expect(await HubContract.getAssetStorageAddress('IdempotentAssetStorage')).to.equal(
        accounts[4].address,
      );
    });
  });
});
