import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `PublishingConvictionStorage`, the canonical state store
 * for publisher conviction accounts.
 *
 * Split-out architecture (mirrors `ConvictionStakingStorage` for staking):
 *   - This storage contract holds every byte of conviction-account
 *     state (Account records, per-billing-window TRAC accounting,
 *     persistent top-up buffer, agent registrations, governance cap).
 *   - `PublishingConviction` (deployed at 052b) is the stateless logic
 *     contract that reads/writes here via `onlyContracts`-gated
 *     mutators.
 *   - `DKGPublishingConvictionNFT` (053) is the slim ERC-721 wrapper
 *     that drives publisher-facing TRAC moves and forwards every
 *     business action to the logic contract.
 *
 * Initialization (`PublishingConvictionStorage.initialize()`) is run by
 * `998_initialize_contracts.ts` after Hub registration. It is
 * idempotent across redeploys: the default `maxAgentsPerAccount = 100`
 * is seeded only on the first call and a HubOwner can subsequently
 * tune it via `setMaxAgentsPerAccount`.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'PublishingConvictionStorage',
  });
};

export default func;
func.tags = ['PublishingConvictionStorage', 'v10'];
func.dependencies = ['Hub'];
