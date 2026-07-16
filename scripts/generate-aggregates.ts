#!/usr/bin/env npx tsx
/**
 * Reads per-epoch publisher snapshots and produces per-chain aggregate files:
 *   { publishers: [{ address, totalWei, totalTRAC }], totalWei, totalTRAC, count }
 *
 * Uses BigInt (wei) throughout to avoid floating-point precision loss.
 * The epoch snapshots store tracAmount as a float in ether units, so we
 * re-derive wei from ethers.parseEther of the rounded string to keep
 * maximum precision.
 */
import { ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SNAPSHOTS_DIR = path.join(__dirname, '..', 'snapshots');

const chains = [
  { name: 'base', file: 'base_publisher_snapshot_epoch16.json' },
  { name: 'gnosis', file: 'gnosis_publisher_snapshot_epoch16.json' },
  { name: 'neuroweb', file: 'neuroweb_publisher_snapshot_epoch16.json' },
];

for (const chain of chains) {
  const filePath = path.join(SNAPSHOTS_DIR, chain.file);
  if (!existsSync(filePath)) {
    console.log(`Skipping ${chain.name}: ${chain.file} not found`);
    continue;
  }

  const epochs = JSON.parse(readFileSync(filePath, 'utf8')) as any[];
  const totals = new Map<string, bigint>();

  for (const epoch of epochs) {
    for (const pub of epoch.publishers) {
      const addr = pub.publisherEVMpubKey as string;
      // Convert float TRAC back to wei with 18-decimal precision
      const wei = ethers.parseEther(pub.tracAmount.toFixed(18));
      totals.set(addr, (totals.get(addr) ?? 0n) + wei);
    }
  }

  const sorted = [...totals.entries()]
    .map(([address, totalWei]) => ({
      address,
      totalWei: totalWei.toString(),
      totalTRAC: parseFloat(ethers.formatEther(totalWei)),
    }))
    .sort((a, b) => b.totalTRAC - a.totalTRAC);

  const grandTotalWei = sorted.reduce((s, e) => s + BigInt(e.totalWei), 0n);

  const output = {
    chain: chain.name,
    generatedAt: new Date().toISOString(),
    sourceFile: chain.file,
    epochsCovered: [...new Set(epochs.map((e: any) => e.epochNum))].sort((a, b) => a - b),
    count: sorted.length,
    totalWei: grandTotalWei.toString(),
    totalTRAC: parseFloat(ethers.formatEther(grandTotalWei)),
    publishers: sorted,
  };

  const outFile = path.join(SNAPSHOTS_DIR, `${chain.name}_publisher_distribution.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');
  console.log(`${chain.name}: ${sorted.length} publishers, ${ethers.formatEther(grandTotalWei)} TRAC → ${outFile}`);
}
