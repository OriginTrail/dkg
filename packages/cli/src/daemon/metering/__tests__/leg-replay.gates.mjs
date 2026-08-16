// Gates for POST /api/metering/leg/replay — buyer-authenticated, read-only
// recovery of a served inference leg's exact delivered bytes + the full signed
// leg (Bo, epoch-2 seq-1 recovery: the buyer lost its copy of the completion
// after a first verify rejected it under the wrong leg domain, so it could
// neither countersign nor withhold, and the close exposes only hash/seq/cost).
//
// The contract this proves:
//  • replay returns the byte-identical signed leg from the journal (unblocks a
//    lost-artifact withhold, which needs the full leg) AND re-serves to recover
//    the exact delivered bytes, proven against the leg's serve-time-signed digest;
//  • it BILLS NOTHING and mutates NO ledger state (no debit, no sequence advance);
//  • a buyer can run the real recount from ONLY the replay output + its own
//    tokenizer bundle, and then countersign — i.e. the sale becomes settleable;
//  • it is not a free-inference oracle: bytes that don't match the committed
//    digest are REFUSED, so a caller only ever gets back the one completion it
//    already paid for.
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "leg-replay-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const R = await import(join(dist, "metering/infer-http-core.js"));
const IM = await import(join(dist, "metering/inference-meter.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const C = await import(join(dist, "metering/capability.js"));
const RM = await import(join(dist, "metering/read-meter.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const MR = await import(join(dist, "metering/metered-read.js"));
const B = await import(join(dist, "metering/evm-binding.js"));
const { Wallet } = await import("ethers");

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));

// deterministic byte-round-tripping stub tokenizer
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " "];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const tokenizer = { encode: (t) => [...t.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0])), decode: (ids) => ids.map((id) => VOCAB[id] ?? "").join("") };
const MANIFEST = { instanceId: "inst-1", weightsDigest: "sha256:w", tokenizerBundleDigest: "sha256:bundle", engineBuild: "stub", samplerConfig: { temperature: "0" }, chatTemplateDigest: "sha256:c" };
const MODEL = { modelId: "stub", weightsDigest: "sha256:w", tokenizerDigest: "sha256:bundle", chatTemplateDigest: "sha256:c",
  tokenizer: { bundleDigest: "sha256:bundle", bundleFiles: ["tokenizer.json"], engine: "stub", engineVersion: "1.0.0" },
  backendManifestDigest: "PLACEHOLDER", backendManifest: MANIFEST };
MODEL.backendManifestDigest = IM.backendManifestDigest(MANIFEST);
const CHAIN = 8453;
const sched = createHash("sha256").update(L.canonicalize(RM.COEFFICIENTS_CANONICAL)).digest("hex");

const evm = Wallet.createRandom(), session = generateKeyPairSync("ed25519");
const BUYER = evm.address;
const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();

writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
writeFileSync(join(home, "metering", "meter-config.json"), JSON.stringify({ mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: [], enforcedPrincipals: [BUYER] }));
const proof = await (async () => {
  const b = { domain: B.BINDING_DOMAIN, principal: BUYER, walletPublicKeyPem: pem(session.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() };
  return { ...b, evmSignature: await evm.signMessage(B.bindingStatement(b)) };
})();
const signDeleg = (over = {}) => {
  const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-r", tabPrincipal: BUYER,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:b",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    tier: "session-key", ...over };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64") };
};

// The exact request the buyer will re-supply at replay time.
const PROMPT = "the cat", COMPLETION = "sat on mat";
let serveCalls = 0;
const goodBackend = {
  async serve() {
    serveCalls++;
    return {
      model: { renderedPrompt: PROMPT, inputTokenIds: tokenizer.encode(PROMPT), deliveredCompletion: COMPLETION, outputTokenIds: tokenizer.encode(COMPLETION), model: MODEL, requestCanonical: { messages: [{ role: "user", content: PROMPT }] }, finishReason: "stop", stopBoundary: { kind: "eos" } },
      tokenizer, specialTokenIds: [1000],
      backendManifestDigest: MODEL.backendManifestDigest,
      tokenizerBundleDigest: MODEL.tokenizer.bundleDigest,
    };
  },
};

const drive = async (method, path, bodyObj) => {
  const captured = { status: 0, body: null };
  const io = { json: (s, b) => { captured.status = s; captured.body = b; }, readBody: async () => (bodyObj === undefined ? "" : JSON.stringify(bodyObj)) };
  await R.handleInfer({ method, path, chainId: CHAIN, home }, io);
  return captured;
};
const inferBody = (over = {}) => ({ delegation: signDeleg(), bindingProof: proof, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 }, messages: [{ role: "user", content: PROMPT }], ...over });
const replayReq = { messages: [{ role: "user", content: PROMPT }], delegation: signDeleg() };
const journalBytes = () => { const f = join(home, "metering", "read-journal.jsonl"); return existsSync(f) ? readFileSync(f).length : 0; };

console.log("\nPOST /api/metering/leg/replay — buyer-authenticated leg recovery\n");

// ── fund the tab and produce ONE real billed inference leg (this is "seq 1") ──
R.setInferenceBackend(goodBackend);
const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
const art = D.buildOpeningArtifact(BUYER, terms); D.registerOpening(home, art);
D.creditDeposit(home, { txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 }, art, D.evaluateDeposit({ txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 }, art));
const served = await drive("POST", "/api/metering/infer", inferBody());
ok("setup: a real inference leg was billed at sequence 1", served.status === 200 && served.body?.metering?.leg?.sequence === 1, JSON.stringify(served).slice(0, 160));
const billedLeg = served.body.metering.leg;

console.log("\nguards:");
ok("GET is 405", (await drive("GET", "/api/metering/leg/replay", replayReq)).status === 405);
ok("missing principal/sequence → 400", (await drive("POST", "/api/metering/leg/replay", { request: replayReq })).status === 400);
ok("missing request.messages → 400", (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, request: {} })).status === 400);
ok("unknown sequence → 404 E_LEG_NOT_FOUND", (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 99, request: replayReq })).body?.error === "E_LEG_NOT_FOUND");
ok("non-integer epoch → 400 E_BAD_FIELD", (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, epoch: "x", request: replayReq })).body?.error === "E_BAD_FIELD");

console.log("\nepoch disambiguation — sequence resets per epoch, so epoch MUST select:");
{
  // A fresh principal's first credit opens epoch 0, so the served leg is epoch 0.
  const legEpoch = Number(billedLeg.tabEpoch);
  ok("legBySequence(seq 1, correct epoch) finds the leg", L.legBySequence(home, BUYER, 1, legEpoch)?.tabEpoch === legEpoch);
  ok("legBySequence(seq 1, wrong epoch) finds NOTHING", L.legBySequence(home, BUYER, 1, legEpoch + 5) === null);
  ok("replay for a non-existent epoch → 404 (never a wrong-epoch leg)",
    (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, epoch: legEpoch + 5, request: replayReq })).body?.error === "E_LEG_NOT_FOUND");
  ok("replay pinned to the correct epoch → 200", (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, epoch: legEpoch, request: replayReq })).status === 200);
}

console.log("\nno backend wired → 503 (never a silent empty recovery):");
R.setInferenceBackend(null);
ok("no backend → 503 E_NO_MODEL_BACKEND", (await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, request: replayReq })).body?.error === "E_NO_MODEL_BACKEND");
R.setInferenceBackend(goodBackend);

console.log("\nthe happy recovery — bytes + full signed leg, proven, read-only:");
let replay;
{
  const balBefore = L.balance(home, BUYER).balance;
  const bytesBefore = journalBytes();
  const seqBefore = billedLeg.sequence;
  const callsBefore = serveCalls;
  replay = await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, request: replayReq });
  ok("200 with reproduced=true", replay.status === 200 && replay.body?.reproduced === true, JSON.stringify(replay).slice(0, 200));
  ok("it re-served the model exactly once", serveCalls === callsBefore + 1);
  ok("returns the delivered completion bytes", replay.body?.deliveredCompletion === COMPLETION);
  ok("the returned bytes hash to the leg's serve-time-signed digest",
    "sha256:" + createHash("sha256").update(Buffer.from(replay.body.deliveredCompletion, "utf8")).digest("hex") === billedLeg.evidence.deliveredResponseBytesDigest);
  ok("returns the FULL signed leg (unblocks a lost-artifact withhold)",
    replay.body?.leg?.legType === "inference" && typeof replay.body?.leg?.providerSignature === "string");
  ok("the returned leg is byte-identical to the journal's signed leg",
    L.canonicalize(replay.body.leg) === L.canonicalize(L.legBySequence(home, BUYER, 1)));
  ok("it names the leg-signature domain the buyer must verify under", replay.body?.legDomain === "odysseus-dkg:read-leg:v0.3");

  // READ-ONLY: no debit, no sequence advance, no journal growth.
  ok("balance unchanged — replay bills nothing", L.balance(home, BUYER).balance === balBefore);
  ok("no new leg — sequence did not advance", L.legBySequence(home, BUYER, 2) === null && L.legBySequence(home, BUYER, 1).sequence === seqBefore);
  ok("no byte appended to the durable journal", journalBytes() === bytesBefore);
}

console.log("\nthe payoff: a buyer recounts from ONLY the replay output, then countersigns:");
{
  // Exactly what Bo does: verify the provider signature under the named domain,
  // then run the independent recount from the returned bytes + his own bundle.
  const leg = replay.body.leg;
  const preimage = Buffer.concat([Buffer.from(replay.body.legDomain + "\n"), Buffer.from(L.canonicalize((({ providerSignature, ...l }) => l)(leg)))]);
  // provider signature verifies under the named domain against the provider key
  const { createPublicKey, verify: edVerify } = await import("node:crypto");
  const provPub = createPublicKey(replay.body.providerPublicKeyPem);
  ok("the provider signature over the leg verifies under the named domain",
    edVerify(null, preimage, provPub, Buffer.from(leg.providerSignature, "base64")));

  const verdict = IM.verifyInferenceRecount({
    tokenizer, renderedPrompt: replay.body.renderedPrompt, deliveredCompletion: replay.body.deliveredCompletion,
    evidence: leg.evidence, specialTokenIds: [1000],
    expectedTokenizerBundleDigest: MODEL.tokenizer.bundleDigest,
    expectedBackendManifestDigest: MODEL.backendManifestDigest,
  });
  ok("the independent receipt-v0.6 recount PASSES on the recovered artifacts", verdict.ok === true, JSON.stringify(verdict));

  // and now the leg is countersignable — the sale becomes settleable.
  const dg = "sha256:" + createHash("sha256").update(L.canonicalize(leg)).digest("hex");
  const csig = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  const cs = MR.countersignLeg({ home, leg, countersignature: csig, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  ok("the recovered leg countersigns (accepted → settlement-admissible)", cs && (cs.ok === true || cs.accepted === true || cs.countersigned === true), JSON.stringify(cs).slice(0, 160));
}

console.log("\nnot a free-inference oracle: non-matching bytes are refused, never returned:");
{
  R.setInferenceBackend({ async serve() { serveCalls++; return { model: { renderedPrompt: PROMPT, inputTokenIds: tokenizer.encode(PROMPT), deliveredCompletion: "a DIFFERENT completion", outputTokenIds: tokenizer.encode("a DIFFERENT completion"), model: MODEL, requestCanonical: {}, finishReason: "stop", stopBoundary: { kind: "eos" } }, tokenizer, specialTokenIds: [1000], backendManifestDigest: MODEL.backendManifestDigest, tokenizerBundleDigest: MODEL.tokenizer.bundleDigest }; } });
  const r = await drive("POST", "/api/metering/leg/replay", { principal: BUYER, sequence: 1, request: replayReq });
  ok("bytes ≠ committed digest → 409 E_REPLAY_NONDETERMINISTIC", r.status === 409 && r.body?.error === "E_REPLAY_NONDETERMINISTIC", JSON.stringify(r).slice(0, 200));
  ok("the refusal returns NO completion bytes", r.body?.deliveredCompletion === undefined);
  R.setInferenceBackend(goodBackend);
}

console.log(`\n${pass}/${pass + fail} leg-replay gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
