// Scan the running devnet chain (:8545) and report REAL on-chain gasUsed for the
// RandomSampling draw + proof and the KnowledgeAssetsLifecycle settle-on-spend paths.
// Usage: node scripts/devnet-gas-scan.mjs   (run while the devnet is up)
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abiDir = path.resolve(__dirname, '..', 'abi');
const RPC = process.env.DEVNET_RPC || 'http://localhost:8545';

const ifaces = {};
for (const name of ['RandomSampling', 'KnowledgeAssetsLifecycle']) {
  const abi = JSON.parse(fs.readFileSync(path.join(abiDir, `${name}.json`)));
  ifaces[name] = new ethers.Interface(abi);
}
// selector -> "Contract.fn"
const bySelector = {};
for (const [cname, iface] of Object.entries(ifaces)) {
  iface.forEachFunction((f) => {
    bySelector[f.selector] = `${cname}.${f.name}`;
  });
}
// We only care about the hot/new paths:
const TRACK = new Set([
  'RandomSampling.createChallenge',
  'RandomSampling.submitProof',
  'KnowledgeAssetsLifecycle.publish',
  'KnowledgeAssetsLifecycle.update',
  'KnowledgeAssetsLifecycle.extendKnowledgeAssetLifetime',
]);

const provider = new ethers.JsonRpcProvider(RPC);
const latest = await provider.getBlockNumber();
console.error(`scanning blocks 0..${latest} on ${RPC}`);

const agg = {}; // fn -> {count, min, max, sum}
for (let b = 0; b <= latest; b++) {
  const block = await provider.getBlock(b, true);
  if (!block) continue;
  for (const tx of block.prefetchedTransactions) {
    if (!tx.data || tx.data.length < 10) continue;
    const sel = tx.data.slice(0, 10);
    const fn = bySelector[sel];
    if (!fn || !TRACK.has(fn)) continue;
    const rcpt = await provider.getTransactionReceipt(tx.hash);
    if (!rcpt) continue;
    const g = Number(rcpt.gasUsed);
    const a = (agg[fn] ??= { count: 0, min: Infinity, max: 0, sum: 0, ok: 0 });
    a.count++;
    a.sum += g;
    a.min = Math.min(a.min, g);
    a.max = Math.max(a.max, g);
    if (rcpt.status === 1) a.ok++;
  }
}

console.log('\n=== Devnet on-chain gas (real node operation) ===');
const rows = Object.entries(agg).sort();
if (rows.length === 0) console.log('  (no tracked txs found yet — let the devnet run / publish first)');
for (const [fn, a] of rows) {
  console.log(
    `${fn.padEnd(45)} n=${String(a.count).padStart(4)} ok=${a.ok}  ` +
      `avg=${Math.round(a.sum / a.count).toString().padStart(8)}  ` +
      `min=${a.min.toString().padStart(8)}  max=${a.max.toString().padStart(8)}`,
  );
}
