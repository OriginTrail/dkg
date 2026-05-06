import { ethers, JsonRpcProvider, Wallet, Contract, Interface } from 'ethers';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  UpdateKAParams,
  ExtendStorageParams,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  ContextGraphOnChain,
  PublishParams,
  OnChainPublishResult,
  KAUpdateVerification,
  CreateOnChainContextGraphParams,
  CreateOnChainContextGraphResult,
  VerifyParams,
  PublishToContextGraphParams,
  V10PublishDirectParams,
  V10UpdateKCParams,
  ConvictionAccountInfo,
  PermanentPublishParams,
  NodeChallenge,
  ProofPeriodStatus,
  CreateChallengeResult,
  OperationalWalletRegistrationResult,
} from './chain-adapter.js';
import {
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  MerkleRootMismatchError,
  ChallengeNoLongerActiveError,
} from './chain-adapter.js';
import { HubResolutionCache } from './hub-resolution-cache.js';

/**
 * Default TTL for re-resolving `RandomSampling` / `RandomSamplingStorage`
 * from the Hub. Matches the daemon auto-update poll cadence — small
 * enough that a missed `Hub.ContractChanged` event still self-heals
 * within ~5 min, large enough that the steady-state RPC overhead is
 * effectively zero (one extra `eth_call` every 5 min for the two
 * names, vs. the prover's per-tick reads). Override per-adapter via
 * `EVMAdapterConfig.randomSamplingHubRefreshMs`.
 */
const DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS = 5 * 60 * 1000;

/**
 * Hard ceiling for the best-effort live `getActiveProofingPeriodDurationInBlocks()`
 * read inside `getActiveProofPeriodStatus()`. The status read itself is one
 * `eth_call`; the duration probe is a sibling `eth_call` on the same provider
 * and should typically resolve in <100ms. If it hasn't returned in 2s the
 * provider is slow or hanging — fall back to `undefined` and let the prover
 * use the cached `existing.proofingPeriodDurationInBlocks` rather than
 * stalling the whole tick. Codex round 5 on PR #369.
 */
const DURATION_PROBE_TIMEOUT_MS = 2000;

/**
 * Upper bound on the in-flight duration probe slot age. The single-flight
 * guard reuses a pending probe to bound RPC cardinality at 1, but if the
 * underlying `eth_call` never settles (hung provider, dropped websocket)
 * the slot would otherwise stay populated forever and suppress every
 * fresh probe. After this many ms we abandon the slot regardless and
 * let the next call start a new probe — capping leaked-handle growth
 * to one per `MAX_PROBE_AGE_MS` window instead of one per tick. Set
 * generously above `DURATION_PROBE_TIMEOUT_MS` so honest slow paths
 * (high RPC latency, congested chain) still benefit from single-flight.
 * Codex round 8 on PR #369.
 */
const MAX_PROBE_AGE_MS = 30_000;

/**
 * Substrings we treat as "the Hub no longer recognises this contract
 * as a registered participant" — i.e. the cached address is stale and
 * the next call should re-resolve from the Hub. Conservative match on
 * the canonical revert wording from `ContractStatus.onlyContracts` /
 * `UnauthorizedAccess(Only Contracts in Hub)` so we don't accidentally
 * drop the cache on an unrelated authorization failure.
 */
const HUB_STALE_ERROR_MARKERS = [
  'Only Contracts in Hub',
  'UnauthorizedAccess(Only Contracts in Hub)',
];

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const localAbiDir = join(__dirname, '..', 'abi');

function loadAbi(contractName: string): ethers.InterfaceAbi {
  const localPath = join(localAbiDir, `${contractName}.json`);
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, 'utf-8'));
  }
  return require(`@origintrail-official/dkg-evm-module/abi/${contractName}.json`);
}

const ERROR_ABI_CONTRACTS = [
  'KnowledgeAssets', 'KnowledgeAssetsV10', 'KnowledgeAssetsStorage', 'KnowledgeCollection',
  'KnowledgeCollectionStorage', 'ContextGraphs', 'ContextGraphStorage',
  'ContextGraphNameRegistry', 'Profile', 'Identity', 'IdentityStorage',
  'Staking', 'StakingStorage', 'StakingV10', 'StakingKPI',
  'ConvictionStakingStorage',
  'DKGStakingConvictionNFT', 'DKGPublishingConvictionNFT',
  'Hub', 'Token', 'Ask', 'AskStorage',
  'Paymaster', 'ShardingTable', 'ParametersStorage',
  'PublishingConvictionAccount',
  'RandomSampling', 'RandomSamplingStorage',
];

const ADMIN_KEY_PURPOSE = 1;
const OPERATIONAL_KEY_PURPOSE = 2;

let _errorInterface: Interface | null = null;

function getErrorInterface(): Interface {
  if (_errorInterface) return _errorInterface;
  const errorFragments: string[] = [];
  for (const name of ERROR_ABI_CONTRACTS) {
    try {
      const abi = loadAbi(name) as any[];
      for (const entry of abi) {
        if (entry.type === 'error') {
          const params = (entry.inputs ?? []).map((i: any) => `${i.type} ${i.name}`).join(', ');
          errorFragments.push(`error ${entry.name}(${params})`);
        }
      }
    } catch { /* ABI not available */ }
  }
  _errorInterface = new Interface([...new Set(errorFragments)]);
  return _errorInterface;
}

/**
 * Decode an EVM custom error selector into a human-readable string.
 * Returns null if the selector doesn't match any known contract error.
 */
export function decodeEvmError(data: string | Uint8Array): { name: string; args: ethers.Result } | null {
  try {
    const hex = typeof data === 'string' ? data : ethers.hexlify(data);
    if (hex.length < 10) return null;
    const parsed = getErrorInterface().parseError(hex);
    return parsed ? { name: parsed.name, args: parsed.args } : null;
  } catch {
    return null;
  }
}

/**
 * Enrich a caught EVM error with a decoded custom error name.
 * Modifies the error message in-place and returns the decoded name (if any).
 */
export function enrichEvmError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // Match the revert-data hex across the RPC-shape variants we see in the
  // wild. CH-10:
  //   - Hardhat:        ... data="0x..."             (key="value", quoted)
  //   - Geth:           ... data: "0x..."            (key: value, JS-object)
  //   - Geth no-quote:  ... data=0x...               (key=value, unquoted)
  //   - Infura/Alchemy: ... errorData="0x..."        (errorData= prefix)
  //   - JSON body:      ... "data":"0x..."           (JSON-encoded provider error)
  // Leading non-letter (or string start) ensures `errorData` doesn't match
  // as `data`. Separator class accepts any combination of `=`, `:`, `"`,
  // `'`, whitespace.
  const match = err.message.match(
    /(?:^|[^a-zA-Z])(?:errorData|data)["':=\s]+(0x[0-9a-fA-F]+)/,
  );
  if (!match) return null;
  const decoded = decodeEvmError(match[1]);
  if (!decoded) return null;
  const argsStr = decoded.args.length > 0 ? `(${decoded.args.join(', ')})` : '';
  const decodedStr = `${decoded.name}${argsStr}`;
  err.message = err.message.replace('unknown custom error', decodedStr);
  return decoded.name;
}

interface EVMAdapterBaseConfig {
  rpcUrl: string;
  /** Primary operational wallet key (used for identity registration, staking, etc.) */
  privateKey: string;
  /** Additional operational wallet keys for parallel transaction submission. */
  additionalKeys?: string[];
  hubAddress: string;
  chainId?: string;
  /**
   * TTL (ms) for re-resolving `RandomSampling` / `RandomSamplingStorage`
   * addresses from the Hub. Defaults to 5 minutes. Values `<= 0` are
   * treated as "use default" and intentionally NOT supported as a
   * "disable periodic refresh" mode: even with the Hub event listener
   * and the `Only Contracts in Hub` retry wrapper, a missed event on
   * a read-only path (e.g. `getActiveProofPeriodStatus`,
   * `getNodeChallenge`) would leave the adapter pinned to a stale
   * address until restart, exactly the failure mode this cache exists
   * to prevent. The TTL is a backstop, not the primary refresh
   * mechanism — keep it short enough that a missed rotation
   * self-heals within minutes and the steady-state RPC overhead is
   * still effectively zero.
   */
  randomSamplingHubRefreshMs?: number;
}

export interface EVMAdapterConfig extends EVMAdapterBaseConfig {
  /** Admin wallet key used for profile/key-management transactions. */
  adminPrivateKey?: string;
  /**
   * Documents that this adapter is intentionally running without admin
   * authority. Missing admin keys are still accepted for backwards-compatible
   * publish/read-only usage; admin-only operations fail when invoked.
   */
  allowNoAdminSigner?: boolean;
}

interface ContractCache {
  hub: Contract;
  identity?: Contract;
  profile?: Contract;
  knowledgeAssets?: Contract;
  knowledgeAssetsStorage?: Contract;
  knowledgeCollection?: Contract;
  knowledgeCollectionStorage?: Contract;
  staking?: Contract;
  contextGraphNameRegistry?: Contract;
  token?: Contract;
  parametersStorage?: Contract;
  askStorage?: Contract;
  contextGraphs?: Contract;
  contextGraphStorage?: Contract;
  knowledgeAssetsV10?: Contract;
  publishingConvictionAccount?: Contract;
  randomSampling?: Contract;
  randomSamplingStorage?: Contract;
}

/**
 * EVM chain adapter implementing the V9 ChainAdapter interface.
 * Resolves contract addresses dynamically from the Hub.
 */
export class EVMChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId: string;

  private readonly provider: JsonRpcProvider;
  /** Primary signer — used for identity/profile/staking operations. */
  private readonly signer: Wallet;
  /** All operational signers (includes primary). Used round-robin for publish TXs. */
  private readonly signerPool: Wallet[];
  /** Admin signer — used only for profile/key-management operations. */
  private readonly adminSigner?: Wallet;
  private signerIndex = 0;
  private signerSelectionQueue: Promise<void> = Promise.resolve();
  private readonly hubAddress: string;
  private contracts: ContractCache;
  private initialized = false;
  /**
   * Single self-refreshing cache for the `RandomSampling` /
   * `RandomSamplingStorage` pair. RS is the highest-value Hub-resolved
   * surface (it gates per-period proof rewards), so it gets stricter
   * freshness guarantees than the one-shot resolution every other
   * contract uses.
   *
   * The two addresses are deliberately treated as a **coupled unit**
   * because `RandomSampling.initialize()` snapshots its
   * `RandomSamplingStorage` address once at deploy time. If the
   * adapter ever held a mixed pair (e.g. new RS + old RSS, or the
   * inverse) `createChallenge()` would write through one contract
   * and `getNodeChallenge()` would read from the other — producing
   * the empty-struct / state-mismatch failures the prover already
   * has a defensive guard against. Resolving both names atomically
   * inside one cache eliminates that race.
   *
   * See `HubResolutionCache` for the semantics; the listener
   * installed in `init()` invalidates this cache on
   * `Hub.ContractChanged` / `Hub.NewContract` for **either** name,
   * and `withHubStaleRetry()` invalidates it when a write surfaces
   * `UnauthorizedAccess(Only Contracts in Hub)`.
   */
  private readonly randomSamplingPairCache: HubResolutionCache<{ rs: Contract; rss: Contract }>;
  private hubRotationListenerStarted = false;
  /**
   * Single-flight guard for the best-effort
   * `getActiveProofingPeriodDurationInBlocks()` probe inside
   * `getActiveProofPeriodStatus()`. Codex round 5 on PR #369: the
   * 2s `Promise.race` timeout returns `undefined` to the caller but
   * the underlying `eth_call` is NOT cancellable in ethers v6, so
   * naively issuing one new probe per tick would accumulate one
   * stuck request per tick on a hung provider. Instead we reuse the
   * same in-flight promise across overlapping calls — at most one
   * probe is ever pending against the provider at a time.
   *
   * Codex round 8 on PR #369: also track the `RandomSampling`
   * Contract instance the probe was started against AND a wall-clock
   * creation timestamp.
   *   - Contract-identity guard: a TTL refresh of
   *     `randomSamplingPairCache` re-resolves `rs` to a freshly
   *     constructed `Contract` instance WITHOUT calling
   *     `invalidateRandomSamplingPair()`. The HubResolutionCache
   *     generation counter is invalidate-only (it is also used by
   *     `resolveAndAssignRandomSamplingPair()` to detect concurrent
   *     invalidations, so it must NOT bump on normal refreshes), so
   *     it can't signal a TTL refresh. Comparing the resolved
   *     Contract instance by reference is the canonical check: a
   *     refresh always hands back a new instance.
   *   - Max-age guard: `Promise.race` returns `undefined` to the
   *     caller on timeout, but the underlying `eth_call` may
   *     never settle (truly hung provider). Without an upper
   *     bound on slot age, a single hung probe would suppress
   *     every fresh probe forever. After `MAX_PROBE_AGE_MS` we
   *     abandon the slot regardless; the orphan promise still has
   *     its `.finally` attached but the slot identity check inside
   *     it correctly does nothing.
   */
  private inflightDurationProbe: Promise<bigint | undefined> | undefined;
  private inflightDurationProbeContract: Contract | undefined;
  private inflightDurationProbeStartedAt = 0;

  constructor(config: EVMAdapterConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
    this.signer = new Wallet(config.privateKey, this.provider);
    this.signerPool = [this.signer];
    for (const key of config.additionalKeys ?? []) {
      this.signerPool.push(new Wallet(key, this.provider));
    }
    if (config.adminPrivateKey) {
      this.adminSigner = new Wallet(config.adminPrivateKey, this.provider);
      const adminAddress = this.adminSigner.address.toLowerCase();
      if (this.signerPool.some((signer) => signer.address.toLowerCase() === adminAddress)) {
        throw new Error('EVM adminPrivateKey must be distinct from operational keys');
      }
    }
    this.hubAddress = config.hubAddress;
    this.chainId = config.chainId ?? 'evm:31337';

    this.contracts = {
      hub: new Contract(config.hubAddress, loadAbi('Hub'), this.signer),
    };

    // Coerce `<=0` to the default. The "disable refresh entirely" mode
    // is intentionally unsupported (see `randomSamplingHubRefreshMs`
    // doc above) — without a TTL backstop, a missed Hub event on a
    // read-only path (`getActiveProofPeriodStatus`, `getNodeChallenge`)
    // would silently pin the adapter to a stale address until restart.
    const rawRsRefreshMs = config.randomSamplingHubRefreshMs ?? DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS;
    const rsRefreshMs = rawRsRefreshMs > 0 ? rawRsRefreshMs : DEFAULT_RANDOM_SAMPLING_HUB_REFRESH_MS;
    this.randomSamplingPairCache = new HubResolutionCache(
      async () => {
        // Resolve both names in a single round (Promise.all) so that
        // the cache only ever holds a coherent pair: when this
        // resolves, both addresses came from the same Hub view.
        const [rs, rss] = await Promise.all([
          this.resolveContract('RandomSampling'),
          this.resolveContract('RandomSamplingStorage'),
        ]);
        return { rs, rss };
      },
      { ttlMs: rsRefreshMs },
    );
  }

  /** Pick the next signer from the pool (round-robin). */
  private nextSigner(): Wallet {
    const s = this.signerPool[this.signerIndex % this.signerPool.length];
    this.signerIndex++;
    return s;
  }

  private findSignerByAddress(address: string): Wallet | undefined {
    const normalized = ethers.getAddress(address).toLowerCase();
    return this.signerPool.find((signer) => signer.address.toLowerCase() === normalized);
  }

  /**
   * Pick the next signer in the pool that the on-chain ContextGraphs contract
   * authorizes for the target context graph. Falls back to round-robin only
   * when the auth surface is unavailable.
   */
  private async nextAuthorizedSigner(contextGraphId: bigint): Promise<Wallet> {
    const previousSelection = this.signerSelectionQueue;
    let releaseSelection!: () => void;
    this.signerSelectionQueue = new Promise<void>((resolve) => { releaseSelection = resolve; });
    await previousSelection;
    try {
      if (!this.contracts.contextGraphs) {
        return this.nextSigner();
      }

      const start = this.signerIndex % this.signerPool.length;
      for (let i = 0; i < this.signerPool.length; i += 1) {
        const idx = (start + i) % this.signerPool.length;
        const signer = this.signerPool[idx];
        const authorized = await this.contracts.contextGraphs.isAuthorizedPublisher(contextGraphId, signer.address);
        if (authorized) {
          this.signerIndex = idx + 1;
          return signer;
        }
      }

      throw new Error(
        `No authorized publisher wallet found in signer pool for context graph ${contextGraphId.toString()}. ` +
        'Ensure at least one configured wallet is permitted by on-chain publish authority.',
      );
    } finally {
      releaseSelection();
    }
  }

  /**
   * Reserve the next authorized signer and return its address. The publisher
   * uses this to bind off-chain signatures to the tx signer before
   * `publishDirect` is submitted.
   */
  async getAuthorizedPublisherAddress(contextGraphId: bigint): Promise<string> {
    await this.init();

    return (await this.nextAuthorizedSigner(contextGraphId)).address;
  }

  /** All operational wallet addresses (for display / funding). */
  getSignerAddresses(): string[] {
    return this.signerPool.map((s) => s.address);
  }

  /** Primary operational private key (hex string with 0x prefix). */
  getOperationalPrivateKey(): string {
    return this.signer.privateKey;
  }

  private walletKeyHash(address: string): string {
    return ethers.keccak256(ethers.solidityPacked(['address'], [ethers.getAddress(address)]));
  }

  private async hasAdminPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return identityStorage.keyHasPurpose(
      identityId,
      this.walletKeyHash(address),
      ADMIN_KEY_PURPOSE,
    );
  }

  private async hasOperationalPurpose(
    identityStorage: Contract,
    identityId: bigint,
    address: string,
  ): Promise<boolean> {
    return identityStorage.keyHasPurpose(
      identityId,
      this.walletKeyHash(address),
      OPERATIONAL_KEY_PURPOSE,
    );
  }

  async isOperationalWalletRegistered(identityId: bigint, address: string): Promise<boolean> {
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    return this.hasOperationalPurpose(identityStorage, identityId, address);
  }

  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult> {
    await this.init();

    const identityId = options?.identityId ?? (await this.getIdentityId());
    const result: OperationalWalletRegistrationResult = {
      identityId,
      registered: [],
      alreadyRegistered: [],
      taken: [],
    };
    if (identityId === 0n) return result;

    const identityStorage = await this.resolveContract('IdentityStorage');
    const candidates = [
      ...this.signerPool.map((s) => s.address),
      ...(options?.additionalAddresses ?? []),
    ];
    const seen = new Set<string>();
    const missing: string[] = [];

    for (const candidate of candidates) {
      const address = ethers.getAddress(candidate);
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const existingIdentityId = BigInt(await identityStorage.getIdentityId(address));
      if (existingIdentityId === identityId) {
        result.alreadyRegistered.push(address);
      } else if (existingIdentityId === 0n) {
        missing.push(address);
      } else {
        result.taken.push({ address, identityId: existingIdentityId });
      }
    }

    if (missing.length === 0) return result;

    if (!this.adminSigner) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: ` +
        'adminPrivateKey is not configured.',
      );
    }
    if (!(await this.hasAdminPurpose(identityStorage, identityId, this.adminSigner.address))) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: configured admin wallet ` +
        `${this.adminSigner.address} is not registered on-chain as an admin key for this identity.`,
      );
    }

    const profile = this.contracts.profile!.connect(this.adminSigner) as Contract;
    const tx = await profile.addOperationalWallets(identityId, missing);
    await tx.wait();

    for (const address of missing) {
      if (await this.hasOperationalPurpose(identityStorage, identityId, address)) {
        result.registered.push(address);
      }
    }

    return result;
  }

  private async resolveContract(name: string, abiName?: string): Promise<Contract> {
    let address: string;
    try {
      address = await this.contracts.hub.getContractAddress(name);
    } catch (err) {
      if (this.isContractMissingRevert(err)) {
        throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`, { cause: err });
      }
      throw err;
    }
    if (address === ethers.ZeroAddress) {
      throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  private async resolveAssetStorage(name: string, abiName?: string): Promise<Contract> {
    let address: string;
    try {
      address = await this.contracts.hub.getAssetStorageAddress(name);
    } catch (err) {
      if (this.isContractMissingRevert(err)) {
        throw new Error(`Asset storage "${name}" not found in Hub at ${this.hubAddress}`, { cause: err });
      }
      throw err;
    }
    if (address === ethers.ZeroAddress) {
      throw new Error(`Asset storage "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  /**
   * The current Hub implementation reverts with `ContractDoesNotExist(name)`
   * (custom error from `UnorderedNamedContractDynamicSet.get`) when a name
   * is missing, instead of returning `address(0)`. We normalise both
   * shapes onto the legacy `Contract "X" not found in Hub at <addr>` marker
   * so downstream code (`getRandomSampling()`'s catch block) only needs
   * to recognise one wording.
   */
  private isContractMissingRevert(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    enrichEvmError(err);
    return err.message.includes('ContractDoesNotExist')
      || err.message.includes('AddressDoesNotExist');
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    this.contracts.identity = await this.resolveContract('Identity');
    this.contracts.profile = await this.resolveContract('Profile');
    this.contracts.staking = await this.resolveContract('Staking');
    this.contracts.parametersStorage = await this.resolveContract('ParametersStorage');

    // V8 legacy contracts
    this.contracts.knowledgeCollection = await this.resolveContract('KnowledgeCollection');
    this.contracts.knowledgeCollectionStorage = await this.resolveAssetStorage('KnowledgeCollectionStorage');

    // V9 contracts (may not be deployed yet on older nodes)
    try {
      this.contracts.knowledgeAssets = await this.resolveContract('KnowledgeAssets');
      this.contracts.knowledgeAssetsStorage = await this.resolveAssetStorage('KnowledgeAssetsStorage');
      this.contracts.askStorage = await this.resolveContract('AskStorage');
    } catch {
      // V9 contracts not deployed — adapter works in V8-only mode
    }

    try {
      this.contracts.contextGraphNameRegistry = await this.resolveContract('ContextGraphNameRegistry');
    } catch {
      // ContextGraphNameRegistry not registered in Hub — createContextGraph/listContextGraphsFromChain unavailable
    }

    try {
      this.contracts.contextGraphs = await this.resolveContract('ContextGraphs');
      this.contracts.contextGraphStorage = await this.resolveAssetStorage('ContextGraphStorage');
    } catch {
      // ContextGraphs not deployed — context graph operations unavailable
    }

    try {
      this.contracts.knowledgeAssetsV10 = await this.resolveContract('KnowledgeAssetsV10');
    } catch {
      // V10 contract not deployed — createKnowledgeAssetsV10 unavailable
    }

    try {
      this.contracts.publishingConvictionAccount = await this.resolveContract('PublishingConvictionAccount');
    } catch {
      // PublishingConvictionAccount not deployed — conviction account operations unavailable
    }

    try {
      await this.resolveAndAssignRandomSamplingPair();
    } catch {
      // RandomSampling not deployed — proof submission unavailable
    }

    await this.startHubRotationListener();

    const tokenAddress: string = await this.contracts.hub.getContractAddress('Token');
    if (tokenAddress !== ethers.ZeroAddress) {
      this.contracts.token = new Contract(
        tokenAddress,
        [
          'function approve(address,uint256) returns (bool)',
          'function balanceOf(address) view returns (uint256)',
          'function allowance(address,address) view returns (uint256)',
        ],
        this.signer,
      );
    }

    this.initialized = true;
  }

  private requireV9(): void {
    if (!this.contracts.knowledgeAssets || !this.contracts.knowledgeAssetsStorage) {
      throw new Error(
        'V9 contracts (KnowledgeAssets, KnowledgeAssetsStorage) not deployed. ' +
        'Deploy them first using the deploy scripts.',
      );
    }
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.provider.getBlock(blockNumber);
    return block?.timestamp ?? 0;
  }

  // =====================================================================
  // Identity
  // =====================================================================

  async getIdentityId(): Promise<bigint> {
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    const id: bigint = await identityStorage.getIdentityId(this.signer.address);
    return id;
  }

  async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    await this.init();

    let identityId = await this.getIdentityId();

    // Step 1: Create profile if none exists
    if (identityId === 0n) {
      const nodeName = options?.nodeName ?? `node-${Date.now()}`;
      if (!this.adminSigner) {
        throw new Error(
          'Cannot create profile: adminPrivateKey is required so the profile admin key is not lost.',
        );
      }
      const nodeId = ethers.hexlify(ethers.randomBytes(32));

      const tx = await this.contracts.profile!.createProfile(
        this.adminSigner.address,
        [],
        nodeName,
        nodeId,
        0,
      );
      const receipt = await tx.wait();

      for (const log of receipt.logs) {
        try {
          const parsed = this.contracts.identity!.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed?.name === 'IdentityCreated') {
            identityId = BigInt(parsed.args.identityId);
            break;
          }
        } catch { /* not this contract */ }
      }

      if (identityId === 0n) {
        throw new Error('Profile created but no IdentityCreated event found');
      }
    }

    // Step 2: Stake via V10 path (separate try/catch so profile isn't lost).
    //
    // V10 consolidation (v4.0.0): stake routes through
    // `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`,
    // which mints a V10 NFT position, writes `nodeStakeV10` in
    // `ConvictionStakingStorage`, and pulls TRAC into the V10 vault (CSS) via
    // `StakingV10`. The legacy V8 `Staking.stake` path updates only V8
    // `StakingStorage` and leaves `nodeStakeV10 = 0`, so
    // `RandomSampling.calculateNodeScore` (which reads `getNodeStakeV10`
    // exclusively) computes zero and node scores never grow — exactly the
    // bug we just chased on devnet. This path mirrors `scripts/devnet.sh`.
    //
    // TRAC allowance must go to `StakingV10` (the actual `transferFrom`
    // caller), NOT to the NFT — the NFT is only the entry point and never
    // custodies TRAC.
    const stakeAmount = options?.stakeAmount ?? ethers.parseEther('50000');
    const lockTier = options?.lockTier ?? 1; // tier 1 = 1-month, cheapest non-zero multiplier
    if (stakeAmount > 0n && this.contracts.token) {
      try {
        const stakingNFT = await this.resolveContract('DKGStakingConvictionNFT');
        const stakingV10Addr: string = await this.contracts.hub.getContractAddress('StakingV10');
        if (stakingV10Addr === ethers.ZeroAddress) {
          throw new Error('StakingV10 not registered in Hub — V10 staking unavailable');
        }
        const approveTx = await this.contracts.token.approve(stakingV10Addr, stakeAmount);
        await approveTx.wait();
        // Wait an extra block for state propagation on public RPCs
        await new Promise(r => setTimeout(r, 2000));

        const stakeTx = await stakingNFT.createConviction(identityId, stakeAmount, lockTier);
        await stakeTx.wait();
      } catch (err) {
        console.warn(
          `[ensureProfile] V10 staking failed for identity ${identityId} (profile exists, stake manually via DKGStakingConvictionNFT.createConviction): ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return identityId;
  }

  async registerIdentity(proof: IdentityProof): Promise<bigint> {
    await this.init();
    if (!this.adminSigner) {
      throw new Error(
        'Cannot register identity: adminPrivateKey is required so the profile admin key is not lost.',
      );
    }
    const nodeName = `node-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
    const nodeId = proof.publicKey.length > 0 ? proof.publicKey : ethers.randomBytes(32);

    const tx = await this.contracts.profile!.createProfile(
      this.adminSigner.address,
      [],
      nodeName,
      nodeId,
      0,
    );
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.identity!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'IdentityCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.profile!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ProfileCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    throw new Error('Identity registration succeeded but no identity ID found in events');
  }

  // =====================================================================
  // V9: UAL Reservation
  // =====================================================================

  async reserveUALRange(count: number): Promise<ReservedRange> {
    await this.init();
    this.requireV9();

    const tx = await this.contracts.knowledgeAssets!.reserveUALRange(count);
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'UALRangeReserved') {
          return {
            startId: BigInt(parsed.args.startId),
            endId: BigInt(parsed.args.endId),
          };
        }
      } catch { /* not this contract */ }
    }

    throw new Error('reserveUALRange succeeded but no UALRangeReserved event found');
  }

  // =====================================================================
  // V9: Batch Minting
  // =====================================================================

  async batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;
    const kaAddress = await ka.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await this.contracts.token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const tx = await ka.batchMintKnowledgeAssets(
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.startKAId,
      params.endKAId,
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress, // paymaster
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();

    let batchId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          break;
        }
      } catch { /* not this contract */ }
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      batchId,
    };
  }

  // =====================================================================
  // V9: Single-tx Publish (reserve + mint)
  // =====================================================================

  async publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult> {
    await this.init();
    this.requireV9();

    const txSigner = this.nextSigner();
    const ka = this.contracts.knowledgeAssets!.connect(txSigner) as Contract;
    const kaAddress = await this.contracts.knowledgeAssets!.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token.connect(txSigner) as Contract;
      const currentAllowance: bigint = await token.allowance(txSigner.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const tx = await ka.publishKnowledgeAssets(
      params.kaCount,
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress, // paymaster
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = txSigner.address;

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
        }
      } catch { /* not this contract */ }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    const gasUsed = BigInt(receipt.gasUsed);
    const effectiveGasPrice = BigInt(receipt.gasPrice);
    const gasCostWei = gasUsed * effectiveGasPrice;

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
      gasUsed,
      effectiveGasPrice,
      gasCostWei,
    };
  }

  // =====================================================================
  // V9: Knowledge Updates
  // =====================================================================

  async updateKnowledgeAssets(params: UpdateKAParams): Promise<TxResult> {
    await this.init();
    this.requireV9();

    let signer: Wallet | undefined;

    // The contract requires the original publisher to call update.
    // Query the on-chain batch publisher and select the matching signer.
    const storage = this.contracts.knowledgeAssetsStorage;
    if (storage) {
      try {
        const onChainPublisher: string = await storage.getBatchPublisher(params.batchId);
        if (onChainPublisher && onChainPublisher !== ethers.ZeroAddress) {
          signer = this.signerPool.find(
            (s) => s.address.toLowerCase() === onChainPublisher.toLowerCase(),
          );
        }
      } catch {
        // Fall through to hint-based or round-robin
      }
    }

    // Fallback: use the hint from the publisher if chain lookup failed
    if (!signer && params.publisherAddress) {
      signer = this.signerPool.find(
        (s) => s.address.toLowerCase() === params.publisherAddress!.toLowerCase(),
      );
    }
    if (!signer) signer = this.nextSigner();

    const ka = this.contracts.knowledgeAssets!.connect(signer) as Contract;

    const tx = await ka.updateKnowledgeAssets(
      params.batchId,
      ethers.hexlify(params.newMerkleRoot),
      params.newPublicByteSize,
    );

    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      publisherAddress: signer.address,
    };
  }

  // =====================================================================
  // V9: Update Verification (for gossip receivers)
  // =====================================================================

  async verifyKAUpdate(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage && !this.contracts.knowledgeCollectionStorage) {
      return { verified: false };
    }

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return { verified: false };

      let onChainMerkleRoot: Uint8Array | undefined;

      // V9: KnowledgeBatchUpdated on KnowledgeAssetsStorage
      if (!onChainMerkleRoot && this.contracts.knowledgeAssetsStorage) {
        const storage = this.contracts.knowledgeAssetsStorage;
        const storageAddress = (await storage.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== storageAddress) continue;
          try {
            const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'KnowledgeBatchUpdated' && BigInt(parsed.args.batchId) === batchId) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.newMerkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      // V10: KnowledgeCollectionUpdated on KnowledgeCollectionStorage
      if (!onChainMerkleRoot && this.contracts.knowledgeCollectionStorage) {
        const kcs = this.contracts.knowledgeCollectionStorage;
        const kcsAddress = (await kcs.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== kcsAddress) continue;
          try {
            const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'KnowledgeCollectionUpdated' && BigInt(parsed.args.id) === batchId) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.merkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      if (!onChainMerkleRoot) return { verified: false };

      // Check publisher address: try V10 storage first, then V9
      let onChainPublisher: string | undefined;
      if (this.contracts.knowledgeCollectionStorage) {
        try {
          onChainPublisher = await this.contracts.knowledgeCollectionStorage.getLatestMerkleRootPublisher(batchId);
        } catch { /* not found in V10 storage */ }
      }
      if ((!onChainPublisher || onChainPublisher === ethers.ZeroAddress) && this.contracts.knowledgeAssetsStorage) {
        try {
          onChainPublisher = await this.contracts.knowledgeAssetsStorage.getBatchPublisher(batchId);
        } catch { /* not found in V9 storage */ }
      }
      if (!onChainPublisher || onChainPublisher.toLowerCase() !== publisherAddress.toLowerCase()) {
        return { verified: false };
      }

      return {
        verified: true,
        onChainMerkleRoot,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
      };
    } catch {
      return { verified: false };
    }
  }

  // =====================================================================
  // V9: Storage Extension
  // =====================================================================

  async extendStorage(params: ExtendStorageParams): Promise<TxResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;

    if (this.contracts.token && params.tokenAmount > 0n) {
      const kaAddress = await ka.getAddress();
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await this.contracts.token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await ka.extendStorage(
      params.batchId,
      params.additionalEpochs,
      params.tokenAmount,
      ethers.ZeroAddress,
    );

    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  // =====================================================================
  // V9: Namespace Transfer
  // =====================================================================

  async transferNamespace(newOwner: string): Promise<TxResult> {
    await this.init();
    this.requireV9();

    const tx = await this.contracts.knowledgeAssets!.transferNamespace(newOwner);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async getRequiredPublishTokenAmount(publicByteSize: bigint, epochs: number): Promise<bigint> {
    await this.init();
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.contracts.askStorage.getStakeWeightedAverageAsk();
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
  }

  // =====================================================================
  // Events
  // =====================================================================

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    await this.init();

    const storage = this.contracts.knowledgeAssetsStorage ?? this.contracts.knowledgeCollectionStorage!;

    for (const eventType of filter.eventTypes) {
      if (eventType === 'KnowledgeBatchCreated') {
        const eventFilter = storage.filters.KnowledgeBatchCreated();
        const logs = await storage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);

        for (const log of logs) {
          const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            yield {
              type: 'KnowledgeBatchCreated',
              blockNumber: log.blockNumber,
              data: {
                batchId: parsed.args.batchId.toString(),
                publisherAddress: parsed.args.publisher?.toString(),
                merkleRoot: parsed.args.merkleRoot,
                startKAId: parsed.args.startKAId.toString(),
                endKAId: parsed.args.endKAId.toString(),
                txHash: log.transactionHash,
              },
            };
          }
        }
      }

      if (eventType === 'ContextGraphExpanded') {
        const cgStorage = this.contracts.contextGraphStorage;
        if (cgStorage) {
          const eventFilter = cgStorage.filters.ContextGraphExpanded();
          const logs = await cgStorage.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);

          for (const log of logs) {
            const parsed = cgStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'ContextGraphExpanded',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.contextGraphId.toString(),
                  batchId: parsed.args.batchId?.toString(),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }

      // V10/V8: KnowledgeCollectionStorage events
      if (eventType === 'KCCreated' || eventType === 'KnowledgeCollectionCreated') {
        const kcStorage = this.contracts.knowledgeCollectionStorage;
        if (kcStorage) {
          const fromB = filter.fromBlock ?? 0;
          const toB = filter.toBlock ?? 'latest';

          const kcFilter = kcStorage.filters.KnowledgeCollectionCreated();
          const kcLogs = await kcStorage.queryFilter(kcFilter, fromB, toB);

          const mintFilter = kcStorage.filters.KnowledgeAssetsMinted();
          const mintLogs = await kcStorage.queryFilter(mintFilter, fromB, toB);
          const mintByTx = new Map<string, { publisherAddress: string; startKAId: string; endKAId: string }>();
          for (const ml of mintLogs) {
            const mp = kcStorage.interface.parseLog({ topics: [...ml.topics], data: ml.data });
            if (mp) {
              mintByTx.set(ml.transactionHash, {
                publisherAddress: mp.args.to,
                startKAId: mp.args.startId.toString(),
                endKAId: (BigInt(mp.args.endId) - 1n).toString(),
              });
            }
          }

          for (const log of kcLogs) {
            const parsed = kcStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              const mint = mintByTx.get(log.transactionHash);
              yield {
                type: 'KCCreated',
                blockNumber: log.blockNumber,
                data: {
                  kcId: parsed.args.id.toString(),
                  merkleRoot: parsed.args.merkleRoot,
                  merkleRootBytes: parsed.args.merkleRoot,
                  byteSize: parsed.args.byteSize.toString(),
                  txHash: log.transactionHash,
                  publisherAddress: mint?.publisherAddress ?? '',
                  startKAId: mint?.startKAId ?? '0',
                  endKAId: mint?.endKAId ?? '0',
                },
              };
            }
          }
        }
      }

      if (eventType === 'NameClaimed' || eventType === 'ContextGraphNameClaimed') {
        const registry = this.contracts.contextGraphNameRegistry;
        if (registry) {
          const eventFilter = registry.filters.NameClaimed();
          const logs = await registry.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock);
          for (const log of logs) {
            const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'NameClaimed',
                blockNumber: log.blockNumber,
                data: {
                  contextGraphId: parsed.args.nameHash?.toString() ?? '',
                  creator: parsed.args.creator?.toString() ?? '',
                  accessPolicy: Number(parsed.args.accessPolicy ?? 0),
                  txHash: log.transactionHash,
                },
              };
            }
          }
        }
      }
    }
  }

  // =====================================================================
  // V9: Publisher range verification (for PublishHandler)
  // =====================================================================

  async verifyPublisherOwnsRange(
    publisherAddress: string,
    startKAId: bigint,
    endKAId: bigint,
  ): Promise<boolean> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage) return false;

    const storage = this.contracts.knowledgeAssetsStorage;
    const count = await storage.getPublisherRangesCount(publisherAddress);
    for (let i = 0; i < Number(count); i++) {
      const [startId, endId] = await storage.getPublisherRange(publisherAddress, i);
      if (startId <= startKAId && endId >= endKAId) return true;
    }
    return false;
  }

  // =====================================================================
  // Context Graphs (name-hash commitment via ContextGraphNameRegistry)
  //
  // Thin transitional affordance — reserves a bytes32 name-hash with an
  // optional cleartext metadata reveal. Governance for the context graph
  // itself (hosting nodes, publish policy, participants, quorum) lives in
  // `ContextGraphs` / `ContextGraphStorage` — see createOnChainContextGraph.
  // =====================================================================

  async createContextGraph(params: CreateContextGraphParams): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    const name = params.name ?? params.metadata?.['name'];
    if (!registry || !name) {
      throw new Error(
        'createContextGraph: requires ContextGraphNameRegistry in Hub and params.name (or metadata.name). ' +
          'Deploy ContextGraphNameRegistry and register it in the Hub, or provide name.',
      );
    }
    const accessPolicy = params.accessPolicy ?? 0;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(name));
    const tx = await registry.claimName(nameHash, accessPolicy);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('createContextGraph: no receipt');
    let contextGraphIdHex: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'NameClaimed') {
          contextGraphIdHex = String(parsed.args.nameHash);
          break;
        }
      } catch { /* not this contract */ }
    }

    // Optionally reveal cleartext metadata on-chain
    if (params.revealOnChain) {
      const description = params.description ?? params.metadata?.['description'] ?? '';
      await this.revealContextGraphMetadata(nameHash, name, description);
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: true,
      contextGraphId: contextGraphIdHex ?? nameHash,
    };
  }

  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> {
    throw new Error('submitToContextGraph: not yet implemented on EVM adapter (Milestone 5)');
  }

  async revealContextGraphMetadata(contextGraphId: string, name: string, description: string): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) throw new Error('revealContextGraphMetadata: ContextGraphNameRegistry not available');
    const tx = await registry.revealMetadata(contextGraphId, name, description);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('revealContextGraphMetadata: no receipt');
    return { hash: receipt.hash, blockNumber: receipt.blockNumber, success: true };
  }

  async listContextGraphsFromChain(fromBlock?: number): Promise<ContextGraphOnChain[]> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return [];
    const eventFilter = registry.filters.NameClaimed();
    const head = await this.provider.getBlockNumber();
    const PAGE = 9_000;
    const start = fromBlock ?? 0;
    const results: ContextGraphOnChain[] = [];

    // Paginate in PAGE-sized chunks to stay within RPC range limits.
    for (let lo = start; lo <= head; lo += PAGE) {
      const hi = Math.min(lo + PAGE - 1, head);
      const logs = await registry.queryFilter(eventFilter, lo, hi);
      for (const log of logs) {
        const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed || parsed.name !== 'NameClaimed') continue;
        results.push({
          contextGraphId: String(parsed.args.nameHash),
          creator: String(parsed.args.creator),
          accessPolicy: Number(parsed.args.accessPolicy),
          blockNumber: log.blockNumber,
          metadataRevealed: false,
        });
      }
    }

    return results;
  }

  // =====================================================================
  // On-Chain Context Graphs (ContextGraphs contract)
  // =====================================================================

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    await this.init();
    if (!this.contracts.contextGraphs || !this.contracts.contextGraphStorage) {
      throw new Error('ContextGraphs contract not deployed. Deploy ContextGraphs and ContextGraphStorage first.');
    }

    const hostingNodes = params.participantIdentityIds.map((id) => id);
    const tx = await this.contracts.contextGraphs.createContextGraph(
      hostingNodes,
      params.participantAgents ?? [],
      params.requiredSignatures,
      params.metadataBatchId ?? 0n,
      params.publishPolicy ?? 1,
      params.publishAuthority ?? ethers.ZeroAddress,
      params.publishAuthorityAccountId ?? 0n,
    );
    const receipt = await tx.wait();

    let contextGraphId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.contextGraphStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ContextGraphCreated') {
          contextGraphId = BigInt(parsed.args.contextGraphId);
          break;
        }
      } catch { /* not this contract */ }
    }

    if (contextGraphId === undefined) {
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: false,
        contextGraphId: 0n,
      };
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      contextGraphId,
    };
  }

  async getContextGraphParticipants(contextGraphId: bigint): Promise<bigint[] | null> {
    await this.init();
    if (!this.contracts.contextGraphStorage) {
      return null;
    }

    try {
      const hostingNodes: bigint[] = await this.contracts.contextGraphStorage.getHostingNodes(contextGraphId);
      return hostingNodes.map((id) => BigInt(id));
    } catch {
      return null;
    }
  }

  async verify(params: VerifyParams): Promise<TxResult> {
    await this.init();
    if (!this.contracts.contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }

    const tx = await this.contracts.contextGraphs.registerKnowledgeCollection(
      params.contextGraphId,
      params.batchId,
    );
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async publishToContextGraph(params: PublishToContextGraphParams): Promise<OnChainPublishResult> {
    await this.init();
    if (!this.contracts.knowledgeAssets) {
      throw new Error('KnowledgeAssets contract not deployed.');
    }
    if (!this.contracts.knowledgeAssetsStorage) {
      throw new Error('KnowledgeAssetsStorage contract not deployed (required for log parsing).');
    }

    const signer = await this.nextAuthorizedSigner(params.contextGraphId);
    const receiverIdentityIds = params.receiverSignatures.map((s) => s.identityId);
    const receiverRs = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const receiverVSs = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));
    const participantIdentityIds = params.participantSignatures.map((s) => s.identityId);
    const participantRs = params.participantSignatures.map((s) => ethers.hexlify(s.r));
    const participantVSs = params.participantSignatures.map((s) => ethers.hexlify(s.vs));

    const ka = this.contracts.knowledgeAssets.connect(signer) as any;
    const kaAddress = await this.contracts.knowledgeAssets.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token.connect(signer) as Contract;
      const currentAllowance: bigint = await token.allowance(signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await ka.publishToContextGraph(
      params.kaCount,
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress,
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      receiverIdentityIds,
      receiverRs,
      receiverVSs,
      params.contextGraphId,
      participantIdentityIds,
      participantRs,
      participantVSs,
    );

    const ackSignatures = [
      ...params.receiverSignatures,
      ...params.participantSignatures,
    ].filter((s, i, arr) =>
      i === arr.findIndex((a) => a.identityId === s.identityId),
    );

    // V9→V10 mirror: RandomSampling reads `merkleLeafCount` from on-chain
    // storage to pick `chunkId`. Silently writing 1 here would brick every
    // bridged KC whose flat-KC tree has more than one leaf (the prover
    // would request a chunk past the tree's leaf range). Refuse to mirror
    // if the caller didn't supply the real count.
    if (
      typeof params.merkleLeafCount !== 'number'
      || !Number.isInteger(params.merkleLeafCount)
      || params.merkleLeafCount < 1
    ) {
      throw new Error(
        'publishToContextGraph: missing/invalid merkleLeafCount. '
        + 'V10 mirror requires the caller to supply the V10MerkleTree leaf count '
        + '(integer ≥ 1). Hard-coding would corrupt RandomSampling chunk selection.',
      );
    }

    return this.createKnowledgeAssetsV10({
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId: params.contextGraphId,
      merkleRoot: params.merkleRoot,
      knowledgeAssetsAmount: params.kaCount,
      byteSize: params.publicByteSize,
      epochs: params.epochs,
      tokenAmount: params.tokenAmount,
      merkleLeafCount: params.merkleLeafCount,
      isImmutable: false,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      publisherSignature: params.publisherSignature,
      ackSignatures,
      paymaster: ethers.ZeroAddress,
    });
  }

  async resolvePublishByTxHash(txHash: string): Promise<OnChainPublishResult | null> {
    await this.init();

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return null;

      const v10 = this.contracts.knowledgeCollectionStorage
        ? await this.parseV10PublishReceipt(receipt)
        : null;
      if (v10) return v10;

      const v9 = this.contracts.knowledgeAssetsStorage
        ? await this.parseV9PublishReceipt(receipt)
        : null;
      return v9;
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('could not find') || msg.includes('not found') || msg.includes('unknown transaction')) {
        return null;
      }
      throw err;
    }
  }

  // =====================================================================
  // V10 Publish (KnowledgeAssetsV10 → KnowledgeCollectionStorage)
  // =====================================================================

  async getKnowledgeAssetsV10Address(): Promise<string> {
    await this.init();
    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsV10 contract not deployed on this chain.');
    }
    return await this.contracts.knowledgeAssetsV10.getAddress();
  }

  async getEvmChainId(): Promise<bigint> {
    const network = await this.provider.getNetwork();
    return network.chainId;
  }

  async createKnowledgeAssetsV10(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsV10 contract not deployed.');
    }

    // Pre-tx validation of `contextGraphId`. The V10 contract rejects
    // `cgId == 0` at `KnowledgeAssetsV10.sol:379` with `ZeroContextGraphId`;
    // catching this here gives a clearer error than a generic revert and
    // saves a round-trip. Reject `<= 0n` rather than `=== 0n` so that
    // `BigInt("-1") === -1n` does not slip past our fail-loud boundary and
    // die in ethers' uint256 encoder with a cryptic low-level error — the
    // upstream guards in `dkg-publisher.ts`, `agent/dkg-agent.ts`,
    // `cli/publisher-runner.ts`, and `publisher/storage-ack-handler.ts`
    // accept whatever `BigInt(...)` returns for non-throwing inputs, which
    // includes negative decimal strings.
    if (params.contextGraphId <= 0n) {
      throw new Error(
        'V10 publishDirect requires a positive on-chain context graph id; ' +
        `got ${params.contextGraphId}. Register the context graph via ` +
        '`ContextGraphs.createContextGraph` first and pass the returned ' +
        'numeric id as `publishContextGraphId`.',
      );
    }

    let txSigner: Wallet;
    if (params.publisherAddress) {
      const selected = this.findSignerByAddress(params.publisherAddress);
      if (!selected) {
        throw new Error(
          `Configured publisherAddress ${params.publisherAddress} is not present in the EVM signer pool.`,
        );
      }
      if (this.contracts.contextGraphs) {
        const authorized = await this.contracts.contextGraphs.isAuthorizedPublisher(
          params.contextGraphId,
          selected.address,
        );
        if (!authorized) {
          throw new Error(
            `Configured publisherAddress ${selected.address} is not authorized to publish ` +
            `to context graph ${params.contextGraphId.toString()}.`,
          );
        }
      }
      txSigner = selected;
    } else {
      txSigner = await this.nextAuthorizedSigner(params.contextGraphId);
    }
    const ka = this.contracts.knowledgeAssetsV10.connect(txSigner) as Contract;
    const kaAddress = await ka.getAddress();

    // Approval policy: always approve TRAC from the operational signer.
    //
    // `KnowledgeAssetsV10._publishDirect` (KnowledgeAssetsV10.sol:613-628)
    // only routes payment to `IPaymaster(paymaster).coverCost(...)` when
    // `paymasterManager.validPaymasters(paymaster) == true` at tx-mine
    // time; otherwise it falls back to `token.transferFrom(msg.sender,
    // ...)`. The adapter used to skip approval when an off-chain
    // `validPaymasters` probe returned `true`, but that was a TOCTOU bug:
    // if the whitelist mutates between the probe and the mined tx, the
    // contract silently reverts to the `msg.sender` branch and hits a
    // zero allowance → publish reverts. A redundant allowance is cheap
    // and idle when the paymaster does cover the cost, so we always
    // approve and drop the probe entirely.
    if (this.contracts.token) {
      const tokenWithSigner = this.contracts.token.connect(txSigner) as Contract;
      const currentAllowance = await tokenWithSigner.allowance(txSigner.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await tokenWithSigner.approve(kaAddress, params.tokenAmount);
        await approveTx.wait();
      }
    }

    // Build the on-chain PublishParams struct as a plain JS object matching
    // the field order + types in KnowledgeAssetsV10.sol:99-114. ethers.js
    // encodes object literals to solidity structs positionally by field name.
    const publishParamsStruct = {
      publishOperationId: params.publishOperationId,
      contextGraphId: params.contextGraphId,
      merkleRoot: ethers.hexlify(params.merkleRoot),
      knowledgeAssetsAmount: params.knowledgeAssetsAmount,
      byteSize: params.byteSize,
      epochs: params.epochs,
      tokenAmount: params.tokenAmount,
      isImmutable: params.isImmutable,
      merkleLeafCount: params.merkleLeafCount,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      publisherNodeR: ethers.hexlify(params.publisherSignature.r),
      publisherNodeVS: ethers.hexlify(params.publisherSignature.vs),
      identityIds: params.ackSignatures.map((s) => s.identityId),
      r: params.ackSignatures.map((s) => ethers.hexlify(s.r)),
      vs: params.ackSignatures.map((s) => ethers.hexlify(s.vs)),
    };

    // P-1 review (follow-up, Codex iter-5): the `onBroadcast` hook is
    // the durable WAL checkpoint, so it MUST fire in the true send
    // path — after populate / gas-estimate / sign succeed, and
    // immediately before `eth_sendRawTransaction`. If the hook throws
    // (WAL persistence failed, disk full, etc.) we MUST abort: the tx
    // was signed but never broadcast, so the caller is free to retry
    // without any on-chain effect. `contract.method(...)` does
    // populate + sign + broadcast as one step, so we break it apart:
    //
    //   1. populateTransaction — builds the `{ to, data, value }` request
    //   2. signer.populateTransaction — fills chainId / gas / nonce
    //   3. signer.signTransaction — returns the signed hex string
    //   4. onBroadcast — WAL checkpoint; throw aborts the broadcast
    //   5. provider.broadcastTransaction — the real eth_sendRawTransaction
    //
    // This also gives the WAL the pre-broadcast tx hash (ethers v6
    // exposes it on the returned TransactionResponse), so recovery can
    // reconcile an in-flight tx after a daemon crash.
    const populated = await (ka as any).publishDirect.populateTransaction(
      publishParamsStruct,
      params.paymaster,
    );
    const filled = await txSigner.populateTransaction(populated);
    const signedTx = await txSigner.signTransaction(filled);
    // Derive the pre-broadcast tx hash from the signed raw hex so WAL
    // consumers can log the exact identity of the tx about to hit the
    // wire. After broadcast completes, the receipt hash matches this.
    const preBroadcastTxHash = ethers.Transaction.from(signedTx).hash ?? '0x';
    // Codex PR #241 iter-7: `await` the hook. `onBroadcast` is typed
    // as `Promise<void> | void`, so an async WAL writer (disk flush,
    // remote gossip) must run to completion BEFORE we proceed to
    // `broadcastTransaction`. Without `await`, a synchronous
    // `try/catch` here would silently let the broadcast race the
    // still-unresolved WAL promise and break the fail-closed contract.
    try {
      await params.onBroadcast?.({ txHash: preBroadcastTxHash });
    } catch (hookErr) {
      // Fail closed: the signed tx is still in this function's local
      // scope — it has not been sent. Surface the hook error to the
      // caller so they know WAL persistence failed BEFORE broadcast.
      throw new Error(
        `chain:writeahead hook failed before publishDirect broadcast: ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    const tx = await this.provider.broadcastTransaction(signedTx);

    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction receipt is null');

    let kcId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = txSigner.address;
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) {
      throw new Error(
        `V10 publish tx ${receipt.hash} succeeded but KnowledgeCollectionStorage ` +
        `contract is not available — cannot parse minted IDs from receipt`,
      );
    }
    {
      let foundKCCreated = false;
      let foundKAMinted = false;
      for (const log of receipt.logs) {
        try {
          const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'KnowledgeCollectionCreated') {
            kcId = BigInt(parsed.args.id);
            foundKCCreated = true;
          }
          if (parsed?.name === 'KnowledgeAssetsMinted') {
            startKAId = BigInt(parsed.args.startId);
            // KnowledgeCollectionStorage emits exclusive endId (startId + amount);
            // convert to inclusive for consistent UAL range representation.
            endKAId = BigInt(parsed.args.endId) - 1n;
            publisherAddress = parsed.args.to;
            foundKAMinted = true;
          }
        } catch { /* not this contract */ }
      }
      if (!foundKCCreated) {
        throw new Error(
          `V10 publish tx ${receipt.hash} succeeded but KnowledgeCollectionCreated event ` +
          `not found in receipt logs — contract ABI may be stale`,
        );
      }
      if (!foundKAMinted) {
        throw new Error(
          `V10 publish tx ${receipt.hash} succeeded but KnowledgeAssetsMinted event ` +
          `not found in receipt logs — contract ABI may be stale`,
        );
      }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId: kcId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.gasPrice ? BigInt(receipt.gasPrice) : undefined,
      gasCostWei: receipt.gasUsed && receipt.gasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice) : undefined,
      tokenAmount: params.tokenAmount,
    };
  }

  private async parseV10PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) return null;

    let kcId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let foundKCCreated = false;
    let foundKAMinted = false;

    for (const log of receipt.logs) {
      try {
        const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'KnowledgeCollectionCreated') {
          kcId = BigInt(parsed.args.id);
          foundKCCreated = true;
        }
        if (parsed?.name === 'KnowledgeAssetsMinted') {
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId) - 1n;
          publisherAddress = parsed.args.to;
          foundKAMinted = true;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundKCCreated || !foundKAMinted) return null;

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId: kcId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
    };
  }

  private async parseV9PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const storage = this.contracts.knowledgeAssetsStorage;
    if (!storage) return null;

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let foundBatchCreated = false;

    for (const log of receipt.logs) {
      try {
        const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          foundBatchCreated = true;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundBatchCreated) return null;

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
    };
  }

  // =====================================================================
  // V10 Update (KnowledgeAssetsV10 → KnowledgeCollectionStorage)
  // =====================================================================

  async updateKnowledgeCollectionV10(params: V10UpdateKCParams): Promise<TxResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsV10) {
      throw new Error('KnowledgeAssetsV10 contract not deployed — cannot update via V10 path.');
    }

    let signer: Wallet | undefined;

    // Look up the on-chain publisher to select the correct signer.
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (kcs) {
      try {
        const onChainPublisher: string = await kcs.getLatestMerkleRootPublisher(params.kcId);
        if (onChainPublisher && onChainPublisher !== ethers.ZeroAddress) {
          signer = this.signerPool.find(
            (s) => s.address.toLowerCase() === onChainPublisher.toLowerCase(),
          );
        }
      } catch {
        // Fall through to hint-based or round-robin
      }
    }

    if (!signer && params.publisherAddress) {
      signer = this.signerPool.find(
        (s) => s.address.toLowerCase() === params.publisherAddress!.toLowerCase(),
      );
    }
    if (!signer) signer = this.nextSigner();

    const ka = this.contracts.knowledgeAssetsV10.connect(signer) as Contract;

    const kav10Address = await this.contracts.knowledgeAssetsV10.getAddress();
    const evmChainId = (await this.provider.getNetwork()).chainId;

    const identityId = params.publisherNodeIdentityId ?? await this.getIdentityId();

    // Look up the current tokenAmount on-chain to carry it forward.
    // V10 batches live in KnowledgeCollectionStorage; fall back to
    // KnowledgeAssetsStorage (V9) if not found.
    let currentTokenAmount = 0n;
    if (kcs) {
      try {
        currentTokenAmount = BigInt(await kcs.getTokenAmount(params.kcId));
      } catch { /* not in KCS */ }
    }
    if (currentTokenAmount === 0n && this.contracts.knowledgeAssetsStorage) {
      try {
        const batch = await this.contracts.knowledgeAssetsStorage.getBatch(params.kcId);
        if (batch && batch.tokenAmount != null) {
          currentTokenAmount = BigInt(batch.tokenAmount);
        }
      } catch { /* not in KAS either */ }
    }

    // The V10 contract requires newTokenAmount >= the cost of the new byte
    // size (ask * newByteSize / 1024). Carry forward the current amount but
    // also ensure it covers the cost for the new payload.
    let requiredForNewSize = 0n;
    if (this.contracts.askStorage) {
      try {
        const ask = BigInt(await this.contracts.askStorage.getStakeWeightedAverageAsk());
        requiredForNewSize = (ask * params.newByteSize * 1n) / 1024n;
      } catch { /* use 0 */ }
    }
    const baseTokenAmount = params.newTokenAmount ?? currentTokenAmount;
    const newTokenAmount = baseTokenAmount > requiredForNewSize ? baseTokenAmount : requiredForNewSize;

    // Look up the contextGraphId for this KC
    const contextGraphStorage = this.contracts.contextGraphStorage;
    let contextGraphId = 0n;
    if (contextGraphStorage) {
      try {
        contextGraphId = BigInt(await contextGraphStorage.kcToContextGraph(params.kcId));
      } catch { /* use 0 */ }
    }

    // Compute pre-update merkle root count (array length)
    let preUpdateMerkleRootCount = 0n;
    if (kcs) {
      try {
        const roots: unknown[] = await kcs.getMerkleRoots(params.kcId);
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const opId = params.updateOperationId ?? `update-${Date.now()}`;
    const burnIds = params.burnTokenIds ?? [];

    let pubSig = params.publisherSignature;
    if (!pubSig) {
      const pubDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
        ['uint256', 'address', 'uint72', 'uint256', 'bytes32'],
        [evmChainId, kav10Address, identityId, contextGraphId, ethers.hexlify(params.newMerkleRoot)],
      ));
      const raw = ethers.Signature.from(await signer.signMessage(pubDigest));
      pubSig = { r: ethers.getBytes(raw.r), vs: ethers.getBytes(raw.yParityAndS) };
    }

    let ackSigs = params.ackSignatures ?? [];
    if (ackSigs.length === 0) {
      // Update ACK digest: keccak256(abi.encodePacked(chainid, KAV10, cgId, kcId, preCount, newRoot, byteSize, tokenAmount, mintAmount, keccak256(burnIds)))
      const burnPackedHash = ethers.keccak256(
        burnIds.length > 0
          ? ethers.solidityPacked(burnIds.map(() => 'uint256'), burnIds)
          : new Uint8Array(0),
      );
      const newMerkleLeafCount = BigInt(params.newMerkleLeafCount ?? 0);
      const ackDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
        ['uint256', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'],
        [evmChainId, kav10Address, contextGraphId, params.kcId, preUpdateMerkleRootCount,
         ethers.hexlify(params.newMerkleRoot), params.newByteSize, newTokenAmount,
         BigInt(params.mintAmount ?? 0), burnPackedHash, newMerkleLeafCount],
      ));
      const raw = ethers.Signature.from(await signer.signMessage(ackDigest));
      ackSigs = [{ identityId, r: ethers.getBytes(raw.r), vs: ethers.getBytes(raw.yParityAndS) }];
    }

    const updateParams = {
      id: params.kcId,
      updateOperationId: opId,
      newMerkleRoot: ethers.hexlify(params.newMerkleRoot),
      newByteSize: params.newByteSize,
      newTokenAmount,
      newMerkleLeafCount: params.newMerkleLeafCount,
      mintKnowledgeAssetsAmount: params.mintAmount ?? 0,
      knowledgeAssetsToBurn: burnIds,
      publisherNodeIdentityId: identityId,
      publisherNodeR: ethers.hexlify(pubSig.r),
      publisherNodeVS: ethers.hexlify(pubSig.vs),
      identityIds: ackSigs.map(s => s.identityId),
      r: ackSigs.map(s => ethers.hexlify(s.r)),
      vs: ackSigs.map(s => ethers.hexlify(s.vs)),
    };

    // Approve TRAC for the V10 update — the contract may transferFrom
    // for the newTokenAmount (same policy as publishDirect).
    if (this.contracts.token && newTokenAmount > 0n) {
      const tokenWithSigner = this.contracts.token.connect(signer) as Contract;
      const prevAllowance = await tokenWithSigner.allowance(signer.address, kav10Address);
      if (prevAllowance < newTokenAmount) {
        const approveTx = await tokenWithSigner.approve(kav10Address, newTokenAmount);
        await approveTx.wait();
      }
    }

    // P-1 review (Codex iter-5): same pattern as publishDirect above —
    // break the single contract call into populate / sign / hook /
    // broadcast so the `onBroadcast` checkpoint fires at the actual
    // eth_sendRawTransaction boundary, and so a hook failure (e.g.
    // WAL persistence error) aborts broadcast instead of leaving an
    // unmatched WAL record.
    const populated = await (ka as any).updateDirect.populateTransaction(
      updateParams,
      ethers.ZeroAddress,
    );
    const filled = await signer.populateTransaction(populated);
    const signedTx = await signer.signTransaction(filled);
    const preBroadcastTxHash = ethers.Transaction.from(signedTx).hash ?? '0x';
    // Codex PR #241 iter-7: `await` so async WAL writes complete
    // before broadcast (see publishDirect above for the full rationale).
    try {
      await params.onBroadcast?.({ txHash: preBroadcastTxHash });
    } catch (hookErr) {
      throw new Error(
        `chain:writeahead hook failed before updateDirect broadcast: ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    const tx = await this.provider.broadcastTransaction(signedTx);

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(
        `updateDirect broadcast succeeded (txHash=${preBroadcastTxHash}) but receipt was null ` +
        `— the tx was likely replaced or dropped before confirmation`,
      );
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      publisherAddress: signer.address,
    };
  }

  // =====================================================================
  // Staking Conviction
  // =====================================================================

  // V10 baseline tier ladder seeded by `ConvictionStakingStorage._seedBaselineTiers()`
  // (rest, 30d, 90d, 180d, 366d). Passing a tier outside this set reverts on-chain with
  // `InvalidLockTier()` from `DKGStakingConvictionNFT._convictionMultiplier`. Validating
  // off-chain saves a round-trip and surfaces a clearer error to the caller.
  private static readonly V10_BASELINE_LOCK_TIERS = [0, 1, 3, 6, 12] as const;

  private snapToBaselineLockTier(lockEpochs: number): number {
    // Snap DOWN to the largest baseline tier ≤ lockEpochs. Conservative: never lock
    // the user up for longer than the legacy `lockEpochs` they asked for. Examples:
    //   lockEpochs=2 → 1, lockEpochs=4 → 3, lockEpochs=11 → 6, lockEpochs=30 → 12.
    let snapped = 0;
    for (const tier of EVMChainAdapter.V10_BASELINE_LOCK_TIERS) {
      if (tier <= lockEpochs) snapped = tier;
      else break;
    }
    return snapped;
  }

  private normalizeLegacyLockEpochs(lockEpochs: number): number {
    if (!Number.isInteger(lockEpochs)) {
      throw new Error(`stakeWithLock: lockEpochs must be an integer, got ${lockEpochs}`);
    }
    if (lockEpochs < 0) {
      throw new Error(`stakeWithLock: lockEpochs must be non-negative, got ${lockEpochs}`);
    }
    return this.snapToBaselineLockTier(lockEpochs);
  }

  async stakeWithLock(identityId: bigint, amount: bigint, lockEpochs: number): Promise<TxResult> {
    return this.stakeWithLockTier(identityId, amount, this.normalizeLegacyLockEpochs(lockEpochs));
  }

  async stakeWithLockTier(identityId: bigint, amount: bigint, lockTier: number): Promise<TxResult> {
    if (!Number.isInteger(lockTier) || !(EVMChainAdapter.V10_BASELINE_LOCK_TIERS as readonly number[]).includes(lockTier)) {
      throw new Error(
        `stakeWithLockTier: lockTier must be one of {${EVMChainAdapter.V10_BASELINE_LOCK_TIERS.join(', ')}} (V10 baseline tier ladder), got ${lockTier}`,
      );
    }
    await this.init();

    let nft: Contract;
    try {
      nft = await this.resolveContract('DKGStakingConvictionNFT');
    } catch {
      throw new Error('DKGStakingConvictionNFT contract not deployed.');
    }

    // V10 consolidation (v4.0.0): TRAC is pulled by `StakingV10`, not by
    // the NFT — the NFT is only the entry point and never custodies TRAC.
    // Approving the NFT here would still leave the inner `stakingV10.stake`
    // call short on allowance and revert. Mirror the pattern used in
    // `ensureProfile` / `scripts/devnet.sh`.
    if (this.contracts.token && amount > 0n) {
      const stakingV10Addr: string = await this.contracts.hub.getContractAddress('StakingV10');
      if (stakingV10Addr === ethers.ZeroAddress) {
        throw new Error('StakingV10 not registered in Hub — V10 staking unavailable');
      }
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, stakingV10Addr);
      if (currentAllowance < amount) {
        await (await this.contracts.token.approve(stakingV10Addr, ethers.MaxUint256)).wait();
      }
    }

    const tx = await nft.createConviction(identityId, amount, lockTier);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async getDelegatorConvictionMultiplier(_identityId: bigint, _delegator: string): Promise<{ multiplier: number }> {
    // V8 address-keyed stakers have no conviction multiplier (always 1x).
    // V10 per-position multipliers are queried by tokenId via
    // ConvictionStakingStorage.getPosition(), not this address-keyed function.
    return { multiplier: 1 };
  }

  // =====================================================================
  // Publishing Conviction Accounts
  // =====================================================================

  async createConvictionAccount(amount: bigint, lockEpochs: number): Promise<{ accountId: bigint } & TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const pca = this.contracts.publishingConvictionAccount;
    const pcaAddress = await pca.getAddress();

    if (this.contracts.token && amount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, pcaAddress);
      if (currentAllowance < amount) {
        const approveTx = await this.contracts.token.approve(pcaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await pca.createAccount(amount, lockEpochs);
    const receipt = await tx.wait();

    let accountId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = pca.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'AccountCreated') {
          accountId = BigInt(parsed.args.accountId);
          break;
        }
      } catch { /* not this contract */ }
    }

    if (accountId === 0n) {
      throw new Error('createConvictionAccount succeeded but no AccountCreated event found');
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      accountId,
    };
  }

  async addConvictionFunds(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const pca = this.contracts.publishingConvictionAccount;
    const pcaAddress = await pca.getAddress();

    if (this.contracts.token && amount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, pcaAddress);
      if (currentAllowance < amount) {
        const approveTx = await this.contracts.token.approve(pcaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await pca.addFunds(accountId, amount);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async extendConvictionLock(accountId: bigint, additionalEpochs: number): Promise<TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const tx = await this.contracts.publishingConvictionAccount.extendLock(accountId, additionalEpochs);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async getConvictionAccountInfo(accountId: bigint): Promise<ConvictionAccountInfo | null> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) return null;

    try {
      const [admin, balance, initialDeposit, lockEpochs, conviction, discountBps] =
        await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);

      if (admin === ethers.ZeroAddress) return null;

      return {
        accountId,
        admin,
        balance: BigInt(balance),
        initialDeposit: BigInt(initialDeposit),
        lockEpochs: Number(lockEpochs),
        conviction: BigInt(conviction),
        discountBps: Number(discountBps),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  async getConvictionDiscount(accountId: bigint): Promise<{ discountBps: number; conviction: bigint }> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      return { discountBps: 0, conviction: 0n };
    }

    try {
      const [admin, , , , conviction, discountBps] =
        await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);

      if (admin === ethers.ZeroAddress) return { discountBps: 0, conviction: 0n };

      return {
        discountBps: Number(discountBps),
        conviction: BigInt(conviction),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return { discountBps: 0, conviction: 0n };
      throw err;
    }
  }

  // =====================================================================
  // Utilities
  // =====================================================================

  getSignerAddress(): string {
    return this.signer.address;
  }

  async getMinimumRequiredSignatures(): Promise<number> {
    await this.init();
    if (!this.contracts.parametersStorage) return 3;
    return Number(await this.contracts.parametersStorage.minimumRequiredSignatures());
  }

  async verifyACKIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    if (!identityStorage) return false;

    // Match on-chain verification: keyHasPurpose(identityId, keccak256(signer), OPERATIONAL_KEY)
    const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
    const hasPurpose: boolean = await identityStorage.keyHasPurpose(
      claimedIdentityId,
      keyHash,
      OPERATIONAL_KEY_PURPOSE,
    );
    if (!hasPurpose) return false;

    // Verify the identity is a staked core node (spec §9.0: "Core nodes MUST be staked").
    // v4.0.0 — read V10 canonical stake (`ConvictionStakingStorage.getNodeStakeV10`)
    // instead of the V8 `StakingStorage.getNodeStake` archive: under mandatory
    // migration the V8 `nodeStake` field is unmaintained for V10 nodes and
    // would zero-gate every legitimate V10 ACK signer (this exactly mirrors
    // the on-chain `KnowledgeAssetsV10` ACK-signer gate, also rewired in
    // v4.0.0). Falls back to V8 if CSS is not registered (older deploys).
    let cs: Contract | null = null;
    try {
      cs = await this.resolveContract('ConvictionStakingStorage');
    } catch {
      cs = null;
    }
    if (cs) {
      const stake: bigint = await cs.getNodeStakeV10(claimedIdentityId);
      if (stake === 0n) return false;
      return true;
    }

    let ss: Contract | null = null;
    try {
      ss = await this.resolveContract('StakingStorage');
    } catch {
      ss = null;
    }
    if (!ss) return false;
    const v8Stake: bigint = await ss.getNodeStake(claimedIdentityId);
    if (v8Stake === 0n) return false;

    return true;
  }

  async verifySyncIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    if (!identityStorage) return false;

    const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
    return identityStorage.keyHasPurpose(claimedIdentityId, keyHash, OPERATIONAL_KEY_PURPOSE);
  }

  async signACKDigest(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array } | undefined> {
    try {
      const identityId = await this.getIdentityId();
      if (identityId === 0n) return undefined;
      if (!(await this.isOperationalWalletRegistered(identityId, this.signer.address))) {
        return undefined;
      }

      const sig = ethers.Signature.from(await this.signer.signMessage(digest));
      return {
        r: ethers.getBytes(sig.r),
        vs: ethers.getBytes(sig.yParityAndS),
      };
    } catch {
      return undefined;
    }
  }

  getACKSignerKey(): string | undefined {
    return this.signer.privateKey;
  }

  isV10Ready(): boolean {
    return !!this.contracts.knowledgeAssetsV10;
  }

  isRandomSamplingReady(): boolean {
    return !!this.contracts.randomSampling && !!this.contracts.randomSamplingStorage;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(
      await this.signer.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const selected = this.findSignerByAddress(address);
    if (!selected) {
      throw new Error(`Cannot sign with ${address}: address is not present in the EVM signer pool.`);
    }
    const sig = ethers.Signature.from(
      await selected.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  async getContract(name: string): Promise<Contract> {
    await this.init();
    return this.resolveContract(name);
  }

  // ===== Permanent Publishing =====

  async publishKnowledgeAssetsPermanent(params: PermanentPublishParams): Promise<OnChainPublishResult> {
    await this.init();
    if (!this.contracts.knowledgeAssets) throw new Error('KnowledgeAssets contract not deployed.');

    const publishSigner = this.nextSigner();
    const kaAddr = await this.contracts.knowledgeAssets.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const allowance: bigint = await this.contracts.token.allowance(publishSigner.address, kaAddr);
      if (allowance < params.tokenAmount) {
        await (await (this.contracts.token.connect(publishSigner) as Contract).approve(kaAddr, ethers.MaxUint256)).wait();
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => s.r);
    const vsValues = params.receiverSignatures.map((s) => s.vs);

    const ka = this.contracts.knowledgeAssets.connect(publishSigner) as Contract;
    const tx = await ka.batchMintKnowledgeAssetsPermanent(
      params.kaCount,
      params.publisherNodeIdentityId,
      params.merkleRoot,
      params.publicByteSize,
      params.tokenAmount,
      params.publisherSignature.r,
      params.publisherSignature.vs,
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();
    const storageIface = this.contracts.knowledgeAssetsStorage!.interface;

    let batchId = 0n;
    let startKAId: bigint | undefined;
    let endKAId: bigint | undefined;
    let publisherAddress = publishSigner.address;
    for (const log of receipt.logs) {
      try {
        const parsed = storageIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
        }
      } catch { /* different contract log */ }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);
    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress: publishSigner.address,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.gasPrice ? BigInt(receipt.gasPrice) : undefined,
      tokenAmount: params.tokenAmount,
    };
  }

  // =====================================================================
  // Random Sampling (V10 RandomSampling.sol)
  // =====================================================================

  /**
   * Resolve `RandomSampling` and `RandomSamplingStorage` through the
   * Hub-backed cache. Each call may trigger a re-resolve when the
   * cached value is missing or has expired (TTL or invalidation),
   * which is exactly the property that makes node operators no longer
   * need a daemon restart after a Hub-side contract rotation.
   *
   * Failure-mode handling: only the documented "name not registered
   * in the Hub" case (which `resolveContract` throws as
   * `Contract "X" not found in Hub at <addr>`) is rewritten to a
   * deployment-oriented hint. Every other failure (transient RPC,
   * ABI mismatch, provider error, etc.) propagates with its original
   * message preserved so the prover loop's error log points
   * operators at the actual cause instead of misdirecting them
   * toward a redeploy.
   */
  private async getRandomSampling(): Promise<{ rs: Contract; rss: Contract }> {
    try {
      return await this.resolveAndAssignRandomSamplingPair();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found in Hub at')) {
        throw new Error(
          'RandomSampling / RandomSamplingStorage not deployed in this Hub. ' +
          'The deployer is responsible for shipping these alongside V10 publish.',
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Resolve the RS+RSS pair from the cache and write the handles into
   * `this.contracts.randomSampling[Storage]` ONLY if no `invalidate()`
   * happened during the await. Without the generation guard, an
   * in-flight resolve started before a Hub rotation would leak the
   * pre-rotation pair back into the side-channel handles, undoing the
   * invalidation's clearing of those handles and leaving
   * `isRandomSamplingReady()` reporting `true` against stale addresses.
   * Returning the (possibly stale) pair to the immediate caller is
   * still safe — `withHubStaleRetry` catches the inevitable on-chain
   * `UnauthorizedAccess` and re-tries against the freshly resolved
   * pair.
   */
  private async resolveAndAssignRandomSamplingPair(): Promise<{ rs: Contract; rss: Contract }> {
    const generationBefore = this.randomSamplingPairCache.currentGeneration();
    const pair = await this.randomSamplingPairCache.get();
    if (this.randomSamplingPairCache.currentGeneration() === generationBefore) {
      this.contracts.randomSampling = pair.rs;
      this.contracts.randomSamplingStorage = pair.rss;
    }
    return pair;
  }

  /**
   * Run `fn` and, if it fails with the unique "this caller is no
   * longer registered as a Hub contract" revert, drop the cached RS
   * pair and retry exactly once. This is the safety net for the
   * rare case where (a) the daemon missed the `Hub.ContractChanged`
   * event (RPC reconnect, dropped subscription, etc.) AND (b) the TTL
   * hasn't expired yet. After the retry, the cache holds the freshly
   * resolved pair for subsequent ticks.
   */
  private async withHubStaleRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (HUB_STALE_ERROR_MARKERS.some((m) => msg.includes(m))) {
        this.invalidateRandomSamplingPair();
        return await fn();
      }
      throw err;
    }
  }

  /**
   * Invalidate both the cache AND the side-channel contract handles. Without
   * dropping `this.contracts.randomSampling[Storage]`, the public
   * `isRandomSamplingReady()` probe would keep returning `true` after a Hub
   * rotation (until the next `getRandomSampling()` re-populates the
   * handles), giving the prover a stale all-clear.
   *
   * Codex round 6 on PR #369: ALSO drop the in-flight duration probe.
   * The probe was started against the OLD `RandomSampling` contract;
   * if Hub rotates while it is pending we MUST NOT pair the new
   * contract's `getActiveProofPeriodStatus()` with the old contract's
   * duration in the next call. Worse, if the old probe never settles
   * (hung provider) it would suppress every fresh probe forever via
   * the single-flight guard. Clearing the slot here lets the next
   * call issue a fresh probe against the new contract; the now-orphan
   * old promise is still handled by its `.finally` hook (the slot
   * identity check inside .finally won't match, so it correctly does
   * nothing).
   */
  private invalidateRandomSamplingPair(): void {
    this.randomSamplingPairCache.invalidate();
    this.contracts.randomSampling = undefined;
    this.contracts.randomSamplingStorage = undefined;
    this.inflightDurationProbe = undefined;
    this.inflightDurationProbeContract = undefined;
    this.inflightDurationProbeStartedAt = 0;
  }

  /**
   * Subscribe to Hub `ContractChanged` / `NewContract` events and
   * invalidate the RS pair cache whenever **either** RS-side name is
   * rotated. The pair is treated as a single coupled unit (see the
   * `randomSamplingPairCache` field comment) — invalidating on either
   * name forces an atomic re-resolve of both.
   *
   * `Hub._setContractAddress` is double-tap-emitting (`Hub-extra.test.ts`
   * E-7): on the new-contract path it emits `NewContract` twice, and
   * on the update path it emits both `ContractChanged` AND
   * `NewContract`. We listen to BOTH events so the cache invalidates
   * regardless of which Hub variant the deployment ships, and the
   * invalidation is idempotent so duplicate notifications are
   * harmless.
   *
   * `Contract.on(...)` is async in ethers v6: a sync `try/catch` would
   * miss provider rejections (e.g. HTTP-only endpoints that can't
   * install filter subscriptions) and leave us with an unhandled
   * rejection. We `await` both subscriptions and only set
   * `hubRotationListenerStarted` after both succeed, so a failed
   * provider can be retried by a future call site if we ever need to
   * — and meanwhile the TTL refresh path still keeps the pair fresh.
   */
  private async startHubRotationListener(): Promise<void> {
    if (this.hubRotationListenerStarted) return;
    const onChange = (name: unknown): void => {
      if (typeof name !== 'string') return;
      if (name === 'RandomSampling' || name === 'RandomSamplingStorage') {
        this.invalidateRandomSamplingPair();
      }
    };
    try {
      await this.contracts.hub.on('ContractChanged', onChange);
      await this.contracts.hub.on('NewContract', onChange);
      this.hubRotationListenerStarted = true;
    } catch {
      /* provider doesn't support filter subscriptions — TTL refresh is the fallback */
    }
  }

  /**
   * Map a caught chain error onto a typed prover error when the revert
   * matches one of the documented retry-next-period / non-retryable
   * conditions; otherwise rethrow the original. Centralised so the
   * three call sites stay in sync with the on-chain revert wording.
   *
   * Note: `createChallenge` reverts via custom errors (decoded by the
   * `getErrorInterface()` helper above), `submitProof` uses
   * `revert("...")` strings for the period/proof-mismatch cases plus a
   * `MerkleRootMismatchError` custom error.
   */
  private translateRandomSamplingError(err: unknown): never {
    if (!(err instanceof Error)) throw err;
    enrichEvmError(err);
    const msg = err.message;
    if (msg.includes('NoEligibleContextGraph')) throw new NoEligibleContextGraphError();
    if (msg.includes('NoEligibleKnowledgeCollection')) throw new NoEligibleKnowledgeCollectionError();
    if (msg.includes('This challenge is no longer active')) throw new ChallengeNoLongerActiveError();
    const merkleMatch = msg.match(/MerkleRootMismatchError\((0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+)\)/);
    if (merkleMatch) {
      throw new MerkleRootMismatchError(merkleMatch[1], merkleMatch[2]);
    }
    throw err;
  }

  /**
   * Convert the on-chain `Challenge` tuple (or struct) into our wire
   * type. The contract returns an all-zero struct when no challenge
   * exists for an identity, which we surface as `null` so callers
   * don't have to dispatch on `kcId === 0n`.
   */
  private toNodeChallenge(raw: any): NodeChallenge | null {
    const kcId = BigInt(raw.knowledgeCollectionId ?? raw[0]);
    const startBlock = BigInt(raw.activeProofPeriodStartBlock ?? raw[4]);
    if (kcId === 0n && startBlock === 0n) return null;
    return {
      knowledgeCollectionId: kcId,
      chunkId: BigInt(raw.chunkId ?? raw[1]),
      knowledgeCollectionStorageContract: String(raw.knowledgeCollectionStorageContract ?? raw[2]),
      epoch: BigInt(raw.epoch ?? raw[3]),
      activeProofPeriodStartBlock: startBlock,
      proofingPeriodDurationInBlocks: BigInt(raw.proofingPeriodDurationInBlocks ?? raw[5]),
      solved: Boolean(raw.solved ?? raw[6]),
    };
  }

  async createChallenge(): Promise<CreateChallengeResult> {
    await this.init();

    const identityStorage = await this.resolveContract('IdentityStorage');
    const identityId: bigint = await identityStorage.getIdentityId(this.signer.address);

    return this.withHubStaleRetry(async () => {
      const { rs, rss } = await this.getRandomSampling();

      let receipt: ethers.TransactionReceipt;
      try {
        const tx = await rs.createChallenge();
        receipt = await tx.wait();
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      // Decode `ChallengeGenerated(identityId, contextGraphId, kcId, chunkId, epoch, startBlock)`
      // from the receipt. cgId is indexed (topic[2]); the rest are in data
      // but we only need cgId here — the proof builder reads kcId/chunkId
      // off the Challenge struct fetched below, so everything stays
      // consistent if the storage layout shifts.
      let contextGraphId = 0n;
      const rsIface = rs.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = rsIface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === 'ChallengeGenerated') {
            contextGraphId = BigInt(parsed.args.contextGraphId);
            break;
          }
        } catch { /* not this contract */ }
      }
      if (contextGraphId === 0n) {
        // The picker only emits the event when it actually lands on a CG,
        // so a missing event is a bug — fail loud rather than fall back
        // to "lookup by KC" which V10 doesn't support natively.
        throw new Error(
          'createChallenge succeeded on-chain but no ChallengeGenerated event was found in the receipt; ' +
          'cannot route proof builder without contextGraphId.',
        );
      }

      const challengeRaw = await rss.getNodeChallenge(identityId);
      const challenge = this.toNodeChallenge(challengeRaw);
      if (!challenge) {
        throw new Error(
          `createChallenge succeeded but RandomSamplingStorage.getNodeChallenge(${identityId}) ` +
          'returned an empty struct. This indicates a state inconsistency between ' +
          'RandomSampling and RandomSamplingStorage.',
        );
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: true,
        challenge,
        contextGraphId,
      };
    });
  }

  async submitProof(leaf: Uint8Array | `0x${string}`, merkleProof: Uint8Array[]): Promise<TxResult> {
    await this.init();

    const leafHex = typeof leaf === 'string' ? leaf : ethers.hexlify(leaf);
    if (!ethers.isHexString(leafHex, 32)) {
      throw new Error('submitProof: leaf must be a 32-byte value (bytes32)');
    }
    const proofHex = merkleProof.map((p) => ethers.hexlify(p));

    return this.withHubStaleRetry(async () => {
      const { rs } = await this.getRandomSampling();

      let receipt: ethers.TransactionReceipt;
      try {
        const tx = await rs.submitProof(leafHex, proofHex);
        receipt = await tx.wait();
      } catch (err) {
        this.translateRandomSamplingError(err);
      }

      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        success: true,
      };
    });
  }

  async getActiveProofPeriodStatus(): Promise<ProofPeriodStatus> {
    await this.init();
    const { rs } = await this.getRandomSampling();

    // Codex round 2 on PR #369: the cached `NodeChallenge.proofingPeriodDurationInBlocks`
    // is whatever the contract used at challenge-creation time. The chain's
    // `updateAndGetActiveProofPeriodStartBlock()` rolls forward using the
    // CURRENT epoch's duration via `getActiveProofingPeriodDurationInBlocks()`.
    // If a governance change shortens the duration mid-flight, off-chain
    // staleness checks against the cached duration would underestimate
    // expiry and re-deadlock at the rollover boundary. Pull the live
    // duration alongside the status read so the prover can compare
    // wall-clock against the same value the contract uses for rollover.
    //
    // Codex round 3 + 4 + 5 — keep the live-duration read STRICTLY best-effort:
    // a transient RPC blip, partial rollout, or an older RS deployment
    // that omits the method from its ABI must NOT make the whole
    // `getActiveProofPeriodStatus()` reject OR stall.
    //
    // Naive `Promise.allSettled` is NOT enough —
    // `rs.getActiveProofingPeriodDurationInBlocks()` would throw
    // synchronously (`TypeError: ... is not a function`) before
    // `allSettled` can wrap it when the method is missing entirely.
    //
    // Plain `try/catch` is also NOT enough — a hung RPC (provider
    // accepts the request but never responds) keeps the await pending
    // forever, blocking the entire status probe even though the
    // primary `getActiveProofPeriodStatus()` already returned. The
    // prover can safely continue with the cached challenge duration,
    // so race the duration read against a short timeout and prefer
    // `undefined` on slow paths. The prover treats `undefined` as
    // "fall back to existing.proofingPeriodDurationInBlocks".
    const readDurationBestEffort = async (): Promise<bigint | undefined> => {
      try {
        const fn = (rs as unknown as { getActiveProofingPeriodDurationInBlocks?: () => Promise<unknown> })
          .getActiveProofingPeriodDurationInBlocks;
        if (typeof fn !== 'function') return undefined;
        const v = await fn.call(rs);
        return BigInt(v as never);
      } catch {
        return undefined;
      }
    };
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      });
      return Promise.race([
        p.then((v) => { if (timer) clearTimeout(timer); return v; }),
        timeout,
      ]);
    };
    // Single-flight: if a previous tick's probe is still pending,
    // reuse it instead of issuing a fresh `eth_call`. Codex round 8:
    // first invalidate the slot if (a) the resolved RS Contract
    // instance has changed since the probe was started (TTL-refresh
    // path constructs a fresh Contract WITHOUT calling
    // invalidateRandomSamplingPair → the probe was started against
    // the old contract and must not be paired with the new
    // contract's status), or (b) the slot is older than
    // MAX_PROBE_AGE_MS (a truly hung probe must not suppress retries
    // forever).
    const probeAgeMs = this.inflightDurationProbe
      ? Date.now() - this.inflightDurationProbeStartedAt
      : 0;
    if (this.inflightDurationProbe && (
      this.inflightDurationProbeContract !== rs ||
      probeAgeMs > MAX_PROBE_AGE_MS
    )) {
      this.inflightDurationProbe = undefined;
    }
    let probe = this.inflightDurationProbe;
    if (!probe) {
      const fresh = readDurationBestEffort();
      this.inflightDurationProbe = fresh;
      this.inflightDurationProbeContract = rs;
      this.inflightDurationProbeStartedAt = Date.now();
      // `.finally` covers both resolve and reject paths without
      // altering the value the caller observes.
      void fresh.finally(() => {
        if (this.inflightDurationProbe === fresh) {
          this.inflightDurationProbe = undefined;
        }
      });
      probe = fresh;
    }
    const [raw, proofingPeriodDurationInBlocks] = await Promise.all([
      rs.getActiveProofPeriodStatus(),
      withTimeout(probe, DURATION_PROBE_TIMEOUT_MS, undefined),
    ]);
    return {
      activeProofPeriodStartBlock: BigInt(raw.activeProofPeriodStartBlock ?? raw[0]),
      isValid: Boolean(raw.isValid ?? raw[1]),
      proofingPeriodDurationInBlocks,
    };
  }

  async getNodeChallenge(identityId: bigint): Promise<NodeChallenge | null> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const raw = await rss.getNodeChallenge(identityId);
    return this.toNodeChallenge(raw);
  }

  async getNodeEpochProofPeriodScore(
    identityId: bigint,
    epoch: bigint,
    periodStartBlock: bigint,
  ): Promise<bigint> {
    await this.init();
    const { rss } = await this.getRandomSampling();
    const score: bigint = await rss.getNodeEpochProofPeriodScore(identityId, epoch, periodStartBlock);
    return BigInt(score);
  }

  // =====================================================================
  // KC views (V10 KnowledgeCollectionStorage + ContextGraphStorage)
  // =====================================================================

  private requireKCStorage(): Contract {
    const kcs = this.contracts.knowledgeCollectionStorage;
    if (!kcs) {
      throw new Error(
        'KnowledgeCollectionStorage not deployed in this Hub. ' +
        'V10 KC views require a Hub with KnowledgeCollectionStorage registered.',
      );
    }
    return kcs;
  }

  private requireContextGraphStorage(): Contract {
    const cgs = this.contracts.contextGraphStorage;
    if (!cgs) {
      throw new Error(
        'ContextGraphStorage not deployed in this Hub. ' +
        'getKCContextGraphId requires a Hub with ContextGraphStorage registered.',
      );
    }
    return cgs;
  }

  async getLatestMerkleRoot(kcId: bigint): Promise<Uint8Array> {
    await this.init();
    const kcs = this.requireKCStorage();
    const rootHex: string = await kcs.getLatestMerkleRoot(kcId);
    return ethers.getBytes(rootHex);
  }

  async getMerkleLeafCount(kcId: bigint): Promise<number> {
    await this.init();
    const kcs = this.requireKCStorage();
    const count: bigint = BigInt(await kcs.getMerkleLeafCount(kcId));
    return Number(count);
  }

  async getLatestMerkleRootPublisher(kcId: bigint): Promise<string> {
    await this.init();
    const kcs = this.requireKCStorage();
    const publisher: string = await kcs.getLatestMerkleRootPublisher(kcId);
    return publisher;
  }

  async getKCContextGraphId(kcId: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const cgId: bigint = await cgs.kcToContextGraph(kcId);
    return BigInt(cgId);
  }
}
