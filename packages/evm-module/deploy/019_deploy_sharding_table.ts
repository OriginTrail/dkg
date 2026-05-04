import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isMigration =
    hre.helpers.contractDeployments.contracts['ShardingTable']?.migration ||
    false;

  const oldShardingTableAddress =
    hre.helpers.contractDeployments.contracts['ShardingTable']?.evmAddress;

  if (isMigration) {
    console.log('Running migration of old ShardingTable...');
    delete hre.helpers.contractDeployments.contracts['ShardingTable'].migration;
    hre.helpers.contractDeployments.contracts['OldShardingTable'] =
      hre.helpers.contractDeployments.contracts['ShardingTable'];
  }

  const block = await hre.ethers.provider.getBlock('latest');
  const blockTimeNow = block!.timestamp;

  const newShardingTable = await hre.helpers.deploy({
    newContractName: 'ShardingTable',
    additionalArgs: [isMigration ? blockTimeNow + 86400 : blockTimeNow],
  });

  if (isMigration && hre.network.name.startsWith('neuroweb')) {
    console.log(`Executing sharding table storage migration`);
    const shardingTableStorageAddress =
      hre.helpers.contractDeployments.contracts['ShardingTableStorage']
        .evmAddress;

    console.log(
      `Old ShardingTable: ${oldShardingTableAddress}, New ShardingTable: ${
        newShardingTable.address
      }, ShardingTableStorage: ${shardingTableStorageAddress}`,
    );

    const oldShardingTable = await hre.ethers.getContractAt(
      'ShardingTable',
      oldShardingTableAddress,
    );

    const nodes = await oldShardingTable['getShardingTable()']();
    let identityId = nodes[0]?.identityId;
    console.log(
      `Found ${nodes.length} nodes in the old ShardingTable, starting identityId: ${identityId}`,
    );
    console.log(`Full list of migrated nodes: ${JSON.stringify(nodes)}`);

    const numberOfNodesInBatch = 10;
    let iteration = 1;

    const oldShardingTableStorageAddress =
      await oldShardingTable.shardingTableStorage();
    const encodedDataArray = [];

    while (identityId) {
      console.log(
        `Migrating sharding table with starting identityId: ${identityId}, number of nodes in batch: ${numberOfNodesInBatch}, ShardingTableStorage: ${shardingTableStorageAddress}`,
      );

      encodedDataArray.push(
        newShardingTable.interface.encodeFunctionData(
          'migrateOldShardingTable',
          [identityId, numberOfNodesInBatch, oldShardingTableStorageAddress],
        ),
      );

      console.log(
        `Migration COMPLETED iteration: ${iteration} with starting identityId: ${
          identityId
        }, number of nodes in batch: ${
          numberOfNodesInBatch
        }, ShardingTableStorage: ${shardingTableStorageAddress}`,
      );

      identityId = nodes[iteration * numberOfNodesInBatch]?.identityId;
      iteration += 1;
    }

    hre.helpers.setParametersEncodedData.push({
      contractName: 'ShardingTable',
      encodedData: encodedDataArray,
    });
  }
};

export default func;
func.tags = ['ShardingTable'];
// v4.0.0 — `getMultipleNodes` reads V10 canonical stake from CSS. CSS must
// be Hub-registered before `ShardingTable.initialize()` runs.
func.dependencies = [
  'Hub',
  'ProfileStorage',
  'ShardingTableStorage',
  'StakingStorage',
  'ConvictionStakingStorage',
];
