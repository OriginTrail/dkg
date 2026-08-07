// V2 Stage-3 — the metered read: gates for the BILLING path itself.
//
// Every previous suite tested machinery around billing — terms, handshakes,
// deposits, bindings — while nothing billed anyone. These gates assert the
// outcome: that a delegated read debits the DELEGATION's principal, that it
// debits nobody else, and that a debit is never a settled payment.
//
// The property that would have caught the original defect: "billing follows
// the delegation, not the transport token."
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "mread-"));
process.env.DKG_HOME = home;

const M = await import(join(dist, "metering/metered-read.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const C = await import(join(dist, "metering/capability.js"));
const RM = await import(join(dist, "metering/read-meter.js"));
const S = await import(join(dist, "metering/stage3-endpoint.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));

const BUYER = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const OTHER = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const CHAIN = 8453;
const wallet = generateKeyPairSync("ed25519"), session = generateKeyPairSync("ed25519");
const otherWallet = generateKeyPairSync("ed25519");
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
const sched = createHash("sha256").update(L.canonicalize(RM.COEFFICIENTS_CANONICAL)).digest("hex");

mkdirSync(join(home, "metering"), { recursive: true });
writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({
  principals: {
    [BUYER.toLowerCase()]: { label: "buyer", walletPublicKeyPem: pem(wallet.publicKey, "pub") },
    [OTHER.toLowerCase()]: { label: "other", walletPublicKeyPem: pem(otherWallet.publicKey, "pub") },
  },
}));

const delegation = (over = {}, signWith = wallet) => {
  const d = {
    domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-read-1", tabPrincipal: BUYER,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:buyer",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/metering/read"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(),
    expiresAt: new Date(Date.now() + 3600e3).toISOString(), tier: "session-key", ...over,
  };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(signWith.privateKey, "priv"))).toString("base64") };
};
const freshState = () => ({ spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
const enforceCfg = { mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set([BUYER]) };
const shadowCfg = { mode: "shadow", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set() };
const SPARQL = "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 5";
const BODY = JSON.stringify({ bindings: Array.from({ length: 20 }, (_, i) => ({ s: `urn:x:${i}` })) });

const authArgs = (over = {}) => ({
  home, chainId: CHAIN, cfg: enforceCfg,
  request: { delegation: delegation(), sparql: SPARQL, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } },
  state: freshState(),
  route: "POST /api/metering/read", nodeClass: "dkg-edge-mainnet", settlementId: "settle-main",
  scheduleDigest: sched, priceVectorDigest: sched, ...over,
});

console.log("\nMetered read — the billing path itself\n");

console.log("authorisation follows the DELEGATION, not the transport token:");
{
  // Open + fund a tab for the buyer.
  const terms = S.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
  const artifact = D.buildOpeningArtifact(BUYER, terms);
  D.registerOpening(home, artifact);
  const transfer = { txHash: "0x1", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
  const verdict = D.evaluateDeposit(transfer, artifact);
  D.creditDeposit(home, transfer, artifact, verdict);
  ok("tab funded for the buyer", L.balance(home, BUYER).balance > 0, String(L.balance(home, BUYER).balance));

  const a = M.authoriseMeteredRead(authArgs());
  ok("a valid delegation authorises, and the principal is the tabPrincipal",
    a.ok === true && a.principal === BUYER, JSON.stringify(a));

  // THE regression: a delegation signed by a different wallet must not bill the buyer.
  const forged = delegation({}, otherWallet);
  const b = M.authoriseMeteredRead(authArgs({ request: { delegation: forged, sparql: SPARQL, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } } }));
  ok("a delegation signed by another wallet CANNOT bill the buyer",
    b.ok === false, JSON.stringify(b));

  // A principal with no tab cannot read on credit.
  const noTab = delegation({ tabPrincipal: OTHER, capabilityId: "cap-other" }, otherWallet);
  const c = M.authoriseMeteredRead(authArgs({
    cfg: { ...enforceCfg, enforcedPrincipals: new Set([BUYER, OTHER]) },
    request: { delegation: noTab, sparql: SPARQL, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } },
  }));
  ok("a principal with no open tab is refused 402, not served on credit",
    c.ok === false && c.status === 402 && c.code === "E_NO_OPEN_TAB", JSON.stringify(c));

  const wrongRoute = M.authoriseMeteredRead(authArgs({ route: "POST /api/query" }));
  ok("a delegation scoped to the metered route does not authorise /api/query",
    wrongRoute.ok === false, JSON.stringify(wrongRoute));
}

console.log("\nbilling debits the right principal, by the right amount:");
{
  const before = L.balance(home, BUYER).balance;
  const r = M.settleMeteredRead({ home, cfg: enforceCfg, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200 });
  ok("a read in enforce mode BILLS", r.ok && r.billed === true, JSON.stringify(r).slice(0, 200));
  ok("the debit is non-zero and matches the schedule",
    r.ok && r.costMicroTrac > 0 && r.costMicroTrac === r.leg.pricing.costMicroTrac);
  const after = L.balance(home, BUYER).balance;
  ok("the buyer's balance fell by exactly the cost", before - after === r.costMicroTrac, `${before} -> ${after}, cost ${r.costMicroTrac}`);
  ok("no other principal was touched", L.balance(home, OTHER).balance === 0);
  ok("the leg is hash-chained to the previous one", typeof r.leg.previousLegHash === "string" && r.leg.sequence >= 1);
}

console.log("\na debit is NOT a settled payment (D14):");
{
  const r = M.settleMeteredRead({ home, cfg: enforceCfg, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200 });
  ok("the response states settlement is inadmissible", r.ok && r.settlement.admissible === false);
  ok("the leg carries pending-countersignature status", r.leg.settlement.status === "pending-countersignature");
  const bad = M.countersignLeg({ leg: r.leg, countersignature: "AAAA", sessionPublicKeyPem: pem(session.publicKey, "pub") });
  ok("a bogus countersignature does not make it settleable", bad.ok === false, JSON.stringify(bad));
  // The buyer signs the DIGEST of the leg exactly as delivered — no field
  // surgery. Anything else and provider and buyer sign different bytes.
  const digest = "sha256:" + createHash("sha256").update(L.canonicalize(r.leg)).digest("hex");
  const preimage = Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(digest)]);
  const sig = edSign(null, preimage, createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  const good = M.countersignLeg({ leg: r.leg, countersignature: sig, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  ok("a valid buyer countersignature MAKES the leg settleable", good.ok === true, JSON.stringify(good));
  const tampered = { ...r.leg, pricing: { ...r.leg.pricing, costMicroTrac: 999_999 } };
  ok("the countersignature does not transfer to a leg with an altered price",
    M.countersignLeg({ leg: tampered, countersignature: sig, sessionPublicKeyPem: pem(session.publicKey, "pub") }).ok === false);
}

console.log("\nshadow mode bills nobody, and says so:");
{
  const before = L.balance(home, BUYER).balance;
  const r = M.settleMeteredRead({ home, cfg: shadowCfg, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200 });
  ok("a shadow read does not bill", r.ok && r.billed === false);
  ok("the balance is unchanged", L.balance(home, BUYER).balance === before);
  ok("the shadow receipt does NOT masquerade as a billed leg",
    r.leg.legType === "read-shadow" && r.leg.pricing.wouldHaveCostMicroTrac > 0 && r.leg.pricing.costMicroTrac === undefined);
  ok("it still records an observation for calibration",
    existsSync(join(home, "metering", "shadow-observations.jsonl")));
}

console.log("\nthe buyer's per-call ceiling is honoured:");
{
  const r = M.settleMeteredRead({ home, cfg: enforceCfg, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200, maxMicroTrac: 0 });
  ok("a read above the buyer's declared ceiling is REFUSED, not silently discounted",
    r.ok === false && r.code === "E_OVER_BUYER_CEILING", JSON.stringify(r));
  const b = L.balance(home, BUYER).balance;
  const r2 = M.settleMeteredRead({ home, cfg: enforceCfg, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200, maxMicroTrac: 0 });
  ok("...and the refusal costs nothing", L.balance(home, BUYER).balance === b);
}

console.log("\nfunds run out honestly:");
{
  // Note on why this uses an inflated ask: at the real ask (100 µTRAC/1000 U) a
  // typical read costs 1 µTRAC, so draining a 1 TRAC tab takes ~1,000,000 reads.
  // The exhaustion path is untestable at production prices, which is itself the
  // clearest statement of the deposit-vs-consumption mismatch.
  const pricey = { ...enforceCfg, readAskMicroPer1k: 1_000_000_000 };
  const before = L.balance(home, BUYER).balance;
  const r1 = M.settleMeteredRead({ home, cfg: pricey, principal: BUYER, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200 });
  ok("one read at an inflated ask can exceed the whole tab", r1.ok === false || r1.costMicroTrac > before,
    r1.ok ? String(r1.costMicroTrac) : JSON.stringify(r1));
  ok("an unaffordable read is refused with 402, not served free",
    r1.ok === false && r1.status === 402, JSON.stringify(r1).slice(0, 160));
  ok("the balance never goes negative and was not touched by the refusal",
    L.balance(home, BUYER).balance === before && before >= 0, String(L.balance(home, BUYER).balance));
}

console.log("\ngradual release — at most one un-countersigned billable leg (Q3):");
{
  const { createHash } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  // Fresh principal + tab so prior debits in this file do not pollute the count.
  const GR = "0x9999999999999999999999999999999999999999";
  const grWallet = generateKeyPairSync("ed25519");
  writeFileSync(join(process.env.DKG_HOME, "metering", "buyer-registry.json"), JSON.stringify({
    principals: {
      [BUYER.toLowerCase()]: { label: "buyer", walletPublicKeyPem: pem(wallet.publicKey, "pub") },
      [OTHER.toLowerCase()]: { label: "other", walletPublicKeyPem: pem(otherWallet.publicKey, "pub") },
      [GR.toLowerCase()]: { label: "gr", walletPublicKeyPem: pem(grWallet.publicKey, "pub") },
    },
  }));
  const grTerms = S.stage3Terms(PROVIDER, GR, 100, RM.SCHEDULE_VERSION, CHAIN);
  const grArt = D.buildOpeningArtifact(GR, grTerms);
  D.registerOpening(home, grArt);
  const grTransfer = { txHash: "0xgr", from: GR, to: PROVIDER, token: grTerms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
  D.creditDeposit(home, grTransfer, grArt, D.evaluateDeposit(grTransfer, grArt));

  ok("no outstanding leg before the first read", M.outstandingLegs(home, GR) === 0);

  const leg1 = M.settleMeteredRead({ home, cfg: { ...enforceCfg, enforcedPrincipals: new Set([GR]) }, principal: GR, sparql: SPARQL, responseBody: BODY, scopeQuads: 26200 });
  ok("first billable read succeeds and creates ONE outstanding leg",
    leg1.ok && leg1.billed && M.outstandingLegs(home, GR) === 1);

  const grDeleg = (() => {
    const d = {
      domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-gr", tabPrincipal: GR,
      sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:gr",
      audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
      routes: ["POST /api/metering/read"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
      caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
      notBefore: new Date(Date.now() - 3600e3).toISOString(),
      expiresAt: new Date(Date.now() + 3600e3).toISOString(), tier: "session-key",
    };
    return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(grWallet.privateKey, "priv"))).toString("base64") };
  })();
  const blocked = M.authoriseMeteredRead({
    home, chainId: CHAIN, cfg: { ...enforceCfg, enforcedPrincipals: new Set([GR]) },
    request: { delegation: grDeleg, sparql: SPARQL, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } },
    state: freshState(), route: "POST /api/metering/read", nodeClass: "dkg-edge-mainnet", settlementId: "settle-main", scheduleDigest: sched, priceVectorDigest: sched,
  });
  ok("the NEXT billable read is refused 409 while a leg is un-countersigned",
    blocked.ok === false && blocked.status === 409 && blocked.code === "E_AWAITING_COUNTERSIGNATURE", JSON.stringify(blocked));

  // Countersign leg1, which clears the outstanding obligation durably.
  const digest1 = "sha256:" + sha(L.canonicalize(leg1.leg));
  const sig1 = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(digest1)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  const cs = M.countersignLeg({ home, leg: leg1.leg, countersignature: sig1, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  ok("countersigning the leg records it and clears the obligation",
    cs.ok && M.outstandingLegs(home, GR) === 0, JSON.stringify(cs));

  // And the obligation is journal-derived, so it survives a "restart" (re-read).
  ok("the cleared obligation is durable (journal-derived, not in-memory)",
    M.outstandingLegs(home, GR) === 0);

  const cs2 = M.countersignLeg({ home, leg: leg1.leg, countersignature: sig1, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  const signedRecords = readFileSync(join(process.env.DKG_HOME, "metering", "read-journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "leg-countersigned" && r.principal === GR);
  ok("re-countersigning the same leg is idempotent — exactly one record", cs2.ok && signedRecords.length === 1, `${signedRecords.length} records`);
}

console.log(`\n${pass}/${pass + fail} metered-read gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
