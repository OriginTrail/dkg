// OT-RFC-27 script support: the contracts of the stack, resolved through the
// Hub at the address the tracked deployments file records for it, each through
// its generated factory, so its type comes from its ABI; revert decoding; typed
// events from a receipt.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { BaseContract, ContractRunner, Interface, TransactionReceipt } from 'ethers';

import type {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  ConvictionWithdrawalStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  IdentityStorage,
  ParametersStorage,
  ProfileStorage,
  PublishingConviction,
  PublishingConvictionStorage,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  RandomSamplingStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  ShardingTableStorage,
  StakingKPI,
  StakingV10,
  StakingV10Ledger,
  Token,
} from '../../typechain';
import type { TypedContractEvent, TypedLogDescription } from '../../typechain/common';
import { DKGPublishingConvictionNFT__factory } from '../../typechain/factories/contracts/DKGPublishingConvictionNFT__factory';
import { DKGStakingConvictionNFT__factory } from '../../typechain/factories/contracts/DKGStakingConvictionNFT__factory';
import { PublishingConviction__factory } from '../../typechain/factories/contracts/PublishingConviction__factory';
import { QueryInferenceSettlement__factory } from '../../typechain/factories/contracts/QueryInferenceSettlement__factory';
import { ServiceSubscriptionsWallet__factory } from '../../typechain/factories/contracts/ServiceSubscriptionsWallet__factory';
import { ServiceSubscriptions__factory } from '../../typechain/factories/contracts/ServiceSubscriptions__factory';
import { StakingKPI__factory } from '../../typechain/factories/contracts/StakingKPI__factory';
import { StakingV10Ledger__factory } from '../../typechain/factories/contracts/StakingV10Ledger__factory';
import { StakingV10__factory } from '../../typechain/factories/contracts/StakingV10__factory';
import { Token__factory } from '../../typechain/factories/contracts/Token__factory';
import { Chronos__factory } from '../../typechain/factories/contracts/storage/Chronos__factory';
import { ConvictionServiceStorage__factory } from '../../typechain/factories/contracts/storage/ConvictionServiceStorage__factory';
import { ConvictionStakingStorage__factory } from '../../typechain/factories/contracts/storage/ConvictionStakingStorage__factory';
import { ConvictionWithdrawalStorage__factory } from '../../typechain/factories/contracts/storage/ConvictionWithdrawalStorage__factory';
import { EpochStorage__factory } from '../../typechain/factories/contracts/storage/EpochStorage__factory';
import { Hub__factory } from '../../typechain/factories/contracts/storage/Hub__factory';
import { IdentityStorage__factory } from '../../typechain/factories/contracts/storage/IdentityStorage__factory';
import { ParametersStorage__factory } from '../../typechain/factories/contracts/storage/ParametersStorage__factory';
import { ProfileStorage__factory } from '../../typechain/factories/contracts/storage/ProfileStorage__factory';
import { PublishingConvictionStorage__factory } from '../../typechain/factories/contracts/storage/PublishingConvictionStorage__factory';
import { QueryInferenceStorage__factory } from '../../typechain/factories/contracts/storage/QueryInferenceStorage__factory';
import { RandomSamplingStorage__factory } from '../../typechain/factories/contracts/storage/RandomSamplingStorage__factory';
import { ShardingTableStorage__factory } from '../../typechain/factories/contracts/storage/ShardingTableStorage__factory';

/** The contracts that exist before the OT-RFC-27 deploy, as the Hub holds them. */
export type BaseContracts = {
  token: Token;
  chronos: Chronos;
  params: ParametersStorage;
  pcs: PublishingConvictionStorage;
  nft: DKGPublishingConvictionNFT;
  css: ConvictionStakingStorage;
  rss: RandomSamplingStorage;
  ids: IdentityStorage;
  ps: ProfileStorage;
  sts: ShardingTableStorage;
  snft: DKGStakingConvictionNFT;
  es: EpochStorage;
  /** The contract the Hub holds as RandomSampling, which writes the proof scores. */
  randomSampling: string;
};

/** The OT-RFC-27 contracts, new and upgraded, as the Hub holds them after the deploy. */
export type PoolContracts = {
  pc: PublishingConviction;
  ss: ServiceSubscriptions;
  ssw: ServiceSubscriptionsWallet;
  cssvc: ConvictionServiceStorage;
  qis: QueryInferenceStorage;
  qs: QueryInferenceSettlement;
  sv10: StakingV10;
  kpi: StakingKPI;
  ledger: StakingV10Ledger;
  cws: ConvictionWithdrawalStorage;
};

export type Contracts = BaseContracts & PoolContracts;

/** The contracts the deploy adds to the Hub. */
export const NEW_CONTRACTS: readonly string[] = [
  'ConvictionServiceStorage',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'QueryInferenceStorage',
  'QueryInferenceSettlement',
  'StakingV10Ledger',
  'ConvictionWithdrawalStorage',
];

/** The version of each contract after the deploy. */
export const EXPECTED_VERSIONS: Readonly<Record<string, string>> = {
  ConvictionServiceStorage: '1.2.0',
  ServiceSubscriptions: '1.2.0',
  ServiceSubscriptionsWallet: '1.0.0',
  QueryInferenceStorage: '1.0.0',
  QueryInferenceSettlement: '1.0.0',
  StakingV10Ledger: '1.0.0',
  ConvictionWithdrawalStorage: '1.0.0',
  PublishingConviction: '10.2.0',
  StakingV10: '10.1.0',
  StakingKPI: '10.1.0',
};

/** A generated factory: what it connects has the type of the ABI it holds. */
export type FactoryOf<T> = { connect(address: string, runner?: ContractRunner | null): T };

/** The stack behind one Hub. */
export class Stack {
  private constructor(
    private readonly hre: HardhatRuntimeEnvironment,
    readonly hub: Hub,
    private readonly runner: ContractRunner,
  ) {}

  static async at(hre: HardhatRuntimeEnvironment, hubAddress: string): Promise<Stack> {
    if ((await hre.ethers.provider.getCode(hubAddress)) === '0x') throw new Error(`no Hub at ${hubAddress} on this chain`);
    // As hardhat's getContractAt: the first signer if there is one, otherwise read-only.
    const [first] = await hre.ethers.getSigners();
    const runner: ContractRunner = first ?? hre.ethers.provider;
    return new Stack(hre, Hub__factory.connect(hubAddress, runner), runner);
  }

  /** The contract at `address`. */
  connect<T>(factory: FactoryOf<T>, address: string): T {
    return factory.connect(address, this.runner);
  }

  /** The contract the Hub holds under `hubName`, which may be an alias of the artifact's name, as `EpochStorageV8` is. */
  async held<T>(factory: FactoryOf<T>, hubName: string): Promise<T> {
    return this.connect(factory, await this.addr(hubName));
  }

  addr(name: string): Promise<string> {
    return this.hub.getContractAddress(name);
  }

  holds(name: string): Promise<boolean> {
    return this.hub['isContract(string)'](name);
  }

  async versionAt(address: string): Promise<string> {
    try {
      const c = await this.hre.ethers.getContractAt(['function version() view returns (string)'], address);
      return String(await c.getFunction('version').staticCall());
    } catch {
      return 'none';
    }
  }

  /** The new contracts the Hub does not hold yet: none once the deploy and the Hub transaction are in. */
  async missing(): Promise<string[]> {
    const out: string[] = [];
    for (const n of NEW_CONTRACTS) if (!(await this.holds(n))) out.push(n);
    return out;
  }

  async base(): Promise<BaseContracts> {
    return {
      token: await this.held(Token__factory, 'Token'),
      chronos: await this.held(Chronos__factory, 'Chronos'),
      params: await this.held(ParametersStorage__factory, 'ParametersStorage'),
      pcs: await this.held(PublishingConvictionStorage__factory, 'PublishingConvictionStorage'),
      nft: await this.held(DKGPublishingConvictionNFT__factory, 'DKGPublishingConvictionNFT'),
      css: await this.held(ConvictionStakingStorage__factory, 'ConvictionStakingStorage'),
      rss: await this.held(RandomSamplingStorage__factory, 'RandomSamplingStorage'),
      ids: await this.held(IdentityStorage__factory, 'IdentityStorage'),
      ps: await this.held(ProfileStorage__factory, 'ProfileStorage'),
      sts: await this.held(ShardingTableStorage__factory, 'ShardingTableStorage'),
      snft: await this.held(DKGStakingConvictionNFT__factory, 'DKGStakingConvictionNFT'),
      es: await this.held(EpochStorage__factory, 'EpochStorageV8'),
      randomSampling: await this.addr('RandomSampling'),
    };
  }

  async pool(): Promise<PoolContracts> {
    return {
      pc: await this.held(PublishingConviction__factory, 'PublishingConviction'),
      ss: await this.held(ServiceSubscriptions__factory, 'ServiceSubscriptions'),
      ssw: await this.held(ServiceSubscriptionsWallet__factory, 'ServiceSubscriptionsWallet'),
      cssvc: await this.held(ConvictionServiceStorage__factory, 'ConvictionServiceStorage'),
      qis: await this.held(QueryInferenceStorage__factory, 'QueryInferenceStorage'),
      qs: await this.held(QueryInferenceSettlement__factory, 'QueryInferenceSettlement'),
      sv10: await this.held(StakingV10__factory, 'StakingV10'),
      kpi: await this.held(StakingKPI__factory, 'StakingKPI'),
      ledger: await this.held(StakingV10Ledger__factory, 'StakingV10Ledger'),
      cws: await this.held(ConvictionWithdrawalStorage__factory, 'ConvictionWithdrawalStorage'),
    };
  }
}

// Every interface whose errors a revert may carry.
const ERROR_SOURCES = [
  'Hub',
  'Token',
  'EpochStorage',
  'PublishingConviction',
  'DKGPublishingConvictionNFT',
  'StakingV10',
  'StakingV10Ledger',
  'StakingKPI',
  'QueryInferenceSettlement',
  'QueryInferenceStorage',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'ConvictionServiceStorage',
  'ConvictionStakingStorage',
  'ConvictionWithdrawalStorage',
  'DKGStakingConvictionNFT',
];
let errorInterfaces: Interface[] | undefined;

/** A revert's data, decoded against the stack's errors: `Name(arg, …)`. */
export async function decodeError(hre: HardhatRuntimeEnvironment, data: string | undefined): Promise<string> {
  if (!data || data === '0x') return 'revert (no data)';
  if (data.startsWith('0x4e487b71') && data.length === 74) return `Panic(0x${BigInt(`0x${data.slice(10)}`).toString(16)})`;
  errorInterfaces ??= await Promise.all(ERROR_SOURCES.map(async (n) => (await hre.ethers.getContractFactory(n)).interface));
  for (const i of errorInterfaces) {
    try {
      const e = i.parseError(data);
      if (e) return `${e.name}(${e.args.map((a: unknown) => String(a)).join(', ')})`;
    } catch {
      // not this interface's
    }
  }
  return `revert ${data.slice(0, 10)}`;
}

/** The revert data of an error thrown by a call or an estimate, wherever the provider put it. */
export function errorData(e: unknown): string | undefined {
  const at = (o: unknown, ...keys: string[]): unknown =>
    keys.reduce<unknown>((x, k) => (typeof x === 'object' && x !== null && k in x ? (x as Record<string, unknown>)[k] : undefined), o);
  for (const c of [at(e, 'data'), at(e, 'error', 'data'), at(e, 'info', 'error', 'data'), at(e, 'error', 'error', 'data')]) {
    if (typeof c === 'string' && c.startsWith('0x')) return c;
    const inner = at(c, 'data');
    if (typeof inner === 'string' && inner.startsWith('0x')) return inner;
  }
  return undefined;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const short = (e as Error & { shortMessage?: unknown }).shortMessage;
    return typeof short === 'string' ? short : e.message;
  }
  return String(e);
}

export type EventArgs<E extends TypedContractEvent> = TypedLogDescription<E>['args'];

/** The `event` logs `contract` emitted in `receipt`, with typechain's types. */
export function eventsIn<E extends TypedContractEvent>(
  receipt: TransactionReceipt | null | undefined,
  contract: BaseContract,
  event: E,
): EventArgs<E>[] {
  if (!receipt) return [];
  const address = typeof contract.target === 'string' ? contract.target.toLowerCase() : '';
  const out: EventArgs<E>[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed && parsed.name === event.name) out.push(parsed.args as EventArgs<E>);
  }
  return out;
}
