// OT-RFC-27 script support: the contracts of the stack, resolved through the
// Hub at the address the tracked deployments file records for it, each with the
// typechain type of the artifact it is loaded from; revert decoding; typed events
// from a receipt.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { BaseContract, Interface, TransactionReceipt } from 'ethers';

import type {
  Chronos,
  ServiceSubscriptionsStorage,
  ConvictionStakingStorage,
  ConvictionWithdrawalStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  IdentityStorage,
  ParametersStorage,
  ProfileStorage,
  Profile,
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
  sss: ServiceSubscriptionsStorage;
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
  'ServiceSubscriptionsStorage',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'QueryInferenceStorage',
  'QueryInferenceSettlement',
  'StakingV10Ledger',
  'ConvictionWithdrawalStorage',
];

/** The version of each contract after the deploy. */
export const EXPECTED_VERSIONS: Readonly<Record<string, string>> = {
  ServiceSubscriptionsStorage: '1.2.0',
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

/**
 * The artifact each contract comes from, and the type that artifact's ABI gives
 * it: what is loaded under a name is typed by that name, with no type for a
 * caller to choose. Types only, so the scripts load no generated code: the ABI
 * is the current artifact's, as `hardhat compile` leaves it, which regenerates
 * no typechain.
 */
export type Artifacts = {
  Chronos: Chronos;
  ServiceSubscriptionsStorage: ServiceSubscriptionsStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ConvictionWithdrawalStorage: ConvictionWithdrawalStorage;
  DKGPublishingConvictionNFT: DKGPublishingConvictionNFT;
  DKGStakingConvictionNFT: DKGStakingConvictionNFT;
  EpochStorage: EpochStorage;
  Hub: Hub;
  IdentityStorage: IdentityStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  ProfileStorage: ProfileStorage;
  PublishingConviction: PublishingConviction;
  PublishingConvictionStorage: PublishingConvictionStorage;
  QueryInferenceSettlement: QueryInferenceSettlement;
  QueryInferenceStorage: QueryInferenceStorage;
  RandomSamplingStorage: RandomSamplingStorage;
  ServiceSubscriptions: ServiceSubscriptions;
  ServiceSubscriptionsWallet: ServiceSubscriptionsWallet;
  ShardingTableStorage: ShardingTableStorage;
  StakingKPI: StakingKPI;
  StakingV10: StakingV10;
  StakingV10Ledger: StakingV10Ledger;
  Token: Token;
};

/** The contract at `address`, with the ABI and the type of the artifact `name`. */
export async function contractAt<N extends keyof Artifacts>(hre: HardhatRuntimeEnvironment, name: N, address: string): Promise<Artifacts[N]> {
  return (await hre.ethers.getContractAt(name, address)) as unknown as Artifacts[N];
}

/** The stack behind one Hub. */
export class Stack {
  private constructor(
    private readonly hre: HardhatRuntimeEnvironment,
    readonly hub: Hub,
  ) {}

  static async at(hre: HardhatRuntimeEnvironment, hubAddress: string): Promise<Stack> {
    if ((await hre.ethers.provider.getCode(hubAddress)) === '0x') throw new Error(`no Hub at ${hubAddress} on this chain`);
    return new Stack(hre, await contractAt(hre, 'Hub', hubAddress));
  }

  /** The contract at `address`, of the artifact `name`. */
  connect<N extends keyof Artifacts>(name: N, address: string): Promise<Artifacts[N]> {
    return contractAt(this.hre, name, address);
  }

  /** The contract the Hub holds under `hubName`, by default its artifact's name; it may be an alias, as `EpochStorageV8` is. */
  async held<N extends keyof Artifacts>(name: N, hubName: string = name): Promise<Artifacts[N]> {
    return this.connect(name, await this.addr(hubName));
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
      token: await this.held('Token'),
      chronos: await this.held('Chronos'),
      params: await this.held('ParametersStorage'),
      pcs: await this.held('PublishingConvictionStorage'),
      nft: await this.held('DKGPublishingConvictionNFT'),
      css: await this.held('ConvictionStakingStorage'),
      rss: await this.held('RandomSamplingStorage'),
      ids: await this.held('IdentityStorage'),
      ps: await this.held('ProfileStorage'),
      sts: await this.held('ShardingTableStorage'),
      snft: await this.held('DKGStakingConvictionNFT'),
      es: await this.held('EpochStorage', 'EpochStorageV8'),
      randomSampling: await this.addr('RandomSampling'),
    };
  }

  async pool(): Promise<PoolContracts> {
    return {
      pc: await this.held('PublishingConviction'),
      ss: await this.held('ServiceSubscriptions'),
      ssw: await this.held('ServiceSubscriptionsWallet'),
      sss: await this.held('ServiceSubscriptionsStorage'),
      qis: await this.held('QueryInferenceStorage'),
      qs: await this.held('QueryInferenceSettlement'),
      sv10: await this.held('StakingV10'),
      kpi: await this.held('StakingKPI'),
      ledger: await this.held('StakingV10Ledger'),
      cws: await this.held('ConvictionWithdrawalStorage'),
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
  'ServiceSubscriptionsStorage',
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
