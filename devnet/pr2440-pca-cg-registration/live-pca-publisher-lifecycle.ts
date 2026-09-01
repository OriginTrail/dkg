import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  fetchStatus,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import { validateSharedSweepTopology } from '../../scripts/devnet-shared-sweep-preflight.mjs';
import {
  CONTEXT_GRAPHS_ABI,
  CONTEXT_GRAPH_STORAGE_ABI,
  PARAMETERS_ABI,
  PCA_ABI,
  TOKEN_ABI,
  WAIVER_ABI,
} from './pca-registration-contracts.js';

const HUB_OWNER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const COMMITMENT_BASELINE = ethers.parseEther('500000');
const REGISTRATION_DEPOSIT = ethers.parseEther('100');
const lower = (value: string): string => value.toLowerCase();

async function nextPendingNonce(
  provider: ethers.JsonRpcProvider,
  address: string,
): Promise<number> {
  const quantity = await provider.send('eth_getTransactionCount', [address, 'pending']);
  return Number(BigInt(quantity));
}

export interface LivePcaPublisherResources {
  state: DevnetState;
  node: DevnetNode;
  walletA: ethers.Wallet;
  walletB: ethers.Wallet;
  ownerWallet: ethers.Wallet;
  token: ethers.Contract;
  pca: ethers.Contract;
  parameters: ethers.Contract;
  contextGraphStorage: ethers.Contract;
  waiver: ethers.Contract;
  contextGraphsAddress: string;
  contextGraphStorageAddress: string;
  waiverAddress: string;
  knowledgeAssetsLifecycleAddress: string;
}

export type FixtureInitializationCheckpoint =
  | 'after-registration-deposit'
  | 'after-pca-mint-before-read'
  | 'after-pca-creation'
  | 'after-agent-registration'
  | 'after-wallet-state';

export type FixtureAcceptedBroadcastCheckpoint =
  | 'pca-funding'
  | 'pca-mint';

export type FixtureCleanupCheckpoint = 'pca-detachment';

export interface LivePcaPublisherFixtureCreateOptions {
  initializationFault?: {
    checkpoint: FixtureInitializationCheckpoint;
    error: Error;
    onReached?: (context: {
      fixtureDir: string;
      fixtureId: string;
      pcaAccountId: bigint;
    }) => void;
  };
  acceptedBroadcastFault?: {
    checkpoint: FixtureAcceptedBroadcastCheckpoint;
    error: Error;
    onAccepted?: (context: {
      transaction: KnownTransaction;
      pcaOwnerAddress: string;
    }) => void;
  };
  cleanupFault?: {
    checkpoint: FixtureCleanupCheckpoint;
    error: Error;
    failures?: number;
  };
}

type AcceptedBroadcastFault = NonNullable<
  LivePcaPublisherFixtureCreateOptions['acceptedBroadcastFault']
>;

export function shouldInjectAcceptedBroadcastFault(
  fault: AcceptedBroadcastFault | undefined,
  checkpoint: FixtureAcceptedBroadcastCheckpoint | undefined,
): fault is AcceptedBroadcastFault {
  return fault !== undefined
    && checkpoint !== undefined
    && fault.checkpoint === checkpoint;
}

export interface LivePcaPublisherMutableState {
  registrationDeposit: bigint;
  walletABalance: bigint;
  walletAContextGraphsAllowance: bigint;
  walletBBalance: bigint;
  walletBContextGraphsAllowance: bigint;
  walletBPcaAllowance: bigint;
  walletAPcaBalance: bigint;
  walletAAgentAccountId: bigint;
  walletBPcaBalance: bigint;
  walletBAgentAccountId: bigint;
}

export interface LivePcaPublisherWalletBalances {
  native: bigint;
  trac: bigint;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type SharedSweepTopology = Awaited<ReturnType<typeof validateSharedSweepTopology>>;

async function requireDevnet(): Promise<{
  state: DevnetState;
  topology: SharedSweepTopology;
}> {
  const topology = await validateSharedSweepTopology();
  const state = await detectDevnet(topology.nodeCount);
  if (!state) {
    throw new Error(
      `No ${topology.nodeCount}-node devnet detected. Start with DEVNET_ENABLE_PUBLISHER=1 ` +
      `DEVNET_PUBLISHER_WALLET_INDEX=${topology.publisherWalletIndex} ` +
      `./scripts/devnet.sh start ${topology.nodeCount} after pnpm run build.`,
    );
  }
  return { state, topology };
}

async function prepareAndValidateDevnet(
  state: DevnetState,
  topology: SharedSweepTopology,
): Promise<void> {
  await ensureAllIdentities(state, 4);
  const nodes = Object.values(state.nodes);
  invariant(
    nodes.length === topology.nodeCount,
    `expected ${topology.nodeCount} devnet nodes, received ${nodes.length}`,
  );
  await Promise.all(nodes.map(fetchStatus));

  invariant(
    topology.publisherWalletIndex > 0,
    'issue #2440 requires a non-primary publisher wallet',
  );
  const node = state.nodes[1];
  invariant(node, 'issue #2440 requires devnet node 1');
  const selected = node.opWallets[topology.publisherWalletIndex];
  invariant(
    selected,
    `${node.home} requires operational wallet index ${topology.publisherWalletIndex}`,
  );
  invariant(
    lower(new ethers.Wallet(selected.privateKey).address) === lower(selected.address),
    `${node.home} selected publisher private key must control its configured address`,
  );
}

async function resolveResources(
  state: DevnetState,
  publisherWalletIndex: number,
): Promise<LivePcaPublisherResources> {
  const nodes = Object.values(state.nodes);
  invariant(nodes.length === 6, `expected six devnet nodes, received ${nodes.length}`);

  const node = state.nodes[1]!;
  const walletA = new ethers.Wallet(node.opWallets[0]!.privateKey, state.provider);
  const walletB = new ethers.Wallet(
    node.opWallets[publisherWalletIndex]!.privateKey,
    state.provider,
  );
  invariant(lower(walletA.address) !== lower(walletB.address), 'publisher wallets must be distinct');
  const ownerWallet = new ethers.Wallet(HUB_OWNER_PK, state.provider);

  const token = new ethers.Contract(state.addrs.Token, TOKEN_ABI, state.provider);
  const pca = new ethers.Contract(state.addrs.DKGPublishingConvictionNFT, PCA_ABI, state.provider);
  const parameters = new ethers.Contract(state.addrs.ParametersStorage, PARAMETERS_ABI, state.provider);
  const contextGraphsAddress = ethers.getAddress(state.addrs.ContextGraphs);
  const contextGraphs = new ethers.Contract(
    contextGraphsAddress,
    CONTEXT_GRAPHS_ABI,
    state.provider,
  );
  const contextGraphStorageAddress = ethers.getAddress(
    await contextGraphs.contextGraphStorage(),
  );
  const contextGraphStorage = new ethers.Contract(
    contextGraphStorageAddress,
    CONTEXT_GRAPH_STORAGE_ABI,
    state.provider,
  );
  const waiverAddress = ethers.getAddress(state.addrs.ContextGraphWaiverStorage);
  const waiver = new ethers.Contract(waiverAddress, WAIVER_ABI, state.provider);
  const knowledgeAssetsLifecycleAddress = ethers.getAddress(
    await state.hub.getContractAddress('KnowledgeAssetsLifecycle'),
  );
  const hubOwner = ethers.getAddress(await new ethers.Contract(
    state.addrs.Hub,
    ['function owner() view returns (address)'],
    state.provider,
  ).owner());
  invariant(hubOwner === ownerWallet.address, 'configured Hub owner key does not match deployment');
  invariant(
    await state.provider.getBalance(ownerWallet.address) > 0n,
    'configured Hub owner needs native gas; restart the task-scoped devnet',
  );

  return {
    state,
    node,
    walletA,
    walletB,
    ownerWallet,
    token,
    pca,
    parameters,
    contextGraphStorage,
    waiver,
    contextGraphsAddress,
    contextGraphStorageAddress,
    waiverAddress,
    knowledgeAssetsLifecycleAddress,
  };
}

async function captureMutableState(
  resources: LivePcaPublisherResources,
): Promise<LivePcaPublisherMutableState> {
  const pcaAddress = await resources.pca.getAddress();
  return {
    registrationDeposit: BigInt(
      await resources.parameters.contextGraphRegistrationDeposit(),
    ),
    walletABalance: BigInt(await resources.token.balanceOf(resources.walletA.address)),
    walletAContextGraphsAllowance: BigInt(
      await resources.token.allowance(
        resources.walletA.address,
        resources.contextGraphsAddress,
      ),
    ),
    walletBBalance: BigInt(await resources.token.balanceOf(resources.walletB.address)),
    walletBContextGraphsAllowance: BigInt(
      await resources.token.allowance(
        resources.walletB.address,
        resources.contextGraphsAddress,
      ),
    ),
    walletBPcaAllowance: BigInt(
      await resources.token.allowance(resources.walletB.address, pcaAddress),
    ),
    walletAPcaBalance: BigInt(await resources.pca.balanceOf(resources.walletA.address)),
    walletAAgentAccountId: BigInt(
      await resources.pca.agentToAccountId(resources.walletA.address),
    ),
    walletBPcaBalance: BigInt(await resources.pca.balanceOf(resources.walletB.address)),
    walletBAgentAccountId: BigInt(
      await resources.pca.agentToAccountId(resources.walletB.address),
    ),
  };
}

async function captureWalletBBalances(
  resources: LivePcaPublisherResources,
): Promise<LivePcaPublisherWalletBalances> {
  const [native, trac] = await Promise.all([
    resources.state.provider.getBalance(resources.walletB.address),
    resources.token.balanceOf(resources.walletB.address),
  ]);
  return { native: BigInt(native), trac: BigInt(trac) };
}

type CleanupAction = { label: string; run: () => void | Promise<void> };

export interface KnownTransaction {
  from: string;
  hash: string;
  nonce: number;
  signedTransaction: string;
}

export type KnownTransactionOutcome = 'replaced' | 'reverted' | 'succeeded';

type KnownTransactionProvider = Pick<
  ethers.JsonRpcProvider,
  | 'broadcastTransaction'
  | 'getTransaction'
  | 'getTransactionCount'
  | 'getTransactionReceipt'
  | 'waitForTransaction'
>;

export async function reconcileKnownTransaction(
  provider: KnownTransactionProvider,
  transaction: KnownTransaction,
): Promise<KnownTransactionOutcome> {
  const nonceDisposition = async (): Promise<'available' | 'occupied' | 'replaced'> => {
    const latestNonce = await provider.getTransactionCount(transaction.from, 'latest');
    if (latestNonce > transaction.nonce) return 'replaced';
    const pendingNonce = await provider.getTransactionCount(transaction.from, 'pending');
    return pendingNonce > transaction.nonce ? 'occupied' : 'available';
  };
  const outcomeFromReceipt = async (): Promise<KnownTransactionOutcome | undefined> => {
    const receipt = await provider.getTransactionReceipt(transaction.hash);
    if (!receipt) return undefined;
    return receipt.status === 1 ? 'succeeded' : 'reverted';
  };
  const waitForReceipt = async (): Promise<KnownTransactionOutcome> => {
    const receipt = await provider.waitForTransaction(transaction.hash, 1, 30_000);
    if (!receipt) {
      throw new Error(
        `transaction ${transaction.hash} remains pending; cleanup must retry`,
      );
    }
    return receipt.status === 1 ? 'succeeded' : 'reverted';
  };

  const existingOutcome = await outcomeFromReceipt();
  if (existingOutcome) return existingOutcome;
  if (await provider.getTransaction(transaction.hash)) return waitForReceipt();

  const beforeBroadcast = await nonceDisposition();
  if (beforeBroadcast === 'replaced') return 'replaced';
  if (beforeBroadcast === 'occupied') {
    throw new Error(
      `transaction nonce ${transaction.nonce} for ${transaction.from} is occupied by an `
      + 'unrelated pending transaction; cleanup must retry without replacement',
    );
  }

  try {
    const response = await provider.broadcastTransaction(transaction.signedTransaction);
    invariant(
      lower(response.hash) === lower(transaction.hash),
      `broadcast hash mismatch: expected ${transaction.hash}, received ${response.hash}`,
    );
  } catch (broadcastError) {
    const recoveredOutcome = await outcomeFromReceipt();
    if (recoveredOutcome) return recoveredOutcome;
    if (await provider.getTransaction(transaction.hash)) return waitForReceipt();
    const afterFailure = await nonceDisposition();
    if (afterFailure === 'replaced') return 'replaced';
    if (afterFailure === 'occupied') {
      throw new Error(
        `transaction nonce ${transaction.nonce} for ${transaction.from} became occupied by `
        + 'an unrelated pending transaction; cleanup must retry without replacement',
        { cause: broadcastError },
      );
    }
    throw broadcastError;
  }

  return waitForReceipt();
}

export class CleanupStack {
  private readonly actions: Array<CleanupAction & { completed: boolean }> = [];
  private inFlightPromise?: Promise<void>;

  defer(label: string, run: CleanupAction['run']): void {
    this.actions.push({ label, run, completed: false });
  }

  dispose(): Promise<void> {
    if (this.inFlightPromise) return this.inFlightPromise;

    const attempt = this.disposeInternal();
    this.inFlightPromise = attempt;
    attempt.then(
      () => {
        if (this.inFlightPromise === attempt) this.inFlightPromise = undefined;
      },
      () => {
        if (this.inFlightPromise === attempt) this.inFlightPromise = undefined;
      },
    );
    return attempt;
  }

  private async disposeInternal(): Promise<void> {
    const failures: Error[] = [];
    for (let index = this.actions.length - 1; index >= 0; index -= 1) {
      const action = this.actions[index]!;
      if (action.completed) continue;
      try {
        await action.run();
        action.completed = true;
      } catch (error) {
        failures.push(new Error(`${action.label}: ${(error as Error).message}`));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Fixture cleanup failed: ${failures.map((failure) => failure.message).join('; ')}`,
      );
    }
  }
}

const pendingInitializationCleanups = new Map<object, CleanupStack>();

export async function retryLivePcaPublisherInitializationCleanup(
  initializationError: object,
): Promise<void> {
  const cleanup = pendingInitializationCleanups.get(initializationError);
  if (!cleanup) return;
  await cleanup.dispose();
  pendingInitializationCleanups.delete(initializationError);
}

export async function drainLivePcaPublisherInitializationCleanups(): Promise<void> {
  const failures: Error[] = [];
  for (const [initializationError, cleanup] of pendingInitializationCleanups) {
    try {
      await cleanup.dispose();
      pendingInitializationCleanups.delete(initializationError);
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} deferred PCA fixture initialization cleanup(s) still failed`,
    );
  }
}

export class LivePcaPublisherLifecycle {
  readonly resources: LivePcaPublisherResources;
  readonly fixtureId = randomUUID();
  pcaAccountId = 0n;

  private readonly initializationFault?: LivePcaPublisherFixtureCreateOptions['initializationFault'];
  private readonly acceptedBroadcastFault?: LivePcaPublisherFixtureCreateOptions['acceptedBroadcastFault'];
  private readonly cleanupFault?: LivePcaPublisherFixtureCreateOptions['cleanupFault'];
  private cleanupFaultFailuresRemaining = 0;
  private readonly pcaOwnerWallet: ethers.Wallet;
  private fixtureDir = '';
  private pcaFundingAmount = 0n;
  private pcaGasFundingTransaction?: KnownTransaction;
  private pcaGasRefundTransaction?: KnownTransaction;
  private pcaAgentRegistrationTransaction?: KnownTransaction;
  private pcaApprovalTransaction?: KnownTransaction;
  private pcaFundingRefundTransaction?: KnownTransaction;
  private pcaFundingTransaction?: KnownTransaction;
  private pcaMintTransaction?: KnownTransaction;
  private registrationDepositBefore = 0n;
  private registrationDepositChanged = false;
  private registrationDepositSetTransaction?: KnownTransaction;
  private registrationDepositRestoreTransaction?: KnownTransaction;
  private walletABalanceBefore = 0n;
  private walletAContextGraphsAllowanceBefore = 0n;
  private walletBTracBalanceBefore = 0n;

  private constructor(
    resources: LivePcaPublisherResources,
    options: LivePcaPublisherFixtureCreateOptions,
    private readonly cleanup: CleanupStack,
  ) {
    this.resources = resources;
    this.initializationFault = options.initializationFault;
    this.acceptedBroadcastFault = options.acceptedBroadcastFault;
    this.cleanupFault = options.cleanupFault;
    this.cleanupFaultFailuresRemaining = options.cleanupFault?.failures ?? 1;
    this.pcaOwnerWallet = ethers.Wallet.createRandom().connect(resources.state.provider);
  }

  static async captureMutableState(): Promise<LivePcaPublisherMutableState> {
    const { state, topology } = await requireDevnet();
    await prepareAndValidateDevnet(state, topology);
    return captureMutableState(await resolveResources(state, topology.publisherWalletIndex));
  }

  static async capturePcaTotalSupply(): Promise<bigint> {
    const { state, topology } = await requireDevnet();
    await prepareAndValidateDevnet(state, topology);
    const resources = await resolveResources(state, topology.publisherWalletIndex);
    return BigInt(await resources.pca.totalSupply());
  }

  static async captureWalletBBalances(): Promise<LivePcaPublisherWalletBalances> {
    const { state, topology } = await requireDevnet();
    await prepareAndValidateDevnet(state, topology);
    return captureWalletBBalances(
      await resolveResources(state, topology.publisherWalletIndex),
    );
  }

  static async create(
    options: LivePcaPublisherFixtureCreateOptions = {},
  ): Promise<LivePcaPublisherLifecycle> {
    const { state, topology } = await requireDevnet();
    const cleanup = new CleanupStack();
    try {
      await prepareAndValidateDevnet(state, topology);
      const lifecycle = new LivePcaPublisherLifecycle(
        await resolveResources(state, topology.publisherWalletIndex),
        options,
        cleanup,
      );
      await lifecycle.initialize();
      return lifecycle;
    } catch (error) {
      try {
        await cleanup.dispose();
      } catch {
        if (typeof error === 'object' && error !== null) {
          pendingInitializationCleanups.set(error, cleanup);
        }
      }
      throw error;
    }
  }

  get fixtureDirectory(): string {
    return this.fixtureDir;
  }

  get initialWalletABalance(): bigint {
    return this.walletABalanceBefore;
  }

  get initialWalletAContextGraphsAllowance(): bigint {
    return this.walletAContextGraphsAllowanceBefore;
  }

  get initialWalletBTracBalance(): bigint {
    return this.walletBTracBalanceBefore;
  }

  dispose(): Promise<void> {
    return this.cleanup.dispose();
  }

  private async initialize(): Promise<void> {
    const { pca, token, walletA, walletB, contextGraphsAddress } = this.resources;
    this.fixtureDir = mkdtempSync(join(tmpdir(), `dkg-pr2440-${this.fixtureId}-`));
    const fixtureDir = this.fixtureDir;
    this.cleanup.defer('temporary fixture directory removal', () => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    this.walletABalanceBefore = BigInt(await token.balanceOf(walletA.address));
    this.walletAContextGraphsAllowanceBefore = BigInt(
      await token.allowance(walletA.address, contextGraphsAddress),
    );
    const walletBBalancesBefore = await captureWalletBBalances(this.resources);
    this.walletBTracBalanceBefore = walletBBalancesBefore.trac;
    invariant(walletBBalancesBefore.native > 0n, 'wallet B needs native gas');

    invariant(await pca.balanceOf(walletA.address) === 0n, 'wallet A must own no PCA');
    invariant(
      await pca.agentToAccountId(walletA.address) === 0n,
      'wallet A must have no PCA agent binding',
    );
    invariant(await pca.balanceOf(walletB.address) === 0n, 'wallet B must own no PCA');
    invariant(
      await pca.agentToAccountId(walletB.address) === 0n,
      'wallet B must have no PCA agent binding',
    );
    invariant(
      await token.allowance(walletB.address, contextGraphsAddress) === 0n,
      'wallet B ContextGraphs allowance must start at zero',
    );
    invariant(
      await token.allowance(walletB.address, await pca.getAddress()) === 0n,
      'wallet B PCA allowance must start at zero',
    );
    invariant(
      await pca.balanceOf(this.pcaOwnerWallet.address) === 0n,
      'fixture PCA owner must start without a PCA',
    );
    invariant(
      await token.balanceOf(this.pcaOwnerWallet.address) === 0n,
      'fixture PCA owner must start with zero TRAC',
    );

    await this.activateRegistrationDeposit();
    this.failInitializationAt('after-registration-deposit');
    await this.createEligiblePcaForWalletB();
    this.failInitializationAt('after-wallet-state');
    invariant(
      await token.balanceOf(walletA.address) === this.walletABalanceBefore,
      'fixture must not change wallet A TRAC',
    );
    invariant(
      await token.allowance(walletA.address, contextGraphsAddress)
        === this.walletAContextGraphsAllowanceBefore,
      'fixture must not change wallet A ContextGraphs allowance',
    );
    invariant(
      await token.balanceOf(walletB.address) === this.walletBTracBalanceBefore,
      'fixture PCA setup must preserve wallet B TRAC',
    );
    invariant(
      await this.resources.state.provider.getBalance(walletB.address)
        > 0n,
      'wallet B must retain native gas during fixture setup',
    );
    invariant(
      await token.allowance(walletB.address, contextGraphsAddress) === 0n,
      'wallet B ContextGraphs allowance must retain zero',
    );
  }

  private failInitializationAt(checkpoint: FixtureInitializationCheckpoint): void {
    if (this.initializationFault?.checkpoint !== checkpoint) return;
    this.initializationFault.onReached?.({
      fixtureDir: this.fixtureDir,
      fixtureId: this.fixtureId,
      pcaAccountId: this.pcaAccountId,
    });
    throw this.initializationFault.error;
  }

  private failCleanupAt(checkpoint: FixtureCleanupCheckpoint): void {
    if (
      this.cleanupFault?.checkpoint !== checkpoint
      || this.cleanupFaultFailuresRemaining <= 0
    ) return;
    this.cleanupFaultFailuresRemaining -= 1;
    throw this.cleanupFault.error;
  }

  private async discoverFixturePcaAccountId(): Promise<bigint> {
    if (this.pcaAccountId > 0n) return this.pcaAccountId;
    if (!this.pcaMintTransaction) return 0n;

    const { state, pca } = this.resources;
    const candidates = new Set<bigint>();
    const outcome = await this.reconcileKnownTransaction(this.pcaMintTransaction);
    if (outcome !== 'succeeded') return 0n;
    const receipt = await state.provider.getTransactionReceipt(this.pcaMintTransaction.hash);
    invariant(receipt, `fixture PCA mint ${this.pcaMintTransaction.hash} receipt disappeared`);

    const pcaAddress = lower(await pca.getAddress());
    for (const log of receipt.logs) {
      if (lower(log.address) !== pcaAddress) continue;
      try {
        const parsed = pca.interface.parseLog(log);
        if (
          parsed?.name === 'Transfer'
          && lower(String(parsed.args.from)) === lower(ethers.ZeroAddress)
          && lower(String(parsed.args.to)) === lower(this.pcaOwnerWallet.address)
        ) {
          candidates.add(BigInt(parsed.args.tokenId));
        }
      } catch {
        // Ignore unrelated logs emitted by the known PCA mint transaction.
      }
    }

    if (candidates.size !== 1) {
      throw new Error(
        `known PCA mint ${this.pcaMintTransaction.hash} emitted ${candidates.size} `
        + 'matching mint events; ownership preserved for retry/manual recovery',
      );
    }
    const [accountId] = candidates;
    this.pcaAccountId = accountId!;
    return accountId!;
  }

  private async detachFixturePca(): Promise<void> {
    const { state, ownerWallet, pca, walletB } = this.resources;
    const pcaOwner = this.pcaOwnerWallet;
    const accountId = await this.discoverFixturePcaAccountId();
    if (accountId === 0n) {
      await this.recoverUnconsumedPcaFunding();
      return;
    }

    if (this.pcaAgentRegistrationTransaction) {
      await this.reconcileKnownTransaction(this.pcaAgentRegistrationTransaction);
    }
    const cleanupAddress = ownerWallet.address;
    const currentOwner = ethers.getAddress(await pca.ownerOf(accountId));
    const currentAgentAccountId = BigInt(await pca.agentToAccountId(walletB.address));
    if (lower(currentOwner) === lower(cleanupAddress)) {
      invariant(currentAgentAccountId === 0n, 'detached fixture PCA retained wallet B agent');
      return;
    }
    if (lower(currentOwner) !== lower(pcaOwner.address)) {
      throw new Error(
        `cleanup conflict: fixture PCA ${accountId} owner changed to ${currentOwner}; `
        + 'ownership preserved for manual recovery',
      );
    }
    if (currentAgentAccountId === accountId) {
      await (await (pca.connect(pcaOwner) as ethers.Contract).deregisterAgent(
        accountId,
        walletB.address,
        { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      )).wait();
    } else if (currentAgentAccountId !== 0n) {
      throw new Error(
        `cleanup conflict: wallet B is bound to PCA ${currentAgentAccountId}, expected `
        + `${accountId}; agent binding preserved for manual recovery`,
      );
    }
    await (await (pca.connect(pcaOwner) as ethers.Contract).transferFrom(
      pcaOwner.address,
      cleanupAddress,
      accountId,
      { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
    )).wait();
    invariant(
      lower(await pca.ownerOf(accountId)) === lower(cleanupAddress),
      'fixture PCA canonical owner cleanup failed',
    );
    invariant(await pca.balanceOf(pcaOwner.address) === 0n, 'fixture PCA owner cleanup failed');
    invariant(await pca.balanceOf(walletB.address) === 0n, 'publisher wallet gained PCA ownership');
    invariant(
      BigInt(await pca.agentToAccountId(walletB.address)) === 0n,
      'fixture PCA agent cleanup failed',
    );
  }

  private async recoverUnconsumedPcaFunding(): Promise<void> {
    if (this.pcaGasFundingTransaction) {
      await this.reconcileKnownTransaction(this.pcaGasFundingTransaction);
    }
    if (!this.pcaFundingTransaction || this.pcaFundingAmount === 0n) return;

    const { state, ownerWallet, token, pca } = this.resources;
    const pcaOwner = this.pcaOwnerWallet;
    if (this.pcaFundingRefundTransaction) {
      const refundOutcome = await this.reconcileKnownTransaction(
        this.pcaFundingRefundTransaction,
      );
      if (refundOutcome === 'succeeded') {
        this.pcaFundingAmount = 0n;
        return;
      }
      this.pcaFundingRefundTransaction = undefined;
    }

    const fundingOutcome = await this.reconcileKnownTransaction(this.pcaFundingTransaction);
    if (fundingOutcome !== 'succeeded') {
      this.pcaFundingAmount = 0n;
      return;
    }

    if (this.pcaApprovalTransaction) {
      await this.reconcileKnownTransaction(this.pcaApprovalTransaction);
    }

    const pcaAddress = await pca.getAddress();
    const allowance = BigInt(await token.allowance(pcaOwner.address, pcaAddress));
    if (allowance === this.pcaFundingAmount) {
      await (await (token.connect(pcaOwner) as ethers.Contract).approve(
        pcaAddress,
        0n,
        { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      )).wait();
    } else if (allowance !== 0n) {
      throw new Error(
        `cleanup conflict: fixture PCA owner allowance is ${allowance}, expected 0 or `
        + `${this.pcaFundingAmount}; allowance preserved for manual recovery`,
      );
    }

    const balance = BigInt(await token.balanceOf(pcaOwner.address));
    if (balance < this.pcaFundingAmount) {
      throw new Error(
        `cleanup conflict: fixture PCA owner retains ${balance} of fixture funding `
        + `${this.pcaFundingAmount}; balance preserved for retry/manual recovery`,
      );
    }
    const refundRequest = await (token.connect(pcaOwner) as ethers.Contract)
      .transfer.populateTransaction(
      ownerWallet.address,
      this.pcaFundingAmount,
      { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      );
    await this.broadcastKnownTransaction(
      pcaOwner,
      refundRequest,
      (transaction) => {
        this.pcaFundingRefundTransaction = transaction;
      },
    );
    this.pcaFundingAmount = 0n;
  }

  private async refundPcaOwnerNativeBalance(): Promise<void> {
    const { state, ownerWallet } = this.resources;
    const pcaOwner = this.pcaOwnerWallet;
    if (this.pcaGasFundingTransaction) {
      await this.reconcileKnownTransaction(this.pcaGasFundingTransaction);
    }
    if (this.pcaGasRefundTransaction) {
      const outcome = await this.reconcileKnownTransaction(this.pcaGasRefundTransaction);
      if (outcome === 'succeeded') {
        invariant(
          await state.provider.getBalance(pcaOwner.address) === 0n,
          'fixture PCA owner native refund mined without draining its balance',
        );
        return;
      }
      if (outcome === 'replaced') {
        throw new Error(
          'fixture PCA owner native refund was replaced; balance preserved for manual recovery',
        );
      }
      this.pcaGasRefundTransaction = undefined;
    }

    const balance = await state.provider.getBalance(pcaOwner.address);
    if (balance === 0n) return;
    const gasLimit = 21_000n;
    const gasPrice = BigInt(await state.provider.send('eth_gasPrice', []));
    const gasCost = gasLimit * gasPrice;
    invariant(
      balance > gasCost,
      `fixture PCA owner native balance ${balance} cannot cover refund gas ${gasCost}`,
    );
    await this.broadcastKnownTransaction(
      pcaOwner,
      {
        type: 0,
        nonce: await nextPendingNonce(state.provider, pcaOwner.address),
        to: ownerWallet.address,
        value: balance - gasCost,
        gasLimit,
        gasPrice,
      },
      (transaction) => {
        this.pcaGasRefundTransaction = transaction;
      },
    );
    invariant(
      await state.provider.getBalance(pcaOwner.address) === 0n,
      'fixture PCA owner native refund did not drain its balance',
    );
  }

  private async reconcileKnownTransaction(
    transaction: KnownTransaction,
  ): Promise<KnownTransactionOutcome> {
    return reconcileKnownTransaction(this.resources.state.provider, transaction);
  }

  private async broadcastKnownTransaction(
    signer: ethers.Wallet,
    request: ethers.TransactionRequest,
    remember: (transaction: KnownTransaction) => void,
    acceptedFaultCheckpoint?: FixtureAcceptedBroadcastCheckpoint,
  ): Promise<void> {
    invariant(
      lower(signer.address) === lower(this.resources.ownerWallet.address)
        || lower(signer.address) === lower(this.pcaOwnerWallet.address),
      'fixture setup and cleanup transactions require a lifecycle-exclusive signer',
    );
    const populated = await signer.populateTransaction(request);
    invariant(populated.nonce !== undefined, 'known transaction nonce is unavailable');
    const signed = await signer.signTransaction(populated);
    const transaction: KnownTransaction = {
      from: signer.address,
      hash: ethers.keccak256(signed),
      nonce: Number(populated.nonce),
      signedTransaction: signed,
    };
    remember(transaction);
    const acceptedFault = this.acceptedBroadcastFault;
    if (shouldInjectAcceptedBroadcastFault(acceptedFault, acceptedFaultCheckpoint)) {
      const response = await this.resources.state.provider.broadcastTransaction(signed);
      invariant(
        lower(response.hash) === lower(transaction.hash),
        `accepted fault broadcast hash mismatch: expected ${transaction.hash}, received ${response.hash}`,
      );
      acceptedFault.onAccepted?.({
        transaction,
        pcaOwnerAddress: this.pcaOwnerWallet.address,
      });
      throw acceptedFault.error;
    }
    const outcome = await this.reconcileKnownTransaction(transaction);
    invariant(
      outcome === 'succeeded',
      `transaction ${transaction.hash} was ${outcome}`,
    );
  }

  private async activateRegistrationDeposit(): Promise<void> {
    const { state, ownerWallet, parameters } = this.resources;
    this.registrationDepositBefore = BigInt(
      await parameters.contextGraphRegistrationDeposit(),
    );
    invariant(
      REGISTRATION_DEPOSIT > 0n && REGISTRATION_DEPOSIT < 1n << 96n,
      'fixture registration deposit must be a positive uint96 value',
    );
    if (this.registrationDepositBefore === REGISTRATION_DEPOSIT) return;

    // Register compensation before broadcasting. If the mined outcome is
    // uncertain, cleanup reconciles this exact signed transaction first and
    // then restores only state that still carries the fixture-owned value.
    this.registrationDepositChanged = true;
    this.cleanup.defer(
      'registration deposit restoration',
      () => this.restoreRegistrationDeposit(),
    );
    const request = await (parameters.connect(ownerWallet) as ethers.Contract)
      .setContextGraphRegistrationDeposit.populateTransaction(
        REGISTRATION_DEPOSIT,
        { nonce: await nextPendingNonce(state.provider, ownerWallet.address) },
      );
    await this.broadcastKnownTransaction(
      ownerWallet,
      request,
      (transaction) => {
        this.registrationDepositSetTransaction = transaction;
      },
    );
    invariant(
      BigInt(await parameters.contextGraphRegistrationDeposit()) === REGISTRATION_DEPOSIT,
      'fixture registration deposit activation failed',
    );
  }

  private async restoreRegistrationDeposit(): Promise<void> {
    if (!this.registrationDepositChanged) return;
    const { state, ownerWallet, parameters } = this.resources;

    if (this.registrationDepositSetTransaction) {
      await this.reconcileKnownTransaction(this.registrationDepositSetTransaction);
    }
    if (this.registrationDepositRestoreTransaction) {
      const outcome = await this.reconcileKnownTransaction(
        this.registrationDepositRestoreTransaction,
      );
      if (outcome === 'succeeded') {
        invariant(
          BigInt(await parameters.contextGraphRegistrationDeposit())
            === this.registrationDepositBefore,
          'fixture registration deposit restore transaction mined without restoring the snapshot',
        );
        return;
      }
    }

    const current = BigInt(await parameters.contextGraphRegistrationDeposit());
    if (current === this.registrationDepositBefore) return;
    if (current !== REGISTRATION_DEPOSIT) {
      throw new Error(
        `cleanup conflict: registration deposit changed to ${current}, expected fixture value `
        + `${REGISTRATION_DEPOSIT}; external value preserved for retry/manual recovery`,
      );
    }

    const request = await (parameters.connect(ownerWallet) as ethers.Contract)
      .setContextGraphRegistrationDeposit.populateTransaction(
        this.registrationDepositBefore,
        { nonce: await nextPendingNonce(state.provider, ownerWallet.address) },
      );
    await this.broadcastKnownTransaction(
      ownerWallet,
      request,
      (transaction) => {
        this.registrationDepositRestoreTransaction = transaction;
      },
    );
    invariant(
      BigInt(await parameters.contextGraphRegistrationDeposit())
        === this.registrationDepositBefore,
      'fixture registration deposit restoration failed',
    );
  }

  private async createEligiblePcaForWalletB(): Promise<void> {
    const {
      state,
      node,
      ownerWallet,
      walletB,
      token,
      pca,
      parameters,
      waiver,
    } = this.resources;
    const pcaOwner = this.pcaOwnerWallet;
    const floor = BigInt(await parameters.minPcaCommitmentForCgWaiver());
    const commitment = floor > COMMITMENT_BASELINE ? floor * 2n : COMMITMENT_BASELINE;
    invariant(commitment < 1n << 96n, 'fixture PCA commitment exceeds uint96');
    invariant(
      await token.balanceOf(ownerWallet.address) >= commitment,
      'fixture owner lacks TRAC for canonical PCA funding',
    );

    this.cleanup.defer('fixture PCA discovery and detachment', async () => {
      this.failCleanupAt('pca-detachment');
      await this.detachFixturePca();
      await this.refundPcaOwnerNativeBalance();
    });

    const gasFundingRequest: ethers.TransactionRequest = {
      nonce: await nextPendingNonce(state.provider, ownerWallet.address),
      to: pcaOwner.address,
      value: ethers.parseEther('1'),
    };
    await this.broadcastKnownTransaction(
      ownerWallet,
      gasFundingRequest,
      (transaction) => {
        this.pcaGasFundingTransaction = transaction;
      },
    );

    this.pcaFundingAmount = commitment;
    const fundingRequest = await (token.connect(ownerWallet) as ethers.Contract)
      .transfer.populateTransaction(
        pcaOwner.address,
        commitment,
        { nonce: await nextPendingNonce(state.provider, ownerWallet.address) },
      );
    await this.broadcastKnownTransaction(
      ownerWallet,
      fundingRequest,
      (transaction) => {
        this.pcaFundingTransaction = transaction;
      },
      'pca-funding',
    );
    const fundedBalance = BigInt(await token.balanceOf(pcaOwner.address));
    invariant(
      fundedBalance === commitment,
      `fixture PCA owner funding conflict: expected ${commitment}, found ${fundedBalance}; `
      + 'concurrent TRAC was preserved and must not be committed by the fixture',
    );
    const pcaAddress = await pca.getAddress();
    const approvalRequest = await (token.connect(pcaOwner) as ethers.Contract)
      .approve.populateTransaction(
        pcaAddress,
        fundedBalance,
        { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      );
    await this.broadcastKnownTransaction(
      pcaOwner,
      approvalRequest,
      (transaction) => {
        this.pcaApprovalTransaction = transaction;
      },
    );
    const mintRequest = await (pca.connect(pcaOwner) as ethers.Contract)
      .createAccount.populateTransaction(
        fundedBalance,
        node.identityId,
        { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      );
    await this.broadcastKnownTransaction(
      pcaOwner,
      mintRequest,
      (transaction) => {
        this.pcaMintTransaction = transaction;
      },
      'pca-mint',
    );
    this.failInitializationAt('after-pca-mint-before-read');

    invariant(await token.balanceOf(pcaOwner.address) === 0n, 'PCA mint must consume fixture owner TRAC');
    invariant(await token.allowance(pcaOwner.address, pcaAddress) === 0n, 'PCA mint allowance must be consumed');
    invariant(await pca.balanceOf(pcaOwner.address) === 1n, 'fixture owner must own fixture PCA');
    invariant(await pca.balanceOf(walletB.address) === 0n, 'publisher wallet must not own a PCA');
    this.pcaAccountId = await this.discoverFixturePcaAccountId();
    invariant(
      lower(await pca.ownerOf(this.pcaAccountId)) === lower(pcaOwner.address),
      'fixture PCA owner mismatch',
    );
    this.failInitializationAt('after-pca-creation');

    const registrationRequest = await (pca.connect(pcaOwner) as ethers.Contract)
      .registerAgent.populateTransaction(
        this.pcaAccountId,
        walletB.address,
        { nonce: await nextPendingNonce(state.provider, pcaOwner.address) },
      );
    await this.broadcastKnownTransaction(
      pcaOwner,
      registrationRequest,
      (transaction) => {
        this.pcaAgentRegistrationTransaction = transaction;
      },
    );
    this.failInitializationAt('after-agent-registration');
    invariant(
      await pca.agentToAccountId(walletB.address) === this.pcaAccountId,
      'fixture PCA agent registration failed',
    );

    const account = await pca.accounts(this.pcaAccountId);
    invariant(BigInt(account.committedTRAC ?? account[0]) === fundedBalance, 'fixture PCA commitment mismatch');
    invariant(Boolean(account.fullySwept ?? account[8]) === false, 'fixture PCA must be active');
    const latest = await state.provider.getBlock('latest');
    invariant(latest, 'latest block is unavailable');
    invariant(
      BigInt(account.expiresAtTimestamp ?? account[4]) > BigInt(latest.timestamp),
      'fixture PCA must not be expired',
    );
    invariant(await waiver.waivedCgCount(this.pcaAccountId) === 0n, 'fixture PCA waiver count must start at zero');
  }
}
