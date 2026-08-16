// P2 3.1 — envelope scaling (G3-A, fast boundary suite).
//
// The at-scale N=100,000 proof (real 100k journal legs + subprocess crash-
// replay) lives in slow/envelope-scale-100k.gates.mjs and is EXCLUDED from the
// default sweep for runtime (~8 min of real fsync'd appends) — run explicitly.
// This suite proves every boundary of the same machinery at sweep speed:
// quote-layer scale policy (versioned invariant), route refusals, and the
// ledger's atomic call-slot + aggregate-ceiling + deposit-bound enforcement.
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const Q = await import(join(dist, "metering/inference-quote.js"));
const L = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const sha = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");
const PROVIDER = "0x633E5a7Ce4bE99e91E9C0e7dBc51eB27a6Ab8B92".slice(0, 42);
const REFUND = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const SCHED = "ab".repeat(32);
const REF_COST = 234;                      // the reference call (42 in / 25 out)

const build = (calls) => Q.buildFundedRunQuote({ tabEpoch: 1, providerAddress: PROVIDER, refundAddress: REFUND, scheduleDigest: SCHED, calls });
const reforge = (q) => {                   // re-digest a tampered quote so ONLY the scale check can catch it
  const { quoteId, fundedRunTermsDigest, ...bound } = q;
  const d = sha(L.canonicalize(bound));
  return { ...bound, quoteId: d, fundedRunTermsDigest: d };
};

console.log("envelope-scale gates (P2 3.1 / G3-A fast):");

console.log("\n(1) quote layer — scale is a versioned invariant:");
{
  const def = build(undefined);
  ok("default build keeps N=10, stamps envelope-scale/v2 + deposit-bound note", def.envelope.calls === 10 && def.envelope.scalePolicyVersion === "envelope-scale/v2" && typeof def.envelope.depositBoundNote === "string");
  ok("default quote verifies", Q.verifyFundedRunQuote(def).ok === true, JSON.stringify(Q.verifyFundedRunQuote(def)));
  const big = build(100_000);
  ok("N=100,000 builds with PROPORTIONAL ceiling 23,400,000 (N × 234)", big.envelope.maxAcceptedClaimMicroTrac === 100_000 * REF_COST && Q.verifyFundedRunQuote(big).ok === true);
  ok("N=1 builds (v2 floor)", build(1).envelope.maxAcceptedClaimMicroTrac === REF_COST && Q.verifyFundedRunQuote(build(1)).ok === true);
  for (const bad of [0, 100_001, -5, 2.5, NaN, 1e15]) {
    ok(`build refuses N=${String(bad)} (E_ENVELOPE_SCALE)`, (() => { try { build(bad); return false; } catch (e) { return String(e.message).startsWith("E_ENVELOPE_SCALE"); } })());
  }
  // a SELF-CONSISTENT forged quote outside policy must fail at the base
  // verifier — digest validity is not scale validity
  const forged = reforge({ ...build(100_000), envelope: { ...build(100_000).envelope, calls: 100_001, maxAcceptedClaimMicroTrac: 100_001 * REF_COST } });
  const fv = Q.verifyFundedRunQuote(forged);
  ok("self-consistent forged N=100,001 → E_QUOTE_ENVELOPE_SCALE at the base verifier", fv.ok === false && fv.code === "E_QUOTE_ENVELOPE_SCALE", JSON.stringify(fv));
  const unknown = reforge({ ...build(10), envelope: { ...build(10).envelope, scalePolicyVersion: "envelope-scale/v99" } });
  ok("unknown scale version → E_QUOTE_ENVELOPE_SCALE", Q.verifyFundedRunQuote(unknown).code === "E_QUOTE_ENVELOPE_SCALE");
  const proportionality = reforge({ ...build(100_000), envelope: { ...build(100_000).envelope, maxAcceptedClaimMicroTrac: 100_000 * REF_COST + 1 } });
  ok("tampered ceiling at scale (N×234 + 1) → E_QUOTE_ENVELOPE (proportionality holds at every N)", Q.verifyFundedRunQuote(proportionality).code === "E_QUOTE_ENVELOPE");
  // the deposit-bound note is a v2 VERIFIER INVARIANT (Hermes 3.1 #1): a
  // self-consistent v2 quote that omits or rewords the buyer-visible
  // min(deposit, ceiling) statement refuses at the base verifier
  const noteless = (() => { const q = build(10); const { depositBoundNote, ...env } = q.envelope; return reforge({ ...q, envelope: env }); })();
  ok("v2 quote OMITTING depositBoundNote → E_QUOTE_DEPOSIT_NOTE", Q.verifyFundedRunQuote(noteless).code === "E_QUOTE_DEPOSIT_NOTE");
  const reworded = reforge({ ...build(10), envelope: { ...build(10).envelope, depositBoundNote: "trust us" } });
  ok("v2 quote with ALTERED depositBoundNote → E_QUOTE_DEPOSIT_NOTE", Q.verifyFundedRunQuote(reworded).code === "E_QUOTE_DEPOSIT_NOTE");
  ok("canonical note verbatim → verifies", Q.verifyFundedRunQuote(build(10)).ok === true);
  ok("note text is FROZEN per scale version (OpenClaw 3.1): map is frozen + v2 note bound to its version key", Object.isFrozen(Q.DEPOSIT_BOUND_NOTES) && Q.DEPOSIT_BOUND_NOTES["envelope-scale/v2"] === Q.DEPOSIT_BOUND_NOTE);
}

console.log("\n(2) legacy compatibility — absent field resolves to envelope-scale/v1 (N fixed at 10):");
{
  const legacy = (calls) => {
    const q = build(10);
    const { scalePolicyVersion, depositBoundNote, ...env } = q.envelope;
    return reforge({ ...q, envelope: { ...env, calls, maxAcceptedClaimMicroTrac: calls * REF_COST } });
  };
  ok("legacy-shaped quote (no scale field, NO deposit note, N=10) still verifies — digests unchanged, note invariant is v2-scoped", Q.verifyFundedRunQuote(legacy(10)).ok === true, JSON.stringify(Q.verifyFundedRunQuote(legacy(10))));
  ok("legacy-shaped quote with N=50 → refused (v1 range is exactly 10)", Q.verifyFundedRunQuote(legacy(50)).code === "E_QUOTE_ENVELOPE_SCALE");
  const expected = { chainId: 8453, tracContract: build(10).tracContract, providerAddress: PROVIDER, refundAddress: REFUND, tabEpoch: 1, principalTrac: "1", confirmationDepth: 12, expiryMs: 24 * 60 * 60 * 1000, scheduleDigest: SCHED, envelopeCalls: 10, expiryPolicyVersion: "funded-run-expiry/v1", envelopeScalePolicyVersion: "envelope-scale/v1" };
  ok("expected-binding: legacy quote pins as v1 and passes", Q.verifyFundedRunQuote(legacy(10), { expected }).ok === true);
  ok("expected-binding: v2 quote pinned as v1 → E_QUOTE_EXPECT_ENVELOPE (unconditional compare)", Q.verifyFundedRunQuote(build(10), { expected }).code === "E_QUOTE_EXPECT_ENVELOPE");
  const { envelopeScalePolicyVersion, ...noPin } = expected;
  ok("expected-binding with scale version OMITTED refuses (must pin it)", Q.verifyFundedRunQuote(legacy(10), { expected: noPin }).ok === false);
}

console.log("\n(3) ledger — atomic enforcement at the exact boundaries (same machinery the 100k suite drives):");
{
  const mk = (calls, ceiling, balance) => {
    const h = mkdtempSync(join(tmpdir(), "env-scale-"));
    mkdirSync(join(h, "metering"), { recursive: true });
    const r = L.creditFunded(h, REFUND, balance, { chainId: 8453, token: "0xT", txHash: "0xd", logIndex: 0 }, { expectedEpoch: 0, quoteDigest: "sha256:Q", calls, aggregateCeilingMicroTrac: ceiling });
    if (!r?.ok && r?.ok !== undefined) throw new Error("credit failed: " + JSON.stringify(r));
    return h;
  };
  const leg = (h, cost) => { try { return { ok: true, r: L.recordInferenceLeg(h, { principal: REFUND, inputTokens: 1, outputTokens: 0, costMicroTrac: cost, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: "sha256:Q", requesterKeyRef: "sha256:k" }) }; } catch (e) { return { ok: false, code: e.message }; } };
  const jlen = (h) => readFileSync(join(h, "metering", "read-journal.jsonl")).length;

  // call-slot boundary: N=3
  const h1 = mk(3, 1000, 1000);
  ok("slots 1..N fill", leg(h1, 1).ok && leg(h1, 1).ok && leg(h1, 1).ok && L.envelopeStateOf(h1, REFUND).calls === 3);
  const j1 = jlen(h1);
  const over = leg(h1, 1);
  ok("slot N+1 → E_ENVELOPE_CALLS_EXCEEDED, journal byte-identical (atomic refusal)", over.ok === false && over.code === "E_ENVELOPE_CALLS_EXCEEDED" && jlen(h1) === j1, JSON.stringify(over));

  // aggregate boundary: exact-at-ceiling accepted, +1 refused
  const h2 = mk(1000, 500, 10_000);
  ok("aggregate below ceiling accepted (499)", leg(h2, 499).ok === true);
  const j2 = jlen(h2);
  const agg = leg(h2, 2);
  ok("aggregate would exceed (499+2>500) → E_ENVELOPE_AGGREGATE_EXCEEDED, zero writes", agg.ok === false && agg.code === "E_ENVELOPE_AGGREGATE_EXCEEDED" && jlen(h2) === j2);
  ok("EXACTLY at ceiling accepted (499+1=500)", leg(h2, 1).ok === true);
  ok("beyond exact ceiling refused again", leg(h2, 1).ok === false && L.envelopeStateOf(h2, REFUND).aggregateMicroTrac === 500);

  // deposit bound binds BEFORE a huge envelope (the min() relation the quote's
  // depositBoundNote states): balance 100, ceiling 23,400,000
  const h3 = mk(100_000, 23_400_000, 100);
  ok("deposit-bound: spend within balance ok (60)", leg(h3, 60).ok === true);
  const j3 = jlen(h3);
  const funds = leg(h3, 41);
  ok("deposit-bound: E_INSUFFICIENT_FUNDS binds before the envelope, zero writes", funds.ok === false && funds.code === "E_INSUFFICIENT_FUNDS" && jlen(h3) === j3);
}

console.log(`\n${pass}/${pass + fail} envelope-scale gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
