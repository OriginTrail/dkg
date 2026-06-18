// =============================================================================
// v8-sweep-driver.ts — OT-RFC-50 admin-push migration: the off-chain sweep
// =============================================================================
//
// Drains EVERY V8 position into V10 migration credit, signed by the Hub owner:
//   * delegator stake (+ pending withdrawals) → delegator's credit, via
//     DKGStakingConvictionNFT.adminDrainBatch over (delegator, node) pairs;
//   * operator fees (resting balance + open fee-withdrawal request) → the
//     operator's SAME credit bucket, via adminDrainOperatorFeesBatch over
//     (node, operator) pairs.
// Both run in gas-sized chunks. Since OT-RFC-50 removed self-service migration,
// THIS is the only path that empties V8 — so it must be provably complete (the
// vault must end EMPTY, ≤ dust). It is, by construction:
//
//   * Enumeration (fast path): DelegatorsInfo.getDelegators(id) — cheap, but NOT
//     complete on its own: DelegatorsInfo was deployed months AFTER StakingStorage
//     on the real V8 chains, so addDelegator never fired for pre-DI stakers and
//     they appear in neither getDelegators NOR DelegatorAdded (the Base Sepolia
//     fork showed 34% of active stake invisible to it). Treat it as a fast first
//     pass only.
//   * Genesis-complete recovery: every V8 stake did
//     `token.transferFrom(staker, StakingStorage)` (archive/Staking.sol:148), so
//     Token.Transfer(to = StakingStorage) from the StakingStorage deploy block is
//     the COMPLETE delegator-address universe (a superset; non-delegator senders
//     read 0 and are skipped). We scan it whenever there's an active-stake gap or
//     leftover vault TRAC, then probe each candidate's stake across all nodes.
//     Set EVENT_SCAN_FROM to the SS deploy block; the full scan needs an archive
//     RPC. Residual tail (positions grown purely from restaked rewards, which
//     have no fresh deposit Transfer) is caught by the on-chain `selfMigrate`.
//   * Operator fees: enumerated id-keyed over every node (getOperatorFeeBalance
//     + open fee-withdrawal request) — COMPLETE by construction, no address
//     needed to FIND a fee. To DRAIN one, migrationCredit is address-keyed but
//     IdentityStorage holds only key *hashes*, so the operator address is
//     supplied via OPERATOR_MAP and validated on-chain (keyHasPurpose ADMIN_KEY);
//     a fee-bearing node with no resolvable current admin is a preflight BLOCKER.
//   * Correctness gates (all required for COMPLETE — none can be falsely-green):
//       1. getTotalStake() == 0              (all active stake drained — exact)
//       2. getNodeStake(id) == 0 ∀ id        (localizes any active-stake gap)
//       3. operator fee balance + request == 0 ∀ id  (all fees drained)
//       4. credited == totalStake + enumeratedPending + operatorFees (reconcile)
//       5. balanceOf(SS) <= DUST_TOLERANCE   (EMPTY-VAULT gate — the strongest:
//          stake, pending AND fees all physically left the vault; any residual
//          is a missed pending delegator, an unresolved operator, or rewards/dust
//          — surfaced, not silently tolerated).
//     The SS vault physically holds: active stake + delegator pending + operator
//     fees (balance AND open fee-withdrawal requests) + maybe unclaimed rewards/
//     dust. Stranded migrant TRAC is always inside balanceOf(SS), so the empty-
//     vault gate cannot falsely certify COMPLETE.
//   * Idempotency: drainV8ToCredit / drainOperatorFeeToCredit zero the V8 slot
//     and return 0 on re-drain; the batch fns skip zero. So chunks are re-run-
//     safe across crashes/reorgs — no progress file is needed for correctness.
//
// Modes:  MODE=plan (default) — enumerate + decompose + report; no txs.
//         MODE=execute        — preflight-gate, then submit the chunks + verify.
//
// Run (per chain; signer accounts[0] MUST be the Hub owner / multisig owner):
//   MODE=plan TARGET_HUB=0x<freezeHub> [CHUNK_SIZE=150] [EVENT_SCAN_FROM=<block>] \
//   [EVENT_SCAN_STEP=50000] [DUST_TOLERANCE=<wei>] [RPC_RETRIES=4] \
//   [OPERATOR_MAP='{"<id>":"0x<admin>",…}' | OPERATOR_MAP_FILE=<path>] \
//   npx hardhat run scripts/v8-sweep-driver.ts --network <chain>
//
// CUTOVER ORDERING (freeze-first): V8 `Staking` MUST already be unregistered from
// the Hub before sweeping — else users/operators can stake/withdraw/finalize-fee
// mid-sweep against balances we are draining. The driver asserts this and aborts.
// MODE=execute also HARD-FAILS preflight (before any tx) on an active-stake gap,
// unattributed vault TRAC, a degraded pending scan, or an unresolved operator —
// so a red plan can never become a partial, manual-reconciliation sweep
// (OVERRIDE_PREFLIGHT=1 forces, NOT recommended). For a production Custodian
// multisig, replace the EOA submit with a propose-to-Safe adapter (calldata is
// built separately). NOT RUN AGAINST PRODUCTION here.

import * as fs from 'fs';

import hre from 'hardhat';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? '150');
const EVENT_SCAN_FROM = process.env.EVENT_SCAN_FROM ? Number(process.env.EVENT_SCAN_FROM) : 0;
const EVENT_SCAN_STEP = Number(process.env.EVENT_SCAN_STEP ?? '50000');
const DUST_TOLERANCE = BigInt(process.env.DUST_TOLERANCE ?? '0');
const RPC_RETRIES = Number(process.env.RPC_RETRIES ?? '4');
const OVERRIDE_PREFLIGHT = process.env.OVERRIDE_PREFLIGHT === '1';
const ADMIN_KEY = 1n; // IdentityLib.ADMIN_KEY

const fmt = (x: bigint) => hre.ethers.formatEther(x);
const keyOf = (a: string) => hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [a]));

// Curated identityId → operator (current ADMIN_KEY holder) address map. Operator
// addresses are NOT recoverable on-chain (IdentityStorage holds key *hashes*),
// so the operator-fee drain needs the address supplied here and validated on
// chain. Source: OPERATOR_MAP (inline JSON) or OPERATOR_MAP_FILE (path). Keys
// are identityId strings, values 0x addresses. Any fee-bearing node missing
// here (or whose address is not a current admin) is a preflight blocker.
function loadOperatorMap(): Record<string, string> {
  if (process.env.OPERATOR_MAP) return JSON.parse(process.env.OPERATOR_MAP);
  if (process.env.OPERATOR_MAP_FILE) return JSON.parse(fs.readFileSync(process.env.OPERATOR_MAP_FILE, 'utf8'));
  return {};
}

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
  // Operator-fee TRAC: the live balance PLUS any open fee-withdrawal request
  // (which leaves getOperatorFeeBalance at request time but only leaves the
  // vault at finalize). Enumerated id-keyed (every node), so it is complete —
  // no address needed to FIND a fee, only to drain it. We DO drain these now
  // (OT-RFC-50: operator fee → operator's migration credit), so the vault must
  // empty to ~0, not to Σ fees.
  type FeeNode = { id: number; fee: bigint; operator: string | null };
  const operatorMap = loadOperatorMap();
  let feeDrainable = 0n;
  const feeNodes: FeeNode[] = [];
  for (let id = 1; id <= lastId; id++) {
    const bal = (await retry(() => SS.getOperatorFeeBalance(id))) as bigint;
    const req = (await retry(() => SS.getOperatorFeeWithdrawalRequestAmount(id))) as bigint;
    const fee = bal + req;
    if (fee === 0n) continue;
    feeDrainable += fee;
    // Resolve the operator (must currently hold ADMIN_KEY) from the curated map.
    const candidate = operatorMap[String(id)];
    const operator =
      candidate && (await retry(() => ID.keyHasPurpose(id, keyOf(candidate), ADMIN_KEY))) ? candidate : null;
    feeNodes.push({ id, fee, operator });
  }
  const unresolvedFee = feeNodes.filter((n) => !n.operator);
  let scanDegraded = false; // hoisted so the preflight can see a degraded pending scan
  console.log('\nPre-sweep vault decomposition:');
  console.log(`  vault balanceOf(SS) = ${fmt(vaultBefore)} TRAC`);
  console.log(`  active stake (getTotalStake) = ${fmt(totalStake)}`);
  console.log(
    `  operator fees (balance + open withdrawals, WILL be drained) = ${fmt(feeDrainable)} ` +
      `across ${feeNodes.length} node(s); ${feeNodes.length - unresolvedFee.length} resolved, ${unresolvedFee.length} unresolved`,
  );

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

  // ---- genesis-complete recovery: Token.Transfer(to=StakingStorage) ----
  // The unaccounted non-fee, non-active vault TRAC. If >0 there ARE pending
  // amounts (or rewards/dust) the active sweep won't move, so scan for them.
  let enumeratedPending = pairs.reduce((s, p) => s + p.pend, 0n);
  let enumeratedActive = pairs.reduce((s, p) => s + p.base, 0n);
  let unattributed = vaultBefore - totalStake - feeDrainable - enumeratedPending;
  let activeGap = totalStake - enumeratedActive;
  // getDelegators (and DelegatorAdded) only know delegators registered SINCE
  // DelegatorsInfo was deployed — which on real V8 chains was months after
  // StakingStorage, so pre-DI stakers are invisible to both. But every V8 stake
  // did `token.transferFrom(staker, StakingStorage, …)` (archive/Staking.sol:148),
  // so Token.Transfer(to = StakingStorage) is the COMPLETE genesis delegator-
  // address universe (a superset — non-delegator senders just read 0 stake and
  // are skipped). Trigger on leftover vault TRAC OR an active-stake gap
  // (enumerated active < getTotalStake) — the latter fires even when the vault is
  // under-collateralized (unattributed negative). Set EVENT_SCAN_FROM to the
  // StakingStorage deploy block; the full genesis scan needs an archive RPC.
  // (NB: a position grown purely from restaked rewards has no fresh deposit
  // Transfer — that residual tail is covered by the on-chain `selfMigrate`.)
  if (unattributed > DUST_TOLERANCE || activeGap > DUST_TOLERANCE) {
    console.log(
      `\nRecovering delegators missing from getDelegators (unattributed vault ${fmt(unattributed)}, ` +
        `active-stake gap ${fmt(activeGap)}) — scanning Token.Transfer(to=StakingStorage) from block ` +
        `${EVENT_SCAN_FROM} for the complete genesis delegator set …`,
    );
    const depositFilter = Token.filters.Transfer(null, ssAddr); // to == StakingStorage (indexed)
    const latest = await hre.ethers.provider.getBlockNumber();
    const candidates = new Set<string>();
    for (let from = EVENT_SCAN_FROM; from <= latest; from += EVENT_SCAN_STEP + 1) {
      const to = Math.min(from + EVENT_SCAN_STEP, latest);
      try {
        const logs = await retry(() => Token.queryFilter(depositFilter, from, to));
        for (const log of logs) {
          const a = (log.args.from as string).toLowerCase();
          if (a !== hre.ethers.ZeroAddress) candidates.add(a);
        }
      } catch (e: any) {
        scanDegraded = true;
        console.log(
          `  ⚠️  getLogs FAILED for blocks [${from}, ${to}] — window SKIPPED (scan INCOMPLETE): ` +
            `${e?.shortMessage ?? e?.message ?? e}. LOWER EVENT_SCAN_STEP (provider range cap) or use an archive RPC.`,
        );
      }
    }
    console.log(`  ${candidates.size} candidate addresses from deposit Transfers; probing stake across ${lastId} node(s) …`);
    let extra = 0;
    for (const addr of candidates) {
      for (let id = 1; id <= lastId; id++) {
        const tag = `${id}:${addr}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const { base, pend } = await readPair(id, addr);
        if (base + pend > 0n) {
          pairs.push({ id, delegator: addr, base, pend });
          extra++;
        }
      }
    }
    console.log(`  +${extra} missing pairs recovered${scanDegraded ? ' (⚠️ scan was degraded — see above)' : ''}`);
    enumeratedPending = pairs.reduce((s, p) => s + p.pend, 0n);
    enumeratedActive = pairs.reduce((s, p) => s + p.base, 0n);
    unattributed = vaultBefore - totalStake - feeDrainable - enumeratedPending;
    activeGap = totalStake - enumeratedActive;
  } else {
    console.log('\nNo unattributed vault TRAC and no active-stake gap — DelegatorsInfo.getDelegators is complete; skipping the event scan.');
  }

  // ---- plan report + completeness flags ----
  const nodes = new Set(pairs.map((p) => p.id));
  const drainable = totalStake + enumeratedPending; // what we will move SS→CSS
  const chunks = Math.ceil(pairs.length / CHUNK_SIZE);
  const feeChunks = Math.ceil(feeNodes.length / CHUNK_SIZE);
  console.log('\n=== PLAN ===');
  console.log(`  drainable pairs: ${pairs.length} across ${nodes.size} node(s)  (${chunks} × up to ${CHUNK_SIZE}/tx)`);
  console.log(`  enumerated: active ${fmt(enumeratedActive)} + pending ${fmt(enumeratedPending)} = ${fmt(enumeratedActive + enumeratedPending)} TRAC`);
  console.log(`  will drain delegator stake (totalStake + enumerated pending): ${fmt(drainable)} → migration credit`);
  console.log(`  will drain operator fees: ${fmt(feeDrainable)} across ${feeNodes.length} node(s) (${feeChunks} × up to ${CHUNK_SIZE}/tx) → operator migration credit`);
  console.log(`  total leaving vault (stake + pending + fees): ${fmt(drainable + feeDrainable)}`);
  console.log(`  unattributed vault TRAC (after fees + enumerated pending): ${fmt(unattributed)}`);

  // active-stake gap: getTotalStake is exact, so enumeratedActive < totalStake ⇒
  // a missing active delegator the Token.Transfer scan (above) could not recover.
  if (activeGap > 0n) {
    console.log(
      `\n  🔴 ACTIVE-STAKE GAP: getTotalStake ${fmt(totalStake)} but enumeration found only ${fmt(enumeratedActive)} ` +
        `active — ${fmt(activeGap)} TRAC belongs to a delegator NOT recoverable via DelegatorsInfo (not in ` +
        `getDelegators OR the Token.Transfer scan from EVENT_SCAN_FROM). Widen the scan (EVENT_SCAN_FROM = ` +
        `StakingStorage deploy block, archive RPC), or have the straggler call selfMigrate, before executing.`,
    );
  }
  if (unattributed > DUST_TOLERANCE) {
    console.log(
      `\n  🔴 UNATTRIBUTED VAULT TRAC: ${fmt(unattributed)} is NOT explained by active stake + enumerated pending + ` +
        `operator fees. It is EITHER a missed pending delegator (widen the Token.Transfer scan) OR unclaimed ` +
        `rewards/dust. Characterize it (and set DUST_TOLERANCE if benign) before certifying COMPLETE.`,
    );
  }
  if (unresolvedFee.length > 0) {
    console.log(
      `\n  🔴 UNRESOLVED OPERATOR(S): ${unresolvedFee.length} fee-bearing node(s) have NO current ADMIN_KEY address ` +
        `in OPERATOR_MAP — their fees (${fmt(unresolvedFee.reduce((s, n) => s + n.fee, 0n))} TRAC) CANNOT be drained, so ` +
        `the vault will not empty and the cutover is blocked. Supply the current admin address for: ` +
        `${unresolvedFee.map((n) => `id ${n.id} (${fmt(n.fee)})`).join(', ')}.`,
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

  // ---- preflight: hard-fail BEFORE sending any tx on an unresolved accounting
  // gap (operational safety — a red plan must not become a partial sweep). ----
  const blockers: string[] = [];
  if (activeGap > 0n) blockers.push(`active-stake gap ${fmt(activeGap)} (a delegator missing from DelegatorsInfo)`);
  if (unattributed > DUST_TOLERANCE) blockers.push(`unattributed vault ${fmt(unattributed)} > dust ${fmt(DUST_TOLERANCE)}`);
  if (scanDegraded) blockers.push('the Token.Transfer genesis scan was degraded/incomplete (lower EVENT_SCAN_STEP / archive RPC)');
  if (unresolvedFee.length > 0) blockers.push(`${unresolvedFee.length} fee-bearing node(s) with no current ADMIN_KEY address`);
  if (blockers.length > 0) {
    console.log('\n🛑 PREFLIGHT BLOCKED — no transaction sent:');
    blockers.forEach((b) => console.log(`   • ${b}`));
    if (!OVERRIDE_PREFLIGHT) {
      console.log(
        '\n   Resolve the above (the sweep cannot be COMPLETE while any persists), or set OVERRIDE_PREFLIGHT=1 to ' +
          'force a partial sweep that WILL require manual reconciliation (NOT recommended).',
      );
      process.exit(1);
    }
    console.log('\n   OVERRIDE_PREFLIGHT=1 set — proceeding with a KNOWN-INCOMPLETE sweep.');
  }

  // ---- execute: chunked adminDrainBatch (calldata built separately from submit) ----
  const buildCalldata = (chunk: Pair[]) =>
    NFT.interface.encodeFunctionData('adminDrainBatch', [chunk.map((p) => p.delegator), chunk.map((p) => BigInt(p.id))]);
  // EOA submit adapter. Production: replace with a propose-to-Custodian-multisig
  // adapter taking (to=NFT, data=calldata) and routing through the Safe.
  const submitChunk = async (chunk: Pair[]) =>
    (await admin.sendTransaction({ to: await NFT.getAddress(), data: buildCalldata(chunk) })).wait();

  console.log('\n=== EXECUTE ===');
  console.log('  -- delegator stake + pending --');
  for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + CHUNK_SIZE);
    const rcpt = await submitChunk(chunk);
    console.log(`  chunk ${i / CHUNK_SIZE + 1}/${chunks} (${chunk.length} pairs) — tx ${rcpt?.hash} gas ${rcpt?.gasUsed}`);
  }

  // ---- operator fees: resolved nodes only (unresolved blocked above unless
  // overridden). Folds into the operator's SAME migration credit (OT-RFC-50). ----
  const resolvedFee = feeNodes.filter((n) => n.operator);
  const submitFeeChunk = async (chunk: FeeNode[]) =>
    (
      await admin.sendTransaction({
        to: await NFT.getAddress(),
        data: NFT.interface.encodeFunctionData('adminDrainOperatorFeesBatch', [
          chunk.map((n) => BigInt(n.id)),
          chunk.map((n) => n.operator),
        ]),
      })
    ).wait();
  console.log('  -- operator fees --');
  for (let i = 0; i < resolvedFee.length; i += CHUNK_SIZE) {
    const chunk = resolvedFee.slice(i, i + CHUNK_SIZE);
    const rcpt = await submitFeeChunk(chunk);
    console.log(`  fee chunk ${i / CHUNK_SIZE + 1}/${feeChunks} (${chunk.length} nodes) — tx ${rcpt?.hash} gas ${rcpt?.gasUsed}`);
  }

  // ---- verify: per-node stake + per-node fee + empty-vault + reconcile gates ----
  console.log('\n=== VERIFY ===');
  let badNodes = 0;
  let badFeeNodes = 0;
  for (let id = 1; id <= lastId; id++) {
    const ns: bigint = await retry(() => SS.getNodeStake(id));
    if (ns !== 0n) {
      console.log(`  ❌ node ${id} still has ${fmt(ns)} active stake`);
      badNodes++;
    }
    const feeLeft =
      ((await retry(() => SS.getOperatorFeeBalance(id))) as bigint) +
      ((await retry(() => SS.getOperatorFeeWithdrawalRequestAmount(id))) as bigint);
    if (feeLeft !== 0n) {
      console.log(`  ❌ node ${id} still has ${fmt(feeLeft)} operator fee`);
      badFeeNodes++;
    }
  }
  const totalStakeAfter: bigint = await retry(() => SS.getTotalStake());
  const vaultAfter: bigint = await retry(() => Token.balanceOf(ssAddr));
  const credited = vaultBefore - vaultAfter; // TRAC that left the vault → CSS
  const expectedDrained = drainable + feeDrainable; // stake + pending + fees
  console.log(`  per-node active-stake oracle: ${badNodes === 0 ? 'all zero ✓' : `${badNodes} node(s) nonzero ✗`}`);
  console.log(`  per-node operator-fee oracle: ${badFeeNodes === 0 ? 'all zero ✓' : `${badFeeNodes} node(s) nonzero ✗`}`);
  console.log(`  getTotalStake: ${fmt(totalStakeAfter)} (expect 0)`);
  console.log(`  vault: ${fmt(vaultBefore)} → ${fmt(vaultAfter)}  (drained ${fmt(credited)} → CSS)`);
  console.log(`  reconcile: drained ${fmt(credited)} vs expected ${fmt(expectedDrained)} (stake + pending + operator fees)`);
  console.log(`  empty-vault gate: ${fmt(vaultAfter)} residual (must be ≤ ${fmt(DUST_TOLERANCE)} dust tolerance)`);

  const complete =
    badNodes === 0 &&
    badFeeNodes === 0 &&
    totalStakeAfter === 0n &&
    unresolvedFee.length === 0 &&
    credited === expectedDrained &&
    vaultAfter <= DUST_TOLERANCE;
  if (complete) {
    console.log('\n✅ SWEEP COMPLETE — all V8 stake + pending + operator fees drained into migration credit.');
    console.log('   getTotalStake()==0, all per-node stake & fee zero, vault emptied to ≤ dust.');
    console.log('   Safe to unregister V8 Staking on this chain (the vault is now empty).');
  } else {
    console.log(
      `\n❌ INCOMPLETE — one or more gates failed. Re-run (idempotent). ` +
        `If getTotalStake/per-node stake won't zero: a delegator is missing from DelegatorsInfo. ` +
        `If a per-node fee won't zero or the vault won't empty: an operator was unresolved/skipped (supply OPERATOR_MAP) ` +
        `or there is unclaimed rewards/dust — characterize it and raise DUST_TOLERANCE.`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n❌ sweep driver error:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
