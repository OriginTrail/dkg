// One-time migration: seed the CGWeightTreeStorage Fenwick index from the existing
// ContextGraphValueStorage ledger, validate, then unlock the value-weighted draw.
//
// Works for both a fresh chain (no weighted CGs -> seeds nothing, just unlocks) and an
// upgrade (existing CGs -> seeds active leaves in batches). Run as the Hub owner:
//
//   npx hardhat run scripts/migrate-cg-weight-tree.ts --network base_sepolia_v10 --config hardhat.node.config.ts
//
// Idempotency: aborts if the tree is already unlocked (migration already done).
//
// Why this is cheap: each leaf weight is read off-chain via getCGValueAtEpoch (a view; the
// O(D) per-epoch replay runs on the RPC node for free), and seedMany only does O(k.log)
// SSTOREs. The ledger is finalized lazily later (settle-on-spend / settle-on-miss), so no
// O(D) on-chain work happens here.
//
// Each seeded leaf is still ~log2(capacity) (~21) cold SSTOREs, so the batch is kept small
// (default 25 ≈ a few hundred k gas/tx). Override with MIGRATE_BATCH for a specific chain's
// gas limit. (Off the critical path for a clean redeploy, which seeds nothing.)
import hre from 'hardhat';

const BATCH = Number(process.env.MIGRATE_BATCH || 25); // CGs per seedMany tx (conservative)

async function main() {
  const { ethers, deployments } = hre;
  const [signer] = await ethers.getSigners();
  console.log(`migrator (Hub owner): ${signer.address}`);

  const tree = await ethers.getContractAt(
    'CGWeightTreeStorage',
    (await deployments.get('CGWeightTreeStorage')).address,
    signer,
  );
  const cgStorage = await ethers.getContractAt(
    'ContextGraphStorage',
    (await deployments.get('ContextGraphStorage')).address,
    signer,
  );
  const cgValue = await ethers.getContractAt(
    'ContextGraphValueStorage',
    (await deployments.get('ContextGraphValueStorage')).address,
    signer,
  );
  const chronos = await ethers.getContractAt(
    'Chronos',
    (await deployments.get('Chronos')).address,
    signer,
  );

  if (!(await tree.backfillLocked())) {
    console.log('Tree already unlocked (backfillLocked=false) — migration already done. Aborting.');
    return;
  }

  const currentEpoch: bigint = await chronos.getCurrentEpoch();
  const counter: bigint = await cgStorage.getLatestContextGraphId();
  console.log(`currentEpoch=${currentEpoch} cgCount=${counter}`);

  // 1) Off-chain: compute the active, nonzero current-epoch leaf for every CG.
  const cgIds: bigint[] = [];
  const weights: bigint[] = [];
  let expectedTotal = 0n;
  for (let cg = 1n; cg <= counter; cg++) {
    if (!(await cgStorage.isContextGraphActive(cg))) continue; // Invariant 2: inactive -> leaf 0
    // FATAL on a read failure: getCGValueAtEpoch only reverts on ledger corruption
    // (NegativeCumulative). Silently seeding 0 would drop that CG's weight; abort so the
    // operator investigates rather than unlocking with a missing leaf.
    let w = 0n;
    try {
      w = await cgValue.getCGValueAtEpoch(cg, currentEpoch);
    } catch (e) {
      throw new Error(`cg ${cg}: getCGValueAtEpoch reverted (${(e as Error).message.slice(0, 80)}) — aborting migration`);
    }
    if (w > 0n) {
      cgIds.push(cg);
      weights.push(w);
      expectedTotal += w;
    }
    if (cg % 500n === 0n) console.log(`  scanned ${cg}/${counter}`);
  }
  console.log(`weighted (active, nonzero) CGs: ${cgIds.length}, Σweight=${expectedTotal}`);

  // 2) On-chain: seed in batches (O(k.log) per batch).
  for (let i = 0; i < cgIds.length; i += BATCH) {
    const cgBatch = cgIds.slice(i, i + BATCH);
    const wBatch = weights.slice(i, i + BATCH);
    const tx = await tree.seedMany(cgBatch, wBatch);
    await tx.wait();
    console.log(`  seeded ${Math.min(i + BATCH, cgIds.length)}/${cgIds.length}`);
  }

  // 3) Validate: bitTotal == Σ seeded leaves, and cross-check against the ledger's global total.
  const bitTotal: bigint = await tree.bitTotal();
  if (bitTotal !== expectedTotal) {
    throw new Error(`bitTotal ${bitTotal} != Σseeded ${expectedTotal} — migration corrupt, NOT unlocking`);
  }
  let globalTotal = 0n;
  try {
    globalTotal = await cgValue.getTotalValueAtEpoch(currentEpoch);
  } catch {
    /* getter may not exist on older deploys; skip cross-check */
  }
  console.log(`bitTotal=${bitTotal} (== Σseeded ✓)  ledger getTotalValueAtEpoch=${globalTotal}`);
  if (globalTotal !== 0n && globalTotal !== bitTotal) {
    // FATAL by default: the RFC makes this cross-check part of unlock validation. A mismatch
    // means missing/mis-seeded weight UNLESS there are inactive-but-valued CGs (legitimately
    // excluded from the tree by Invariant 2) — in which case set MIGRATE_ALLOW_TOTAL_MISMATCH=1
    // after confirming the delta equals the inactive-CG value. Do NOT unlock on an unexplained gap.
    const msg = `global total ${globalTotal} != bitTotal ${bitTotal} (delta ${globalTotal - bitTotal})`;
    if (process.env.MIGRATE_ALLOW_TOTAL_MISMATCH === '1') {
      console.warn(`  OVERRIDE (MIGRATE_ALLOW_TOTAL_MISMATCH=1): ${msg} — unlocking anyway.`);
    } else {
      throw new Error(
        `${msg} — NOT unlocking. If this equals the inactive-but-valued CG total (Invariant 2), ` +
          're-run with MIGRATE_ALLOW_TOTAL_MISMATCH=1.',
      );
    }
  }

  // 4) Unlock the draw.
  const tx = await tree.finishBackfill();
  await tx.wait();
  console.log('finishBackfill() done — value-weighted draw is live.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
