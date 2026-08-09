// Gate I0 — operator backend wiring (routes/metered-infer.ts adapter).
//
// The claim under test, exactly as promised to Bo (event f7a40bb0): wiring a
// model backend is CONFIG in the adapter, outside METERING_MODULE_MANIFEST, so
// the audited build pin does not move; absent config keeps the route 503; a
// malformed config NEVER produces a half-wired billing surface.
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "infer-wiring-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const R = await import(join(dist, "routes/metered-infer.js"));
const IM = await import(join(dist, "metering/inference-meter.js"));
const A = await import(join(dist, "metering/build-attestation.js"));
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

// ── mock sidecar: honest, manifest-consistent, canonical /encode ────────────
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " "];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const encode = (t) => [...t.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0]));
const BUNDLE_DIGEST = "sha256:" + "ab".repeat(32);   // parser requires exactly 64 hex
const manifest = { instanceId: "wire-1", weightsDigest: "sha256:w", tokenizerBundleDigest: BUNDLE_DIGEST, engineBuild: "stub", samplerConfig: { temperature: "0" }, chatTemplateDigest: "sha256:c" };
const sidecar = createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const body = JSON.parse(b || "{}");
  const j = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/manifest") return j(200, { ...manifest, manifestDigest: IM.backendManifestDigest(manifest) });
  if (req.url === "/serve") {
    const prompt = "the cat", completion = "sat on mat";
    return j(200, { renderedPrompt: prompt, deliveredCompletion: completion, inputTokenIds: encode(prompt), outputTokenIds: encode(completion), finishReason: "stop", manifestDigest: IM.backendManifestDigest(manifest), tokenizerBundleFiles: ["t.json"], tokenizerEngine: "stub", tokenizerEngineVersion: "1" });
  }
  if (req.url === "/encode") return j(200, { ids: encode(String(body.text ?? "")) });
  if (req.url === "/decode") return j(200, { text: (body.ids ?? []).map((id) => VOCAB[id] ?? "").join("") });
  return j(404, {});
});
await new Promise((r) => sidecar.listen(0, "127.0.0.1", r));
const sidecarUrl = `http://127.0.0.1:${sidecar.address().port}`;

// ── funded, enforced buyer so a wired call can actually bill ────────────────
const CHAIN = 8453;
const sched = createHash("sha256").update(L.canonicalize(RM.COEFFICIENTS_CANONICAL)).digest("hex");
const evm = Wallet.createRandom(), session = generateKeyPairSync("ed25519");
const BUYER = evm.address;
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
writeFileSync(join(home, "metering", "meter-config.json"), JSON.stringify({ mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: [], enforcedPrincipals: [BUYER] }));
const proof = await (async () => {
  const x = { domain: B.BINDING_DOMAIN, principal: BUYER, walletPublicKeyPem: pem(session.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() };
  return { ...x, evmSignature: await evm.signMessage(B.bindingStatement(x)) };
})();
const signDeleg = () => {
  const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-w", tabPrincipal: BUYER,
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
const tr = { txHash: "0xw", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
D.creditDeposit(home, tr, art, D.evaluateDeposit(tr, art));

const drive = async (method, path, bodyObj) => {
  const req = Readable.from([Buffer.from(bodyObj === undefined ? "" : JSON.stringify(bodyObj))]);
  req.method = method;
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(s) { captured.status = s; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  await R.handleMeteredInferRoutes({ req, res, path, config: { chain: { chainId: CHAIN } }, network: null });
  return captured;
};
const inferBody = () => ({
  delegation: signDeleg(), bindingProof: proof,
  revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 },
  messages: [{ role: "user", content: "the cat" }], maxTokens: 64,
});
const CONFIG_PATH = join(home, "metering", "inference-backend.json");

console.log("\nGate I0 — operator backend wiring (adapter, outside the pin)\n");

console.log("the pin promise:");
{
  ok("the wiring file is OUTSIDE metering-artifact/v1 (routes/, not metering/)",
    !A.METERING_MODULE_MANIFEST.includes("metered-infer.js"));
  // The pin value changes whenever an IN-MANIFEST module changes (e.g. the
  // tab-epoch fix to ledger.js). What must stay true is that WIRING files are
  // OUTSIDE the manifest, so wiring never moves the pin — asserted above. Here we
  // only confirm the attestation is complete and self-consistent, not a frozen value.
  const att2 = A.buildAttestation({ dir: join(dist, "metering") });
  ok("the repo dist attests complete + coherent (wiring is outside the pinned set)",
    att2.complete === true && att2.unexpectedModules.length === 0 && att2.buildDigest.startsWith("sha256:"), att2.buildDigest);
}

console.log("\nabsent config — behaviour identical to before this commit:");
{
  const r = await drive("POST", "/api/metering/infer", inferBody());
  ok("no config file → 503 E_NO_MODEL_BACKEND", r.status === 503 && r.body?.error === "E_NO_MODEL_BACKEND", JSON.stringify(r).slice(0, 120));
  ok("wiring status reports unconfigured, no rejection", R.inferenceWiringStatus().configured === false);
}

console.log("\nmalformed configs NEVER produce a half-wired billing surface:");
{
  writeFileSync(CONFIG_PATH, "{ this is not json");
  const r = await drive("POST", "/api/metering/infer", inferBody());
  ok("unparseable config → still 503, no crash", r.status === 503 && r.body?.error === "E_NO_MODEL_BACKEND");
  ok("...and the rejection reason is recorded", typeof R.inferenceWiringStatus().rejectedReason === "string");
}

console.log("\nvalid config wires the backend and it BILLS end-to-end:");
{
  // NOTE: config is parsed once per process; these gates re-import the adapter
  // with a fresh module registry to simulate the restart an operator would do.
  const R2 = await import(join(dist, "routes/metered-infer.js") + `?fresh=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    baseUrl: sidecarUrl, modelId: "stub/wired",
    specialTokenIdRanges: [[1000, 1001]],
    expectedTokenizerBundleDigest: BUNDLE_DIGEST,
  }));
  const drive2 = async (method, path, bodyObj) => {
    const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))]); req.method = method;
    const captured = { status: 0, body: null };
    const res = { writableEnded: false, writeHead(s) { captured.status = s; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
    await R2.handleMeteredInferRoutes({ req, res, path, config: { chain: { chainId: CHAIN } }, network: null });
    return captured;
  };
  const r = await drive2("POST", "/api/metering/infer", inferBody());
  const expect = 2 * encode("the cat").length + 6 * encode("sat on mat").length;
  ok("a wired call serves and BILLS through the audited core", r.status === 200 && r.body?.metering?.billed === true && r.body?.metering?.costMicroTrac === expect, JSON.stringify(r).slice(0, 200));
  ok("the leg binds the sidecar's manifest and the provider build",
    typeof r.body?.metering?.leg?.evidence?.model?.backendManifestDigest === "string" &&
    typeof r.body?.metering?.leg?.evidence?.providerBuild?.buildDigest === "string");
  ok("wiring status reports configured", R2.inferenceWiringStatus().configured === true);
  // countersign the billed leg so gradual release cannot mask later sections
  const mr = await import(join(dist, "metering/metered-read.js"));
  const leg = r.body.metering.leg;
  const dg = "sha256:" + createHash("sha256").update(L.canonicalize(leg)).digest("hex");
  const sg = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64");
  mr.countersignLeg({ home, leg, countersignature: sg, sessionPublicKeyPem: pem(session.publicKey, "pub") });
}

console.log("\nrejected config classes (each must stay 503):");
const REJECTS = [
  ["non-loopback baseUrl (G4)", { baseUrl: "http://10.0.0.5:9312", modelId: "m", specialTokenIdRanges: [[1, 2]], expectedTokenizerBundleDigest: "sha256:" + "ef".repeat(32) }],
  ["missing tokenizer bundle pin", { baseUrl: sidecarUrl, modelId: "m", specialTokenIdRanges: [[1, 2]] }],
  ["empty special-token ranges", { baseUrl: sidecarUrl, modelId: "m", specialTokenIdRanges: [], expectedTokenizerBundleDigest: "sha256:" + "ef".repeat(32) }],
  ["missing modelId", { baseUrl: sidecarUrl, specialTokenIdRanges: [[1, 2]], expectedTokenizerBundleDigest: "sha256:" + "ef".repeat(32) }],
];
for (const [name, cfg] of REJECTS) {
  // the backend global lives in the SHARED core — unwire it so the fresh
  // adapter instance actually parses (and rejects) the config under test
  R.setInferenceBackend(null);
  const R3 = await import(join(dist, "routes/metered-infer.js") + `?rej=${encodeURIComponent(name)}-${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  const req = Readable.from([Buffer.from(JSON.stringify(inferBody()))]); req.method = "POST";
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(s) { captured.status = s; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  await R3.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
  ok(`${name} → rejected, route stays 503`, captured.status === 503 && typeof R3.inferenceWiringStatus().rejectedReason === "string", `status=${captured.status} reason=${R3.inferenceWiringStatus().rejectedReason}`);
}

console.log("\na sidecar whose bundle drifts from the config pin cannot serve:");
{
  R.setInferenceBackend(null);
  const R4 = await import(join(dist, "routes/metered-infer.js") + `?drift=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: sidecarUrl, modelId: "m", specialTokenIdRanges: [[1000, 1001]], expectedTokenizerBundleDigest: "sha256:" + "cd".repeat(32) }));
  const req = Readable.from([Buffer.from(JSON.stringify(inferBody()))]); req.method = "POST";
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(s) { captured.status = s; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  await R4.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
  ok("bundle drift → 502 E_MODEL_SERVE_FAILED (E_TOKENIZER_BUNDLE_DRIFT), nothing billed",
    captured.status === 502 && String(captured.body?.detail ?? "").includes("E_TOKENIZER_BUNDLE_DRIFT"), JSON.stringify(captured).slice(0, 160));
}

console.log("\ntransport hardening (Bo's I0 requirements, 71f17798):");
{
  // redirect defense: a sidecar answering 302 to an external host must be a
  // hard failure, never followed.
  const evil = createServer((req, res) => { res.writeHead(302, { location: "http://93.184.216.34/exfil" }); res.end(); });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  R.setInferenceBackend(null);
  const R5 = await import(join(dist, "routes/metered-infer.js") + `?redir=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: `http://127.0.0.1:${evil.address().port}`, modelId: "m", specialTokenIdRanges: [[1000, 1001]], expectedTokenizerBundleDigest: BUNDLE_DIGEST, timeoutMs: 3000 }));
  const req = Readable.from([Buffer.from(JSON.stringify(inferBody()))]); req.method = "POST";
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(st) { captured.status = st; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  const bytesBefore = L.balance(home, BUYER).balance;
  await R5.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
  ok("a redirecting sidecar is a hard 502, never followed (SSRF defense)", captured.status === 502, JSON.stringify(captured).slice(0, 140));
  ok("nothing billed on the redirect refusal", L.balance(home, BUYER).balance === bytesBefore);
  evil.close();
}
{
  // hung sidecar → timeout → 502, never a wedge
  const hang = createServer(() => { /* never responds */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  R.setInferenceBackend(null);
  const R6 = await import(join(dist, "routes/metered-infer.js") + `?hang=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: `http://127.0.0.1:${hang.address().port}`, modelId: "m", specialTokenIdRanges: [[1000, 1001]], expectedTokenizerBundleDigest: BUNDLE_DIGEST, timeoutMs: 1000 }));
  const req = Readable.from([Buffer.from(JSON.stringify(inferBody()))]); req.method = "POST";
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(st) { captured.status = st; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  const t0 = Date.now();
  await R6.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
  ok("a hung sidecar times out to 502 within the configured bound", captured.status === 502 && Date.now() - t0 < 5000, `status=${captured.status} in ${Date.now() - t0}ms`);
  hang.close();
}
{
  // concurrency cap: with maxConcurrent=1 and a slow sidecar, the second
  // simultaneous call fails fast E_BACKEND_BUSY instead of queueing.
  const slow = createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const j = (st, o) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/manifest") return j(200, { ...manifest, manifestDigest: IM.backendManifestDigest(manifest) });
    if (req.url === "/serve") {
      await new Promise((r) => setTimeout(r, 800));
      const prompt = "the cat", completion = "sat on mat";
      return j(200, { renderedPrompt: prompt, deliveredCompletion: completion, inputTokenIds: encode(prompt), outputTokenIds: encode(completion), finishReason: "stop", manifestDigest: IM.backendManifestDigest(manifest), tokenizerBundleFiles: ["t.json"], tokenizerEngine: "stub", tokenizerEngineVersion: "1" });
    }
    if (req.url === "/encode") return j(200, { ids: encode(String(JSON.parse(b || "{}").text ?? "")) });
    if (req.url === "/decode") return j(200, { text: ((JSON.parse(b || "{}").ids) ?? []).map((id) => VOCAB[id] ?? "").join("") });
    return j(404, {});
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  R.setInferenceBackend(null);
  const R7 = await import(join(dist, "routes/metered-infer.js") + `?conc=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: `http://127.0.0.1:${slow.address().port}`, modelId: "m", specialTokenIdRanges: [[1000, 1001]], expectedTokenizerBundleDigest: BUNDLE_DIGEST, maxConcurrent: 1, timeoutMs: 10000 }));
  const fire = async () => {
    const req = Readable.from([Buffer.from(JSON.stringify(inferBody()))]); req.method = "POST";
    const captured = { status: 0, body: null };
    const res = { writableEnded: false, writeHead(st) { captured.status = st; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
    await R7.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
    return captured;
  };
  const [a, b2] = await Promise.all([fire(), fire()]);
  const statuses = [a.status, b2.status].sort();
  const busy = [a, b2].find((x) => x.status === 502 && String(x.body?.detail ?? "").includes("E_BACKEND_BUSY"));
  ok("under a concurrency cap of 1, the second simultaneous call fails fast E_BACKEND_BUSY", busy !== undefined, `statuses=${statuses} bodies=${JSON.stringify([a.body?.detail, b2.body?.detail]).slice(0, 120)}`);
  slow.close();
}

console.log("\nBo's live-attack precondition, offline: enforced-but-UNFUNDED rejects with no ledger side effect:");
{
  // A second buyer: registered, EIP-191-bound, ENFORCED — but no tab was ever
  // opened or funded. The call must refuse without creating a charge, a leg, or
  // any residual claim.
  const evm2 = Wallet.createRandom(), session2 = generateKeyPairSync("ed25519");
  const BUYER2 = evm2.address;
  writeFileSync(join(home, "metering", "meter-config.json"), JSON.stringify({ mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: [], enforcedPrincipals: [BUYER, BUYER2] }));
  const proof2 = await (async () => {
    const x = { domain: B.BINDING_DOMAIN, principal: BUYER2, walletPublicKeyPem: pem(session2.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() };
    return { ...x, evmSignature: await evm2.signMessage(B.bindingStatement(x)) };
  })();
  const deleg2 = (() => {
    const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-uf", tabPrincipal: BUYER2,
      sessionPublicKeyPem: pem(session2.publicKey, "pub"), agentUrn: "urn:b2",
      audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] },
      routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: sched, priceVectorDigest: sched },
      caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 },
      notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), tier: "session-key" };
    return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(session2.privateKey, "priv"))).toString("base64") };
  })();
  R.setInferenceBackend(null);
  const R8 = await import(join(dist, "routes/metered-infer.js") + `?unfunded=${Date.now()}`);
  writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: sidecarUrl, modelId: "m", specialTokenIdRanges: [[1000, 1001]], expectedTokenizerBundleDigest: BUNDLE_DIGEST }));
  const { readFileSync: rf, existsSync: ex } = await import("node:fs");
  const jf = join(home, "metering", "read-journal.jsonl");
  const journalBefore = ex(jf) ? rf(jf).length : 0;
  const req = Readable.from([Buffer.from(JSON.stringify({ delegation: deleg2, bindingProof: proof2, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 }, messages: [{ role: "user", content: "the cat" }], maxTokens: 64 }))]); req.method = "POST";
  const captured = { status: 0, body: null };
  const res = { writableEnded: false, writeHead(st) { captured.status = st; return this; }, end(b) { this.writableEnded = true; try { captured.body = JSON.parse(b); } catch { captured.body = b; } }, setHeader() {} };
  await R8.handleMeteredInferRoutes({ req, res, path: "/api/metering/infer", config: { chain: { chainId: CHAIN } }, network: null });
  const journalAfter = ex(jf) ? rf(jf).length : 0;
  ok("enforced principal with NO funded tab is refused (402/403), never served free",
    captured.status === 402 || captured.status === 403, `status=${captured.status} err=${captured.body?.error}`);
  ok("the refusal wrote ZERO journal bytes — no charge, no leg, no residual claim", journalAfter === journalBefore, `${journalBefore} → ${journalAfter}`);
  ok("the funded buyer's balance is untouched by the stranger's attempt", L.balance(home, BUYER).balance > 0);
}

sidecar.close();
console.log(`\n${pass}/${pass + fail} infer-wiring gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
