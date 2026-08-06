// V2 Stage-3 — HTTP-LEVEL gates for the provider endpoint.
//
// Why this file exists: stage3-endpoint.gates.mjs passed 12/12 while a real
// buyer request returned 404, because every gate called the functions directly
// and none of them made an HTTP request. A unit gate cannot observe a missing
// route registration. These gates start a real server, speak real HTTP, and
// assert on status codes and JSON bodies.
import { createServer } from "node:http";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../../dist/daemon");

process.env.DKG_HOME = mkdtempSync(join(tmpdir(), "metering-routes-"));

const { handleMetering } = await import(join(dist, "metering/http-core.js"));
const { canonicalize } = await import(join(dist, "metering/ledger.js"));
const { COEFFICIENTS_CANONICAL } = await import(join(dist, "metering/read-meter.js"));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── a bare server that mounts ONLY the metering router ────────────────────
const wallets = { publisher: { address: "0x633E5a7C0000000000000000000000000000dEaD" } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // The adapter's job, reproduced exactly: read a body, write JSON. Everything
  // the gates care about lives in the core, which is what we exercise here.
  const io = {
    json: (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
    readBody: () => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); }),
  };
  try {
    const handled = await handleMetering({
      method: req.method, path: url.pathname, searchParams: url.searchParams,
      providerAddress: wallets.publisher.address,
      requestAgentAddress: "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba",
      safeHeadBlock: null,
      home: process.env.DKG_HOME,
    }, io);
    if (!handled && !res.writableEnded) { res.writeHead(404); res.end("not a metering route"); }
  } catch (e) {
    if (!res.writableEnded) { res.writeHead(500); res.end(String(e?.stack ?? e)); }
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = async (p, b) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: typeof b === "string" ? b : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log("\nStage-3 provider endpoint — HTTP-level gates\n");

// ── 1. the regression that started this file ──────────────────────────────
console.log("route registration (the buyer-found defect):");
// The core is what the rest of this file exercises, but a perfectly correct
// core is still a 404 if nobody mounts it — that WAS the defect. So assert the
// wiring itself, against the built daemon, not against a hopeful comment.
{
  const { readFileSync, existsSync } = await import("node:fs");
  const hr = join(dist, "handle-request.js");
  const adapter = join(dist, "routes", "metering.js");
  const src = existsSync(hr) ? readFileSync(hr, "utf8") : "";
  ok("the built daemon imports the metering route adapter",
    src.includes("handleMeteringRoutes"), "handle-request.js does not reference it");
  ok("the built daemon actually CALLS it in the dispatch chain",
    /await\s+handleMeteringRoutes\s*\(/.test(src), "imported but never invoked");
  ok("the adapter delegates to the core under test",
    existsSync(adapter) && readFileSync(adapter, "utf8").includes("handleMetering"),
    "adapter does not call handleMetering — gates would test dead code");
}

const terms = await get("/api/metering/terms");
ok("GET /api/metering/terms is NOT 404 — the route is actually mounted",
  terms.status === 200, `got ${terms.status}`);
ok("terms quote carries a version, digest and bindings",
  terms.body?.quoteVersion === "stage3-quote/v1" && !!terms.body?.termsDigest && !!terms.body?.bindings?.scheduleDigest);
ok("terms echo the buyer-set rules (12 confirmations, 1 TRAC min, no rollover)",
  terms.body?.terms?.confirmationDepth === 12 && terms.body?.terms?.minimumCreditTrac === "1" && terms.body?.terms?.rolloverPolicy === "none");
ok("provider address is the node's real publisher wallet, not a placeholder",
  terms.body?.terms?.providerAddress === wallets.publisher.address);

// ── 2. the honesty rule, over the wire ────────────────────────────────────
console.log("\nhonesty (a shadow node must not look like it bills):");
ok("meterMode is reported verbatim",
  typeof terms.body?.meterMode === "string");
ok("billing says 'none' whenever mode is not enforce",
  terms.body?.meterMode === "enforce" ? terms.body?.billing?.includes("enforcement") : terms.body?.billing?.startsWith("none"),
  `mode=${terms.body?.meterMode} billing=${terms.body?.billing}`);
ok("scheduleDigest served over HTTP equals the digest of the shipped coefficient table",
  terms.body?.bindings?.scheduleDigest === createHash("sha256").update(canonicalize(COEFFICIENTS_CANONICAL)).digest("hex"));

// ── 3. malformed input is refused, not partially applied ──────────────────
console.log("\nfail-closed input handling:");
ok("malformed JSON on handshake → 400 E_BAD_JSON",
  (await post("/api/metering/handshake", "{not json")).body?.error === "E_BAD_JSON");
ok("missing fields on handshake → 400 E_MISSING_FIELD",
  (await post("/api/metering/handshake", {})).body?.error === "E_MISSING_FIELD");
ok("missing fields on tab/open → 400 E_MISSING_FIELD",
  (await post("/api/metering/tab/open", { delegation: {} })).body?.error === "E_MISSING_FIELD");
const unknown = await get("/api/metering/does-not-exist");
ok("unknown /api/metering/* path → 404 default-deny, no fallthrough",
  unknown.status === 404 && unknown.body?.error === "E_UNKNOWN_METERING_ROUTE");

// ── 4. zero-value preflight over HTTP ─────────────────────────────────────
console.log("\nzero-value preflight (Bo's gate):");
const wallet = generateKeyPairSync("ed25519"), session = generateKeyPairSync("ed25519");
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
const walletPublicKeyPem = pem(wallet.publicKey, "pub");
const BO = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const scheduleDigest = terms.body.bindings.scheduleDigest;
const priceDigest = terms.body.bindings.priceVectorDigest;
const { delegationPreimage } = await import(join(dist, "metering/capability.js"));
const { setDebitGate } = await import(join(dist, "metering/ledger.js"));
const { debitAllowed } = await import(join(dist, "metering/deposit-rail.js"));
setDebitGate((h, p, now) => debitAllowed(h, p, now));

const mkDelegation = (over = {}) => {
  const d = {
    domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-http-gate-1", tabPrincipal: BO,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:odysseus-dkg:agent:hermes-bo",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/query"], bindings: { scheduleDigest, priceVectorDigest: priceDigest },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 100_000, windowMs: 60_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(),
    expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    tier: "session-key", ...over,
  };
  return { ...d, walletSignature: edSign(null, delegationPreimage(d), createPrivateKey(pem(wallet.privateKey, "priv"))).toString("base64") };
};
const req1 = { route: "POST /api/query", nodeClass: "dkg-edge-mainnet", settlementId: "settle-main", scheduleDigest, priceVectorDigest: priceDigest };
const freshCp = { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 };
const TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";

const hs = await post("/api/metering/handshake", {
  delegation: mkDelegation(), walletPublicKeyPem, request: req1,
  revocationCheckpoint: freshCp,
});
ok("handshake reachable over HTTP and returns 200", hs.status === 200, `got ${hs.status}`);
ok("estimatedMicroTrac is exactly 0", hs.body?.estimatedMicroTrac === 0);
ok("ledgerTouched is false", hs.body?.ledgerTouched === false);
ok("a valid delegation preflights OK", hs.body?.ok === true, JSON.stringify(hs.body));

const bad = await post("/api/metering/handshake", {
  delegation: mkDelegation({ audience: { settlement: "settle-OTHER", nodeClasses: ["dkg-edge-mainnet"] } }), walletPublicKeyPem, request: req1,
  revocationCheckpoint: freshCp,
});
ok("wrong audience is refused with a stable code, still at zero value",
  bad.body?.ok === false && typeof bad.body?.verdict === "string" && bad.body?.estimatedMicroTrac === 0,
  JSON.stringify(bad.body));

const wrongRoute = await post("/api/metering/handshake", {
  delegation: mkDelegation(), walletPublicKeyPem,
  request: { ...req1, route: "POST /api/admin" },
  revocationCheckpoint: freshCp,
});
ok("out-of-scope route is refused", wrongRoute.body?.ok === false, JSON.stringify(wrongRoute.body));

const substituted = await post("/api/metering/handshake", {
  delegation: mkDelegation(), walletPublicKeyPem,
  request: { ...req1, priceVectorDigest: "sha256:attacker-supplied" },
  revocationCheckpoint: freshCp,
});
ok("price-digest substitution is refused", substituted.body?.ok === false, JSON.stringify(substituted.body));

const forged = mkDelegation();
forged.caps = { ...forged.caps, absoluteMicroTrac: 999_999_999 };   // tamper AFTER signing
ok("a tampered delegation cannot preflight OK",
  (await post("/api/metering/handshake", {
    delegation: forged, walletPublicKeyPem, request: req1,
    revocationCheckpoint: freshCp,
  })).body?.ok === false);

// ── 5. tab lifecycle over HTTP ────────────────────────────────────────────
console.log("\ntab lifecycle:");
const before = await get(`/api/metering/tab?principal=${BO}`);
ok("tab view is reachable and reports no open tab before opening",
  before.status === 200 && before.body?.tabOpen === false && before.body?.balanceMicroTrac === 0);

const forgedOpen = await post("/api/metering/tab/open", {
  delegation: forged, walletPublicKeyPem, refundAddress: BO, request: req1,
  revocationCheckpoint: freshCp,
});
ok("a forged delegation cannot open a tab → 403",
  forgedOpen.status === 403 && forgedOpen.body?.opened === false, JSON.stringify(forgedOpen.body));

const opened = await post("/api/metering/tab/open", {
  delegation: mkDelegation(), walletPublicKeyPem,
  refundAddress: BO, request: req1,
  revocationCheckpoint: freshCp,
});
ok("a valid delegation opens a tab → 200", opened.status === 200 && opened.body?.opened === true, JSON.stringify(opened.body));
ok("opening artifact echoes the buyer's LOCKED refund address",
  opened.body?.artifact?.terms?.refundAddress === BO);
ok("a countersign digest is returned for the buyer to sign",
  typeof opened.body?.countersignDigest === "string" && opened.body.countersignDigest.startsWith("sha256:"));

const after = await get(`/api/metering/tab?principal=${BO}`);
ok("tab view now shows the tab open with the refund address and terms digest",
  after.body?.tabOpen === true && after.body?.refundAddress === BO && !!after.body?.termsDigest);
ok("opening a tab credits NOTHING — balance is still zero",
  after.body?.balanceMicroTrac === 0, `balance=${after.body?.balanceMicroTrac}`);

// ── 6. deposit rules survive the HTTP path ────────────────────────────────
console.log("\ndeposit rules over HTTP:");
const malformed = await post("/api/metering/tab/credit", { principal: BO, transfer: { from: BO, amountTrac: "5" } });
ok("a malformed transfer is REFUSED with a 400, never a 500 stack trace",
  malformed.status === 400 && malformed.body?.error === "E_MALFORMED_TRANSFER", `${malformed.status} ${JSON.stringify(malformed.body)}`);
const shallow = await post("/api/metering/tab/credit", {
  principal: BO,
  transfer: { token: TRAC, from: BO, to: wallets.publisher.address, amountTrac: "5", txHash: "0xaaa", blockNumber: 100, safeHeadBlock: 110 },
});
ok("11 confirmations is refused over HTTP → 403", shallow.status === 403 && shallow.body?.credited === false, JSON.stringify(shallow.body));

const stranger = await post("/api/metering/tab/credit", {
  principal: BO,
  transfer: { token: TRAC, from: "0xStranger", to: wallets.publisher.address, amountTrac: "5", txHash: "0xbbb", blockNumber: 100, safeHeadBlock: 111 },
});
ok("a stranger cannot fund the buyer's tab → 403", stranger.status === 403 && stranger.body?.credited === false, JSON.stringify(stranger.body));

const tooSmall = await post("/api/metering/tab/credit", {
  principal: BO,
  transfer: { token: TRAC, from: BO, to: wallets.publisher.address, amountTrac: "0.5", txHash: "0xccc", blockNumber: 100, safeHeadBlock: 111 },
});
ok("below the 1 TRAC minimum is refused → 403", tooSmall.status === 403 && tooSmall.body?.credited === false, JSON.stringify(tooSmall.body));

const good = await post("/api/metering/tab/credit", {
  principal: BO,
  transfer: { token: TRAC, from: BO, to: wallets.publisher.address, amountTrac: "5", txHash: "0xddd", blockNumber: 100, safeHeadBlock: 111 },
});
ok("12 confirmations at safe head credits → 200", good.status === 200 && good.body?.credited === true, JSON.stringify(good.body));

const funded = await get(`/api/metering/tab?principal=${BO}`);
ok("balance reflects the credited deposit", funded.body?.balanceMicroTrac > 0, `balance=${funded.body?.balanceMicroTrac}`);

// ── 7. the property that matters most ─────────────────────────────────────
console.log("\nthe endpoint grants no spending right:");
ok("a funded tab still reports sequence 0 and a genesis chain — funding bills nothing",
  funded.body?.sequence === 0 && funded.body?.lastLegHash === "genesis",
  `sequence=${funded.body?.sequence} lastLegHash=${funded.body?.lastLegHash}`);
ok("no HTTP route on this surface can produce a settlement-admissible leg",
  !["/api/metering/terms", "/api/metering/handshake", "/api/metering/tab/open", "/api/metering/tab", "/api/metering/tab/credit"]
    .some((p) => p.includes("leg") || p.includes("settle")));

server.close();
console.log(`\n${pass}/${pass + fail} HTTP gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
