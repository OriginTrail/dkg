// HTTP-route gates for POST /api/metering/infer.
//
// stage-3 taught us a unit gate cannot see a missing/miswired route (a correct
// core still 404s if nobody mounts it). These drive the real route handler with
// a real RequestContext + mock req/res, and additionally assert the built daemon
// imports AND calls it in the dispatch chain.
import { Readable } from "node:stream";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "infer-route-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const R = await import(join(dist, "routes/metered-infer.js"));
const IM = await import(join(dist, "metering/inference-meter.js"));
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

// deterministic stub tokenizer (byte-round-tripping)
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " "];
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

writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
// the route reads its meter config from disk — enforce this buyer
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

// ── a mock RequestContext driver ──
const drive = async (method, bodyObj, { noChain = false } = {}) => {
  const req = Readable.from([Buffer.from(bodyObj === undefined ? "" : JSON.stringify(bodyObj))]);
  req.method = method;
  const captured = { status: 0, body: null };
  const res = {
    writableEnded: false,
    writeHead(s) { captured.status = s; return this; },
    end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } },
    setHeader() {},
  };
  const ctx = {
    req, res, path: "/api/metering/infer",
    config: noChain ? {} : { chain: { chainId: CHAIN } }, network: null,
  };
  await R.handleMeteredInferRoutes(ctx);
  return captured;
};

const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const body = (over = {}) => ({
  delegation: signDeleg(), bindingProof: proof,
  revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 },
  messages: [{ role: "user", content: "the cat" }], ...over,
});

// a backend that "serves" a fixed completion for the fixed prompt
const goodBackend = {
  async serve() {
    const prompt = "the cat", completion = "sat on mat";
    return {
      model: { renderedPrompt: prompt, inputTokenIds: tokenizer.encode(prompt), deliveredCompletion: completion, outputTokenIds: tokenizer.encode(completion), model: MODEL, requestCanonical: { messages: [{ role: "user", content: prompt }] }, finishReason: "stop", stopBoundary: { kind: "eos" } },
      tokenizer, specialTokenIds: [1000],
      backendManifestDigest: MODEL.backendManifestDigest,
      tokenizerBundleDigest: MODEL.tokenizer.bundleDigest,
    };
  },
};

console.log("\nPOST /api/metering/infer — route gates\n");

console.log("dispatch wiring (the stage-3 regression class):");
{
  const hr = join(dist, "handle-request.js");
  const src = existsSync(hr) ? readFileSync(hr, "utf8") : "";
  ok("the built daemon imports the infer route", src.includes("handleMeteredInferRoutes"));
  ok("the built daemon CALLS it in the dispatch chain", /await\s+handleMeteredInferRoutes\s*\(/.test(src));
}

console.log("\nguards:");
ok("GET is 405", (await drive("GET", body())).status === 405);
ok("no chain configured → 503 E_CHAIN_UNRESOLVED", (await drive("POST", body(), { noChain: true })).body?.error === "E_CHAIN_UNRESOLVED");
ok("missing delegation → 400", (await drive("POST", { messages: [] })).status === 400);
ok("missing messages → 400", (await drive("POST", { delegation: signDeleg() })).status === 400);

console.log("\nno backend wired:");
R.setInferenceBackend(null);
{
  const r = await drive("POST", body());
  ok("no backend → 503 E_NO_MODEL_BACKEND (never a self-billed no-op)", r.status === 503 && r.body?.error === "E_NO_MODEL_BACKEND");
  ok("inferenceBackendConfigured() reports false", R.inferenceBackendConfigured() === false);
}

console.log("\nserve failure is a 502, not a billing/auth error:");
R.setInferenceBackend({ async serve() { throw new Error("cuda oom"); } });
{
  const r = await drive("POST", body());
  ok("a failed generation → 502 E_MODEL_SERVE_FAILED", r.status === 502 && r.body?.error === "E_MODEL_SERVE_FAILED");
  ok("nothing was billed on serve failure", L.balance(home, BUYER).balance === 0);
}

console.log("\nlive metered call:");
// fund the tab
const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
const art = D.buildOpeningArtifact(BUYER, terms); D.registerOpening(home, art);
D.creditDeposit(home, { txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 }, art, D.evaluateDeposit({ txHash: "0xd", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 }, art));
R.setInferenceBackend(goodBackend);
{
  const r = await drive("POST", body());
  const expect = 2 * tokenizer.encode("the cat").length + 6 * tokenizer.encode("sat on mat").length;
  ok("a served inference returns 200 and the completion", r.status === 200 && r.body?.completion === "sat on mat", JSON.stringify(r).slice(0, 200));
  ok("it billed 2·in + 6·out", r.body?.metering?.billed === true && r.body?.metering?.costMicroTrac === expect);
  ok("the leg is legType=inference, pending countersignature", r.body?.metering?.leg?.legType === "inference" && r.body?.metering?.leg?.settlement?.status === "pending-countersignature");
  ok("balance debited on the ledger by exactly the cost", L.balance(home, BUYER).balance === 1_000_000 - expect);
}

console.log(`\n${pass}/${pass + fail} metered-infer-route gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
