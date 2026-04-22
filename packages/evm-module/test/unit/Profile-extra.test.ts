/**
 * Profile-extra.test.ts — audit coverage (E-17).
 *
 * Finding E-17 (MEDIUM, SPEC-GAP, see .test-audit/BUGS_FOUND.md):
 *   "Profile.registerNode 50K TRAC core-stake rule not asserted at the
 *   Profile layer; integration tests use the value but don't pin the
 *   contract enforcement."
 *
 * What this test pins:
 *   1. `Profile` exposes NO `registerNode(...)` function. The V10 spec
 *      references such a function for node core-stake enforcement, but
 *      the contract ABI does not expose it — the only entry point is
 *      `createProfile`.
 *   2. `createProfile` does NOT enforce a minimum stake (the 50K TRAC
 *      `ParametersStorage.minimumStake` rule). A call with the caller
 *      holding ZERO TRAC succeeds — demonstrating that the 50K-TRAC
 *      gate lives in `Staking` (sharding table add) and is NOT pinned
 *      at profile creation time.
 *
 * Test #2 is INTENTIONAL RED evidence of the spec-gap. It passes today
 * (no revert) because the code path simply doesn't exist. The spec-compliance
 * assertion (`expect(...).to.be.reverted`) flips the test red to make the
 * gap visible. When the gap is closed, the assertion flips to green.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Hub, ParametersStorage, Profile } from '../../typechain';

describe('@unit Profile — extra audit coverage (E-17: 50K TRAC core-stake rule)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let ProfileContract: Profile;
  let ParametersStorageContract: ParametersStorage;

  async function deployFixture() {
    await hre.deployments.fixture(['Profile']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const Profile = await hre.ethers.getContract<Profile>('Profile');
    const ParametersStorage = await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    );
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return { accounts: signers, Hub, Profile, ParametersStorage };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Profile: ProfileContract,
      ParametersStorage: ParametersStorageContract,
    } = await loadFixture(deployFixture));
  });

  // ======================================================================
  // 1. No `registerNode` entry point exists (pins the missing function).
  // ======================================================================
  it('ABI: Profile has NO registerNode function (SPEC-GAP)', async () => {
    const frags = ProfileContract.interface.fragments.filter(
      (f: { type: string; name?: string }) =>
        f.type === 'function' && (f as { name?: string }).name === 'registerNode',
    );
    expect(frags.length, 'Profile.registerNode must not exist (confirmed gap)').to.equal(0);
  });

  // ======================================================================
  // 2. `minimumStake` parameter is 50K TRAC — sanity pin before E-17.
  // ======================================================================
  it('ParametersStorage.minimumStake is 50_000 TRAC (baseline for E-17)', async () => {
    expect(await ParametersStorageContract.minimumStake()).to.equal(
      hre.ethers.parseEther('50000'),
    );
  });

  // ======================================================================
  // 3. SPEC-GAP (INTENTIONAL RED): createProfile accepts a caller with
  //    ZERO staked TRAC. Per the V10 spec, node core-stake must be
  //    enforced at the Profile layer (50K TRAC) before a node can register.
  //    The current code ONLY enforces it indirectly via
  //    `Staking._addNodeToShardingTable` — meaning a node identity can be
  //    created for a profile with no stake.
  // ======================================================================
  it('SPEC-GAP (INTENTIONAL RED): createProfile with 0 stake does NOT revert — Profile layer has no stake gate', async () => {
    // Spec expectation: createProfile reverts when caller has < minimumStake
    // TRAC bonded. The current code has no such check at the Profile layer
    // (it lives in Staking.stake's sharding-table branch only). This test
    // asserts the EXPECTED spec behavior (`.to.be.reverted`) against the
    // CURRENT code (call SUCCEEDS with 0 stake). It is INTENTIONALLY red
    // today; it flips green when the Profile layer pins the check.
    const caller = accounts[0]; // deployer, matches existing Profile.test fixture
    const nodeId =
      '0x07f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
    const currentStake = await ParametersStorageContract.minimumStake();
    expect(currentStake).to.be.gt(0n);

    await expect(
      ProfileContract.connect(caller).createProfile(
        accounts[1].address,
        [],
        'Node E-17',
        nodeId,
        1000,
      ),
    ).to.be.reverted;
  });
});
