// The account stack the Conviction Account payment suites (OT-RFC-27) run on,
// and what they read off a receipt and off the pools.

import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  PublishingConviction,
  PublishingConvictionStorage,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../../typechain';
import { ACCOUNT_STACK_TAGS } from './conviction-service';

/** EpochStorage's shards: the publishing pool the stakers share, and the treasury's. */
export const STAKER_SHARD_ID = 1n;
export const TREASURY_SHARD_ID = 2n;

/**
 * The development deploy of `tags`, the account stack by default, and its
 * contracts. Each suite wraps it in a fixture function of its own, adding what
 * it registers on top: `loadFixture` keeps one snapshot per fixture function,
 * and one function shared by suites would be restored to a snapshot that another
 * suite's fixture has since invalidated.
 */
export async function deployAccountStack(tags: string[] = ACCOUNT_STACK_TAGS) {
  await hre.deployments.fixture(tags);
  return {
    accounts: await hre.ethers.getSigners(),
    Hub: await hre.ethers.getContract<Hub>('Hub'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
  };
}

export type AccountStack = Awaited<ReturnType<typeof deployAccountStack>>;

/** The time of the block a receipt's transaction ran in. */
export const blockTime = async (receipt: ContractTransactionReceipt): Promise<bigint> =>
  BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

/** The parsed events `name` that `contract` emitted in a receipt, in order. */
export const eventsOf = (receipt: ContractTransactionReceipt, contract: BaseContract, name: string): Result[] => {
  const address = (contract.target as string).toLowerCase();
  const out: Result[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name === name) out.push(parsed.args);
  }
  return out;
};

/** The ranges a receipt credited to `shard` of the pools, as [start, end, amount], in order. */
export const poolCredits = (
  es: EpochStorage,
  receipt: ContractTransactionReceipt,
  shard: bigint = STAKER_SHARD_ID,
): bigint[][] =>
  eventsOf(receipt, es, 'TokensAddedToEpochRange')
    .filter((a) => a.shardId === shard)
    .map((a) => [a.startEpoch, a.endEpoch, a.tokenAmount]);

/** `shard`'s pool of each epoch of [from, to]. */
export const poolsOver = async (
  es: EpochStorage,
  from: bigint,
  to: bigint,
  shard: bigint = STAKER_SHARD_ID,
): Promise<Map<bigint, bigint>> => {
  const out = new Map<bigint, bigint>();
  for (let e = from; e <= to; e++) out.set(e, await es.getEpochPool(shard, e));
  return out;
};
