#!/usr/bin/env -S npx tsx
/**
 * epoch-snapshot.ts
 *
 * Captures a point-in-time snapshot of all staker delegations and node stakes
 * across DKG V8 mainnet chains, for use in the V8→V10 migration.
 *
 * Identity iteration uses IdentityStorage.lastIdentityId() for the exact upper
 * bound (matching the pattern from dkg-evm-module/scripts/snapshot_stakes.js).
 * Queries are batched and pinned to a specific block for consistency.
 *
 * Usage:
 *   npx tsx scripts/epoch-snapshot.ts --rpc <url> --hub <address>
 *
 * Output:
 *   snapshot-<chainId>-<epoch>.json
 */
import { ethers, JsonRpcProvider, Contract } from 'ethers';
import { writeFileSync } from 'node:fs';

// ── Minimal ABI fragments ──────────────────────────────────────────────

const HUB_ABI = [
  'function getContractAddress(string) view returns (address)',
];

const IDENTITY_STORAGE_ABI = [
  'function lastIdentityId() view returns (uint72)',
];

const STAKING_STORAGE_ABI = [
  'function getTotalStake() view returns (uint96)',
  'function getNodeStake(uint72) view returns (uint96)',
  'function getDelegatorStakeBase(uint72, bytes32) view returns (uint96)',
];

// v4.0.0 — CSS holds the V10 canonical raw stake aggregate. Migration windows
// have non-zero values in BOTH stores until convertToNFT finishes draining
// V8 → V10; the snapshot sums them so the per-node "stake" column is faithful
// either side of cutover.
const CONVICTION_STAKING_STORAGE_ABI = [
  'function getNodeStakeV10(uint72) view returns (uint256)',
  'function totalStakeV10() view returns (uint256)',
];

const DELEGATORS_INFO_ABI = [
  'function getDelegators(uint72) view returns (address[])',
];

const CHRONOS_ABI = [
  'function getCurrentEpoch() view returns (uint256)',
];

// ── Configuration ──────────────────────────────────────────────────────

const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ── CLI argument parsing ────────────────────────────────────────────────

function parseArgs(): { rpc: string; hub: string } {
  const args = process.argv.slice(2);
  let rpc = '';
  let hub = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rpc' && args[i + 1]) rpc = args[++i];
    else if (args[i] === '--hub' && args[i + 1]) hub = args[++i];
  }

  if (!rpc || !hub) {
    console.error('Usage: npx tsx scripts/epoch-snapshot.ts --rpc <url> --hub <address>');
    process.exit(1);
  }

  return { rpc, hub };
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt === MAX_RETRIES) throw e;
      console.log(`  Retry ${attempt}/${MAX_RETRIES}: ${e.message?.substring(0, 80)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('unreachable');
}

async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ── Types ───────────────────────────────────────────────────────────────

interface DelegatorEntry {
  address: string;
  stakeBase: string;
}

interface NodeEntry {
  identityId: number;
  stake: string;
  delegators: DelegatorEntry[];
}

interface Snapshot {
  chainId: string;
  blockNumber: number;
  blockDate: string;
  epoch: number;
  timestamp: string;
  hubAddress: string;
  totalStake: string;
  lastIdentityId: number;
  totalDelegators: number;
  nodes: NodeEntry[];
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { rpc, hub: hubAddress } = parseArgs();

  const provider = new JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  const chainId = network.chainId.toString();

  console.log(`Chain ID: ${chainId}`);
  console.log(`Hub:      ${hubAddress}`);

  const hub = new Contract(hubAddress, HUB_ABI, provider);

  // Pin to a specific block for consistent snapshot — all reads use this blockTag
  const blockNumber = await provider.getBlockNumber();

  // Resolve contract addresses from Hub at the pinned block. CSS may not be
  // registered on pre-V10 chains; tolerate a zero address there.
  const [
    stakingStorageAddr,
    convictionStakingStorageAddr,
    delegatorsInfoAddr,
    chronosAddr,
    identityStorageAddr,
  ] = await Promise.all([
      hub.getContractAddress('StakingStorage', { blockTag: blockNumber }),
      hub.getContractAddress('ConvictionStakingStorage', { blockTag: blockNumber })
        .catch(() => '0x0000000000000000000000000000000000000000'),
      hub.getContractAddress('DelegatorsInfo', { blockTag: blockNumber }),
      hub.getContractAddress('Chronos', { blockTag: blockNumber }),
      hub.getContractAddress('IdentityStorage', { blockTag: blockNumber }),
    ]);

  const stakingStorage = new Contract(stakingStorageAddr, STAKING_STORAGE_ABI, provider);
  const cssEnabled = convictionStakingStorageAddr !== ethers.ZeroAddress;
  const convictionStakingStorage = cssEnabled
    ? new Contract(convictionStakingStorageAddr, CONVICTION_STAKING_STORAGE_ABI, provider)
    : null;
  const delegatorsInfo = new Contract(delegatorsInfoAddr, DELEGATORS_INFO_ABI, provider);
  const chronos = new Contract(chronosAddr, CHRONOS_ABI, provider);
  const identityStorage = new Contract(identityStorageAddr, IDENTITY_STORAGE_ABI, provider);
  const block = await provider.getBlock(blockNumber);
  const blockDate = new Date((block?.timestamp ?? 0) * 1000).toISOString();

  const epoch = Number(await chronos.getCurrentEpoch({ blockTag: blockNumber }));
  const v8TotalStake: bigint = await stakingStorage.getTotalStake({ blockTag: blockNumber });
  const v10TotalStake: bigint = convictionStakingStorage
    ? BigInt(await convictionStakingStorage.totalStakeV10({ blockTag: blockNumber }))
    : 0n;
  const totalStake = v8TotalStake + v10TotalStake;
  const lastId = Number(await identityStorage.lastIdentityId({ blockTag: blockNumber }));

  console.log(`Block:    ${blockNumber} (${blockDate})`);
  console.log(`Epoch:    ${epoch}`);
  console.log(`Total stake: ${ethers.formatEther(totalStake)} TRAC`);
  console.log(`  V8 (StakingStorage):           ${ethers.formatEther(v8TotalStake)} TRAC`);
  console.log(`  V10 (ConvictionStakingStorage):${ethers.formatEther(v10TotalStake)} TRAC`);
  console.log(`Last identity ID: ${lastId}`);

  // Iterate all identity IDs in batches
  const identityIds = Array.from({ length: lastId }, (_, i) => i + 1);
  const nodes: NodeEntry[] = [];
  let totalDelegators = 0;

  await processBatch(identityIds, BATCH_SIZE, async (id) => {
    // Sum V8 + V10 raw stake. Convert V10 (uint256) safely via BigInt.
    const [v8Stake, v10Stake] = await Promise.all([
      retry(() => stakingStorage.getNodeStake(id, { blockTag: blockNumber })) as Promise<bigint>,
      convictionStakingStorage
        ? (retry(() =>
            convictionStakingStorage.getNodeStakeV10(id, { blockTag: blockNumber }),
          ) as Promise<bigint>).then(BigInt)
        : Promise.resolve(0n),
    ]);
    const stake: bigint = v8Stake + v10Stake;

    const delegatorAddresses: string[] = await retry(() =>
      delegatorsInfo.getDelegators(id, { blockTag: blockNumber }),
    ).catch(() => [] as string[]);

    // Include nodes with stake OR delegators (zero-stake nodes may still
    // have delegator state the migrator needs: rolling rewards, claim flags)
    if (stake === 0n && delegatorAddresses.length === 0) return;

    const delegators: DelegatorEntry[] = [];
    for (const addr of delegatorAddresses) {
      const key = ethers.keccak256(ethers.solidityPacked(['address'], [addr]));
      const stakeBase: bigint = await retry(() =>
        stakingStorage.getDelegatorStakeBase(id, key, { blockTag: blockNumber }),
      ).catch(() => 0n);

      delegators.push({ address: addr, stakeBase: stakeBase.toString() });
    }

    nodes.push({ identityId: id, stake: stake.toString(), delegators });
    totalDelegators += delegators.length;

    if (id % 20 === 0 || id === lastId) {
      console.log(`  Processed ${id}/${lastId} (${nodes.length} nodes, ${totalDelegators} delegators)`);
    }
  });

  nodes.sort((a, b) => a.identityId - b.identityId);

  console.log(`\nFound ${nodes.length} staked nodes, ${totalDelegators} total delegators`);

  const snapshot: Snapshot = {
    chainId,
    blockNumber,
    blockDate,
    epoch,
    timestamp: new Date().toISOString(),
    hubAddress,
    totalStake: totalStake.toString(),
    lastIdentityId: lastId,
    totalDelegators,
    nodes,
  };

  const filename = `snapshot-${chainId}-${epoch}.json`;
  writeFileSync(filename, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${filename}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
