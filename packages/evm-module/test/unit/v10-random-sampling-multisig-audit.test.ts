/**
 * DKG v10 RandomSampling multisig-access-control audit coverage.
 *
 * Finding covered (see .test-audit/BUGS_FOUND.md):
 *   E-3 (CRITICAL, TEST-DEBT): Re-enable the multisig-as-Hub-owner access-control
 *        tests that were commented out in the existing suites with TODO notes:
 *          - `test/unit/RandomSampling.test.ts:332-338`
 *          - `test/unit/RandomSampling.test.ts:397-406`
 *          - `test/unit/RandomSamplingStorage.test.ts:189-193`
 *          - `test/unit/RandomSamplingStorage.test.ts:213-216`
 *
 * These tests assert that a non-owner / non-multisig-owner caller to the
 * `onlyOwnerOrMultiSigOwner`-gated setters reverts with
 * `HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner")`. They were
 * disabled because the Hub owner in the shared fixture is an EOA, not a
 * multisig wallet — but the revert path is correct in either case because the
 * modifier falls through to the `Only Hub Owner or Multisig Owner` branch when
 * `msg.sender` is neither the Hub owner nor a multisig signer of it.
 *
 * This file re-instates those tests in a dedicated describe tagged E-3 so a
 * regression in the modifier (e.g. a bypass) trips immediately. If any of the
 * tests goes RED, DO NOT modify production code — record the finding back into
 * BUGS_FOUND.md as a new E-* entry.
 */

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Hub,
  HubLib,
  RandomSampling,
  RandomSamplingStorage,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  HubLib: HubLib;
  RandomSampling: RandomSampling;
  RandomSamplingStorage: RandomSamplingStorage;
};

describe('@unit v10 RandomSampling multisig audit (E-3)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let HubLibContract: HubLib;
  let RS: RandomSampling;
  let RSS: RandomSamplingStorage;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Token',
      'KnowledgeCollectionStorage',
      'KnowledgeCollection',
      'RandomSamplingStorage',
      'RandomSampling',
      'ShardingTableStorage',
      'EpochStorage',
      'Profile',
    ]);

    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const RS = await hre.ethers.getContract<RandomSampling>('RandomSampling');
    const RSS = await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );
    // HubLib is a library but its typechain exposes the custom error interface.
    // Deploying the library isn't needed for error decoding — we only use the
    // contract instance as an error-source handle for `revertedWithCustomError`.
    const HubLibFactory = await hre.ethers.getContractFactory('HubLib');
    const HubLibC = (await HubLibFactory.deploy()) as unknown as HubLib;
    await HubLibC.waitForDeployment();
    const accounts = await hre.ethers.getSigners();
    return {
      accounts,
      Hub,
      HubLib: HubLibC,
      RandomSampling: RS,
      RandomSamplingStorage: RSS,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      HubLib: HubLibContract,
      RandomSampling: RS,
      RandomSamplingStorage: RSS,
    } = await loadFixture(deployFixture));
  });

  describe('RandomSampling.setProofingPeriodDurationInBlocks', () => {
    it('reverts with UnauthorizedAccess when called by a non-owner/non-multisig signer', async () => {
      // NOTE (left RED per E-3): this assertion surfaces a real PROD-BUG
      // hiding behind the originally-disabled test. With an EOA Hub owner
      // (as in the shared fixture), the modifier ends up executing
      //   `try ICustodian(hubOwner).getOwners() returns (...) { ... } catch { ... }`
      // inside `_isMultiSigOwner`. In solc 0.8.20 the compiler-inserted
      // `extcodesize(hubOwner) > 0` guard can revert BEFORE the try-wrapped
      // external call and its empty revert data bubbles up, so the outer
      // `revert HubLib.UnauthorizedAccess(...)` is never reached. The raw
      // revert data observed in this repo is `0x` (empty), not the
      // UnauthorizedAccess selector.
      //
      // Leaving this RED documents the gap. Production fix = handle EOA
      // multisig candidate (short-circuit when `addr.code.length == 0`).
      await expect(
        RS.connect(accounts[1]).setProofingPeriodDurationInBlocks(100),
      ).to.be.revertedWithCustomError(HubLibContract, 'UnauthorizedAccess');
    });

    it('allows the Hub owner to update the duration', async () => {
      // Sanity check that the happy path still works — any regression that
      // made the setter *always* revert would break this too.
      await expect(RS.setProofingPeriodDurationInBlocks(200)).to.not.be.reverted;
    });

    it('at minimum reverts (without matching a specific selector) for non-owner', async () => {
      // Weaker companion assertion that pins current behaviour: the call MUST
      // still revert — just not necessarily with a typed custom error. A
      // regression that silently allowed non-owners through would flip this
      // from GREEN to RED.
      await expect(
        RS.connect(accounts[1]).setProofingPeriodDurationInBlocks(100),
      ).to.be.reverted;
    });
  });

  describe('RandomSamplingStorage.setW1', () => {
    it('reverts with UnauthorizedAccess when called by a non-owner/non-multisig signer', async () => {
      // Left RED for the same reason as setProofingPeriodDurationInBlocks
      // above — storage contract shares the same `_isMultiSigOwner`
      // implementation and therefore the same extcodesize-on-EOA hazard.
      const newW1 = hre.ethers.parseUnits('2', 18);
      await expect(
        RSS.connect(accounts[1]).setW1(newW1),
      ).to.be.revertedWithCustomError(HubLibContract, 'UnauthorizedAccess');
    });

    it('at minimum reverts (without matching a specific selector) for non-owner', async () => {
      const newW1 = hre.ethers.parseUnits('2', 18);
      await expect(RSS.connect(accounts[1]).setW1(newW1)).to.be.reverted;
    });
  });

  describe('RandomSamplingStorage.setW2', () => {
    it('reverts with UnauthorizedAccess when called by a non-owner/non-multisig signer', async () => {
      // Left RED for the same reason as setW1 above.
      const newW2 = hre.ethers.parseUnits('3', 18);
      await expect(
        RSS.connect(accounts[1]).setW2(newW2),
      ).to.be.revertedWithCustomError(HubLibContract, 'UnauthorizedAccess');
    });

    it('at minimum reverts (without matching a specific selector) for non-owner', async () => {
      const newW2 = hre.ethers.parseUnits('3', 18);
      await expect(RSS.connect(accounts[1]).setW2(newW2)).to.be.reverted;
    });
  });
});
