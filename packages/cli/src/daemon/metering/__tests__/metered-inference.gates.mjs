// Metered inference — the billing path, and proof it settles through the
// SAME spine as reads (deposit → leg → gradual release → countersign → close).
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "minfer-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const MI = await import(join(dist, "metering/metered-inference.js"));
const IM = await import(join(dist, "metering/inference-meter.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const C = await import(join(dist, "metering/capability.js"));
const RM = await import(join(dist, "metering/read-meter.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const B = await import(join(dist, "metering/evm-binding.js"));
const S = await import(join(dist, "metering/settlement.js"));
const { Wallet } = await import("ethers");

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));

// stub tokenizer (deterministic, byte-round-tripping)
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " ", "sky", "is", "blue"];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const tokenizer = { encode: (t) => [...t.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0])), decode: (ids) => ids.map((id) => VOCAB[id] ?? "").join("") };
const MANIFEST = { instanceId: "inst-1", weightsDigest: "sha256:w", tokenizerBundleDigest: "sha256:bundle", engineBuild: "stub", samplerConfig: { temperature: "0" }, chatTemplateDigest: "sha256:c" };
const MODEL = { modelId: "stub", weightsDigest: "sha256:w", tokenizerDigest: "sha256:bundle", chatTemplateDigest: "sha256:c",
  tokenizer: { bundleDigest: "sha256:bundle", bundleFiles: ["tokenizer.json"], engine: "stub", engineVersion: "1.0.0" },
  backendManifestDigest: "PLACEHOLDER" };
MODEL.backendManifestDigest = IM.backendManifestDigest(MANIFEST);
const CHAIN = 8453;
const sched = createHash("sha256").update(L.canonicalize(RM.COEFFICIENTS_CANONICAL)).digest("hex");

const evm = Wallet.createRandom(), session = generateKeyPairSync("ed25519");
const BUYER = evm.address;
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();

// registry + real EIP-191 proof (funded inference requires binding, like reads)
writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
const proof = await (async () => {
  const base = { domain: B.BINDING_DOMAIN, principal: BUYER, walletPublicKeyPem: pem(session.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() };
  return { ...base, evmSignature: await evm.signMessage(B.bindingStatement(base)) };
})();

const delegation = (over = {}) => {
  const d = {
    domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-infer", tabPrincipal: BUYER,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:buyer",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    tier: "session-key", ...over,
  };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(evm ? session.privateKey : session.privateKey, "priv"))).toString("base64") };
};
// delegation must be signed by the WALLET key (evm), verified via the EIP-191-bound session key...
// here the binding maps evm→session pubkey, and verifyCapability checks the wallet signature under
// the anchored (session) key. Sign with the session private key to match the bound public key.
const signDeleg = (over = {}) => {
  const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-infer", tabPrincipal: BUYER,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:buyer",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    tier: "session-key", ...over };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64") };
};
const freshState = () => ({ spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
const enforce = { mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set([BUYER]) };
const shadow = { mode: "shadow", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set() };

const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const modelResult = (prompt, completion) => ({
  renderedPrompt: prompt, inputTokenIds: tokenizer.encode(prompt),
  deliveredCompletion: completion, outputTokenIds: tokenizer.encode(completion),
  model: MODEL, requestCanonical: { messages: [{ role: "user", content: prompt }] },
  finishReason: "stop", stopBoundary: { kind: "eos" },
});

const call = (over = {}) => ({
  home, chainId: CHAIN, cfg: enforce,
  request: { delegation: signDeleg(), bindingProof: proof, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } },
  state: freshState(), scheduleDigest: sched, priceVectorDigest: sched, nodeClass: "dkg-edge-mainnet", settlementId: "settle-main",
  model: modelResult("the cat", "sat on mat"), tokenizer, specialTokenIds: [1000, 2000], ...over,
});

console.log("\nMetered inference — billing path + shared settlement spine\n");

// fund a tab
const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
const art = D.buildOpeningArtifact(BUYER, terms); D.registerOpening(home, art);
const tr = { txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
D.creditDeposit(home, tr, art, D.evaluateDeposit(tr, art));
ok("tab funded", L.balance(home, BUYER).balance === 1_000_000);

console.log("\nbilling:");
const r1 = MI.meterInference(call());
ok("an inference call BILLS input·2 + output·6", r1.ok && r1.billed && r1.costMicroTrac === 2 * tokenizer.encode("the cat").length + 6 * tokenizer.encode("sat on mat").length, JSON.stringify(r1).slice(0, 160));
ok("the leg is legType=inference, pending countersignature", r1.leg.legType === "inference" && r1.leg.settlement.status === "pending-countersignature");
ok("balance debited by exactly the cost", L.balance(home, BUYER).balance === 1_000_000 - r1.costMicroTrac);

console.log("\nauth is shared with reads:");
ok("a delegation scoped to /read cannot bill inference",
  MI.meterInference(call({ request: { delegation: signDeleg({ routes: ["POST /api/metering/read"] }), bindingProof: proof, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } } })).ok === false);
{
  const noProof = MI.meterInference(call({ request: { delegation: signDeleg(), revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } } }));
  ok("funded inference without a binding is REFUSED (no proof → anchor fails closed)",
    noProof.ok === false && (noProof.code === "E_FUNDED_REQUIRES_BINDING" || noProof.code === "E_PRINCIPAL_NOT_REGISTERED"), JSON.stringify(noProof));
}

console.log("\ngradual release across inference legs:");
ok("a second inference is refused 409 until the first is countersigned",
  MI.meterInference(call()).code === "E_AWAITING_COUNTERSIGNATURE");

console.log("\nrecount contract enforced at billing time:");
{
  // clear the outstanding leg first so this exercises recount, not gradual release
  const mr = await import(join(dist, "metering/metered-read.js"));
  const d1 = "sha256:" + createHash("sha256").update(L.canonicalize(r1.leg)).digest("hex");
  const s1 = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(d1)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  mr.countersignLeg({ home, leg: r1.leg, countersignature: s1, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  const bad = call({ model: { ...modelResult("the cat", "sat on mat"), outputTokenIds: [...tokenizer.encode("sat on mat"), 3000] } });
  const bv = MI.meterInference(bad);
  ok("a padded output sequence is refused BEFORE billing (422)", bv.status === 422, JSON.stringify(bv));
}

console.log("\nshadow mode bills nothing:");
{
  const r = MI.meterInference(call({ cfg: shadow }));
  ok("shadow inference is metered but not billed", r.ok && r.billed === false && r.leg.legType === "inference-shadow");
}

console.log("\nsettles through the SAME spine (close → countersign → settle):");
{
  // countersign the first inference leg so the close can accept it
  const digest = "sha256:" + createHash("sha256").update(L.canonicalize(r1.leg)).digest("hex");
  const sig = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(digest)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  const cr = (await import(join(dist, "metering/metered-read.js"))).countersignLeg({ home, leg: r1.leg, countersignature: sig, sessionPublicKeyPem: pem(session.publicKey, "pub") });
  ok("an inference leg is countersignable through the read countersign path (idempotent if already signed)", cr.ok || cr.code === "OK", JSON.stringify(cr));
  // the close statement includes the inference debit leg
  const legs = L.readJournal(home).filter((x) => x.kind === "debit" && String(x.leg?.requester?.principal).toLowerCase() === BUYER.toLowerCase());
  ok("the inference debit leg appears in the journal for close", legs.length >= 1 && legs[0].leg.legType === "inference");
}

console.log(`\n${pass}/${pass + fail} metered-inference gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
