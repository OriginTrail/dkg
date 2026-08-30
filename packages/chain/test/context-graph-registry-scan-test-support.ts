import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import type {
  ContextGraphOnChain,
  ContextGraphRegistryScanCursorKey,
  ContextGraphRegistryScanOptions,
} from '../src/chain-adapter.js';

export function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

type OnceOutcome<R> = { type: 'return'; value: R } | { type: 'throw'; error: unknown };
export function seam<A extends unknown[], R>(initialImpl: (...args: A) => R) {
  const calls: A[] = [];
  const queue: OnceOutcome<R>[] = [];
  let impl = initialImpl;
  const fn = (...args: A): R => {
    calls.push(args);
    if (queue.length > 0) {
      const next = queue.shift() as OnceOutcome<R>;
      if (next.type === 'throw') throw next.error;
      return next.value;
    }
    return impl(...args);
  };
  return Object.assign(fn, {
    calls,
    setImpl(next: (...args: A) => R) {
      impl = next;
    },
    queueOnce(outcome: OnceOutcome<R>) {
      queue.push(outcome);
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      impl = (() => undefined as unknown as R) as (...args: A) => R;
    },
    clear() {
      calls.length = 0;
    },
  });
}

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
export const REGISTRY = '0x3333333333333333333333333333333333333333';

type RoleAwareTestCursorKey = ContextGraphRegistryScanCursorKey & {
  cursorKind: 'historical' | 'tip';
};

export class MemoryRegistryScanCursorStore {
  readonly values = new Map<string, number>();
  readonly loads: string[] = [];
  readonly saves: Array<{ key: string; nextBlock: number }> = [];

  async load(key: RoleAwareTestCursorKey): Promise<number | undefined> {
    const encoded = this.key(key);
    this.loads.push(encoded);
    return this.values.get(encoded);
  }

  async save(key: RoleAwareTestCursorKey, nextBlock: number): Promise<void> {
    const encoded = this.key(key);
    this.saves.push({ key: encoded, nextBlock });
    this.values.set(encoded, nextBlock);
  }

  private key(key: RoleAwareTestCursorKey): string {
    return `${key.chainId}|${key.deploymentId}|${key.cursorKind}|${key.registryAddress.toLowerCase()}`;
  }
}

export function registryCursorStores(store: {
  load(key: RoleAwareTestCursorKey): Promise<number | undefined>;
  save(key: RoleAwareTestCursorKey, nextBlock: number): Promise<void>;
}) {
  return {
    contextGraphRegistryScanCursorStore: {
      load: (key: ContextGraphRegistryScanCursorKey) => store.load({ ...key, cursorKind: 'historical' }),
      save: (key: ContextGraphRegistryScanCursorKey, nextBlock: number) =>
        store.save({ ...key, cursorKind: 'historical' }, nextBlock),
    },
    contextGraphRegistryTipScanCursorStore: {
      load: (key: ContextGraphRegistryScanCursorKey) => store.load({ ...key, cursorKind: 'tip' }),
      save: (key: ContextGraphRegistryScanCursorKey, nextBlock: number) =>
        store.save({ ...key, cursorKind: 'tip' }, nextBlock),
    },
  };
}

export function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

export function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getAddress: recorder(async () => REGISTRY),
    filters: { NameClaimed: recorder(() => 'NameClaimedFilter') },
    interface: {
      parseLog: recorder(({ data }: { data: string }) => {
        if (data === '0x01') {
          return {
            name: 'NameClaimed',
            args: {
              nameHash: '0xaaa0000000000000000000000000000000000000000000000000000000000001',
              creator: '0x1111111111111111111111111111111111111111',
              accessPolicy: 0,
            },
          };
        }
        return null;
      }),
    },
    queryFilter: seam(async (_filter: unknown, _lo: number, _hi: number) => [] as unknown[]),
    connect: recorder(() => undefined),
    ...overrides,
  } as any;
}

export function makeAdapter(registry: any, head = 0, config: Partial<EVMAdapterConfig> = {}) {
  const adapter = new EVMChainAdapter(minimalConfig(config));
  registry.connect = recorder(() => registry);
  const provider = {
    getBlockNumber: seam(async () => head),
    getCode: seam(async (_address: string, block?: number) =>
      block === undefined || block >= 0 ? '0x6000' : '0x',
    ),
  };
  (adapter as any).contracts = { contextGraphNameRegistry: registry };
  (adapter as any).initialized = true;
  (adapter as any).provider = provider;
  (adapter as any).providers = [provider];
  return { adapter, provider };
}

export async function collectRegistryScan(
  adapter: EVMChainAdapter,
  options: ContextGraphRegistryScanOptions,
): Promise<ContextGraphOnChain[]> {
  const results: ContextGraphOnChain[] = [];
  for await (const page of adapter.scanContextGraphRegistryPages(options)) {
    results.push(...page.contextGraphs);
    await page.ack();
  }
  return results;
}
