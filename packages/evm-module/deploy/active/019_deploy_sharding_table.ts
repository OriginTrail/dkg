import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

// v2.0.0 — Dropped the V8→V9 Neuroweb-only migration branch. It used to
// queue calls to `ShardingTable.migrateOldShardingTable(...)` during a
// Neuroweb redeployment to backfill the new contract from the old
// `ShardingTableStorage`. That on-chain function was removed during the
// V9→V10 consolidation, so this branch was already unreachable on V10:
// `interface.encodeFunctionData('migrateOldShardingTable', ...)` would
// have thrown the moment `isMigration && network.startsWith('neuroweb')`
// became true. Removed to avoid misleading future operators reading this
// file. The tag-renaming step (`OldShardingTable` ← old `ShardingTable`)
// is preserved so a Hub redeploy still records the previous address as
// `OldShardingTable` for off-chain forensics.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isMigration =
    hre.helpers.contractDeployments.contracts['ShardingTable']?.migration ||
    false;

  if (isMigration) {
    console.log('Running redeploy of ShardingTable...');
    delete hre.helpers.contractDeployments.contracts['ShardingTable'].migration;
    hre.helpers.contractDeployments.contracts['OldShardingTable'] =
      hre.helpers.contractDeployments.contracts['ShardingTable'];
  }

  await hre.helpers.deploy({
    newContractName: 'ShardingTable',
  });
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
