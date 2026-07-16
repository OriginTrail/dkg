import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `PublishingConviction`, the stateless logic contract
 * for publisher conviction accounts.
 *
 * Reads/writes `PublishingConvictionStorage` via `onlyContracts`. The
 * wrapper-driven write path is gated by `onlyConvictionNFT`
 * (`hub.getContractAddress("DKGPublishingConvictionNFT")`); the public
 * `settle(uint256)` entry point is permissionless.
 *
 * Hub-resolved deps wired in `initialize()`:
 *   - `PublishingConvictionStorage` (052a)
 *   - `EpochStorageV8`, `Chronos`, `ParametersStorage` (existing)
 *   - `ConvictionStakingStorage` (049b) — TRAC vault the protocol
 *     treasury fee is paid out of via `transferStake`.
 *   - `ShardingTableStorage` (006) — OT-RFC-51: `nodeExists` validation for
 *     a designated primary node on `createAccount` / `setPrimaryNode`.
 *
 * Mirror of staking pattern: stateless logic contract sits between the
 * NFT wrapper and the dedicated storage. Logic can be redeployed
 * without touching account state — Hub re-registration plus
 * `initialize()` re-bind is enough.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'PublishingConviction',
  });
};

export default func;
func.tags = ['PublishingConviction', 'v10'];
func.dependencies = [
  'Hub',
  'PublishingConvictionStorage',
  'EpochStorage',
  'Chronos',
  'ParametersStorage',
  'ConvictionStakingStorage',
  // OT-RFC-51: needed for `nodeExists` validation in `initialize()`'s
  // `ShardingTableStorage` dependency + `createAccount`/`setPrimaryNode`.
  'ShardingTableStorage',
];
