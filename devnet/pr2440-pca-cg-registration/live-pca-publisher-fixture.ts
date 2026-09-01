import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  lexical,
  nextNonce,
  parseLastJsonBlock,
  queryNode,
  runDkgCli,
  waitFor,
  type CliResult,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import {
  CONTEXT_GRAPHS_ABI,
  CONTEXT_GRAPH_STORAGE_ABI,
  PREDICATE,
  TOKEN_ABI,
  WAIVER_ABI,
} from './pca-registration-contracts.js';
import {
  drainLivePcaPublisherInitializationCleanups,
  LivePcaPublisherLifecycle,
  retryLivePcaPublisherInitializationCleanup,
  type FixtureAcceptedBroadcastCheckpoint,
  type FixtureCleanupCheckpoint,
  type FixtureInitializationCheckpoint,
  type LivePcaPublisherFixtureCreateOptions,
  type LivePcaPublisherMutableState,
  type LivePcaPublisherResources,
  type LivePcaPublisherWalletBalances,
} from './live-pca-publisher-lifecycle.js';

export {
  drainLivePcaPublisherInitializationCleanups,
  retryLivePcaPublisherInitializationCleanup,
};
export type {
  FixtureAcceptedBroadcastCheckpoint,
  FixtureCleanupCheckpoint,
  FixtureInitializationCheckpoint,
  LivePcaPublisherFixtureCreateOptions,
  LivePcaPublisherMutableState,
  LivePcaPublisherWalletBalances,
};

interface RawPublisherJob extends Record<string, unknown> {
  status?: string;
  claim?: { walletId?: string };
  broadcast?: { walletId?: string; txHash?: string };
  request?: {
    jobType?: string;
    knowledgeAssetVmPublish?: { contextGraphId?: string; name?: string };
  };
  failure?: unknown;
}

export interface FinalizedPublisherJob extends Record<string, unknown> {
  status: 'finalized';
  claim: { walletId: string };
  broadcast: { walletId: string; txHash: string };
  request: {
    jobType: string;
    knowledgeAssetVmPublish: { contextGraphId: string; name: string };
  };
}

export interface FlowFixture {
  contextGraphId: string;
  name: string;
  subject: string;
  value: string;
}

export interface RegistrationEvidence {
  contextGraphId: bigint;
  receipt: ethers.TransactionReceipt;
  created: ethers.LogDescription;
}

export interface WaivedRegistrationEvidence {
  facadeWaivers: ethers.LogDescription[];
  storageWaivers: ethers.LogDescription[];
  deposits: ethers.LogDescription[];
  accountCommitment: bigint;
  registrationDeposit: bigint;
  waivedCountAfter: bigint;
  storedOwner: string;
  storedPublishPolicy: number;
  storedPublishAuthority: string;
  storedPublishAuthorityAccountId: bigint;
  registrationEscrow: bigint;
  walletAAllowance: bigint;
  walletBAllowance: bigint;
  tokenTransfers: ethers.LogDescription[];
  walletAApprovals: ethers.Log[];
  walletBApprovals: ethers.Log[];
}

export interface AsyncPublishEvidence {
  acceptedStatus: string;
  jobId: string;
  job: FinalizedPublisherJob;
}

export interface SyncPublishEvidence {
  status: string;
}

export interface CanonicalTransactionEvidence {
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
}

export interface CanonicalOperationalWalletEffect extends CanonicalTransactionEvidence {
  amount: bigint;
  sourceAddress: string;
  targetAddress: string;
}

const tokenIface = new ethers.Interface(TOKEN_ABI);
const contextGraphsIface = new ethers.Interface(CONTEXT_GRAPHS_ABI);
const contextGraphStorageIface = new ethers.Interface(CONTEXT_GRAPH_STORAGE_ABI);
const waiverIface = new ethers.Interface(WAIVER_ABI);
const lower = (value: string): string => value.toLowerCase();
const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function finalizedPublisherJob(raw: RawPublisherJob, jobId: string): FinalizedPublisherJob {
  invariant(raw.status === 'finalized', `publisher job ${jobId} is not finalized`);
  const claimWalletId = raw.claim?.walletId;
  const broadcastWalletId = raw.broadcast?.walletId;
  const txHash = raw.broadcast?.txHash;
  const jobType = raw.request?.jobType;
  const contextGraphId = raw.request?.knowledgeAssetVmPublish?.contextGraphId;
  const name = raw.request?.knowledgeAssetVmPublish?.name;
  invariant(typeof claimWalletId === 'string' && claimWalletId.length > 0,
    `publisher job ${jobId} is missing claim wallet evidence`);
  invariant(typeof broadcastWalletId === 'string' && broadcastWalletId.length > 0,
    `publisher job ${jobId} is missing broadcast wallet evidence`);
  invariant(typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash),
    `publisher job ${jobId} is missing a valid broadcast transaction hash`);
  invariant(typeof jobType === 'string' && jobType.length > 0,
    `publisher job ${jobId} is missing its request type`);
  invariant(typeof contextGraphId === 'string' && contextGraphId.length > 0,
    `publisher job ${jobId} is missing its context graph id`);
  invariant(typeof name === 'string' && name.length > 0,
    `publisher job ${jobId} is missing its knowledge asset name`);
  return {
    ...raw,
    status: 'finalized',
    claim: { walletId: claimWalletId },
    broadcast: { walletId: broadcastWalletId, txHash },
    request: {
      jobType,
      knowledgeAssetVmPublish: { contextGraphId, name },
    },
  };
}

function requireCliOk(result: CliResult, label: string): void {
  invariant(
    result.code === 0,
    `${label} failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseContextGraphId(stdout: string): string {
  const id = /^\s*ID:\s+(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!id) throw new Error(`could not parse context graph ID from:\n${stdout}`);
  return id;
}

const addressTopic = (address: string): string => ethers.zeroPadValue(ethers.getAddress(address), 32);

/**
 * Exposes primitive #2440 scenario operations and typed evidence. Mutable
 * resource ownership and targeted cleanup are delegated to LivePcaPublisherLifecycle.
 */
export class LivePcaPublisherFixture {
  readonly state: DevnetState;
  readonly node: DevnetNode;
  readonly walletA: ethers.Wallet;
  readonly walletB: ethers.Wallet;
  readonly ownerWallet: ethers.Wallet;
  readonly token: ethers.Contract;
  readonly pca: ethers.Contract;
  readonly parameters: ethers.Contract;
  readonly contextGraphStorage: ethers.Contract;
  readonly waiver: ethers.Contract;
  readonly contextGraphsAddress: string;
  readonly contextGraphStorageAddress: string;
  readonly waiverAddress: string;
  readonly knowledgeAssetsLifecycleAddress: string;
  private readonly lifecycle: LivePcaPublisherLifecycle;

  private constructor(lifecycle: LivePcaPublisherLifecycle) {
    this.lifecycle = lifecycle;
    const resources: LivePcaPublisherResources = lifecycle.resources;
    this.state = resources.state;
    this.node = resources.node;
    this.walletA = resources.walletA;
    this.walletB = resources.walletB;
    this.ownerWallet = resources.ownerWallet;
    this.token = resources.token;
    this.pca = resources.pca;
    this.parameters = resources.parameters;
    this.contextGraphStorage = resources.contextGraphStorage;
    this.waiver = resources.waiver;
    this.contextGraphsAddress = resources.contextGraphsAddress;
    this.contextGraphStorageAddress = resources.contextGraphStorageAddress;
    this.waiverAddress = resources.waiverAddress;
    this.knowledgeAssetsLifecycleAddress = resources.knowledgeAssetsLifecycleAddress;
  }

  static async captureMutableState(): Promise<LivePcaPublisherMutableState> {
    return LivePcaPublisherLifecycle.captureMutableState();
  }

  static async capturePcaTotalSupply(): Promise<bigint> {
    return LivePcaPublisherLifecycle.capturePcaTotalSupply();
  }

  static async captureWalletBBalances(): Promise<LivePcaPublisherWalletBalances> {
    return LivePcaPublisherLifecycle.captureWalletBBalances();
  }

  static async create(
    options: LivePcaPublisherFixtureCreateOptions = {},
  ): Promise<LivePcaPublisherFixture> {
    return new LivePcaPublisherFixture(await LivePcaPublisherLifecycle.create(options));
  }

  get pcaAccountId(): bigint {
    return this.lifecycle.pcaAccountId;
  }

  get fixtureId(): string {
    return this.lifecycle.fixtureId;
  }

  get fixtureDirectory(): string {
    return this.lifecycle.fixtureDirectory;
  }

  get initialWalletABalance(): bigint {
    return this.lifecycle.initialWalletABalance;
  }

  get initialWalletAContextGraphsAllowance(): bigint {
    return this.lifecycle.initialWalletAContextGraphsAllowance;
  }

  get initialWalletBTracBalance(): bigint {
    return this.lifecycle.initialWalletBTracBalance;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  async waivedCount(): Promise<bigint> {
    return BigInt(await this.waiver.waivedCgCount(this.pcaAccountId));
  }

  async blockNumber(): Promise<number> {
    return this.state.provider.getBlockNumber();
  }

  async createAndShareFlow(label: string): Promise<FlowFixture> {
    const scopedLabel = `${this.fixtureId}-${label}`;
    const slug = unique(`pr2440-${scopedLabel}`);
    const created = await runDkgCli(this.node, [
      'context-graph',
      'create',
      slug,
      '--name',
      `PR 2440 ${scopedLabel}`,
      '--description',
      `Issue 2440 ${scopedLabel} PCA registration coverage`,
      '--access-policy',
      '0',
    ], 120_000);
    requireCliOk(created, `${label} context-graph create`);
    const contextGraphId = parseContextGraphId(created.stdout);

    const name = unique(`pr2440-${scopedLabel}-ka`);
    const subject = `urn:test:pr2440:${scopedLabel}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const value = `issue 2440 ${scopedLabel} ${Date.now()}`;
    const filePath = join(this.fixtureDirectory, `${name}.nt`);
    writeFileSync(filePath, `<${subject}> <${PREDICATE}> ${JSON.stringify(value)} .\n`, 'utf8');

    const shared = await runDkgCli(this.node, [
      'ka',
      'create',
      name,
      '--context-graph-id',
      contextGraphId,
      '--input-file',
      filePath,
      '--share',
    ], 180_000);
    requireCliOk(shared, `${label} ka create --share`);
    return { contextGraphId, name, subject, value };
  }

  async publishSync(flow: FlowFixture): Promise<SyncPublishEvidence> {
    const published = await runDkgCli(this.node, [
      'ka',
      'publish',
      flow.name,
      '--context-graph-id',
      flow.contextGraphId,
      '--json',
    ], 300_000);
    requireCliOk(published, 'sync ka publish');
    const result = parseLastJsonBlock<Record<string, unknown>>(published.stdout, 'sync ka publish');
    return { status: String(result.status).toLowerCase() };
  }

  async publishAsync(flow: FlowFixture): Promise<AsyncPublishEvidence> {
    const enqueued = await runDkgCli(this.node, [
      'ka',
      'publish-async',
      flow.name,
      '--context-graph-id',
      flow.contextGraphId,
      '--json',
    ], 60_000);
    requireCliOk(enqueued, 'async ka publish enqueue');
    const accepted = parseLastJsonBlock<Record<string, unknown>>(
      enqueued.stdout,
      'async ka publish enqueue',
    );
    const jobId = String(accepted.jobId ?? '');
    invariant(jobId.length > 0, 'async publish did not return a job id');
    return {
      acceptedStatus: String(accepted.status),
      jobId,
      job: await this.waitForPublisherJob(jobId),
    };
  }

  async findRegistration(
    localContextGraphId: string,
    fromBlock: number,
  ): Promise<RegistrationEvidence> {
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId));
    const event = contextGraphStorageIface.getEvent('ContextGraphCreated');
    if (!event) throw new Error('ContextGraphCreated ABI missing');
    const logs = await this.state.provider.getLogs({
      address: this.contextGraphStorageAddress,
      fromBlock: fromBlock + 1,
      toBlock: 'latest',
      topics: [event.topicHash, null, null, nameHash],
    });
    invariant(logs.length === 1, `expected one ContextGraphCreated for ${localContextGraphId}`);
    const created = contextGraphStorageIface.parseLog(logs[0]!);
    invariant(created?.name === 'ContextGraphCreated', 'failed to parse ContextGraphCreated');
    const receipt = await this.state.provider.getTransactionReceipt(logs[0]!.transactionHash);
    invariant(receipt, 'registration transaction receipt must exist');
    return {
      contextGraphId: BigInt(created.args.contextGraphId),
      receipt,
      created,
    };
  }

  async collectWaivedRegistrationEvidence(
    evidence: RegistrationEvidence,
    fromBlock: number,
  ): Promise<WaivedRegistrationEvidence> {
    const { contextGraphId, receipt } = evidence;
    const facadeWaivers = this.parseExactEvents(
      receipt,
      this.contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDepositWaived',
    );
    const storageWaivers = this.parseExactEvents(
      receipt,
      this.waiverAddress,
      waiverIface,
      'RegistrationDepositWaived',
    );
    const deposits = this.parseExactEvents(
      receipt,
      this.contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDeposited',
    );
    const account = await this.pca.accounts(this.pcaAccountId);
    const policy = await this.contextGraphStorage.getPublishPolicy(contextGraphId);
    return {
      facadeWaivers,
      storageWaivers,
      deposits,
      accountCommitment: BigInt(account.committedTRAC ?? account[0]),
      registrationDeposit: BigInt(
        await this.parameters.contextGraphRegistrationDeposit(),
      ),
      waivedCountAfter: BigInt(await this.waiver.waivedCgCount(this.pcaAccountId)),
      storedOwner: String(await this.contextGraphStorage.getContextGraphOwner(contextGraphId)),
      storedPublishPolicy: Number(policy.publishPolicy ?? policy[0]),
      storedPublishAuthority: String(policy.publishAuthority ?? policy[1]),
      storedPublishAuthorityAccountId: BigInt(
        await this.contextGraphStorage.getPublishAuthorityAccountId(contextGraphId),
      ),
      registrationEscrow: BigInt(
        await this.contextGraphStorage.getRegistrationEscrow(contextGraphId),
      ),
      walletAAllowance: BigInt(
        await this.token.allowance(this.walletA.address, this.contextGraphsAddress),
      ),
      walletBAllowance: BigInt(
        await this.token.allowance(this.walletB.address, this.contextGraphsAddress),
      ),
      tokenTransfers: this.parseExactEvents(
        receipt,
        await this.token.getAddress(),
        tokenIface,
        'Transfer',
      ),
      walletAApprovals: await this.findRegistrationApprovals(
        this.walletA.address,
        fromBlock,
        receipt.blockNumber,
      ),
      walletBApprovals: await this.findRegistrationApprovals(
        this.walletB.address,
        fromBlock,
        receipt.blockNumber,
      ),
    };
  }

  async waitForVmVisibility(flow: FlowFixture): Promise<number> {
    const rows = await waitFor(
      `${flow.subject} visible in VM for ${flow.contextGraphId}`,
      180_000,
      5_000,
      async () => {
        const bindings = await queryNode(
          this.node,
          `SELECT ?o WHERE { GRAPH ?g { <${flow.subject}> <${PREDICATE}> ?o } }`,
          { contextGraphId: flow.contextGraphId, view: 'verifiable-memory' },
        );
        return bindings.some((row) => lexical(row.o) === flow.value) ? bindings : null;
      },
    );
    return rows.length;
  }

  async findAsyncBroadcastReceipt(
    job: FinalizedPublisherJob,
  ): Promise<ethers.TransactionReceipt> {
    const receipt = await this.state.provider.getTransactionReceipt(job.broadcast.txHash);
    invariant(receipt, 'finalized async broadcast transaction receipt must exist');
    return receipt;
  }

  async readFinalizedPublisherJob(jobId: string): Promise<FinalizedPublisherJob> {
    const current = await this.readPublisherJob(jobId);
    if (current.status === 'failed') {
      throw new Error(`publisher job ${jobId} failed: ${JSON.stringify(current.failure ?? current)}`);
    }
    if (current.status !== 'finalized') {
      throw new Error(`publisher job ${jobId} is ${String(current.status)}, expected finalized`);
    }
    return finalizedPublisherJob(current, jobId);
  }

  async submitUnrelatedOperationalWalletEffect(
    amount = 1n,
  ): Promise<CanonicalOperationalWalletEffect> {
    const receipt = await (await (this.token.connect(this.ownerWallet) as ethers.Contract).transfer(
      this.walletA.address,
      amount,
      { nonce: await nextNonce(this.state.provider, this.ownerWallet.address) },
    )).wait();
    invariant(receipt, 'unrelated operational-wallet transaction receipt must exist');
    return {
      amount,
      sourceAddress: this.ownerWallet.address,
      targetAddress: this.walletA.address,
      transactionHash: receipt.hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
    };
  }

  private parseExactEvents(
    receipt: ethers.TransactionReceipt,
    emitter: string,
    iface: ethers.Interface,
    eventName: string,
  ): ethers.LogDescription[] {
    return receipt.logs.flatMap((log) => {
      if (lower(log.address) !== lower(emitter)) return [];
      try {
        const parsed = iface.parseLog(log);
        return parsed?.name === eventName ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  private async findRegistrationApprovals(
    owner: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<ethers.Log[]> {
    const approval = tokenIface.getEvent('Approval');
    if (!approval) throw new Error('Approval ABI missing');
    return this.state.provider.getLogs({
      address: await this.token.getAddress(),
      fromBlock: fromBlock + 1,
      toBlock,
      topics: [approval.topicHash, addressTopic(owner), addressTopic(this.contextGraphsAddress)],
    });
  }

  private async waitForPublisherJob(jobId: string): Promise<FinalizedPublisherJob> {
    const job = await waitFor(
      `publisher job ${jobId} finalized`,
      300_000,
      5_000,
      async () => {
        const current = await this.readPublisherJob(jobId);
        if (current.status === 'failed') {
          throw new Error(`publisher job ${jobId} failed: ${JSON.stringify(current.failure ?? current)}`);
        }
        return current.status === 'finalized' ? finalizedPublisherJob(current, jobId) : null;
      },
    );
    return job;
  }

  private async readPublisherJob(jobId: string): Promise<RawPublisherJob> {
    const detail = await runDkgCli(this.node, ['publisher', 'job', jobId, '--payload'], 60_000);
    requireCliOk(detail, `publisher job ${jobId}`);
    return parseLastJsonBlock<RawPublisherJob>(detail.stdout, `publisher job ${jobId}`);
  }
}
