import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import { randomBytes } from 'crypto';
import hre from 'hardhat';

import {
  Hub,
  Profile,
  ParametersStorage,
  ShardingTable,
  ShardingTableStorage,
} from '../../typechain';

/**
 * Regression: the sharding table must enforce `shardingTableSizeLimit`. The cap
 * bounds the O(n) re-index loops in insertNode/removeNode; without it the table
 * grows unbounded and those write-path loops can exceed the block gas limit.
 */
describe('@unit ShardingTable enforces shardingTableSizeLimit', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Profile: Profile;
  let ParametersStorage: ParametersStorage;
  let ShardingTable: ShardingTable;
  let ShardingTableStorage: ShardingTableStorage;

  async function deploy() {
    hre.helpers.resetDeploymentsJson();
    await hre.deployments.fixture(
      ['ShardingTable', 'IdentityStorageV2', 'StakingV2', 'Profile', 'ParametersStorage'],
      { keepExistingDeployments: false },
    );
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    ShardingTable = await hre.ethers.getContract<ShardingTable>('ShardingTable');
    ShardingTableStorage = await hre.ethers.getContract<ShardingTableStorage>('ShardingTableStorage');
    await Hub.setContractAddress('HubOwner', accounts[0].address);
  }

  async function createAndInsert(i: number): Promise<void> {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const rc = await (
      await Profile.connect(accounts[i + 1]).createProfile(
        accounts[i + 21].address, [], `N${i}`, nodeId, 0,
      )
    ).wait();
    const id = Number(rc!.logs[0].topics[1]);
    await ShardingTable['insertNode(uint72)'](id);
  }

  it('reverts ShardingTableIsFull once nodesCount reaches the limit', async () => {
    await deploy();
    await ParametersStorage.setShardingTableSizeLimit(3);

    // Fill exactly to the cap.
    for (let i = 0; i < 3; i++) await createAndInsert(i);
    expect(await ShardingTableStorage.nodesCount()).to.equal(3);

    // The next insert must revert at the cap — table cannot grow unbounded.
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const rc = await (
      await Profile.connect(accounts[10]).createProfile(accounts[11].address, [], 'overflow', nodeId, 0)
    ).wait();
    const overflowId = Number(rc!.logs[0].topics[1]);

    await expect(ShardingTable['insertNode(uint72)'](overflowId))
      .to.be.revertedWithCustomError(ShardingTable, 'ShardingTableIsFull')
      .withArgs(3, 3);

    // Count is unchanged — the failed insert did not grow the table.
    expect(await ShardingTableStorage.nodesCount()).to.equal(3);
  });

  it('rejects setting the size limit to 0 (would freeze all node admission)', async () => {
    await deploy();
    await expect(ParametersStorage.setShardingTableSizeLimit(0)).to.be.revertedWith(
      'shardingTableSizeLimit must be > 0',
    );
    // A positive limit is still accepted.
    await ParametersStorage.setShardingTableSizeLimit(1);
    expect(await ParametersStorage.shardingTableSizeLimit()).to.equal(1);
  });
});
