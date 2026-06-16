// =============================================================================
// v8-sweep-driver.ts — OT-RFC-50 admin-push migration: the off-chain sweep
// =============================================================================
//
// Drains EVERY V8 delegator's stake (+ pending withdrawals) into their V10
// migration credit, by enumerating (delegator, node) pairs and calling
// DKGStakingConvictionNFT.adminDrainBatch in gas-sized chunks, signed by the Hub
// owner. Since OT-RFC-50 rev 5 removed self-service startMigration, THIS is the
// only path that empties V8 — so it must be provably complete. It is, by
// construction:
//
//   * Enumeration (fast path): DelegatorsInfo.getDelegators(id). The V8 Staking
//     contract registers a delegator (addDelegator, lockstep with every
//     stakeBase increase incl. operator self-stake) — so getDelegators is
//     COMPLETE for active stake.
//   * The one gap: a delegator who fully withdrew (stakeBase→0, no current-epoch
//     score) is removed from getDelegators but may still hold a PENDING
//     withdrawal — whose TRAC is excluded from getNodeStake/getTotalStake. We
//     recover those by scanning DelegatorsInfo `DelegatorAdded(id, address)`
//     logs (the complete historical address universe) — but ONLY when the
//     pre-sweep vault decomposition shows pending actually exists.
//   * Correctness gates (all required for COMPLETE — none can be falsely-green):
//       1. getTotalStake() == 0          (all active stake drained — exact)
//       2. getNodeStake(id) == 0 ∀ id    (localizes any active-stake gap)
//       3. credited == totalStake + enumeratedPending  (drained exactly what we
//          enumerated — reconciles the drain)
//       4. unattributed <= DUST_TOLERANCE (pre-sweep: vault TRAC NOT explained by
//          active stake + enumerated pending + operator-fee resting place is 0;
//          any excess is a possible MISSED pending delegator or unclaimed
//          rewards/dust — surfaced, not silently tolerated).
//     The SS vault physically holds: active stake + delegator pending + operator
//     fees (balance AND open fee-withdrawal requests, which leave
//     getOperatorFeeBalance but stay in the vault until finalize) + maybe
//     unclaimed rewards/dust. Stranded migrant TRAC is always inside
//     balanceOf(SS), so the gates cannot falsely certify COMPLETE.
//   * Idempotency: drainV8ToCredit zeroes the V8 slot and returns 0 on re-drain;
//     adminDrainBatch skips zero pairs. So chunks are re-run-safe across
//     crashes/reorgs — no progress file is needed for correctness.
//
// Modes:  MODE=plan (default) — enumerate + decompose + report; no txs.
//         MODE=execute        — also submit the chunks + verify.
//
// Run (per chain; signer accounts[0] MUST be the Hub owner / multisig owner):
//   MODE=plan TARGET_HUB=0x<freezeHub> [CHUNK_SIZE=150] [EVENT_SCAN_FROM=<block>] \
//   [EVENT_SCAN_STEP=50000] [DUST_TOLERANCE=<wei>] [RPC_RETRIES=4] \
//   npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
//
// PRECONDITION: V8 `Staking` must already be unregistered from the Hub (frozen),
// else users can stake/withdraw mid-sweep — the driver asserts this and aborts.
// For a production Custodian multisig, replace `submitChunk` with a propose-to-
// safe adapter (calldata is built separately). NOT RUN AGAINST PRODUCTION here.

import hre from 'hardhat';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? '150');
const EVENT_SCAN_FROM = process.env.EVENT_SCAN_FROM ? Number(process.env.EVENT_SCAN_FROM) : 0;
const EVENT_SCAN_STEP = Number(process.env.EVENT_SCAN_STEP ?? '50000');
const DUST_TOLERANCE = BigInt(process.env.DUST_TOLERANCE ?? '0');
const RPC_RETRIES = Number(process.env.RPC_RETRIES ?? '4');

const fmt = (x: bigint) => hre.ethers.formatEther(x);
const keyOf = (a: string) => hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [a]));

// Bounded retry so a transient RPC blip doesn't abort a multi-thousand-call
// enumeration; a persistent failure still throws loudly (never a silent skip).
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: any;
  for (let i = 0; i < RPC_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw last;
}

type Pair = { id: number; delegator: string; base: bigint; pend: bigint };

async function main() {
  const [admin] = await hre.ethers.getSigners();
  const adminAddr = await admin.getAddress();

  const resolveAt = async (name: string, env: string) => {
    const addr = process.env[env];
    return addr ? hre.ethers.getContractAt(name, addr) : hre.ethers.getContract(name);
  };
  const Hub = (await resolveAt('Hub', 'TARGET_HUB')) as any;
  const at = async (name: string, env: string) =>
    process.env[env]
      ? hre.ethers.getContractAt(name, process.env[env]!)
      : hre.ethers.getContractAt(name, await Hub.getContractAddress(name));
  const NFT = (await at('DKGStakingConvictionNFT', 'TARGET_NFT')) as any;
  const SS = (await at('StakingStorage', 'TARGET_SS')) as any;
  const DI = (await at('DelegatorsInfo', 'TARGET_DELEGATORS_INFO')) as any;
  const ID = (await at('IdentityStorage', 'TARGET_IDENTITY_STORAGE')) as any;
  const Token = (await at('Token', 'TARGET_TOKEN')) as any;

  const ssAddr = await SS.getAddress();
  const lastId = Number(await ID.lastIdentityId());
  console.log(`V8 sweep driver — MODE=${MODE}`);
  console.log(`  signer ${adminAddr}  (must be Hub owner / multisig owner)`);
  console.log(`  StakingStorage ${ssAddr}  | identityIds 1..${lastId}`);

  // ---- precondition: V8 Staking must be unregistered (frozen) — no live races ----
  // getContractAddress reverts (ContractDoesNotExist) when a name was never
  // registered; either a revert or the zero address means Staking is not live.
  let v8Staking = hre.ethers.ZeroAddress;
  try {
    v8Staking = await Hub.getContractAddress('Staking');
  } catch {
    /* not registered → frozen */
  }
  if (v8Staking !== hre.ethers.ZeroAddress && (await Hub['isContract(address)'](v8Staking))) {
    throw new Error(
      `V8 Staking ${v8Staking} is still Hub-registered (LIVE). Users could stake/withdraw mid-sweep. ` +
        `Unregister it (the cutover deploy step) before sweeping.`,
    );
  }

  // ---- pre-sweep vault decomposition (the "measure first" step) ----
  const vaultBefore: bigint = await retry(() => Token.balanceOf(ssAddr));
  const totalStake: bigint = await retry(() => SS.getTotalStake());
  // Operator-fee TRAC that stays physically in the vault and is NOT drained:
  // the live balance PLUS any open fee-withdrawal request (which leaves
  // getOperatorFeeBalance at request time but only leaves the vault at finalize).
  let feeResting = 0n;
  for (let id = 1; id <= lastId; id++) {
    feeResting += (await retry(() => SS.getOperatorFeeBalance(id))) as bigint;
    feeResting += (await retry(() => SS.getOperatorFeeWithdrawalRequestAmount(id))) as bigint;
  }
  console.log('\nPre-sweep vault decomposition:');
  console.log(`  vault balanceOf(SS) = ${fmt(vaultBefore)} TRAC`);
  console.log(`  active stake (getTotalStake) = ${fmt(totalStake)}`);
  console.log(`  operator-fee resting (balance + open withdrawals, NOT drained) = ${fmt(feeResting)}`);

  // ---- enumerate (delegator, node) pairs with drainable TRAC ----
  const readPair = async (id: number, addr: string): Promise<{ base: bigint; pend: bigint }> => {
    const k = keyOf(addr);
    const base: bigint = await retry(() => SS.getDelegatorStakeBase(id, k));
    const pend: bigint = await retry(() => SS.getDelegatorWithdrawalRequestAmount(id, k));
    return { base, pend };
  };

  console.log('\nEnumerating via DelegatorsInfo.getDelegators …');
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (let id = 1; id <= lastId; id++) {
    let dels: string[] = [];
    try {
      dels = await retry(() => DI.getDelegators(id));
    } catch {
      continue; // node id may not exist
    }
    for (const d of dels) {
      const tag = `${id}:${d.toLowerCase()}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      const { base, pend } = await readPair(id, d);
      if (base + pend > 0n) pairs.push({ id, delegator: d, base, pend });
    }
  }
  console.log(`  ${pairs.length} drainable pairs from getDelegators`);

  // ---- recover pending-only delegators (removed from getDelegators) ----
  // The unaccounted non-fee, non-active vault TRAC. If >0 there ARE pending
  // amounts (or rewards/dust) the active sweep won't move, so scan for them.
  let enumeratedPending = pairs.reduce((s, p) => s + p.pend, 0n);
  let unattributed = vaultBefore - totalStake - feeResting - enumeratedPending;
  if (unattributed > DUST_TOLERANCE) {
    console.log(
      `\nUnattributed vault TRAC ${fmt(unattributed)} beyond active+enumerated-pending+fees — scanning ` +
        `DelegatorAdded logs (full historical address set) for pending-only delegators …`,
    );
    const added = DI.filters.DelegatorAdded();
    const latest = await hre.ethers.provider.getBlockNumber();
    let extra = 0;
    let scanDegraded = false;
    for (let from = EVENT_SCAN_FROM; from <= latest; from += EVENT_SCAN_STEP + 1) {
      const to = Math.min(from + EVENT_SCAN_STEP, latest);
      let logs: any[] = [];
      try {
        logs = await DI.queryFilter(added, from, to);
      } catch (e: any) {
        scanDegraded = true;
        console.log(
          `  ⚠️  getLogs FAILED for blocks [${from}, ${to}] — window SKIPPED (scan now INCOMPLETE): ` +
            `${e?.shortMessage ?? e?.message ?? e}. If this repeats every window, LOWER EVENT_SCAN_STEP ` +
            `(provider range cap) — do NOT widen EVENT_SCAN_FROM.`,
        );
        continue;
      }
      for (const log of logs) {
        const id = Number(log.args.identityId);
        const d = log.args.delegator as string;
        const tag = `${id}:${d.toLowerCase()}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const { base, pend } = await readPair(id, d);
        if (base + pend > 0n) {
          pairs.push({ id, delegator: d, base, pend });
          extra++;
        }
      }
    }
    console.log(`  +${extra} pending-only pairs recovered${scanDegraded ? ' (⚠️ scan was degraded — see above)' : ''}`);
    enumeratedPending = pairs.reduce((s, p) => s + p.pend, 0n);
    unattributed = vaultBefore - totalStake - feeResting - enumeratedPending;
  } else {
    console.log('\nNo unattributed vault TRAC — DelegatorsInfo.getDelegators is complete; skipping the event scan.');
  }

  // ---- plan report + completeness flags ----
  const nodes = new Set(pairs.map((p) => p.id));
  const enumeratedActive = pairs.reduce((s, p) => s + p.base, 0n);
  const drainable = totalStake + enumeratedPending; // what we will move SS→CSS
  const chunks = Math.ceil(pairs.length / CHUNK_SIZE);
  console.log('\n=== PLAN ===');
  console.log(`  drainable pairs: ${pairs.length} across ${nodes.size} node(s)  (${chunks} × up to ${CHUNK_SIZE}/tx)`);
  console.log(`  enumerated: active ${fmt(enumeratedActive)} + pending ${fmt(enumeratedPending)} = ${fmt(enumeratedActive + enumeratedPending)} TRAC`);
  console.log(`  will drain (totalStake + enumerated pending): ${fmt(drainable)} → migration credit`);
  console.log(`  unattributed vault TRAC (after fees + enumerated pending): ${fmt(unattributed)}`);

  // active-stake gap: getTotalStake is exact, so enumeratedActive < totalStake ⇒ a missing active delegator
  const activeGap = totalStake - enumeratedActive;
  if (activeGap > 0n) {
    console.log(
      `\n  🔴 ACTIVE-STAKE GAP: getTotalStake ${fmt(totalStake)} but enumeration found only ${fmt(enumeratedActive)} ` +
        `active — ${fmt(activeGap)} TRAC belongs to a delegator NOT in DelegatorsInfo. Investigate before executing.`,
    );
  }
  if (unattributed > DUST_TOLERANCE) {
    console.log(
      `\n  🔴 UNATTRIBUTED VAULT TRAC: ${fmt(unattributed)} is NOT explained by active stake + enumerated pending + ` +
        `operator fees. It is EITHER a missed pending delegator (widen the DelegatorAdded scan) OR unclaimed ` +
        `rewards/dust. Characterize it (and set DUST_TOLERANCE if benign) before certifying COMPLETE.`,
    );
  }

  // gas headroom: estimate the largest chunk against the live block gas limit
  if (pairs.length > 0) {
    try {
      const biggest = pairs.slice(0, CHUNK_SIZE);
      const est: bigint = await (NFT.connect(admin) as any).adminDrainBatch.estimateGas(
        biggest.map((p) => p.delegator),
        biggest.map((p) => BigInt(p.id)),
      );
      const block = await hre.ethers.provider.getBlock('latest');
      const limit = block!.gasLimit;
      console.log(`  gas: largest chunk (${biggest.length} pairs) ≈ ${est} vs block limit ${limit}` + (est > (limit * 9n) / 10n ? '  ⚠️ within 10% of the limit — lower CHUNK_SIZE' : '  ✓'));
    } catch (e: any) {
      console.log(`  gas: estimateGas failed (${e?.shortMessage ?? e?.message ?? e}) — lower CHUNK_SIZE if a chunk over-runs the block limit.`);
    }
  }

  if (MODE !== 'execute') {
    console.log('\nMODE=plan — no transactions sent. Re-run with MODE=execute to sweep.');
    return;
  }

  // ---- execute: chunked adminDrainBatch (calldata built separately from submit) ----
  const buildCalldata = (chunk: Pair[]) =>
    NFT.interface.encodeFunctionData('adminDrainBatch', [chunk.map((p) => p.delegator), chunk.map((p) => BigInt(p.id))]);
  // EOA submit adapter. Production: replace with a propose-to-Custodian-multisig
  // adapter taking (to=NFT, data=calldata) and routing through the Safe.
  const submitChunk = async (chunk: Pair[]) =>
    (await admin.sendTransaction({ to: await NFT.getAddress(), data: buildCalldata(chunk) })).wait();

  console.log('\n=== EXECUTE ===');
  for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + CHUNK_SIZE);
    const rcpt = await submitChunk(chunk);
    console.log(`  chunk ${i / CHUNK_SIZE + 1}/${chunks} (${chunk.length} pairs) — tx ${rcpt?.hash} gas ${rcpt?.gasUsed}`);
  }

  // ---- verify: per-node + total-stake + reconcile + unattributed gates ----
  console.log('\n=== VERIFY ===');
  let badNodes = 0;
  for (let id = 1; id <= lastId; id++) {
    const ns: bigint = await retry(() => SS.getNodeStake(id));
    if (ns !== 0n) {
      console.log(`  ❌ node ${id} still has ${fmt(ns)} active stake`);
      badNodes++;
    }
  }
  const totalStakeAfter: bigint = await retry(() => SS.getTotalStake());
  const vaultAfter: bigint = await retry(() => Token.balanceOf(ssAddr));
  const credited = vaultBefore - vaultAfter; // TRAC that left the vault → CSS
  console.log(`  per-node active-stake oracle: ${badNodes === 0 ? 'all zero ✓' : `${badNodes} node(s) nonzero ✗`}`);
  console.log(`  getTotalStake: ${fmt(totalStakeAfter)} (expect 0)`);
  console.log(`  vault: ${fmt(vaultBefore)} → ${fmt(vaultAfter)}  (drained ${fmt(credited)} → CSS)`);
  console.log(`  reconcile: drained ${fmt(credited)} vs expected ${fmt(drainable)} (totalStake + enumerated pending)`);
  console.log(`  unattributed (pre-sweep): ${fmt(unattributed)} (must be ≤ ${fmt(DUST_TOLERANCE)} dust tolerance)`);

  const complete =
    badNodes === 0 &&
    totalStakeAfter === 0n &&
    credited === drainable &&
    unattributed <= DUST_TOLERANCE;
  if (complete) {
    console.log('\n✅ SWEEP COMPLETE — all V8 active stake + pending drained into migration credit.');
    console.log('   getTotalStake()==0, all enumerated pending cleared, no unattributed vault TRAC.');
    console.log('   Safe to unregister V8 Staking on this chain (the vault now holds only operator fees / dust).');
  } else {
    console.log(
      `\n❌ INCOMPLETE — one or more gates failed. Re-run (idempotent). ` +
        `If getTotalStake/per-node won't zero: a delegator is missing from DelegatorsInfo. ` +
        `If unattributed > dust persists: a pending delegator was missed (widen/repair the DelegatorAdded scan) ` +
        `or characterize it as rewards/dust and raise DUST_TOLERANCE.`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n❌ sweep driver error:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
