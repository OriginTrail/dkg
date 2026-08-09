// Odysseus backend client — gates against a MOCK sidecar (a real HTTP server).
// The property that matters: the recount is adversarial to the sidecar's own
// generation. If the sidecar generates a padded/non-canonical output sequence
// but its /encode returns the canonical tokenization of the delivered bytes,
// meterInference must REJECT — the node never bills the sidecar's claim.
import { createServer } from "node:http";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "ody-backend-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const OB = await import(join(dist, "metering/odysseus-backend.js"));
const MI = await import(join(dist, "metering/metered-inference.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const C = await import(join(dist, "metering/capability.js"));
const RM = await import(join(dist, "metering/read-meter.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const B = await import(join(dist, "metering/evm-binding.js"));
const { Wallet } = await import("ethers");

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));

// The sidecar's tokenizer (stub, but the CANONICAL authority for /encode).
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " "];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const encode = (t) => [...t.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0]));
const CHAIN = 8453;
const sched = createHash("sha256").update(L.canonicalize(RM.COEFFICIENTS_CANONICAL)).digest("hex");
const MODEL = { modelId: "Qwen/Qwen2.5-1.5B-Instruct", weightsDigest: "sha256:w", tokenizerDigest: "sha256:t", chatTemplateDigest: "sha256:c" };

// ── a mock sidecar. `mode` lets a gate make it misbehave. ──
let mode = "honest";
const server = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const body = JSON.parse(b || "{}");
  const j = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/serve") {
    if (mode === "500") return j(500, { error: "cuda oom" });
    const prompt = "the cat", completion = "sat on mat";
    const outIds = encode(completion);
    // In "padded" mode the sidecar GENERATES a non-canonical sequence (an extra
    // token) while delivering the same bytes — the attack the recount must catch.
    const generated = mode === "padded" ? [...outIds, outIds[outIds.length - 1]] : outIds;
    return j(200, { renderedPrompt: prompt, deliveredCompletion: completion, inputTokenIds: encode(prompt), outputTokenIds: generated });
  }
  if (req.url === "/encode") return j(200, { ids: encode(String(body.text ?? "")) }); // always CANONICAL
  return j(404, { error: "no route" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const backend = OB.makeOdysseusBackend({ baseUrl, model: MODEL, specialTokenIds: [151645] });

// ── funded, enforced tab so a good call actually bills ──
const evm = Wallet.createRandom(), session = generateKeyPairSync("ed25519");
const BUYER = evm.address;
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
const proof = await (async () => {
  const x = { domain: B.BINDING_DOMAIN, principal: BUYER, walletPublicKeyPem: pem(session.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() };
  return { ...x, evmSignature: await evm.signMessage(B.bindingStatement(x)) };
})();
const signDeleg = () => {
  const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-i", tabPrincipal: BUYER,
    sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:b",
    audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
    routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
    caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
    notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), tier: "session-key" };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64") };
};
const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
const art = D.buildOpeningArtifact(BUYER, terms); D.registerOpening(home, art);
const tr = { txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
D.creditDeposit(home, tr, art, D.evaluateDeposit(tr, art));
const enforce = { mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set([BUYER]) };
const state = () => ({ spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
const meter = async () => {
  const served = await backend.serve({ messages: [{ role: "user", content: "the cat" }], principal: BUYER });
  return MI.meterInference({
    home, chainId: CHAIN, cfg: enforce,
    request: { delegation: signDeleg(), bindingProof: proof, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } },
    state: state(), scheduleDigest: sched, priceVectorDigest: sched, nodeClass: "dkg-edge-mainnet", settlementId: "settle-main",
    model: served.model, tokenizer: served.tokenizer, specialTokenIds: served.specialTokenIds,
  });
};

console.log("\nOdysseus backend client — mock sidecar gates\n");

console.log("honest serve → bills through meterInference:");
{
  mode = "honest";
  const r = await meter();
  const expect = 2 * encode("the cat").length + 6 * encode("sat on mat").length;
  ok("an honest served call bills 2·in+6·out", r.ok && r.billed && r.costMicroTrac === expect, JSON.stringify(r).slice(0, 160));
  ok("ledger debited by exactly the cost", L.balance(home, BUYER).balance === 1_000_000 - expect);
  // clear the outstanding leg so later gates exercise recount, not gradual release
  const mr = await import(join(dist, "metering/metered-read.js"));
  const dg = "sha256:" + createHash("sha256").update(L.canonicalize(r.leg)).digest("hex");
  const sg = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  mr.countersignLeg({ home, leg: r.leg, countersignature: sg, sessionPublicKeyPem: pem(session.publicKey, "pub") });
}

console.log("\nthe sidecar cannot bill a non-canonical generation:");
{
  mode = "padded";
  const before = L.balance(home, BUYER).balance;
  const r = await meter();
  ok("a padded generation is REJECTED at billing (422)", r.ok === false && r.status === 422 && r.code === "E_RECOUNT_OUTPUT_SEQ", JSON.stringify(r));
  ok("nothing was billed for the rejected call", L.balance(home, BUYER).balance === before);
}

console.log("\nsidecar transport faults surface as sidecar errors:");
{
  mode = "500";
  let threw = null; try { await backend.serve({ messages: [{ role: "user", content: "x" }], principal: BUYER }); } catch (e) { threw = String(e.message); }
  ok("a 500 from /serve throws E_SIDECAR_500 (not a silent bill)", threw?.startsWith("E_SIDECAR_500"), String(threw));
}

console.log("\nreplay tokenizer fails loud on an unexpected input:");
{
  mode = "honest";
  const served = await backend.serve({ messages: [{ role: "user", content: "the cat" }], principal: BUYER });
  let threw = null; try { served.tokenizer.encode("a string the recount would never ask for"); } catch (e) { threw = String(e.message); }
  ok("replay tokenizer throws E_TOKENIZER_REPLAY_MISS on unknown text", threw === "E_TOKENIZER_REPLAY_MISS", String(threw));
  ok("it DOES answer the two strings the recount re-encodes", JSON.stringify(served.tokenizer.encode("the cat")) === JSON.stringify(encode("the cat")));
}

server.close();
console.log(`\n${pass}/${pass + fail} odysseus-backend gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
