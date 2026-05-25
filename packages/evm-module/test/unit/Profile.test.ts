import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Hub,
  IdentityStorage,
  ParametersStorage,
  Profile,
  ProfileStorage,
  ShardingTableStorage,
  StakingStorage,
  Token,
  WhitelistStorage,
} from '../../typechain';

type ProfileFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  IdentityStorage: IdentityStorage;
  Profile: Profile;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  WhitelistStorage: WhitelistStorage;
  Token: Token;
  StakingStorage: StakingStorage;
  ShardingTableStorage: ShardingTableStorage;
};

describe('@unit Profile contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let IdentityStorage: IdentityStorage;
  let Profile: Profile;
  let ParametersStorage: ParametersStorage;
  let ProfileStorage: ProfileStorage;
  let WhitelistStorage: WhitelistStorage;
  let Token: Token;
  let StakingStorage: StakingStorage;
  let ShardingTableStorage: ShardingTableStorage;

  const nodeId1 =
    '0x07f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
  const identityId1 = 1;

  async function deployProfileFixture(): Promise<ProfileFixture> {
    await hre.deployments.fixture(['Profile']);
    Profile = await hre.ethers.getContract<Profile>('Profile');
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    ProfileStorage =
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
    WhitelistStorage =
      await hre.ethers.getContract<WhitelistStorage>('WhitelistStorage');
    Token = await hre.ethers.getContract<Token>('Token');
    StakingStorage =
      await hre.ethers.getContract<StakingStorage>('StakingStorage');
    ShardingTableStorage =
      await hre.ethers.getContract<ShardingTableStorage>(
        'ShardingTableStorage',
      );
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      Hub,
      IdentityStorage,
      Profile,
      ParametersStorage,
      ProfileStorage,
      WhitelistStorage,
      Token,
      StakingStorage,
      ShardingTableStorage,
    };
  }

  beforeEach(async () => {
    ({
      accounts,
      Hub,
      IdentityStorage,
      Profile,
      ParametersStorage,
      ProfileStorage,
      WhitelistStorage,
      Token,
      StakingStorage,
      ShardingTableStorage,
    } = await loadFixture(deployProfileFixture));
  });

  it('The contract is named "Profile"', async () => {
    expect(await Profile.name()).to.equal('Profile');
  });

  it('The contract is version "1.3.0"', async () => {
    expect(await Profile.version()).to.equal('1.3.0');
  });

  it('Create a profile with valid inputs, expect to pass', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000),
    ).to.not.be.reverted;
  });

  it('Create a profile with additional operational wallets, expect all to be registered', async () => {
    await Profile.createProfile(accounts[1].address, [accounts[2].address], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Existing operational wallet cannot add operational wallets after profile creation', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.addOperationalWallets(identityId, [accounts[2].address]),
    ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
  });

  it('Admin wallet can add operational wallets after profile creation', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[2].address]),
    ).to.not.be.reverted;

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Cannot add the profile admin wallet as an operational wallet', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[1].address]),
    ).to.be.revertedWithCustomError(Profile, 'AdminEqualsOperational');
  });

  it('Adding already registered same-identity operational wallets is idempotent', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [
        accounts[0].address,
        accounts[2].address,
        accounts[2].address,
      ]),
    ).to.not.be.reverted;
    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[0].address, accounts[2].address]),
    ).to.not.be.reverted;

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Cannot add an operational wallet already registered to another identity', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const nodeId2 =
      '0x17f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
    await Profile.connect(accounts[3]).createProfile(
      accounts[4].address,
      [],
      'Node 2',
      nodeId2,
      1000,
    );
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[3].address]),
    ).to.be.revertedWithCustomError(Profile, 'OperationalKeyTaken');
  });

  it('Cannot add the zero address as an operational wallet', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [hre.ethers.ZeroAddress]),
    ).to.be.revertedWithCustomError(Profile, 'OperationalAddressZero');
  });

  it('Cannot exceed the configured operational wallet limit after profile creation', async () => {
    await ParametersStorage.setOpWalletsLimitOnProfileCreation(2);
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[2].address]),
    ).to.not.be.reverted;

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[3].address]),
    ).to.not.be.reverted;

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[4].address]),
    ).to.be.revertedWithCustomError(Profile, 'TooManyOperationalWallets').withArgs(2, 3);
  });

  it('Cannot create a profile with empty node name, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], '', nodeId1, 1000),
    ).to.be.revertedWithCustomError(Profile, 'EmptyNodeName');
  });

  it('Cannot create a profile with empty node ID, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', '0x', 1000),
    ).to.be.revertedWithCustomError(Profile, 'EmptyNodeId');
  });

  it('Cannot create a profile with node ID already taken, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[3]).createProfile(
        accounts[2].address,
        [],
        'Node 2',
        nodeId1,
        1000,
      ),
    ).to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists');
  });

  it('Cannot create a profile with operator fee greater than 10000, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 10001),
    ).to.be.revertedWithCustomError(Profile, 'OperatorFeeOutOfRange');
  });

  it('Update ask for a profile with valid input, expect to pass', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(Profile.updateAsk(identityId1, 2000)).to.not.be.reverted;
  });

  it('Update ask with zero value, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateAsk(identityId1, 0),
    ).to.be.revertedWithCustomError(Profile, 'ZeroAsk');
  });

  it('Update operator fee with valid input, expect to pass', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateOperatorFee(identityId1, 500),
    ).to.not.be.reverted;
  });

  it('Update operator fee with value greater than 10000, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateOperatorFee(identityId1, 10001),
    ).to.be.revertedWithCustomError(Profile, 'InvalidOperatorFee');
  });

  it('Cannot update ask during cooldown, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );
    await Profile.connect(accounts[1]).updateAsk(identityId1, 2000);

    await expect(
      Profile.connect(accounts[1]).updateAsk(identityId1, 3000),
    ).to.be.revertedWithCustomError(Profile, 'AskUpdateOnCooldown');
  });

  it('Whitelist check prevents unauthorized profile creation, expect to fail', async () => {
    await WhitelistStorage.enableWhitelist();

    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000),
    ).to.be.revertedWithCustomError(
      Profile,
      'OnlyWhitelistedAddressesFunction',
    );
  });

  // =====================================================================
  // recreate-profile-recovery 0001 — re-attach a Profile to an existing
  // Identity (testnet ProfileStorage-redeploy recovery). Admin-only; the
  // identityId is reused so surviving staking/conviction/sharding state
  // stays addressable. See docs/adr/0001-recreate-profile-admin-only.md.
  // =====================================================================

  describe('recreateProfile (testnet recovery)', () => {
    // createProfile mints identity 1 (operational = accounts[0],
    // admin = accounts[1]) then we wipe only the Profile — mirroring the
    // testnet state where the Identity survived a ProfileStorage redeploy.
    async function seedBrickedIdentity() {
      await Profile.createProfile(
        accounts[1].address,
        [],
        'Node 1',
        nodeId1,
        1000,
      );
      await ProfileStorage.deleteProfile(identityId1);
    }

    it('admin recreates by supplying the node operational wallet, not the numeric id', async () => {
      await seedBrickedIdentity();
      // accounts[0] is the operational wallet minted by createProfile;
      // accounts[1] is the admin. The admin recovers WITHOUT knowing the
      // numeric identityId — it passes the node operational wallet and the
      // contract resolves the id (admin auth still enforced).
      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.not.be.reverted;

      expect(await ProfileStorage.profileExists(identityId1)).to.equal(true);
      expect(await ProfileStorage.getNodeId(identityId1)).to.equal(nodeId1);
    });

    it('admin recreates the Profile under the same identityId', async () => {
      await seedBrickedIdentity();
      expect(await ProfileStorage.profileExists(identityId1)).to.equal(false);

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.not.be.reverted;

      expect(await ProfileStorage.profileExists(identityId1)).to.equal(true);
      expect(await ProfileStorage.getNodeId(identityId1)).to.equal(nodeId1);
      expect(await ProfileStorage.getName(identityId1)).to.equal('Node 1');
    });

    it('does not mint a new identity (id counter and resolved id unchanged)', async () => {
      await seedBrickedIdentity();
      const lastIdBefore = await IdentityStorage.lastIdentityId();
      const resolvedBefore = await IdentityStorage.getIdentityId(
        accounts[0].address,
      );

      await Profile.connect(accounts[1]).recreateProfile(
        accounts[0].address,
        'Node 1',
        nodeId1,
        1000,
      );

      expect(await IdentityStorage.lastIdentityId()).to.equal(lastIdBefore);
      expect(await IdentityStorage.getIdentityId(accounts[0].address)).to.equal(
        resolvedBefore,
      );
      expect(await IdentityStorage.getIdentityId(accounts[0].address)).to.equal(
        identityId1,
      );
    });

    it('reverts ProfileAlreadyExists when the Identity still has a Profile', async () => {
      await Profile.createProfile(
        accounts[1].address,
        [],
        'Node 1',
        nodeId1,
        1000,
      );

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      )
        .to.be.revertedWithCustomError(Profile, 'ProfileAlreadyExists')
        .withArgs(identityId1);
    });

    it('reverts when caller is an operational key (not admin) of the Identity', async () => {
      await seedBrickedIdentity();

      // accounts[0] is the operational key minted by createProfile.
      await expect(
        Profile.connect(accounts[0]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
    });

    it('reverts when caller holds no admin key for the identityId', async () => {
      await seedBrickedIdentity();

      await expect(
        Profile.connect(accounts[5]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
    });

    it('reverts when the operational wallet has no identity (resolves to id 0)', async () => {
      await seedBrickedIdentity();
      // accounts[6] has no identity → getIdentityId == 0 → _checkAdmin(0)
      // reverts (id 0 is never assigned, has no admin key).
      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[6].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
    });

    it('reverts when caller admins a different identity than the operational wallet resolves to', async () => {
      await seedBrickedIdentity();
      // identity 2: operational = accounts[3], admin = accounts[4].
      await Profile.connect(accounts[3]).createProfile(
        accounts[4].address,
        [],
        'Node 2',
        '0x17f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66',
        1000,
      );
      // admin of identity 2 passes identity 1's operational wallet →
      // resolves to id 1 → _checkAdmin(1) for the wrong admin reverts.
      await expect(
        Profile.connect(accounts[4]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
    });

    it('reverts when the supplied nodeId diverges from a surviving sharding-table entry', async () => {
      await seedBrickedIdentity();
      // Node still in the sharding ring under its ORIGINAL nodeId — the
      // testnet state (ShardingTableStorage survived; ProfileStorage did not).
      await ShardingTableStorage.createNodeObject(1, nodeId1, identityId1, 1);
      const differentNodeId =
        '0x17f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          differentNodeId,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'NodeIdShardingMismatch');
    });

    it('succeeds when the supplied nodeId matches the surviving sharding-table entry', async () => {
      await seedBrickedIdentity();
      await ShardingTableStorage.createNodeObject(1, nodeId1, identityId1, 1);

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.not.be.reverted;
      expect(await ProfileStorage.profileExists(identityId1)).to.equal(true);
    });

    it('reverts EmptyNodeName for an empty node name', async () => {
      await seedBrickedIdentity();

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          '',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'EmptyNodeName');
    });

    it('reverts EmptyNodeId for an empty node id', async () => {
      await seedBrickedIdentity();

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          '0x',
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'EmptyNodeId');
    });

    it('reverts NodeIdAlreadyExists when the node id is taken by another node', async () => {
      await seedBrickedIdentity();
      await Profile.connect(accounts[3]).createProfile(
        accounts[4].address,
        [],
        'Node 2',
        nodeId1,
        1000,
      );

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists');
    });

    // NOTE: a `NodeNameAlreadyExists` recreate test was removed here — it
    // asserted an unreachable revert. `ProfileStorage.isNameTaken` is never
    // written by any contract path, so the name-uniqueness guard (copied
    // verbatim from createProfile) cannot fire in production; the old test
    // only "passed" by faking it via a hardcoded storage slot. The dead
    // mapping itself is tracked as separate pre-existing cleanup.

    it('accepts initialOperatorFee equal to the max and rejects above it', async () => {
      await seedBrickedIdentity();
      const maxFee = await ParametersStorage.maxOperatorFee();

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          maxFee,
        ),
      ).to.not.be.reverted;
    });

    it('reverts OperatorFeeOutOfRange when initialOperatorFee exceeds the max', async () => {
      await seedBrickedIdentity();
      const maxFee = await ParametersStorage.maxOperatorFee();

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          maxFee + 1n,
        ),
      ).to.be.revertedWithCustomError(Profile, 'OperatorFeeOutOfRange');
    });

    it('is gated by the whitelist: reverts when enabled and admin not whitelisted', async () => {
      await seedBrickedIdentity();
      await WhitelistStorage.enableWhitelist();

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.be.revertedWithCustomError(
        Profile,
        'OnlyWhitelistedAddressesFunction',
      );
    });

    it('whitelist enabled and admin whitelisted -> succeeds', async () => {
      await seedBrickedIdentity();
      await WhitelistStorage.enableWhitelist();
      await WhitelistStorage.whitelistAddress(accounts[1].address);

      await expect(
        Profile.connect(accounts[1]).recreateProfile(
          accounts[0].address,
          'Node 1',
          nodeId1,
          1000,
        ),
      ).to.not.be.reverted;
    });

    it('regression: a brand-new wallet can still createProfile after a recovery', async () => {
      await seedBrickedIdentity();
      await Profile.connect(accounts[1]).recreateProfile(
        accounts[0].address,
        'Node 1',
        nodeId1,
        1000,
      );

      const nodeId2 =
        '0x17f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
      await expect(
        Profile.connect(accounts[3]).createProfile(
          accounts[4].address,
          [],
          'Node 2',
          nodeId2,
          1000,
        ),
      ).to.not.be.reverted;
    });
  });

  // =====================================================================
  // RFC 04 v0.3 / Issue #461 — relay-capability flag.
  // Multiaddrs are intentionally NOT stored on Profile — they live in
  // per-round attestation KCs (RFC 04 §5.2).
  // =====================================================================

  describe('Relay capability flag (RFC 04 v0.3 / Issue #461)', () => {
    beforeEach(async () => {
      await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    });

    it('relayCapable defaults to false', async () => {
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(false);
    });

    it('admin wallet can flip relayCapable', async () => {
      await expect(Profile.connect(accounts[1]).updateRelayCapable(identityId1, true))
        .to.emit(ProfileStorage, 'RelayCapabilityUpdated')
        .withArgs(identityId1, false, true);
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(true);
    });

    it('operational wallet can flip relayCapable (onlyIdentityOwner = admin OR operational)', async () => {
      await Profile.connect(accounts[1]).addOperationalWallets(identityId1, [accounts[2].address]);
      await expect(Profile.connect(accounts[2]).updateRelayCapable(identityId1, true)).to.not.be.reverted;
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(true);
    });

    it('non-owner cannot flip relayCapable', async () => {
      await expect(
        Profile.connect(accounts[5]).updateRelayCapable(identityId1, true),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction');
    });

    it('updateRelayCapable reverts when profile does not exist', async () => {
      await expect(
        Profile.connect(accounts[1]).updateRelayCapable(9999, true),
      ).to.be.reverted; // onlyIdentityOwner runs first against nonexistent identity
    });

    it('getProfile surfaces relayCapable alongside legacy fields', async () => {
      await Profile.connect(accounts[1]).updateRelayCapable(identityId1, true);
      const [name, nodeId, ask, opFees, relayCapable] = await ProfileStorage.getProfile(identityId1);
      expect(name).to.equal('Node 1');
      expect(nodeId).to.equal(nodeId1);
      expect(ask).to.equal(0n);
      expect(opFees.length).to.equal(1);
      expect(relayCapable).to.equal(true);
    });
  });
});
