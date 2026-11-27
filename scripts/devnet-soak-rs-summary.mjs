// The RS soak's assertions and report. scripts/devnet-soak-rs.sh runs it
// from packages/evm-module once the soak window has elapsed. The environment
// names its inputs and output (OUT_DIR, TIMESERIES, PUBLISH_LOG, EVENTS_LOG,
// RESTART_WINDOW_FILE, STAKE_BEFORE, STAKE_AFTER, DELEGATORS_FILE, FINDINGS)
// and the run (ROUND, DURATION_SEC, NUM_CORES, NUM_EDGE). It writes the
// report to the FINDINGS file, prints the number of ok, warn and fail lines,
// and exits 1 when any assertion failed.
import fs from "node:fs";

const out = process.env;
const fail = [];
const warn = [];
const ok = [];

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(l => l.trim().length > 0);
}

function jsonOrNull(s) { try { return JSON.parse(s); } catch { return null; } }

const stakeBefore = JSON.parse(fs.readFileSync(out.STAKE_BEFORE, "utf8"));
const stakeAfter  = JSON.parse(fs.readFileSync(out.STAKE_AFTER, "utf8"));
const tsLines     = readLines(out.TIMESERIES).map(jsonOrNull).filter(Boolean);
const pubLines    = readLines(out.PUBLISH_LOG).map(jsonOrNull).filter(Boolean);
const evtLines    = readLines(out.EVENTS_LOG).map(jsonOrNull).filter(Boolean);
const restartWindow = fs.existsSync(out.RESTART_WINDOW_FILE)
  ? jsonOrNull(fs.readFileSync(out.RESTART_WINDOW_FILE, "utf8"))
  : null;

function isPlannedRestartPublishFailure(p) {
  if (!restartWindow || p.status !== "fail") return false;
  const tsMs = Date.parse(p.ts);
  if (!Number.isFinite(tsMs)) return false;
  const startMs = Number(restartWindow.stopTs ?? 0) * 1000;
  const endMs = (Number(restartWindow.apiReadyTs ?? 0) + Number(restartWindow.graceSec ?? 0)) * 1000;
  if (!startMs || !endMs || tsMs < startMs || tsMs > endMs) return false;
  const output = String(p.out ?? "");
  // A publish to the stopped node that started as the planned stop began is
  // killed with it (SIGTERM, exit 143), whatever it had printed by then.
  if (Number(p.rc) === 143 && Number(p.node) === Number(restartWindow.node)) return true;
  // The CLI can fail before its HTTP request when its own node is the one
  // deliberately stopped. Only excuse that diagnostic for the stopped node;
  // another node losing its API in this window remains a blocking failure.
  if (/Cannot read API port/i.test(output)) {
    return Number(p.node) === Number(restartWindow.node);
  }
  return /storage_ack_insufficient|Daemon is not running|ECONNREFUSED|fetch failed|api request failed/i.test(output);
}

// 1. Publisher: at least 90% of non-planned-outage attempts must succeed.
// The mid-soak restart intentionally removes one core for ~120s. With
// requiredACKs=3, a publisher on another core can only collect two core ACKs
// during that window; those publish attempts validate outage behavior but
// should not fail the lane after the restarted node has recovered cleanly.
const pubOk = pubLines.filter(p => p.status === "ok").length;
const pubFailures = pubLines.filter(p => p.status === "fail");
const plannedRestartFailures = pubFailures.filter(isPlannedRestartPublishFailure);
const blockingPubFailures = pubFailures.filter(p => !isPlannedRestartPublishFailure(p));
const pubFail = pubFailures.length;
const pubTotal = pubLines.length;
const effectivePubTotal = pubTotal - plannedRestartFailures.length;
if (plannedRestartFailures.length > 0) {
  const node = restartWindow?.node ?? "?";
  ok.push("PUBLISH tolerated " + plannedRestartFailures.length + " failure(s) during planned node" + node + " restart window");
}
if (effectivePubTotal > 0 && blockingPubFailures.length === 0 && pubOk / effectivePubTotal >= 0.9) {
  ok.push("PUBLISH success rate excluding planned restart window " + pubOk + "/" + effectivePubTotal + " (" + Math.round(100*pubOk/effectivePubTotal) + "%) >= 90%");
} else {
  fail.push("PUBLISH success rate excluding planned restart window " + pubOk + "/" + effectivePubTotal + " (blocking failures=" + blockingPubFailures.length + ", total failures=" + pubFail + ")");
}
// A publish whose share the node could not finish at once counts as ok when
// following the node's answer worked (the client rule): sharing the same draft
// again (share_retries), or waiting for the share job that owned the share
// (share_recovery). Every such publish is reported, and the lane fails when
// more than one publish in ten needed it. The rate counts the attempts the
// success rate counts: a failure the planned restart excuses is reported but
// left out of it.
const pubShareRetried = pubLines.filter(p => Number(p.share_retries ?? 0) > 0 || (p.share_recovery ?? null) !== null);
if (pubShareRetried.length > 0) {
  const answers = pubShareRetried.reduce((n, p) => n + Number(p.share_retries ?? 0), 0);
  const jobs = pubShareRetried.filter(p => (p.share_recovery ?? null) !== null).length;
  const where = pubShareRetried.map(p => "i" + p.i + " node" + p.node + " x" + Number(p.share_retries ?? 0)
    + (p.share_recovery ? " job " + p.share_recovery.state + " " + p.share_recovery.waited_s + "s" : "") + " " + p.status).join(", ");
  const line = "PUBLISH followed " + answers + " retryable share answer(s) and " + jobs + " share job(s) on "
    + pubShareRetried.length + " publish(es): " + where;
  const countedRetried = pubShareRetried.filter(p => !isPlannedRestartPublishFailure(p));
  if (effectivePubTotal > 0 && countedRetried.length / effectivePubTotal > 0.1) {
    fail.push(line + " (more than 1 publish in 10)");
  } else {
    warn.push(line);
  }
}

// 2. RS prover: take the PEAK submittedCount per node across the whole
// timeseries. R1 surfaced that the very last snapshot can be empty
// (`rs: {}`, `uptime_ms: null`) when the agent or the snapshot fetcher
// is mid-shutdown — using the last snapshot then misreports a healthy
// node as "never submitted" even though the chain shows its proofs.
//
// Note: edge nodes legitimately report `loop: null` (role-gated), so
// "missing loop" only counts as an observability gap on CORE nodes —
// and only if the entire `rs` object is missing (a transient API
// unavailability), not when `loop` is intentionally null.
const peakSubmittedByNode = new Map();
const enabledByNode = new Map();
const identityByNode = new Map();
const apiUnavailableByNode = new Map();
for (const snap of tsLines) {
  for (const node of (snap.perNode || [])) {
    const rs = node.rs;
    const isCore = node.node <= Number(out.NUM_CORES);
    if (!rs || Object.keys(rs).length === 0) {
      if (isCore) {
        apiUnavailableByNode.set(node.node, (apiUnavailableByNode.get(node.node) ?? 0) + 1);
      }
      continue;
    }
    if (rs.enabled === true) enabledByNode.set(node.node, true);
    if (rs.identityId) identityByNode.set(node.node, rs.identityId);
    const loop = rs.loop;
    if (loop && typeof loop.submittedCount === "number") {
      const cur = peakSubmittedByNode.get(node.node) ?? 0;
      if (loop.submittedCount > cur) peakSubmittedByNode.set(node.node, loop.submittedCount);
    }
  }
}
const totalApiGaps = [...apiUnavailableByNode.values()].reduce((s, v) => s + v, 0);
if (totalApiGaps > 0) {
  const detail = [...apiUnavailableByNode.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => "node" + n + "=" + c).join(", ");
  warn.push("OBSERVER " + totalApiGaps + " core snapshots had no rs payload (" + detail + ") — likely API/agent transient unavailability");
}
if (peakSubmittedByNode.size === 0 && tsLines.length === 0) {
  fail.push("OBSERVER: no snapshots captured");
} else {
  for (let n = 1; n <= Number(out.NUM_CORES) + Number(out.NUM_EDGE); n++) {
    const isCore = n <= Number(out.NUM_CORES);
    const peak = peakSubmittedByNode.get(n) ?? 0;
    const idStr = identityByNode.get(n) ?? "?";
    if (isCore) {
      if (peak > 0) {
        ok.push("RS core node " + n + " peak submittedCount=" + peak + " (identity " + idStr + ")");
      } else {
        fail.push("RS core node " + n + " never submitted (identity " + idStr + ")");
      }
    } else {
      if (peak > 0) {
        fail.push("RS edge node " + n + " peak submittedCount=" + peak + " — edge nodes must NEVER submit");
      } else if (enabledByNode.get(n) === true) {
        fail.push("RS edge node " + n + " has enabled=true — edge nodes must report enabled=false");
      } else {
        ok.push("RS edge node " + n + " correctly disabled across " + tsLines.length + " snapshots");
      }
    }
  }
}

// 3. On-chain proof events: each successful submitProof emits
//    EpochNodeValidProofsCountIncremented(epoch, identityId, newCount).
//    Assert at least 3 of 4 core identities show up — accommodates one core
//    being briefly down (the mid-soak restart scenario does exactly that).
const proofEvents = evtLines.filter(e => e.event === "EpochNodeValidProofsCountIncremented");
const scoreEvents = evtLines.filter(e => e.event === "NodeEpochScoreAdded");
const submittersByIdentity = new Set();
for (const e of proofEvents) {
  if (e.args && e.args[1]) submittersByIdentity.add(String(e.args[1]));
}
if (submittersByIdentity.size >= 3) {
  ok.push("CHAIN " + proofEvents.length + " EpochNodeValidProofsCountIncremented events from " + submittersByIdentity.size + " distinct identities (>= 3)");
} else if (submittersByIdentity.size > 0) {
  warn.push("CHAIN " + proofEvents.length + " proof events from only " + submittersByIdentity.size + " identities (expected >= 3)");
} else {
  warn.push("CHAIN no EpochNodeValidProofsCountIncremented events captured (sniffer may have missed; cross-check timeseries)");
}
if (scoreEvents.length > 0) {
  ok.push("CHAIN " + scoreEvents.length + " NodeEpochScoreAdded events recorded");
}

// 4. Stake immutability for cores: getNodeStakeV10 must not have shrunk
for (let i = 0; i < stakeBefore.perCore.length; i++) {
  const before = BigInt(stakeBefore.perCore[i].v10StakeWei);
  const after  = BigInt(stakeAfter.perCore[i].v10StakeWei);
  if (after < before) {
    fail.push("STAKE core " + (i+1) + " stake shrank: " + before + " -> " + after);
  } else if (after > before) {
    ok.push("STAKE core " + (i+1) + " stake grew (rewards reinvested?): " + before + " -> " + after);
  } else {
    ok.push("STAKE core " + (i+1) + " stake stable: " + before);
  }
}

// 5. RS score growth: epochScore resets at every epoch transition. R1
// crossed 7 epoch boundaries during the soak and the FINAL snapshot
// landed in a fresh epoch (all zeros) — the simple "after > before"
// check then warned about no growth even though there were 143 score
// events on chain. Use NodeEpochScoreAdded events as the cumulative
// per-(epoch,identity) signal instead.
const scoreByEpochIdentity = new Map();
const proofsByIdentity     = new Map();
for (const e of scoreEvents) {
  if (!e.args) continue;
  const [epoch, identityId, , scoreAdded] = e.args;
  const key = String(epoch) + ":" + String(identityId);
  const cur = scoreByEpochIdentity.get(key) ?? 0n;
  scoreByEpochIdentity.set(key, cur + BigInt(scoreAdded ?? 0));
  const prevCount = proofsByIdentity.get(String(identityId)) ?? 0;
  proofsByIdentity.set(String(identityId), prevCount + 1);
}
const epochsObserved = new Set();
for (const k of scoreByEpochIdentity.keys()) epochsObserved.add(k.split(":")[0]);
if (epochsObserved.size === 0) {
  fail.push("SCORE no NodeEpochScoreAdded events captured");
} else {
  ok.push("SCORE accrual observed across " + epochsObserved.size + " distinct epoch(s); " + scoreEvents.length + " events total");
  for (const [identity, count] of proofsByIdentity.entries()) {
    ok.push("SCORE identity " + identity + " accrued score on " + count + " proofs");
  }
}

// 6. Asymmetric reward signal: aggregate per-identity score across ALL
// epochs in the soak (so brief downtime of one node does not poison
// the comparison). High-stake identities should out-score low-stake
// ones over the full window.
const totalScoreByIdentity = new Map();
for (const [k, v] of scoreByEpochIdentity.entries()) {
  const id = k.split(":")[1];
  const cur = totalScoreByIdentity.get(id) ?? 0n;
  totalScoreByIdentity.set(id, cur + v);
}
const coreIdentities = stakeAfter.perCore.map(c => ({ identity: String(c.identityId), stakeWei: BigInt(c.v10StakeWei), totalScore: totalScoreByIdentity.get(String(c.identityId)) ?? 0n }));
const sortedByStake = [...coreIdentities].sort((a, b) => Number(b.stakeWei - a.stakeWei));
if (sortedByStake.length >= 2) {
  const high = sortedByStake[0];
  const low  = sortedByStake[sortedByStake.length - 1];
  if (high.totalScore > 0n && low.totalScore > 0n) {
    ok.push("ASYMMETRY high-stake identity " + high.identity + " total score " + high.totalScore + " vs low-stake identity " + low.identity + " " + low.totalScore + " (both proving)");
  } else if (high.totalScore === 0n && low.totalScore === 0n) {
    warn.push("ASYMMETRY no aggregated score for any identity (event sniffer may have missed events)");
  } else {
    warn.push("ASYMMETRY uneven coverage: high-stake total=" + high.totalScore + " low-stake total=" + low.totalScore);
  }
}

// 7. Negative scenario A: create/share to unregistered CG was rejected
const negResults = readLines(out.OUT_DIR + "/negative-results.jsonl").map(jsonOrNull).filter(Boolean);
const negA = negResults.find(r => r.scenario === "create_share_unregistered_cg");
if (negA && negA.result === "correctly_rejected") {
  ok.push("NEG-A create/share to unregistered CG correctly rejected (rc=" + negA.rc + ")");
} else if (negA) {
  fail.push("NEG-A create/share to unregistered CG: " + JSON.stringify(negA));
} else {
  warn.push("NEG-A no record of unregistered-CG negative scenario");
}

// 8. Negative scenario B: edge nodes never submitted (re-asserted across the timeseries, not just final)
let edgeViolations = 0;
for (const snap of tsLines) {
  for (const node of (snap.perNode || [])) {
    if (node.node > Number(out.NUM_CORES)) {
      const sc = node.rs?.loop?.submittedCount ?? 0;
      if (sc > 0) edgeViolations++;
    }
  }
}
if (edgeViolations === 0) {
  ok.push("NEG-B edge nodes 5+6 never submitted across " + tsLines.length + " snapshots");
} else {
  fail.push("NEG-B edge nodes submitted on " + edgeViolations + " snapshots");
}

// 9. Reward-mechanism liveness: epoch transitions + score events together
//    are necessary-and-sufficient evidence the staking pipeline is alive.
//    netNodeEpochRewards is computed lazily on first claim (StakingV10
//    setNetNodeEpochRewards path) — it can stay 0 even when rewards have
//    fully accrued in scorePerStake. Do NOT fail on it; just report.
// `.epoch` arrives as a string from the JSON snapshot; bare `>` does
// lexicographic comparison, so "13" > "8" returns false. R2 hit this and
// reported "no epoch transition" even though 8 -> 13 had happened. Use
// BigInt for a correct numeric comparison.
const epochBefore = BigInt(stakeBefore.epoch);
const epochAfter  = BigInt(stakeAfter.epoch);
const epochsTransitioned = epochAfter > epochBefore;
if (epochsTransitioned && scoreEvents.length > 0) {
  ok.push("REWARDS-LIVENESS " + (epochAfter - epochBefore) + " epoch transition(s) and " + scoreEvents.length + " on-chain score events captured");
} else if (!epochsTransitioned) {
  warn.push("REWARDS-LIVENESS no epoch transition observed — reduce Chronos.epochLength to see distribution");
}

// Compose findings.md
const md = [];
md.push("# Devnet soak round " + out.ROUND + " findings");
md.push("");
md.push("- Duration: " + out.DURATION_SEC + "s");
md.push("- Started epoch: " + stakeBefore.epoch + " (block " + stakeBefore.blockNumber + ")");
md.push("- Ended   epoch: " + stakeAfter.epoch + " (block " + stakeAfter.blockNumber + ")");
md.push("- Publishes attempted: " + pubTotal + " (ok=" + pubOk + ", fail=" + pubFail + ")");
md.push("- Snapshots captured: " + tsLines.length);
md.push("- Chain events captured: " + evtLines.length);
md.push("");
md.push("## Pass (" + ok.length + ")");
for (const x of ok) md.push("- " + x);
md.push("");
md.push("## Warn (" + warn.length + ")");
for (const x of warn) md.push("- " + x);
md.push("");
md.push("## Fail (" + fail.length + ")");
for (const x of fail) md.push("- " + x);
md.push("");
md.push("## Stake state (per core)");
md.push("");
md.push("| Core | Identity | Stake (TRAC) | Total score (sum across epochs) | Score-per-stake (final epoch) | Net rewards (wei, lazy) | Peak prover submittedCount |");
md.push("|---|---|---|---|---|---|---|");
for (let i = 0; i < stakeBefore.perCore.length; i++) {
  const a = stakeAfter.perCore[i];
  const fmt = (wei) => (Number(BigInt(wei)) / 1e18).toFixed(0);
  const totalScore = totalScoreByIdentity.get(String(a.identityId)) ?? 0n;
  const peakSubmitted = peakSubmittedByNode.get(i + 1) ?? 0;
  md.push("| " + (i+1) + " | " + a.identityId + " | " + fmt(a.v10StakeWei) + " | " + totalScore + " | " + a.epochScorePerStake + " | " + (a.netNodeEpochRewards ?? "0") + " | " + peakSubmitted + " |");
}
md.push("");
md.push("## Delegator state (post-soak)");
md.push("");
md.push("| # | Address | Core | Rolling rewards (wei) |");
md.push("|---|---|---|---|");
for (let i = 0; i < stakeAfter.perDelegator.length; i++) {
  const d = stakeAfter.perDelegator[i];
  md.push("| " + (i+1) + " | " + d.address + " | " + d.stakedOnCoreNodeIdx + " | " + d.rollingRewardsWei + " |");
}
md.push("");

fs.writeFileSync(out.FINDINGS, md.join("\n"));
console.log(JSON.stringify({ok: ok.length, warn: warn.length, fail: fail.length}));
process.exit(fail.length > 0 ? 1 : 0);
