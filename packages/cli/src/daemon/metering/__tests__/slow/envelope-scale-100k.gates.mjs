// P2 3.1 — G3-A AT SCALE: the envelope ceiling enforced atomically at
// N=100,000 with crash-replay at scale.
//
// EXCLUDED from the default sweep by location (__tests__/slow/) because it
// appends 100,000 REAL durable journal legs through the production path
// (~8 min of fsync'd writes) — no hand-shaped records, no shortcuts. Run
// explicitly; timings are printed so the evidence carries the real numbers.
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../../dist/daemon");
const L = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const BUYER = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const N = 100_000;
const CEILING = N * 234;                 // 23,400,000 µTRAC — proportional
const BALANCE = 1_000_000;               // 1 TRAC — the real principal size

console.log(`envelope-scale AT 100k (G3-A): N=${N}, ceiling=${CEILING}, balance=${BALANCE}`);

const h = mkdtempSync(join(tmpdir(), "env-100k-"));
mkdirSync(join(h, "metering"), { recursive: true });
L.creditFunded(h, BUYER, BALANCE, { chainId: 8453, token: "0xT", txHash: "0xd", logIndex: 0 }, { expectedEpoch: 0, quoteDigest: "sha256:Q", calls: N, aggregateCeilingMicroTrac: CEILING });

const leg = (cost) => { try { L.recordInferenceLeg(h, { principal: BUYER, inputTokens: 1, outputTokens: 0, costMicroTrac: cost, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: "sha256:Q", requesterKeyRef: "sha256:k" }); return { ok: true }; } catch (e) { return { ok: false, code: e.message }; } };

// ── fill every slot through the REAL debit path (cost 1µ so the deposit and
// aggregate ceiling never bind before the call-slot boundary does) ──
const t0 = Date.now();
let filled = 0, firstFailure = null;
for (let i = 0; i < N; i++) {
  const r = leg(1);
  if (!r.ok) { firstFailure = { at: i, code: r.code }; break; }
  filled++;
  if (filled % 20000 === 0) console.log(`  … ${filled}/${N} legs, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const fillSecs = ((Date.now() - t0) / 1000).toFixed(0);
ok(`all ${N} slots fill through the real debit path (${fillSecs}s)`, filled === N && firstFailure === null, JSON.stringify(firstFailure));
const st = L.envelopeStateOf(h, BUYER);
ok(`envelope projection reads calls=${N}, aggregate=${N}µ`, st.calls === N && st.aggregateMicroTrac === N);

// ── the boundary, atomically: slot N+1 refused with a byte-identical journal ──
const J = join(h, "metering", "read-journal.jsonl");
const jBytes = statSync(J).size;
const over = leg(1);
ok("slot 100,001 → E_ENVELOPE_CALLS_EXCEEDED, journal byte-identical (atomic refusal at scale)", over.ok === false && over.code === "E_ENVELOPE_CALLS_EXCEEDED" && statSync(J).size === jBytes, JSON.stringify(over));

// ── crash-replay AT SCALE: a FRESH process must reconstruct the identical
// envelope projection from the 100k-record journal alone, and still refuse ──
const t1 = Date.now();
const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
const L = await import(${JSON.stringify(join(dist, "metering/ledger.js"))});
const st = L.envelopeStateOf(${JSON.stringify(h)}, ${JSON.stringify(BUYER)});
let refused = null;
try { L.recordInferenceLeg(${JSON.stringify(h)}, { principal: ${JSON.stringify(BUYER)}, inputTokens: 1, outputTokens: 0, costMicroTrac: 1, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: "sha256:Q", requesterKeyRef: "sha256:k" }); } catch (e) { refused = e.message; }
console.log(JSON.stringify({ st, refused }));
`], { encoding: "utf8" });
const replay = JSON.parse(out.trim().split("\n").pop());
const replaySecs = ((Date.now() - t1) / 1000).toFixed(1);
ok(`FRESH-PROCESS replay reconstructs calls=${N} from the journal alone (${replaySecs}s cold replay)`, replay.st.calls === N && replay.st.aggregateMicroTrac === N, JSON.stringify(replay.st));
ok("…and the fresh process STILL refuses slot 100,001 (E_ENVELOPE_CALLS_EXCEEDED)", replay.refused === "E_ENVELOPE_CALLS_EXCEEDED", String(replay.refused));
ok("journal untouched by the replay probe", statSync(J).size === jBytes);
console.log(`  journal size at N=100k: ${(jBytes / 1024 / 1024).toFixed(1)} MB`);

console.log(`\n${pass}/${pass + fail} envelope-scale-100k gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
