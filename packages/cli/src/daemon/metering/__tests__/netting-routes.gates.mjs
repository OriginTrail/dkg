// HTTP-route gates for the P2 netting endpoints (netting-http-core + adapter).
//
// The three wiring principles under test:
//  1. Routes cannot bypass in-mutation verification — a bad/foreign close
//     signature is refused END-TO-END over HTTP exactly as at the core.
//  2. Economics are never caller-supplied — the settle-gate refuses requests
//     carrying fee/rate params and fails closed without recorded config.
//  3. recordEarnedRelease is NOT part of this surface — structurally asserted.
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "netting-routes-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const R = await import(join(dist, "metering/netting-http-core.js"));
const N = await import(join(dist, "metering/netting.js"));
const L = await import(join(dist, "metering/ledger.js"));
const MR = await import(join(dist, "metering/metered-read.js"));
const C = await import(join(dist, "metering/capability.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const BUYER = "0xAAAA567890abcdef1234567890abcdef12345678";
const session = generateKeyPairSync("ed25519");
const foreign = generateKeyPairSync("ed25519");
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
const keyRefOf = (p) => "sha256:" + createHash("sha256").update(p).digest("hex");

const drive = async (method, path, { query, body } = {}) => {
  const captured = { status: 0, body: null };
  const io = { json: (s, b) => { captured.status = s; captured.body = b; }, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) };
  const handled = await R.handleNetting({ method, path, home, query }, io);
  return { ...captured, handled };
};
const journalBytes = () => { const f = join(home, "metering", "read-journal.jsonl"); return existsSync(f) ? readFileSync(f).length : 0; };

console.log("\nnetting HTTP routes — wiring gates\n");

console.log("dispatch wiring (the stage-3 regression class):");
{
  const hr = readFileSync(join(dist, "handle-request.js"), "utf8");
  ok("built daemon imports the netting route", hr.includes("handleMeteredNettingRoutes"));
  ok("built daemon CALLS it in the dispatch chain", /await\s+handleMeteredNettingRoutes\s*\(/.test(hr));
  const ad = readFileSync(join(dist, "routes", "metered-netting.js"), "utf8");
  ok("adapter delegates to the core under test", /handleNetting\s*\(/.test(ad) && ad.includes("netting-http-core"));
}

console.log("\nsurface exclusion (principle 3):");
{
  // WHOLE built-tree scan (review, Hermes wiring #4): no dispatcher, route, or
  // alias anywhere in dist/daemon may import or call recordEarnedRelease — the
  // ONLY permitted match is its own declaration in metering/netting.js.
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const p = join(dir, e); const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p); } return out; };
  // alias-resistant (OpenClaw v4.2 #1, symmetric with the settle-worker scan):
  // comment-strip, then ANY token occurrence flags the file.
  const stripC = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const uses = (src) => /\brecordEarnedRelease\b/.test(stripC(src));
  // permitted: the declaration (netting.js) and the sanctioned loopback driver
  // (settle-worker.js — see settle-worker.gates.mjs for its own closed-set and
  // digest-propagation proofs). The worker must in turn be UNREACHABLE from
  // the HTTP surface, asserted below.
  const offenders = walk(dist).filter((f) => !f.endsWith("metering/netting.js") && !f.endsWith("metering/settle-worker.js") && uses(readFileSync(f, "utf8")));
  ok("recordEarnedRelease reachable ONLY from its declaration + the sanctioned settle-worker", offenders.length === 0, offenders.join(", "));
  const httpSurf = [...walk(join(dist, "routes")), join(dist, "handle-request.js"), join(dist, "metering/netting-http-core.js"), join(dist, "metering/infer-http-core.js")].filter((f) => { try { readFileSync(f); return true; } catch { return false; } });
  const refsWorker = httpSurf.filter((f) => /settle-worker/.test(readFileSync(f, "utf8")));
  ok("settle-worker is UNREACHABLE from the HTTP surface (no route/http-core references it)", refsWorker.length === 0, refsWorker.join(", "));
  const r = await drive("POST", "/api/metering/netting/release", { body: {} });
  ok("no release-like path is handled by this surface", r.handled === false);
}

console.log("\nguards:");
{
  ok("quantities: GET only", (await drive("POST", "/api/metering/netting/quantities")).status === 405);
  ok("quantities: missing principal → 400", (await drive("GET", "/api/metering/netting/quantities", { query: "" })).status === 400);
  ok("commit: POST only", (await drive("GET", "/api/metering/close/commit")).status === 405);
  ok("commit: missing fields enumerated → 400", (await drive("POST", "/api/metering/close/commit", { body: { principal: BUYER } })).body?.required?.length >= 5);
  ok("commit: bad mode → 400", (await drive("POST", "/api/metering/close/commit", { body: { principal: BUYER, epoch: 0, mode: "steal", earnedMicroTrac: 0, carryMicroTrac: 0, buyerCountersignature: "x", sessionPublicKeyPem: "y" } })).body?.error === "E_BAD_FIELD");
  ok("rollover: missing closeDigest → 400", (await drive("POST", "/api/metering/close/rollover", { body: { principal: BUYER } })).status === 400);
  // Hermes wiring #1: coercible-but-wrong JSON types are REFUSED, never coerced
  const base = { principal: BUYER, mode: "rollover", earnedMicroTrac: 0, carryMicroTrac: 0, buyerCountersignature: "x", sessionPublicKeyPem: "y" };
  const badEpochs = [["string '0'", "0"], ["whitespace ' '", " "], ["boolean false", false], ["empty array", []], ["negative", -1], ["2^53", 2 ** 53], ["above protocol range", 5_000_000_000]];
  let refusedAll = true;
  for (const [label, v] of badEpochs) {
    const r = await drive("POST", "/api/metering/close/commit", { body: { ...base, epoch: v } });
    if (!(r.status === 400 && r.body?.error === "E_BAD_FIELD")) { refusedAll = false; console.log(`    ✗ epoch ${label} not refused:`, JSON.stringify(r)); }
  }
  ok("commit: '0' / ' ' / false / [] / negative / 2^53 / out-of-range epoch ALL refused (no coercion)", refusedAll);
  const badMicro = await drive("POST", "/api/metering/close/commit", { body: { ...base, epoch: 0, earnedMicroTrac: "5" } });
  ok("commit: string earnedMicroTrac refused", badMicro.status === 400);
}

console.log("\nsettle-gate — recorded economics only (principle 2):");
{
  const noCfg = await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` });
  ok("no recorded config → 503 fail-closed", noCfg.status === 503 && noCfg.body?.error === "E_NO_RECORDED_ECONOMICS");
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({
    feeGweiDecimal: "0.011", ethTracDecimal: "8000",
    recordedAt: "2026-08-12T08:00:00Z", source: "gate-suite reference sample",
  }));
  const withCfg = await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` });
  ok("recorded config → 200 with threshold + provenance echoed", withCfg.status === 200 && withCfg.body?.thresholdMicroTrac >= 6_089_000 && withCfg.body?.economics?.source, JSON.stringify(withCfg.body).slice(0, 140));
  ok("gate result carries the config DIGEST (TOCTOU binding for settlement)", String(withCfg.body?.economics?.configDigest ?? "").startsWith("sha256:"));
  const dig1 = withCfg.body.economics.configDigest;
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.012", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:10:00Z", source: "second sample" }));
  const withCfg2 = await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` });
  ok("changed config → changed digest (swap is detectable, not silent)", withCfg2.body?.economics?.configDigest !== dig1);
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.011", ethTracDecimal: "8000", recordedAt: "not-a-timestamp", source: "s" }));
  ok("unparseable recordedAt → 503 fail-closed (schema, not truthiness)", (await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` })).status === 503);
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.011", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "   " }));
  ok("blank source → 503 fail-closed", (await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` })).status === 503);
  const tamper = await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}&fee-gwei=0.0000001` });
  ok("caller-supplied fee/rate param → E_CALLER_ECONOMICS_REFUSED (never ignored)", tamper.status === 400 && tamper.body?.error === "E_CALLER_ECONOMICS_REFUSED");
  // a malformed recorded config also fails closed (frozen grammar validation)
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "01.0", ethTracDecimal: "8000", recordedAt: "t", source: "s" }));
  ok("non-canonical recorded config → 503 fail-closed", (await drive("GET", "/api/metering/netting/settle-gate", { query: `?principal=${BUYER}` })).status === 503);
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({
    feeGweiDecimal: "0.011", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "gate-suite reference sample",
  }));
}

console.log("\nclose/commit END-TO-END — routes cannot bypass in-mutation verification (principle 1):");
{
  // real funded flow: credit → bill → countersign with the session key
  L.credit(home, BUYER, 100, { chainId: 8453, token: "0xTRAC", txHash: "0xdep1", logIndex: 0 });
  const leg = L.recordInferenceLeg(home, { principal: BUYER, inputTokens: 5, outputTokens: 0, costMicroTrac: 10, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, requesterKeyRef: keyRefOf(pem(session.publicKey, "pub")) });
  const dg = "sha256:" + createHash("sha256").update(L.canonicalize(leg)).digest("hex");
  const csig = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  MR.countersignLeg({ home, leg, countersignature: csig, sessionPublicKeyPem: pem(session.publicKey, "pub") });

  const closeBody = { principal: BUYER, epoch: 0, mode: "rollover", earnedMicroTrac: 10, carryMicroTrac: 90 };
  const signWith = (keys) => edSign(null, Buffer.concat([Buffer.from(N.NSM_CLOSE_DOMAIN + "\n"), Buffer.from(N.closeBody(closeBody))]), createPrivateKey(pem(keys.privateKey, "priv"))).toString("base64");

  const badSig = await drive("POST", "/api/metering/close/commit", { body: { ...closeBody, buyerCountersignature: Buffer.from("garbage").toString("base64"), sessionPublicKeyPem: pem(session.publicKey, "pub") } });
  ok("HTTP commit with bad signature → 409 E_CLOSE_BAD_SIGNATURE", badSig.status === 409 && badSig.body?.code === "E_CLOSE_BAD_SIGNATURE");
  const foreignSig = await drive("POST", "/api/metering/close/commit", { body: { ...closeBody, buyerCountersignature: signWith(foreign), sessionPublicKeyPem: pem(foreign.publicKey, "pub") } });
  ok("HTTP commit with valid-but-foreign key → 409 E_CLOSE_FOREIGN_KEY", foreignSig.status === 409 && foreignSig.body?.code === "E_CLOSE_FOREIGN_KEY");
  const good = await drive("POST", "/api/metering/close/commit", { body: { ...closeBody, buyerCountersignature: signWith(session), sessionPublicKeyPem: pem(session.publicKey, "pub") } });
  ok("HTTP commit with the countersigner's key → 200 + closeDigest", good.status === 200 && String(good.body?.closeDigest ?? "").startsWith("sha256:"), JSON.stringify(good.body));
  const rival = await drive("POST", "/api/metering/close/commit", { body: { ...closeBody, buyerCountersignature: signWith(session), sessionPublicKeyPem: pem(session.publicKey, "pub") } });
  ok("HTTP rival close → 409 E_CLOSE_EPOCH_TAKEN", rival.status === 409 && rival.body?.code === "E_CLOSE_EPOCH_TAKEN");

  console.log("\nrollover END-TO-END + read-only invariants:");
  const roll = await drive("POST", "/api/metering/close/rollover", { body: { principal: BUYER, closeDigest: good.body.closeDigest } });
  ok("HTTP rollover applies carry into fresh epoch", roll.status === 200 && roll.body?.carriedMicroTrac === 90, JSON.stringify(roll.body));
  const replay = await drive("POST", "/api/metering/close/rollover", { body: { principal: BUYER, closeDigest: good.body.closeDigest } });
  ok("HTTP rollover replay → 409 (close-digest dedup)", replay.status === 409);

  const jb = journalBytes();
  const qy = await drive("GET", "/api/metering/netting/quantities", { query: `?principal=${BUYER}` });
  ok("quantities returns the frozen ledger view + I1 verdict", qy.status === 200 && qy.body?.conservation?.ok === true && qy.body?.quantities?.unsettledEarned === 10, JSON.stringify(qy.body?.quantities));
  ok("quantities + settle-gate are READ-ONLY (journal byte-identical)", journalBytes() === jb);

  console.log("\ncross-case principal resolution (Hermes wiring #2 — no split tabs):");
  const lower = BUYER.toLowerCase();
  const qLower = await drive("GET", "/api/metering/netting/quantities", { query: `?principal=${lower}` });
  ok("lowercased principal resolves to the SAME tab (identical quantities)", JSON.stringify(qLower.body) === JSON.stringify(qy.body));
  const rollLower = await drive("POST", "/api/metering/close/rollover", { body: { principal: lower, closeDigest: "sha256:" + "0".repeat(64) } });
  ok("case-variant mutation resolves to recorded form → 409 close-not-found conflict (NOT a fresh split tab)", rollLower.status === 409);
  // and the journal still contains exactly ONE case-form of the principal
  const forms = new Set(readFileSync(join(home, "metering", "read-journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).principal; } catch { return null; } }).filter((p) => p && String(p).toLowerCase() === lower));
  ok("journal holds exactly one case-form of the principal", forms.size === 1, JSON.stringify([...forms]));
  // Hermes wiring v2 #3: an ALREADY-SPLIT ledger (two case-forms in history)
  // must fail closed with E_PRINCIPAL_AMBIGUOUS — never silently pick a side.
  {
    const hSplit = mkdtempSync(join(tmpdir(), "netting-split-"));
    mkdirSync(join(hSplit, "metering"), { recursive: true });
    const J = join(hSplit, "metering", "read-journal.jsonl");
    writeFileSync(J, JSON.stringify({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 10, evidence: { chainId: 1, token: "0xT", txHash: "0xs1", logIndex: 0 } }) + "\n"
      + JSON.stringify({ kind: "credit", principal: BUYER.toLowerCase(), epoch: 0, amountMicroTrac: 10, evidence: { chainId: 1, token: "0xT", txHash: "0xs2", logIndex: 0 } }) + "\n");
    const io = { captured: {}, json(s, b) { this.captured = { s, b }; }, readBody: async () => "" };
    await R.handleNetting({ method: "GET", path: "/api/metering/netting/quantities", home: hSplit, query: `?principal=${BUYER}` }, io);
    ok("pre-split ledger → 409 E_PRINCIPAL_AMBIGUOUS (fail closed, no side silently chosen)",
      io.captured.s === 409 && io.captured.b?.error === "E_PRINCIPAL_AMBIGUOUS", JSON.stringify(io.captured));
  }
}

console.log("\nsettlement reachability (OpenClaw v4 confirmables — structural, not asserted):");
{
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const p = join(dir, e); const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p); } return out; };
  // (1)+(2): settlement has NO HTTP path. Nothing in the HTTP-reachable surface
  // (routes/*, handle-request, the http-cores) may import or call settleTab OR
  // recordNettedSettlement — both are loopback settlement-script territory,
  // exactly like recordEarnedRelease.
  const httpSurface = [...walk(join(dist, "routes")), join(dist, "handle-request.js"), join(dist, "metering/netting-http-core.js"), join(dist, "metering/infer-http-core.js"), join(dist, "metering/metering-http-core.js")].filter((f) => { try { statSync(f); return true; } catch { return false; } });
  const usesSettle = (src) => /import\s*{[^}]*\b(settleTab|recordNettedSettlement)\b/.test(src) || /\b(settleTab|recordNettedSettlement)\s*\(/.test(src);
  const offenders2 = httpSurface.filter((f) => usesSettle(readFileSync(f, "utf8")));
  ok("settleTab/recordNettedSettlement reachable from NO HTTP-surface module (routes, handle-request, http-cores)", offenders2.length === 0, offenders2.join(", "));
  const rs = await drive("POST", "/api/metering/netting/settle", { body: {} });
  ok("no settlement-like path is handled by this surface", rs.handled === false);
  // (3): expectedConfigDigest is MANDATORY on the netted-settlement mutation:
  // omitting it refuses BEFORE any state change even with valid authority.
  writeFileSync(join(home, "metering", "release-authority.token"), "routes-suite-authority");
  const jb2 = readFileSync(join(home, "metering", "read-journal.jsonl")).length;
  const noDigest = N.recordNettedSettlement(home, { principal: BUYER, withdrawalId: "wd:nodigest", txHash: "0xnodigest", netPaidMicroTrac: 1, closes: [], authorityToken: "routes-suite-authority" });
  ok("recordNettedSettlement WITHOUT expectedConfigDigest → economics refusal, zero journal writes",
    noDigest.ok === false && (noDigest.code === "E_ECONOMICS_CHANGED" || noDigest.code === "E_ECONOMICS_ABSENT") && readFileSync(join(home, "metering", "read-journal.jsonl")).length === jb2, JSON.stringify(noDigest));
}

console.log(`\n${pass}/${pass + fail} netting-route gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
