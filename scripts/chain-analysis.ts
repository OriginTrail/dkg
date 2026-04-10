#!/usr/bin/env npx tsx
/**
 * chain-analysis.ts
 *
 * Cross-chain analysis: compares on-chain staking totals against
 * publisher TRAC snapshots and staker/delegator stakes.
 *
 * Per chain reports:
 *   - Total staked TRAC (from StakingStorage.getTotalStake)
 *   - Total publisher TRAC (from our epoch16 snapshots)
 *   - Number of publishers and stakers
 *   - Any remaining/unaccounted TRAC
 */
import { ethers, JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ── Load .env ───────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ── Chain config ────────────────────────────────────────────────────────

interface ChainDef {
  name: string;
  blockchainId: string;
  rpcUrl: string;
  hubAddress: string;
  publisherSnapshotFile: string;
}

const chains: ChainDef[] = [
  {
    name: 'Base',
    blockchainId: 'base:8453',
    rpcUrl: (process.env.RPC_BASE_MAINNET ?? '').split(',')[0],
    hubAddress: process.env.HUB_BASE_MAINNET ?? '',
    publisherSnapshotFile: 'base_publisher_snapshot_epoch16.json',
  },
  {
    name: 'Gnosis',
    blockchainId: 'gnosis:100',
    rpcUrl: (process.env.RPC_GNOSIS_MAINNET ?? '').split(',')[0],
    hubAddress: process.env.HUB_GNOSIS_MAINNET ?? '',
    publisherSnapshotFile: 'gnosis_publisher_snapshot_epoch16.json',
  },
  {
    name: 'NeuroWeb',
    blockchainId: 'neuroweb:2043',
    rpcUrl: (process.env.RPC_NEUROWEB_MAINNET ?? '').split(',')[0],
    hubAddress: process.env.HUB_NEUROWEB_MAINNET ?? '',
    publisherSnapshotFile: 'neuroweb_publisher_snapshot_epoch16.json',
  },
];

// ── ABIs ────────────────────────────────────────────────────────────────

const HUB_ABI = ['function getContractAddress(string) view returns (address)'];

const STAKING_STORAGE_ABI = [
  'function getTotalStake() view returns (uint96)',
  'function getNodeStake(uint72) view returns (uint96)',
  'function getOperatorFeeBalance(uint72) view returns (uint96)',
  'function getOperatorFeeWithdrawalRequestAmount(uint72) view returns (uint96)',
  'function getDelegatorWithdrawalRequestAmount(uint72, bytes32) view returns (uint96)',
  'function delegatorWithdrawalRequestExists(uint72, bytes32) view returns (bool)',
];

const IDENTITY_STORAGE_ABI = [
  'function lastIdentityId() view returns (uint72)',
];

const DELEGATORS_INFO_ABI = [
  'function getDelegators(uint72) view returns (address[])',
];

const CHRONOS_ABI = ['function getCurrentEpoch() view returns (uint256)'];

const EPOCH_STORAGE_ABI = [
  'function getEpochPool(uint256 shardId, uint256 epoch) view returns (uint96)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

// ── Helpers ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const BATCH_SIZE = 5;

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt === MAX_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('unreachable');
}

async function batchProcess<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Main ────────────────────────────────────────────────────────────────

async function analyzeChain(chain: ChainDef) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${chain.name} (${chain.blockchainId})`);
  console.log('='.repeat(70));

  const provider = new JsonRpcProvider(chain.rpcUrl);
  const blockNumber = await provider.getBlockNumber();

  const hub = new Contract(chain.hubAddress, HUB_ABI, provider);

  const [stakingStorageAddr, identityStorageAddr, chronosAddr, delegatorsInfoAddr, epochStorageAddr, tokenAddr, knowledgeCollectionAddr] =
    await Promise.all([
      hub.getContractAddress('StakingStorage', { blockTag: blockNumber }),
      hub.getContractAddress('IdentityStorage', { blockTag: blockNumber }),
      hub.getContractAddress('Chronos', { blockTag: blockNumber }),
      hub.getContractAddress('DelegatorsInfo', { blockTag: blockNumber }),
      hub.getContractAddress('EpochStorageV8', { blockTag: blockNumber }),
      hub.getContractAddress('Token', { blockTag: blockNumber }),
      hub.getContractAddress('KnowledgeCollection', { blockTag: blockNumber }),
    ]);

  const stakingStorage = new Contract(stakingStorageAddr, STAKING_STORAGE_ABI, provider);
  const identityStorage = new Contract(identityStorageAddr, IDENTITY_STORAGE_ABI, provider);
  const chronos = new Contract(chronosAddr, CHRONOS_ABI, provider);
  const delegatorsInfo = new Contract(delegatorsInfoAddr, DELEGATORS_INFO_ABI, provider);
  const epochStorage = new Contract(epochStorageAddr, EPOCH_STORAGE_ABI, provider);
  const token = new Contract(tokenAddr, ERC20_ABI, provider);

  const currentEpoch = Number(await chronos.getCurrentEpoch({ blockTag: blockNumber }));
  const lastIdentityId = Number(await identityStorage.lastIdentityId({ blockTag: blockNumber }));

  // Actual TRAC balances on contracts
  const stakingStorageBalance: bigint = await token.balanceOf(stakingStorageAddr, { blockTag: blockNumber });
  const kcBalance: bigint = await token.balanceOf(knowledgeCollectionAddr, { blockTag: blockNumber });

  console.log(`  Block: ${blockNumber}`);
  console.log(`  Current epoch: ${currentEpoch}`);
  console.log(`  TRAC Token: ${tokenAddr}`);
  console.log(`  StakingStorage (${stakingStorageAddr}):`);
  console.log(`    TRAC balance: ${ethers.formatEther(stakingStorageBalance)} TRAC`);
  console.log(`  KnowledgeCollection (${knowledgeCollectionAddr}):`);
  console.log(`    TRAC balance: ${ethers.formatEther(kcBalance)} TRAC`);
  console.log(`  Last identity ID: ${lastIdentityId}`);

  // ── Staker data: iterate all identities ───────────────────────────────
  console.log(`  Scanning ${lastIdentityId} identities for stakes, operator fees, withdrawals...`);

  const identityIds = Array.from({ length: lastIdentityId }, (_, i) => i + 1);
  let totalNodeStakeWei = 0n;
  let stakedNodeCount = 0;
  let totalDelegatorCount = 0;
  let totalOperatorFeeBalanceWei = 0n;
  let totalOperatorFeeWithdrawalWei = 0n;
  let totalDelegatorWithdrawalWei = 0n;
  let nodesWithOpFee = 0;
  let nodesWithOpFeeWithdrawal = 0;
  let delegatorsWithWithdrawal = 0;

  await batchProcess(identityIds, BATCH_SIZE, async (id) => {
    const [nodeStake, opFeeBalance, opFeeWithdrawal] = await Promise.all([
      retry(() => stakingStorage.getNodeStake(id, { blockTag: blockNumber })) as Promise<bigint>,
      retry(() => stakingStorage.getOperatorFeeBalance(id, { blockTag: blockNumber })) as Promise<bigint>,
      retry(() => stakingStorage.getOperatorFeeWithdrawalRequestAmount(id, { blockTag: blockNumber })) as Promise<bigint>,
    ]);

    if (nodeStake > 0n) {
      totalNodeStakeWei += nodeStake;
      stakedNodeCount++;
    }
    if (opFeeBalance > 0n) {
      totalOperatorFeeBalanceWei += opFeeBalance;
      nodesWithOpFee++;
    }
    if (opFeeWithdrawal > 0n) {
      totalOperatorFeeWithdrawalWei += opFeeWithdrawal;
      nodesWithOpFeeWithdrawal++;
    }

    const delegatorAddresses: string[] = await retry(() =>
      delegatorsInfo.getDelegators(id, { blockTag: blockNumber }),
    ).catch(() => [] as string[]);

    totalDelegatorCount += delegatorAddresses.length;

    // Check pending delegator withdrawal requests
    for (const addr of delegatorAddresses) {
      const delegatorKey = ethers.keccak256(ethers.solidityPacked(['address'], [addr]));
      const withdrawalAmount: bigint = await retry(() =>
        stakingStorage.getDelegatorWithdrawalRequestAmount(id, delegatorKey, { blockTag: blockNumber }),
      ).catch(() => 0n);
      if (withdrawalAmount > 0n) {
        totalDelegatorWithdrawalWei += withdrawalAmount;
        delegatorsWithWithdrawal++;
      }
    }

    if (id % 50 === 0 || id === lastIdentityId) {
      process.stdout.write(`\r    ${id}/${lastIdentityId} identities scanned...`);
    }
  });

  console.log(`\r    ${lastIdentityId}/${lastIdentityId} identities scanned.       `);

  // ── Publisher data: load from snapshot file ───────────────────────────
  const snapshotPath = path.join(__dirname, '..', 'snapshots', chain.publisherSnapshotFile);
  const snapshotData = JSON.parse(readFileSync(snapshotPath, 'utf8')) as any[];

  const publisherSet = new Set<string>();
  let totalPublisherTRAC = 0;

  for (const epochSnap of snapshotData) {
    for (const pub of epochSnap.publishers) {
      publisherSet.add(pub.publisherEVMpubKey);
      totalPublisherTRAC += pub.tracAmount;
    }
  }

  // ── Epoch pool totals (current + future) ──────────────────────────────
  const epochNums = [...new Set(snapshotData.map((s: any) => s.epochNum as number))].sort((a, b) => a - b);
  let totalEpochPoolTRAC = 0;
  for (const snap of snapshotData) {
    totalEpochPoolTRAC += snap.onChainEpochPool;
  }

  // ── Report ────────────────────────────────────────────────────────────
  const stakingBalanceTRAC = parseFloat(ethers.formatEther(stakingStorageBalance));
  const kcBalanceTRAC = parseFloat(ethers.formatEther(kcBalance));
  const totalNodeStakeTRAC = parseFloat(ethers.formatEther(totalNodeStakeWei));
  const opFeeBalanceTRAC = parseFloat(ethers.formatEther(totalOperatorFeeBalanceWei));
  const opFeeWithdrawalTRAC = parseFloat(ethers.formatEther(totalOperatorFeeWithdrawalWei));
  const delegatorWithdrawalTRAC = parseFloat(ethers.formatEther(totalDelegatorWithdrawalWei));

  const accountedTRAC = totalNodeStakeTRAC + totalEpochPoolTRAC + opFeeBalanceTRAC + opFeeWithdrawalTRAC + delegatorWithdrawalTRAC;
  const unaccountedTRAC = stakingBalanceTRAC - accountedTRAC;

  console.log(`\n  ── Results ──`);
  console.log(`  StakingStorage TRAC balance:              ${fmt(stakingBalanceTRAC)} TRAC`);
  console.log(`  KnowledgeCollection TRAC balance:         ${fmt(kcBalanceTRAC)} TRAC`);
  console.log(``);
  console.log(`  1. Node stakes (getNodeStake):            ${fmt(totalNodeStakeTRAC)} TRAC`);
  console.log(`     Staked nodes: ${stakedNodeCount}, Delegator entries: ${totalDelegatorCount}`);
  console.log(`  2. Publisher epoch pools (${epochNums[0]}→${epochNums[epochNums.length - 1]}):         ${fmt(totalEpochPoolTRAC)} TRAC`);
  console.log(`     Unique publishers: ${publisherSet.size}`);
  console.log(`  3. Operator fee balances:                 ${fmt(opFeeBalanceTRAC)} TRAC  (${nodesWithOpFee} nodes)`);
  console.log(`  4. Operator fee withdrawal requests:      ${fmt(opFeeWithdrawalTRAC)} TRAC  (${nodesWithOpFeeWithdrawal} nodes)`);
  console.log(`  5. Delegator withdrawal requests:         ${fmt(delegatorWithdrawalTRAC)} TRAC  (${delegatorsWithWithdrawal} delegators)`);
  console.log(``);
  console.log(`  Total accounted (1+2+3+4+5):              ${fmt(accountedTRAC)} TRAC`);
  console.log(`  Unaccounted (balance - accounted):         ${fmt(unaccountedTRAC)} TRAC`);
  console.log(`  Unaccounted %:                             ${((unaccountedTRAC / stakingBalanceTRAC) * 100).toFixed(4)}%`);

  return {
    chain: chain.name,
    blockchainId: chain.blockchainId,
    blockNumber,
    currentEpoch,
    stakingBalanceTRAC,
    kcBalanceTRAC,
    totalNodeStakeTRAC,
    stakedNodeCount,
    totalDelegatorCount,
    totalPublisherTRAC,
    totalEpochPoolTRAC,
    uniquePublishers: publisherSet.size,
    epochRange: `${epochNums[0]}→${epochNums[epochNums.length - 1]}`,
    opFeeBalanceTRAC,
    opFeeWithdrawalTRAC,
    delegatorWithdrawalTRAC,
    accountedTRAC,
    unaccountedTRAC,
  };
}

async function main() {
  const chainFilter = process.argv[2];
  const chainsToAnalyze = chainFilter
    ? chains.filter(c => c.name.toLowerCase() === chainFilter.toLowerCase())
    : chains;

  if (chainsToAnalyze.length === 0) {
    console.error(`Unknown chain: ${chainFilter}. Options: ${chains.map(c => c.name).join(', ')}`);
    process.exit(1);
  }

  const results: any[] = [];
  for (const chain of chainsToAnalyze) {
    try {
      const r = await analyzeChain(chain);
      results.push(r);
    } catch (err: any) {
      console.error(`\n[${chain.name}] FAILED: ${err.message}`);
    }
  }

  // ── Grand summary ─────────────────────────────────────────────────────
  if (results.length > 1) {
    console.log(`\n${'='.repeat(70)}`);
    console.log('  GRAND SUMMARY (all chains)');
    console.log('='.repeat(70));

    let grandBalance = 0, grandKcBalance = 0, grandNodeStake = 0, grandEpochPool = 0;
    let grandOpFee = 0, grandOpFeeWithdrawal = 0, grandDelegatorWithdrawal = 0;
    let grandNodes = 0, grandDelegators = 0, grandPubs = 0, grandAccounted = 0, grandUnaccounted = 0;

    for (const r of results) {
      console.log(`\n  ${r.chain} (${r.blockchainId}):`);
      console.log(`    StakingStorage balance:      ${fmt(r.stakingBalanceTRAC)}`);
      console.log(`    1. Node stakes:              ${fmt(r.totalNodeStakeTRAC)} (${r.stakedNodeCount} nodes, ${r.totalDelegatorCount} delegators)`);
      console.log(`    2. Publisher epoch pools:     ${fmt(r.totalEpochPoolTRAC)} (${r.uniquePublishers} publishers, epochs ${r.epochRange})`);
      console.log(`    3. Operator fee balances:     ${fmt(r.opFeeBalanceTRAC)}`);
      console.log(`    4. Operator fee withdrawals:  ${fmt(r.opFeeWithdrawalTRAC)}`);
      console.log(`    5. Delegator withdrawals:     ${fmt(r.delegatorWithdrawalTRAC)}`);
      console.log(`    Accounted:                   ${fmt(r.accountedTRAC)}`);
      console.log(`    Unaccounted:                 ${fmt(r.unaccountedTRAC)}`);

      grandBalance += r.stakingBalanceTRAC;
      grandKcBalance += r.kcBalanceTRAC;
      grandNodeStake += r.totalNodeStakeTRAC;
      grandEpochPool += r.totalEpochPoolTRAC;
      grandOpFee += r.opFeeBalanceTRAC;
      grandOpFeeWithdrawal += r.opFeeWithdrawalTRAC;
      grandDelegatorWithdrawal += r.delegatorWithdrawalTRAC;
      grandNodes += r.stakedNodeCount;
      grandDelegators += r.totalDelegatorCount;
      grandPubs += r.uniquePublishers;
      grandAccounted += r.accountedTRAC;
      grandUnaccounted += r.unaccountedTRAC;
    }

    console.log(`\n  ── Totals across all chains ──`);
    console.log(`  StakingStorage TRAC balance:     ${fmt(grandBalance)} TRAC`);
    console.log(`  1. Node stakes:                  ${fmt(grandNodeStake)} TRAC`);
    console.log(`  2. Publisher epoch pools:         ${fmt(grandEpochPool)} TRAC`);
    console.log(`  3. Operator fee balances:         ${fmt(grandOpFee)} TRAC`);
    console.log(`  4. Operator fee withdrawals:      ${fmt(grandOpFeeWithdrawal)} TRAC`);
    console.log(`  5. Delegator withdrawals:         ${fmt(grandDelegatorWithdrawal)} TRAC`);
    console.log(`  Accounted (1+2+3+4+5):            ${fmt(grandAccounted)} TRAC`);
    console.log(`  Unaccounted:                      ${fmt(grandUnaccounted)} TRAC  (${((grandUnaccounted / grandBalance) * 100).toFixed(4)}%)`);
    console.log(`  Nodes: ${grandNodes}, Delegators: ${grandDelegators}, Publishers: ${grandPubs}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
