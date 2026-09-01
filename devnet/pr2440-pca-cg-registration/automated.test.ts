/**
 * Issue #2440 — live PCA-covered Context Graph auto-registration.
 *
 * Preconditions:
 *   pnpm run build
 *   DEVNET_ENABLE_PUBLISHER=1 DEVNET_PUBLISHER_WALLET_INDEX=1 ./scripts/devnet.sh start 6
 *
 * This suite deliberately exercises real node1 operational wallets because the
 * bug is signer-selection across the agent's wallet pool and the async runtime's
 * selected publisher. Every real node wallet's touched TRAC state and the global
 * registration deposit are snapshotted and restored in afterAll.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  fetchStatus,
  lexical,
  nextNonce,
  parseLastJsonBlock,
  queryNode,
  runDkgCli,
  setEth,
  waitFor,
  type CliResult,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const HUB_OWNER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPOSIT = ethers.parseEther('100');
const COMMITMENT_BASELINE = ethers.parseEther('500000');
const PREDICATE = 'https://schema.org/name';

const TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function MINTER_ROLE() view returns (bytes32)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

const PCA_ABI = [
  'function createAccount(uint96 committedTRAC, uint72 primaryNode) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 accountId) view returns (address)',
  'function agentToAccountId(address agent) view returns (uint256)',
  'function accounts(uint256 accountId) view returns (uint96 committedTRAC, uint40 createdAtEpoch, uint40 expiresAtEpoch, uint40 createdAtTimestamp, uint40 expiresAtTimestamp, uint72 primaryNode, uint96 cumulativeSpent, uint40 lastSettledWindow, bool fullySwept)',
];

const PARAMETERS_ABI = [
  'function contextGraphRegistrationDeposit() view returns (uint96)',
  'function minPcaCommitmentForCgWaiver() view returns (uint96)',
  'function setContextGraphRegistrationDeposit(uint96 amount)',
];

const CONTEXT_GRAPHS_ABI = [
  'function contextGraphStorage() view returns (address)',
  'function convictionStakingStorage() view returns (address)',
  'function createContextGraph(address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId, bytes32 nameHash) returns (uint256)',
  'event ContextGraphRegistrationDepositWaived(uint256 indexed contextGraphId, uint256 indexed accountId, address indexed creator)',
  'event ContextGraphRegistrationDeposited(uint256 indexed contextGraphId, address indexed payer, uint96 amount)',
];

const CONTEXT_GRAPH_STORAGE_ABI = [
  'function getContextGraphOwner(uint256 contextGraphId) view returns (address)',
  'function getPublishPolicy(uint256 contextGraphId) view returns (uint8 publishPolicy, address publishAuthority)',
  'function getPublishAuthorityAccountId(uint256 contextGraphId) view returns (uint256)',
  'function getRegistrationEscrow(uint256 contextGraphId) view returns (uint96)',
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, bytes32 indexed nameHash, address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
];

const WAIVER_ABI = [
  'function waivedCgCount(uint256 accountId) view returns (uint256)',
  'event RegistrationDepositWaived(uint256 indexed accountId, address indexed creator, uint256 newWaivedCount, uint256 quota)',
];

interface WalletSnapshot {
  address: string;
  balance: bigint;
  allowances: Map<string, bigint>;
}

interface PublisherJob extends Record<string, unknown> {
  status?: string;
  claim?: { walletId?: string };
  broadcast?: { walletId?: string; txHash?: string };
  request?: {
    jobType?: string;
    knowledgeAssetVmPublish?: { contextGraphId?: string; name?: string };
  };
  failure?: unknown;
}

interface FlowFixture {
  contextGraphId: string;
  name: string;
  subject: string;
  value: string;
}

interface RegistrationEvidence {
  contextGraphId: bigint;
  receipt: ethers.TransactionReceipt;
  created: ethers.LogDescription;
}

const tokenIface = new ethers.Interface(TOKEN_ABI);
const contextGraphsIface = new ethers.Interface(CONTEXT_GRAPHS_ABI);
const contextGraphStorageIface = new ethers.Interface(CONTEXT_GRAPH_STORAGE_ABI);
const waiverIface = new ethers.Interface(WAIVER_ABI);

const lower = (value: string): string => value.toLowerCase();
const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

function expectCliOk(result: CliResult, label: string): void {
  expect(
    result.code,
    `${label} failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function parseContextGraphId(stdout: string): string {
  const id = /^\s*ID:\s+(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!id) throw new Error(`could not parse context graph ID from:\n${stdout}`);
  return id;
}

function balanceSlot(address: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, 1n]),
  );
}

function allowanceSlot(owner: string, spender: string): string {
  const ownerSlot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [owner, 2n]),
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [spender, ownerSlot]),
  );
}

function storageWord(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function addressTopic(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

describe('issue #2440 — PCA-covered live CG registration', () => {
  let state: DevnetState | undefined;
  let node: DevnetNode;
  let walletA: ethers.Wallet;
  let walletB: ethers.Wallet;
  let ownerWallet: ethers.Wallet;
  let token: ethers.Contract;
  let pca: ethers.Contract;
  let parameters: ethers.Contract;
  let contextGraphs: ethers.Contract;
  let contextGraphStorage: ethers.Contract;
  let waiver: ethers.Contract;
  let contextGraphsAddress: string;
  let contextGraphStorageAddress: string;
  let waiverAddress: string;
  let stakingVaultAddress: string;
  let knowledgeAssetsLifecycleAddress: string;
  let pcaAccountId = 0n;
  let depositSnapshot: bigint | undefined;
  let walletSnapshots: WalletSnapshot[] = [];
  let allowanceSpenders: string[] = [];
  let depositChanged = false;
  let walletStateChanged = false;
  let fixtureDir = '';

  async function writeStorage(slot: string, value: bigint): Promise<void> {
    if (!state) throw new Error('devnet state unavailable');
    await state.provider.send('hardhat_setStorageAt', [
      await token.getAddress(),
      slot,
      storageWord(value),
    ]);
  }

  async function setBalance(address: string, value: bigint): Promise<void> {
    await writeStorage(balanceSlot(address), value);
    const actual = BigInt(await token.balanceOf(address));
    if (actual !== value) {
      throw new Error(`TRAC balance storage mismatch for ${address}: expected ${value}, got ${actual}`);
    }
  }

  async function setAllowance(owner: string, spender: string, value: bigint): Promise<void> {
    await writeStorage(allowanceSlot(owner, spender), value);
    const actual = BigInt(await token.allowance(owner, spender));
    if (actual !== value) {
      throw new Error(
        `TRAC allowance storage mismatch for ${owner} -> ${spender}: expected ${value}, got ${actual}`,
      );
    }
  }

  async function setRegistrationDeposit(value: bigint): Promise<void> {
    if (!state) throw new Error('devnet state unavailable');
    const tx = await (parameters.connect(ownerWallet) as ethers.Contract)
      .setContextGraphRegistrationDeposit(value, {
        nonce: await nextNonce(state.provider, ownerWallet.address),
      });
    await tx.wait();
    const actual = BigInt(await parameters.contextGraphRegistrationDeposit());
    if (actual !== value) {
      throw new Error(`registration deposit mismatch: expected ${value}, got ${actual}`);
    }
  }

  async function snapshotRealWallets(): Promise<void> {
    if (!state) throw new Error('devnet state unavailable');
    const realWallets = new Map<string, string>();
    for (const current of Object.values(state.nodes)) {
      for (const wallet of [current.admin, ...current.opWallets]) {
        realWallets.set(lower(wallet.address), ethers.getAddress(wallet.address));
      }
    }
    walletSnapshots = await Promise.all([...realWallets.values()].map(async (address) => {
      const allowances = new Map<string, bigint>();
      for (const spender of allowanceSpenders) {
        allowances.set(lower(spender), BigInt(await token.allowance(address, spender)));
      }
      return {
        address,
        balance: BigInt(await token.balanceOf(address)),
        allowances,
      };
    }));
  }

  async function restoreRealWallets(): Promise<void> {
    const failures: string[] = [];
    for (const snapshot of walletSnapshots) {
      try {
        await setBalance(snapshot.address, snapshot.balance);
      } catch (error) {
        failures.push(`balance ${snapshot.address}: ${(error as Error).message}`);
      }
      for (const spender of allowanceSpenders) {
        try {
          await setAllowance(
            snapshot.address,
            spender,
            snapshot.allowances.get(lower(spender)) ?? 0n,
          );
        } catch (error) {
          failures.push(
            `allowance ${snapshot.address} -> ${spender}: ${(error as Error).message}`,
          );
        }
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  }

  async function createEligiblePcaOwnedByB(): Promise<bigint> {
    if (!state) throw new Error('devnet state unavailable');
    const floor = BigInt(await parameters.minPcaCommitmentForCgWaiver());
    const commitment = floor > COMMITMENT_BASELINE ? floor * 2n : COMMITMENT_BASELINE;
    expect(commitment).toBeLessThan(1n << 96n);

    const minterRole: string = await token.MINTER_ROLE();
    expect(
      await token.hasRole(minterRole, ownerWallet.address),
      'Hardhat account #0 must retain the token minter role for the live fixture',
    ).toBe(true);

    const beforeBalance = BigInt(await token.balanceOf(walletB.address));
    await (await (token.connect(ownerWallet) as ethers.Contract).mint(walletB.address, commitment, {
      nonce: await nextNonce(state.provider, ownerWallet.address),
    })).wait();
    expect(await token.balanceOf(walletB.address)).toBe(beforeBalance + commitment);

    const pcaAddress = await pca.getAddress();
    await (await (token.connect(walletB) as ethers.Contract).approve(pcaAddress, commitment, {
      nonce: await nextNonce(state.provider, walletB.address),
    })).wait();
    await (await (pca.connect(walletB) as ethers.Contract).createAccount(
      commitment,
      node.identityId,
      { nonce: await nextNonce(state.provider, walletB.address) },
    )).wait();

    expect(await token.balanceOf(walletB.address), 'PCA commitment must consume only freshly minted TRAC')
      .toBe(beforeBalance);
    expect(await token.allowance(walletB.address, pcaAddress), 'exact PCA approval must be exhausted')
      .toBe(0n);
    expect(await pca.balanceOf(walletB.address), 'wallet B must own exactly one fixture PCA').toBe(1n);
    const accountId = BigInt(await pca.tokenOfOwnerByIndex(walletB.address, 0n));
    expect(lower(await pca.ownerOf(accountId))).toBe(lower(walletB.address));

    const account = await pca.accounts(accountId);
    expect(BigInt(account.committedTRAC ?? account[0])).toBe(commitment);
    expect(Boolean(account.fullySwept ?? account[8])).toBe(false);
    const latest = await state.provider.getBlock('latest');
    expect(latest).not.toBeNull();
    expect(BigInt(account.expiresAtTimestamp ?? account[4])).toBeGreaterThan(
      BigInt(latest!.timestamp),
    );
    expect(await waiver.waivedCgCount(accountId)).toBe(0n);
    return accountId;
  }

  async function createAndShareFlow(label: string): Promise<FlowFixture> {
    const slug = unique(`pr2440-${label}`);
    const created = await runDkgCli(node, [
      'context-graph',
      'create',
      slug,
      '--name',
      `PR 2440 ${label}`,
      '--description',
      `Issue 2440 ${label} PCA registration coverage`,
      '--access-policy',
      '0',
    ], 120_000);
    expectCliOk(created, `${label} context-graph create`);
    const contextGraphId = parseContextGraphId(created.stdout);

    const name = unique(`pr2440-${label}-ka`);
    const subject = `urn:test:pr2440:${label}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
    const value = `issue 2440 ${label} ${Date.now()}`;
    const filePath = join(fixtureDir, `${name}.nt`);
    writeFileSync(filePath, `<${subject}> <${PREDICATE}> ${JSON.stringify(value)} .\n`, 'utf8');

    const shared = await runDkgCli(node, [
      'ka',
      'create',
      name,
      '--context-graph-id',
      contextGraphId,
      '--input-file',
      filePath,
      '--share',
    ], 180_000);
    expectCliOk(shared, `${label} ka create --share`);
    return { contextGraphId, name, subject, value };
  }

  async function findRegistration(
    localContextGraphId: string,
    fromBlock: number,
  ): Promise<RegistrationEvidence> {
    if (!state) throw new Error('devnet state unavailable');
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(localContextGraphId));
    const event = contextGraphStorageIface.getEvent('ContextGraphCreated');
    if (!event) throw new Error('ContextGraphCreated ABI missing');
    const logs = await state.provider.getLogs({
      address: contextGraphStorageAddress,
      fromBlock: fromBlock + 1,
      toBlock: 'latest',
      topics: [event.topicHash, null, null, nameHash],
    });
    expect(
      logs,
      `expected one exact ContextGraphCreated from ${contextGraphStorageAddress} for ${localContextGraphId}`,
    ).toHaveLength(1);
    const created = contextGraphStorageIface.parseLog(logs[0]!);
    expect(created?.name).toBe('ContextGraphCreated');
    const receipt = await state.provider.getTransactionReceipt(logs[0]!.transactionHash);
    expect(receipt, 'registration transaction receipt must exist').not.toBeNull();
    expect(receipt!.status).toBe(1);
    expect(lower(receipt!.to!)).toBe(lower(contextGraphsAddress));
    expect(lower(receipt!.from)).toBe(lower(walletB.address));
    return {
      contextGraphId: BigInt(created!.args.contextGraphId),
      receipt: receipt!,
      created: created!,
    };
  }

  function parseExactEvents(
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

  async function assertNoRegistrationApproval(
    owner: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    if (!state) throw new Error('devnet state unavailable');
    const approval = tokenIface.getEvent('Approval');
    if (!approval) throw new Error('Approval ABI missing');
    const logs = await state.provider.getLogs({
      address: await token.getAddress(),
      fromBlock: fromBlock + 1,
      toBlock,
      topics: [approval.topicHash, addressTopic(owner), addressTopic(contextGraphsAddress)],
    });
    expect(
      logs,
      `registration must not hide a non-zero ${owner} -> ContextGraphs approval that was consumed back to zero`,
    ).toHaveLength(0);
  }

  async function assertPcaWaivedOpenRegistration(
    evidence: RegistrationEvidence,
    fromBlock: number,
    waivedCountBefore: bigint,
  ): Promise<void> {
    const { contextGraphId, receipt, created } = evidence;
    expect(lower(created.args.owner)).toBe(lower(walletB.address));
    expect(Number(created.args.accessPolicy)).toBe(0);
    expect(Number(created.args.publishPolicy)).toBe(1);
    expect(lower(created.args.publishAuthority)).toBe(lower(ethers.ZeroAddress));
    expect(BigInt(created.args.publishAuthorityAccountId)).toBe(0n);

    const facadeWaivers = parseExactEvents(
      receipt,
      contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDepositWaived',
    );
    const storageWaivers = parseExactEvents(
      receipt,
      waiverAddress,
      waiverIface,
      'RegistrationDepositWaived',
    );
    const deposits = parseExactEvents(
      receipt,
      contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDeposited',
    );
    expect(facadeWaivers, 'facade must emit exactly one waiver event').toHaveLength(1);
    expect(storageWaivers, 'waiver storage must emit exactly one waiver event').toHaveLength(1);
    expect(deposits, 'waived registration must not emit a deposit event').toHaveLength(0);

    const facade = facadeWaivers[0]!.args;
    expect(BigInt(facade.contextGraphId)).toBe(contextGraphId);
    expect(BigInt(facade.accountId)).toBe(pcaAccountId);
    expect(lower(facade.creator)).toBe(lower(walletB.address));
    const storage = storageWaivers[0]!.args;
    expect(BigInt(storage.accountId)).toBe(pcaAccountId);
    expect(lower(storage.creator)).toBe(lower(walletB.address));
    expect(BigInt(storage.newWaivedCount)).toBe(waivedCountBefore + 1n);
    const account = await pca.accounts(pcaAccountId);
    expect(BigInt(storage.quota)).toBe(BigInt(account.committedTRAC ?? account[0]) / DEPOSIT);
    expect(await waiver.waivedCgCount(pcaAccountId)).toBe(waivedCountBefore + 1n);

    expect(lower(await contextGraphStorage.getContextGraphOwner(contextGraphId))).toBe(
      lower(walletB.address),
    );
    const policy = await contextGraphStorage.getPublishPolicy(contextGraphId);
    expect(Number(policy.publishPolicy ?? policy[0])).toBe(1);
    expect(lower(policy.publishAuthority ?? policy[1])).toBe(lower(ethers.ZeroAddress));
    expect(await contextGraphStorage.getPublishAuthorityAccountId(contextGraphId)).toBe(0n);
    expect(await contextGraphStorage.getRegistrationEscrow(contextGraphId)).toBe(0n);

    expect(await token.balanceOf(walletA.address), 'primary wallet A must remain unfunded').toBe(0n);
    expect(await token.balanceOf(walletB.address), 'PCA wallet B must remain liquid-TRAC-free').toBe(0n);
    expect(await token.allowance(walletA.address, contextGraphsAddress)).toBe(0n);
    expect(await token.allowance(walletB.address, contextGraphsAddress)).toBe(0n);
    await assertNoRegistrationApproval(walletA.address, fromBlock, receipt.blockNumber);
    await assertNoRegistrationApproval(walletB.address, fromBlock, receipt.blockNumber);
  }

  async function assertVmVisible(flow: FlowFixture): Promise<void> {
    const rows = await waitFor(
      `${flow.subject} visible in VM for ${flow.contextGraphId}`,
      180_000,
      5_000,
      async () => {
        const bindings = await queryNode(
          node,
          `SELECT ?o WHERE { GRAPH ?g { <${flow.subject}> <${PREDICATE}> ?o } }`,
          { contextGraphId: flow.contextGraphId, view: 'verifiable-memory' },
        );
        return bindings.some((row) => lexical(row.o) === flow.value) ? bindings : null;
      },
    );
    expect(rows.length).toBeGreaterThan(0);
  }

  async function waitForPublisherJob(jobId: string, flow: FlowFixture): Promise<PublisherJob> {
    const job = await waitFor(
      `publisher job ${jobId} finalized`,
      300_000,
      5_000,
      async () => {
        const detail = await runDkgCli(node, ['publisher', 'job', jobId, '--payload'], 60_000);
        expectCliOk(detail, `publisher job ${jobId}`);
        const current = parseLastJsonBlock<PublisherJob>(detail.stdout, `publisher job ${jobId}`);
        if (current.status === 'failed') {
          throw new Error(`publisher job ${jobId} failed: ${JSON.stringify(current.failure ?? current)}`);
        }
        return current.status === 'finalized' ? current : null;
      },
    );
    expect(job.request?.jobType).toBe('knowledge-asset-vm-publish');
    expect(job.request?.knowledgeAssetVmPublish?.contextGraphId).toBe(flow.contextGraphId);
    expect(job.request?.knowledgeAssetVmPublish?.name).toBe(flow.name);
    expect(lower(job.claim?.walletId ?? '')).toBe(lower(walletB.address));
    expect(lower(job.broadcast?.walletId ?? '')).toBe(lower(walletB.address));
    expect(job.broadcast?.txHash, `publisher job ${jobId} must retain exact broadcast evidence`)
      .toMatch(/^0x[0-9a-fA-F]{64}$/);
    return job;
  }

  beforeAll(async () => {
    const detected = await detectDevnet(6);
    if (!detected) {
      throw new Error(
        'No six-node devnet detected. Start with DEVNET_ENABLE_PUBLISHER=1 ' +
        'DEVNET_PUBLISHER_WALLET_INDEX=1 ./scripts/devnet.sh start 6 after pnpm run build.',
      );
    }
    state = detected;
    await ensureAllIdentities(state, 4);
    node = state.nodes[1]!;
    expect(Object.keys(state.nodes)).toHaveLength(6);
    const liveStatuses = await Promise.all(
      Object.values(state.nodes).map((current) => fetchStatus(current)),
    );
    expect(liveStatuses, 'all six daemon APIs must be live').toHaveLength(6);

    for (const current of Object.values(state.nodes)) {
      expect(current.opWallets.length, `node${current.num} needs operational wallet index 1`)
        .toBeGreaterThan(1);
      const config = JSON.parse(readFileSync(join(current.home, 'config.json'), 'utf8'));
      const publisherConfig = JSON.parse(
        readFileSync(join(current.home, 'publisher-wallets.json'), 'utf8'),
      ) as { wallets?: Array<{ address?: string; privateKey?: string }> };
      expect(config?.publisher?.enabled, `node${current.num} publisher runtime must be enabled`)
        .toBe(true);
      expect(publisherConfig.wallets, `node${current.num} must configure one selected publisher`)
        .toHaveLength(1);
      expect(lower(publisherConfig.wallets![0]!.address ?? '')).toBe(
        lower(current.opWallets[1]!.address),
      );
      expect(
        lower(new ethers.Wallet(publisherConfig.wallets![0]!.privateKey!).address),
        `node${current.num} selected publisher key must control operational wallet index 1`,
      ).toBe(lower(current.opWallets[1]!.address));
    }

    walletA = new ethers.Wallet(node.opWallets[0]!.privateKey, state.provider);
    walletB = new ethers.Wallet(node.opWallets[1]!.privateKey, state.provider);
    expect(lower(walletA.address)).not.toBe(lower(walletB.address));
    ownerWallet = new ethers.Wallet(HUB_OWNER_PK, state.provider);
    await setEth(state, ownerWallet.address);

    token = new ethers.Contract(state.addrs.Token, TOKEN_ABI, state.provider);
    pca = new ethers.Contract(state.addrs.DKGPublishingConvictionNFT, PCA_ABI, state.provider);
    parameters = new ethers.Contract(state.addrs.ParametersStorage, PARAMETERS_ABI, state.provider);
    contextGraphsAddress = ethers.getAddress(state.addrs.ContextGraphs);
    contextGraphs = new ethers.Contract(contextGraphsAddress, CONTEXT_GRAPHS_ABI, state.provider);
    contextGraphStorageAddress = ethers.getAddress(await contextGraphs.contextGraphStorage());
    contextGraphStorage = new ethers.Contract(
      contextGraphStorageAddress,
      CONTEXT_GRAPH_STORAGE_ABI,
      state.provider,
    );
    waiverAddress = ethers.getAddress(state.addrs.ContextGraphWaiverStorage);
    waiver = new ethers.Contract(waiverAddress, WAIVER_ABI, state.provider);
    stakingVaultAddress = ethers.getAddress(await contextGraphs.convictionStakingStorage());
    knowledgeAssetsLifecycleAddress = ethers.getAddress(
      await state.hub.getContractAddress('KnowledgeAssetsLifecycle'),
    );
    allowanceSpenders = [
      contextGraphsAddress,
      ethers.getAddress(await pca.getAddress()),
      knowledgeAssetsLifecycleAddress,
    ];

    const hubOwner = ethers.getAddress(await new ethers.Contract(
      state.addrs.Hub,
      ['function owner() view returns (address)'],
      state.provider,
    ).owner());
    expect(hubOwner, 'known Hardhat owner key must control the live Hub').toBe(ownerWallet.address);

    depositSnapshot = BigInt(await parameters.contextGraphRegistrationDeposit());
    await snapshotRealWallets();
    fixtureDir = mkdtempSync(join(tmpdir(), 'dkg-pr2440-'));

    expect(await pca.balanceOf(walletA.address), 'wallet A must not own a PCA').toBe(0n);
    expect(await pca.agentToAccountId(walletA.address), 'wallet A must not be a PCA agent').toBe(0n);
    expect(await pca.balanceOf(walletB.address), 'wallet B fixture requires a fresh no-PCA baseline').toBe(0n);
    expect(await pca.agentToAccountId(walletB.address), 'wallet B must not inherit agent coverage').toBe(0n);

    depositChanged = true;
    await setRegistrationDeposit(DEPOSIT);
    walletStateChanged = true;
    pcaAccountId = await createEligiblePcaOwnedByB();
    expect(await pca.agentToAccountId(walletB.address), 'wallet B coverage must use ownership')
      .toBe(0n);

    // Make ordinary deposit fallback impossible for both pool candidates. A
    // false coverage selection now fails loudly instead of spending pre-funded
    // devnet TRAC and producing a green publish.
    await setBalance(walletA.address, 0n);
    await setBalance(walletB.address, 0n);
    await setAllowance(walletA.address, contextGraphsAddress, 0n);
    await setAllowance(walletB.address, contextGraphsAddress, 0n);
    expect(await parameters.contextGraphRegistrationDeposit()).toBe(DEPOSIT);
  }, 300_000);

  afterAll(async () => {
    const failures: string[] = [];
    if (state && depositChanged && depositSnapshot !== undefined) {
      try {
        await setRegistrationDeposit(depositSnapshot);
      } catch (error) {
        failures.push(`registration deposit restore failed: ${(error as Error).message}`);
      }
    }
    if (state && walletStateChanged) {
      try {
        await restoreRealWallets();
      } catch (error) {
        failures.push(`real wallet TRAC restore failed: ${(error as Error).message}`);
      }
    }
    if (fixtureDir) {
      try {
        rmSync(fixtureDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(`temporary fixture cleanup failed: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  }, 300_000);

  it('sync VM first-publish auto-registers an open graph with exact PCA-covered wallet B', async () => {
    if (!state) throw new Error('devnet state unavailable');
    const flow = await createAndShareFlow('sync');
    const waivedBefore = BigInt(await waiver.waivedCgCount(pcaAccountId));
    const fromBlock = await state.provider.getBlockNumber();

    const published = await runDkgCli(node, [
      'ka',
      'publish',
      flow.name,
      '--context-graph-id',
      flow.contextGraphId,
      '--json',
    ], 300_000);
    expectCliOk(published, 'sync ka publish');
    const publishResult = parseLastJsonBlock<Record<string, unknown>>(
      published.stdout,
      'sync ka publish',
    );
    expect(['confirmed', 'finalized']).toContain(String(publishResult.status).toLowerCase());

    const evidence = await findRegistration(flow.contextGraphId, fromBlock);
    await assertPcaWaivedOpenRegistration(evidence, fromBlock, waivedBefore);
    await assertVmVisible(flow);
  }, 600_000);

  it('async VM first-publish retains selected wallet B through registration and broadcast', async () => {
    if (!state) throw new Error('devnet state unavailable');
    const flow = await createAndShareFlow('async');
    const waivedBefore = BigInt(await waiver.waivedCgCount(pcaAccountId));
    const fromBlock = await state.provider.getBlockNumber();

    const enqueued = await runDkgCli(node, [
      'ka',
      'publish-async',
      flow.name,
      '--context-graph-id',
      flow.contextGraphId,
      '--json',
    ], 60_000);
    expectCliOk(enqueued, 'async ka publish enqueue');
    const accepted = parseLastJsonBlock<Record<string, unknown>>(
      enqueued.stdout,
      'async ka publish enqueue',
    );
    expect(accepted.status).toBe('accepted');
    expect(accepted.jobId).toBeTruthy();
    const job = await waitForPublisherJob(String(accepted.jobId), flow);

    const evidence = await findRegistration(flow.contextGraphId, fromBlock);
    await assertPcaWaivedOpenRegistration(evidence, fromBlock, waivedBefore);
    expect(lower(job.broadcast!.walletId!)).toBe(lower(evidence.receipt.from));
    const publishReceipt = await state.provider.getTransactionReceipt(job.broadcast!.txHash!);
    expect(publishReceipt, 'async broadcast transaction receipt must exist').not.toBeNull();
    expect(publishReceipt!.status).toBe(1);
    expect(lower(publishReceipt!.from)).toBe(lower(walletB.address));
    expect(lower(publishReceipt!.to!)).toBe(lower(knowledgeAssetsLifecycleAddress));
    await assertVmVisible(flow);
  }, 600_000);

  it('direct non-PCA wallet C pays the exact 100 TRAC deposit into registration escrow', async () => {
    if (!state) throw new Error('devnet state unavailable');
    const walletC = ethers.Wallet.createRandom().connect(state.provider);
    await setEth(state, walletC.address);
    expect(await pca.balanceOf(walletC.address)).toBe(0n);
    expect(await pca.agentToAccountId(walletC.address)).toBe(0n);
    const waivedBefore = BigInt(await waiver.waivedCgCount(pcaAccountId));

    await (await (token.connect(ownerWallet) as ethers.Contract).mint(walletC.address, DEPOSIT, {
      nonce: await nextNonce(state.provider, ownerWallet.address),
    })).wait();
    await (await (token.connect(walletC) as ethers.Contract).approve(contextGraphsAddress, DEPOSIT, {
      nonce: await nextNonce(state.provider, walletC.address),
    })).wait();
    const payerBefore = BigInt(await token.balanceOf(walletC.address));
    const vaultBefore = BigInt(await token.balanceOf(stakingVaultAddress));
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(unique('pr2440-paid-control')));

    const tx = await (contextGraphs.connect(walletC) as ethers.Contract).createContextGraph(
      [],
      0n,
      0,
      1,
      ethers.ZeroAddress,
      0n,
      nameHash,
      { nonce: await nextNonce(state.provider, walletC.address) },
    );
    const receipt = await tx.wait() as ethers.TransactionReceipt;
    expect(receipt.status).toBe(1);
    expect(lower(receipt.to!)).toBe(lower(contextGraphsAddress));
    expect(lower(receipt.from)).toBe(lower(walletC.address));

    const createdEvents = parseExactEvents(
      receipt,
      contextGraphStorageAddress,
      contextGraphStorageIface,
      'ContextGraphCreated',
    );
    expect(createdEvents).toHaveLength(1);
    const contextGraphId = BigInt(createdEvents[0]!.args.contextGraphId);
    expect(createdEvents[0]!.args.nameHash).toBe(nameHash);
    expect(lower(createdEvents[0]!.args.owner)).toBe(lower(walletC.address));
    expect(Number(createdEvents[0]!.args.publishPolicy)).toBe(1);
    expect(lower(createdEvents[0]!.args.publishAuthority)).toBe(lower(ethers.ZeroAddress));
    expect(BigInt(createdEvents[0]!.args.publishAuthorityAccountId)).toBe(0n);

    const deposits = parseExactEvents(
      receipt,
      contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDeposited',
    );
    expect(deposits).toHaveLength(1);
    expect(BigInt(deposits[0]!.args.contextGraphId)).toBe(contextGraphId);
    expect(lower(deposits[0]!.args.payer)).toBe(lower(walletC.address));
    expect(BigInt(deposits[0]!.args.amount)).toBe(DEPOSIT);
    expect(parseExactEvents(
      receipt,
      contextGraphsAddress,
      contextGraphsIface,
      'ContextGraphRegistrationDepositWaived',
    )).toHaveLength(0);
    expect(parseExactEvents(
      receipt,
      waiverAddress,
      waiverIface,
      'RegistrationDepositWaived',
    )).toHaveLength(0);
    expect(await waiver.waivedCgCount(pcaAccountId)).toBe(waivedBefore);

    expect(await token.balanceOf(walletC.address)).toBe(payerBefore - DEPOSIT);
    expect(await token.allowance(walletC.address, contextGraphsAddress)).toBe(0n);
    expect(await token.balanceOf(stakingVaultAddress)).toBe(vaultBefore + DEPOSIT);
    expect(await contextGraphStorage.getRegistrationEscrow(contextGraphId)).toBe(DEPOSIT);
    expect(lower(await contextGraphStorage.getContextGraphOwner(contextGraphId))).toBe(
      lower(walletC.address),
    );
  }, 120_000);
});
