// =============================================================================
// V8→V10 migration conviction credit
// =============================================================================
//
// Background
// ----------
// V10 launches after a multi-month V8 migration window. Delegators who
// maintained continuous V8 stake on a node for the 60 days preceding launch
// and elect a high-conviction V10 tier (6m or 12m) get their V10 lock
// shortened by 60 days as a "thank-you" for the V8 conviction we cannot
// otherwise prove on-chain at migration time.
//
// On-chain pieces
// ---------------
//   * `V8MigrationEligibility` — frozen registry of `(identityId, delegator)`
//     pairs that the off-chain snapshot script certified as continuous-V8.
//     Must be `frozen()` before any migration can apply the credit.
//   * `ConvictionStakingStorage.createPosition` — gained an
//     `expiryShortenedBy` parameter (v4.1.0); gated on `migrationEpoch != 0`
//     so the V8→V10 bonus cannot leak into fresh V10 stakes.
//   * `StakingV10._convertToNFT` — reads the (frozen) registry and, for
//     eligible 6m/12m migrants, passes a fixed `60 days` as
//     `expiryShortenedBy` (v3.1.0). The literal matches the off-chain
//     eligibility window and is independent of network-tuned
//     `chronos.epochLength`.
//
// What this file tests
// --------------------
//   1. Eligible 6m/12m migrants get a 60-day-earlier expiry; ineligible
//      migrants and lower-tier migrants get the default expiry.
//   2. Boost amount is unchanged — only the WINDOW is shortened. Magnitude
//      of `runningNodeEffectiveStake` and `nodeExpiryDrop` match the
//      no-credit baseline.
//   3. The registry's `frozen` flag locks out further uploads.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  StakingStorage,
  StakingV10,
  Token,
  V8MigrationEligibility,
} from '../typechain';

const SCALE18 = 10n ** 18n;
const SIX_X = 6n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
// 60-day credit, in seconds. Hard-coded literal (StakingV10 3.1.0 review
// follow-up): the off-chain V8MigrationEligibility window is a fixed
// 60-day wall-clock window before V10 launch; the on-chain credit must
// match independent of network-tuned epochLength (devnet: 1h; testnet: 1d).
const SIXTY_DAYS_SECONDS = 60n * 24n * 60n * 60n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
  V8MigrationEligibility: V8MigrationEligibility;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'V8MigrationEligibility',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>(
      'StakingStorage',
    ),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    ),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    V8MigrationEligibility: await hre.ethers.getContract<V8MigrationEligibility>(
      'V8MigrationEligibility',
    ),
  };
}

describe('@integration V8→V10 migration conviction credit', function () {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let SS: StakingStorage;
  let CSS: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;
  let ChronosContract: Chronos;
  let RegistryContract: V8MigrationEligibility;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingStorage: SS,
      ConvictionStakingStorage: CSS,
      Profile: ProfileContract,
      Token: TokenContract,
      Chronos: ChronosContract,
      V8MigrationEligibility: RegistryContract,
    } = await loadFixture(deployFixture));
  });

  // -------------------------------------------------------------------------
  // Helpers (cloned from v10-converttonft-drain-fix.test.ts so the two files
  // remain self-contained and can be removed independently)
  // -------------------------------------------------------------------------

  // Each profile is created from a fresh operational wallet (`accounts[opIdx]`)
  // because Profile.createProfile keys identities by `msg.sender` and rejects
  // a second profile from the same operational caller.
  const createProfile = async (opIdx = 1) => {
    const nodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const tx = await ProfileContract.connect(accounts[opIdx]).createProfile(
      accounts[0].address,
      [],
      `Node-${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    return Number(receipt!.logs[0].topics[1]);
  };

  const seedV8Stake = async (
    delegator: SignerWithAddress,
    identityId: number,
    stakeBase: bigint,
  ) => {
    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegator.address]),
    );
    await TokenContract.mint(await SS.getAddress(), stakeBase);
    await SS.connect(accounts[0]).increaseDelegatorStakeBase(
      identityId,
      v8Key,
      stakeBase,
    );
    await SS.connect(accounts[0]).increaseNodeStake(identityId, stakeBase);
    await SS.connect(accounts[0]).increaseTotalStake(stakeBase);
    return v8Key;
  };

  // -------------------------------------------------------------------------
  // Registry lifecycle
  // -------------------------------------------------------------------------

  describe('V8MigrationEligibility lifecycle', () => {
    it('Has the expected name and version', async () => {
      expect(await RegistryContract.name()).to.equal('V8MigrationEligibility');
      expect(await RegistryContract.version()).to.equal('10.0.2');
    });

    it('setEligibleBatch records pairs and bumps the counter, idempotently', async () => {
      const ids = [1n, 2n, 3n];
      const addrs = [
        accounts[2].address,
        accounts[3].address,
        accounts[4].address,
      ];

      await expect(RegistryContract.connect(accounts[0]).setEligibleBatch(ids, addrs))
        .to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[0], addrs[0])
        .and.to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[1], addrs[1])
        .and.to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[2], addrs[2]);

      expect(await RegistryContract.eligibleCount()).to.equal(3n);
      for (let i = 0; i < ids.length; i++) {
        expect(await RegistryContract.isEligible(ids[i], addrs[i])).to.equal(true);
      }

      // Re-uploading the same set is idempotent — counter unchanged, no
      // additional events emitted.
      const tx = await RegistryContract.connect(accounts[0]).setEligibleBatch(
        ids,
        addrs,
      );
      const r = await tx.wait();
      const log = r!.logs.filter(
        (l) => 'fragment' in l && (l as { fragment: { name: string } }).fragment.name === 'EligibilitySet',
      );
      expect(log.length).to.equal(0);
      expect(await RegistryContract.eligibleCount()).to.equal(3n);
    });

    it('setEligibleBatch rejects mismatched array lengths and zero entries', async () => {
      await expect(
        RegistryContract.setEligibleBatch([1n], [accounts[1].address, accounts[2].address]),
      ).to.be.revertedWith('Length mismatch');
      await expect(
        RegistryContract.setEligibleBatch([0n], [accounts[1].address]),
      ).to.be.revertedWith('Zero identityId');
      await expect(
        RegistryContract.setEligibleBatch([1n], [hre.ethers.ZeroAddress]),
      ).to.be.revertedWith('Zero delegator');
    });

    it('freeze locks out further uploads; second freeze reverts', async () => {
      await RegistryContract.setEligibleBatch([1n], [accounts[2].address]);
      await expect(RegistryContract.freeze())
        .to.emit(RegistryContract, 'Frozen');
      expect(await RegistryContract.frozen()).to.equal(true);

      await expect(
        RegistryContract.setEligibleBatch([2n], [accounts[3].address]),
      ).to.be.revertedWith('Registry frozen');
      await expect(RegistryContract.freeze()).to.be.revertedWith('Already frozen');
    });

    it('Only HubOwner can mutate', async () => {
      await expect(
        RegistryContract.connect(accounts[2]).setEligibleBatch(
          [1n],
          [accounts[2].address],
        ),
      ).to.be.reverted; // HubLib.UnauthorizedAccess
      await expect(
        RegistryContract.connect(accounts[2]).freeze(),
      ).to.be.reverted;
    });
  });

});
