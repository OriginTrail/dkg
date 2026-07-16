import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `DKGPublishingConvictionNFT`, the slim ERC-721 wrapper
 * over publisher conviction accounts.
 *
 * Post-split architecture (`PublishingConvictionStorage` 052a +
 * `PublishingConviction` 052b + this wrapper 053):
 *   - The wrapper holds NO application state. `_nextAccountId` mint
 *     counter + Hub-resolved storage/token/vault refs only.
 *   - `PublishingConviction` is resolved lazily from Hub on every
 *     forward so logic-only re-registration does not require wrapper
 *     reinitialization.
 *   - `initialize()` resolves `PublishingConvictionStorage`, `Token`,
 *     and `ConvictionStakingStorage` (the v4.0.0 V10 vault — the
 *     wrapper's `transferFrom` paths route TRAC there).
 *   - Hub registration order: storage → logic → wrapper → KAV10 (which
 *     resolves the wrapper through `IDKGPublishingConvictionNFT`).
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DKGPublishingConvictionNFT',
  });
};

export default func;
func.tags = ['DKGPublishingConvictionNFT', 'v10'];
func.dependencies = [
  'Hub',
  'Token',
  // Split-out V10 deps (storage is cached; logic is resolved lazily).
  'PublishingConvictionStorage',
  'PublishingConviction',
  // v4.0.0 vault — TRAC custody for `createAccount` / `topUp` flows.
  'ConvictionStakingStorage',
  'StakingStorage',
  'EpochStorage',
  'Chronos',
  'ParametersStorage',
];
