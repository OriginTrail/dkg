// NSM v3 fixture suite — every gate must pass before Phase 2 (prompt rule).
// Hermetic: scratch homes in a temp dir, stub connectors on ephemeral loopback
// ports, a real Qwen tokenizer bundle, no network beyond 127.0.0.1.
//
//   A. 8/8 inference recount set (tampered bytes, inflated input, inflated
//      output, tokenizer drift, over-bill, forged signature, honest ×2)
//   B. query legs: inflated quad count → withhold; over-bill → withhold
//   C. ☁ legs: template-constant drift → withhold
//   D. public-surface probes: withdraw/settle/credit/release ABSENT → 404
//   E. secret redaction: upstream key absent from legs, journal, responses
//   F. key-conservation: per-key sub-ledgers sum to tab billed
//   G. auth: wrong signer 401 · nonce replay 401 · consumed txHash 409
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const { handleFront } = await import(join(DIST, "seller/front.js"));
const { handleGateway } = await import(join(DIST, "gateway/router.js"));
const { openTab, tabQuantities } = await import(join(DIST, "seller/tabs.js"));
const { mintKey, keyConservation, revokeKey } = await import(join(DIST, "gateway/keys.js"));
const { verifyInferenceLegV3, verifyQueryLegV3 } = await import(join(DIST, "buyer/recount.js"));
const { hfEngine } = await import(join(DIST, "buyer/bpe.js"));
const { BuyerClient } = await import(join(DIST, "buyer/client.js"));
const { connectLlamaCpp } = await import(join(DIST, "seller/connector-llamacpp.js"));
const { CHAT_TEMPLATE_CONSTANTS, templateConstantsDigest } = await import(join(DIST, "seller/connector-openai.js"));
const { providerPublicPem } = await import(join(DIST, "core/ledger.js"));

const BUNDLE_SRC = process.env.QWEN_BUNDLE ?? `${process.env.HOME}/odysseus-dkg-proto/inference-recount-matrix/buyer-bundle`;
const FAKE_UPSTREAM_KEY = "sk-test-fixture-000000000000000000000000000000000000000000000000";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── scratch environment ──
const T = mkdtempSync(join(tmpdir(), "nsm-gates-"));
const sellerHome = join(T, "seller-mkt"); mkdirSync(sellerHome, { recursive: true });
const buyerHome = join(T, "buyer-mkt"); mkdirSync(buyerHome, { recursive: true });
const bundleDir = join(T, "bundle"); cpSync(BUNDLE_SRC, bundleDir, { recursive: true });
const ggufPath = join(T, "model.gguf"); writeFileSync(ggufPath, Buffer.from("GGUF-fixture-weights"));
const secretFile = join(T, "upstream-openai.env"); writeFileSync(secretFile, `OPENAI_API_KEY=${FAKE_UPSTREAM_KEY}\n`);
const buyerWallet = Wallet.createRandom();
const walletEnv = join(T, "buyer-wallet.env"); writeFileSync(walletEnv, `BUYER_WALLET_KEY=${buyerWallet.privateKey}\n`);

const engine = hfEngine(readFileSync(join(bundleDir, "tokenizer.json"), "utf8"));

// ── stub llama.cpp (tokenizes with the SAME engine → honest legs recount clean) ──
const llamaSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/models") return send({ data: [{ id: "Qwen/Qwen2.5-fixture" }] });
    if (req.url === "/apply-template") {
      const { messages } = JSON.parse(body);
      return send({ prompt: messages.map((m) => `<|${m.role}|>${m.content}`).join("\n") + "\n<|assistant|>" });
    }
    if (req.url === "/tokenize") {
      const { content } = JSON.parse(body);
      return send({ tokens: engine.encode(content) });
    }
    if (req.url === "/v1/chat/completions") {
      return send({ choices: [{ message: { content: "Deterministic fixture completion about knowledge graphs." }, finish_reason: "stop" }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => llamaSrv.listen(0, "127.0.0.1", r));
const llamaPort = llamaSrv.address().port;

// ── stub OpenAI upstream (usage counted with the same public-bundle arithmetic) ──
const CLOUD_COMPLETION = "Cloud fixture completion.";
let cloudMode = "ok";
const cloudSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (cloudMode === "429") { res.writeHead(429); res.end("{}"); return; }
    if (cloudMode === "500") { res.writeHead(500); res.end("{}"); return; }
    const { messages } = JSON.parse(body);
    const per = { perMessageTokens: 3, perReplyPrimerTokens: 3 };
    const inTok = messages.reduce((s, m) => s + engine.encodeCount(m.content) + engine.encodeCount(m.role) + per.perMessageTokens, 0) + per.perReplyPrimerTokens;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: CLOUD_COMPLETION }, finish_reason: "stop" }],
      usage: { prompt_tokens: inTok, completion_tokens: engine.encodeCount(CLOUD_COMPLETION) },
    }));
  });
});
await new Promise((r) => cloudSrv.listen(0, "127.0.0.1", r));
const cloudPort = cloudSrv.address().port;

// ── seller front server ──
const chainBinding = await connectLlamaCpp({
  kind: "llamacpp", baseUrl: `http://127.0.0.1:${llamaPort}`, ggufPath,
  tokenizerDir: bundleDir, settings: { seed: 42, temperature: 0, ctx: 8192 },
});
const chainOffering = {
  id: "fixture-chain", provenanceClass: "weights-pinned",
  connector: {}, perInputTokenMicroTrac: 2, perOutputTokenMicroTrac: 6,
  queryFlatMicroTrac: 5, perReturnedQuadMicroTrac: 1,
};
const cloudOffering = {
  id: "fixture-cloud", provenanceClass: "upstream-claimed",
  connector: {}, perInputTokenMicroTrac: 3, perOutputTokenMicroTrac: 9,
  queryFlatMicroTrac: 5, perReturnedQuadMicroTrac: 1,
};
const cloudBinding = {
  kind: "openai", baseUrl: `http://127.0.0.1:${cloudPort}`, model: "gpt-fixture",
  secretEnvFile: secretFile, tokenizerBundle: "fixture-public-bundle",
  templateConstantsDigest: templateConstantsDigest(),
};
const offerings = new Map();
const obChain = { offering: chainOffering, binding: chainBinding, tokenizerBundleRef: chainBinding.tokenizerBundleDigest };
const obCloud = { offering: cloudOffering, binding: cloudBinding, tokenizerBundleRef: "public:fixture-public-bundle" };
offerings.set("fixture-chain", obChain); offerings.set(chainBinding.modelId, obChain);
offerings.set("fixture-cloud", obCloud); offerings.set("gpt-fixture", obCloud);

const QUERY_RESULT = { bindings: [{ s: "a" }, { s: "b" }, { s: "c" }] };
const frontDeps = {
  home: sellerHome, cfg: { enabled: true, offerings: [] }, offerings,
  providerAddress: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab",
  chainId: 8453, rpcUrl: "http://127.0.0.1:1",   // RPC unused: tab opened directly below
  queryExecutor: async () => ({ body: JSON.stringify(QUERY_RESULT), returnedQuads: QUERY_RESULT.bindings.length }),
  log: () => {},
};
const frontSrv = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const handled = await handleFront(frontDeps, req, res, path, "/marketplace");
  if (!handled && !res.headersSent) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"NotFound"}'); }
});
await new Promise((r) => frontSrv.listen(0, "127.0.0.1", r));
const frontPort = frontSrv.address().port;
const apiBase = `http://127.0.0.1:${frontPort}/marketplace`;

// open a tab directly (deposit-rail RPC verification exercised in Phase 2 E2E)
const opened = openTab(sellerHome, {
  txHash: "0x" + "ab".repeat(32), from: buyerWallet.address, amountMicroTrac: 1_000_000,
});
const tab = opened.tab;

console.log("\n═══ G. auth + tab lifecycle ═══");
ok("tab opens from verified deposit", opened.ok === true && tab.depositMicroTrac === 1_000_000);
{
  const dup = openTab(sellerHome, { txHash: "0x" + "ab".repeat(32), from: buyerWallet.address, amountMicroTrac: 1_000_000 });
  ok("consumed txHash refused on reuse (E_TXHASH_CONSUMED)", dup.ok === false && dup.code === "E_TXHASH_CONSUMED");
}

const client = new BuyerClient(apiBase, walletEnv, tab.tabId);

// wrong signer
{
  const mallory = Wallet.createRandom();
  const malloryEnv = join(T, "mallory.env"); writeFileSync(malloryEnv, `BUYER_WALLET_KEY=${mallory.privateKey}\n`);
  const evil = new BuyerClient(apiBase, malloryEnv, tab.tabId);
  const r = await evil.chat("fixture-chain", [{ role: "user", content: "hi" }], 16);
  ok("wrong signer → 401 E_AUTH_ADDRESS", r.status === 401 && r.body.error === "E_AUTH_ADDRESS", JSON.stringify(r.body).slice(0, 80));
}
// nonce replay: manual double-send with identical headers
{
  const body = Buffer.from(JSON.stringify({ model: "fixture-chain", messages: [{ role: "user", content: "replay probe" }], max_tokens: 8 }));
  const { buildAuthStatement } = await import(join(DIST, "seller/auth.js"));
  const nonce = "fixed-nonce-1";
  const stmt = buildAuthStatement({ method: "POST", path: "/v1/chat/completions", body, tabId: tab.tabId, nonce });
  const sig = await buyerWallet.signMessage(stmt);
  const hdrs = { "content-type": "application/json", "x-nsm-tab": tab.tabId, "x-nsm-address": buyerWallet.address, "x-nsm-nonce": nonce, "x-nsm-signature": sig };
  const r1 = await fetch(apiBase + "/v1/chat/completions", { method: "POST", headers: hdrs, body });
  const r2 = await fetch(apiBase + "/v1/chat/completions", { method: "POST", headers: hdrs, body });
  ok("first use of nonce accepted", r1.status === 200, `status=${r1.status}`);
  ok("nonce replay → 401 E_AUTH_REPLAY", r2.status === 401 && (await r2.json()).error === "E_AUTH_REPLAY");
}

console.log("\n═══ D. public-surface 404 probes (ABSENT, not forbidden) ═══");
for (const p of ["withdraw", "settle", "credit", "release"]) {
  const g = await fetch(`${apiBase}/${p}`);
  const po = await fetch(`${apiBase}/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(`/${p} → 404 on GET and POST`, g.status === 404 && po.status === 404, `${g.status}/${po.status}`);
}

console.log("\n═══ A. inference recount set (8 fixtures) ═══");
// honest ⛓ leg via the real front
const hr = await client.chat("fixture-chain", [{ role: "user", content: "What is a knowledge graph?" }], 64);
ok("⛓ chat serves (200 + leg)", hr.status === 200 && !!hr.body.nsm?.leg, `status=${hr.status}`);
const honestLeg = hr.body.nsm.leg;
const honestBytes = Buffer.from(hr.body.choices[0].message.content, "utf8");
const expectation = {
  tokenizerBundleRef: chainBinding.tokenizerBundleDigest,
  perInputTokenMicroTrac: 2, perOutputTokenMicroTrac: 6,
  queryFlatMicroTrac: 5, perReturnedQuadMicroTrac: 1,
  providerPublicPem: providerPublicPem(sellerHome),
};
const promptMsgs = [{ role: "user", content: "What is a knowledge graph?" }];
const run = (leg, bytes, exp = expectation) => verifyInferenceLegV3({
  leg, deliveredBytes: bytes, promptMessages: promptMsgs, offering: exp, engine, provenanceClass: "weights-pinned",
});

{
  const v = run(honestLeg, honestBytes);
  ok("1. honest leg → COUNTERSIGN", v.decision === "countersign", JSON.stringify(v.violations).slice(0, 120));
  const v2 = run(structuredClone(honestLeg), honestBytes);
  ok("2. honest leg (clone) → COUNTERSIGN (determinism)", v2.decision === "countersign");
}
{
  const v = run(honestLeg, Buffer.concat([honestBytes, Buffer.from("!")]));
  ok("3. tampered bytes → WITHHOLD E_BYTES_DIGEST", v.decision === "withhold" && v.violations.some((x) => x.code === "E_BYTES_DIGEST"));
}
{
  const bad = structuredClone(honestLeg);
  bad.meter.outputTokens += 5;
  bad.pricing.costMicroTrac = bad.meter.inputTokens * 2 + bad.meter.outputTokens * 6;
  const v = run(bad, honestBytes);
  ok("4. inflated OUTPUT count → WITHHOLD E_RECOUNT_MISMATCH", v.decision === "withhold" && v.violations.some((x) => x.code === "E_RECOUNT_MISMATCH"));
}
{
  const bad = structuredClone(honestLeg);
  bad.evidence.inputTokens = 999; bad.meter.inputTokens = 999;
  bad.pricing.costMicroTrac = 999 * 2 + bad.meter.outputTokens * 6;
  const v = verifyInferenceLegV3({
    leg: bad, deliveredBytes: honestBytes, promptMessages: promptMsgs,
    offering: expectation, engine, provenanceClass: "upstream-claimed",   // input recount path
  });
  ok("5. inflated INPUT count → WITHHOLD E_RECOUNT_MISMATCH", v.decision === "withhold" && v.violations.some((x) => x.code === "E_RECOUNT_MISMATCH"));
}
{
  const bad = structuredClone(honestLeg);
  bad.tokenizerBundleRef = "sha256:" + "ff".repeat(32);
  const v = run(bad, honestBytes);
  ok("6. tokenizer drift → WITHHOLD E_TOKENIZER_DRIFT", v.decision === "withhold" && v.violations.some((x) => x.code === "E_TOKENIZER_DRIFT"));
}
{
  const bad = structuredClone(honestLeg);
  bad.pricing.costMicroTrac += 1;
  const v = run(bad, honestBytes);
  ok("7. over-bill (+1µ) → WITHHOLD E_OVERBILL", v.decision === "withhold" && v.violations.some((x) => x.code === "E_OVERBILL"));
}
{
  const bad = structuredClone(honestLeg);
  bad.signature = Buffer.from("forged".repeat(11)).toString("base64");
  const v = run(bad, honestBytes);
  ok("8. forged signature → WITHHOLD E_LEG_SIGNATURE", v.decision === "withhold" && v.violations.some((x) => x.code === "E_LEG_SIGNATURE"));
}

console.log("\n═══ B. query legs ═══");
const qr = await client.query("SELECT ?s WHERE { ?s ?p ?o } LIMIT 3");
ok("query serves (200 + leg)", qr.status === 200 && !!qr.body.nsm?.leg, `status=${qr.status}`);
const queryLeg = qr.body.nsm.leg;
const queryBytes = Buffer.from(JSON.stringify(qr.body.result), "utf8");
const countQuads = (body) => { try { return (JSON.parse(body).bindings ?? []).length; } catch { return -1; } };
{
  const v = verifyQueryLegV3({ leg: queryLeg, deliveredBody: queryBytes, countQuads, offering: expectation });
  ok("honest query leg → COUNTERSIGN", v.decision === "countersign", JSON.stringify(v.violations).slice(0, 120));
}
{
  const bad = structuredClone(queryLeg);
  bad.meter.returnedQuads += 7;
  bad.pricing.costMicroTrac = 5 + 1 * bad.meter.returnedQuads;
  const v = verifyQueryLegV3({ leg: bad, deliveredBody: queryBytes, countQuads, offering: expectation });
  ok("inflated returned-quad count → WITHHOLD E_RECOUNT_MISMATCH", v.decision === "withhold" && v.violations.some((x) => x.code === "E_RECOUNT_MISMATCH"));
}
{
  const bad = structuredClone(queryLeg);
  bad.pricing.costMicroTrac += 3;
  const v = verifyQueryLegV3({ leg: bad, deliveredBody: queryBytes, countQuads, offering: expectation });
  ok("query over-bill → WITHHOLD E_OVERBILL", v.decision === "withhold" && v.violations.some((x) => x.code === "E_OVERBILL"));
}

console.log("\n═══ C. ☁ legs ═══");
const cr = await client.chat("gpt-fixture", [{ role: "user", content: "Cloud probe." }], 32);
ok("☁ chat serves (200 + leg)", cr.status === 200 && !!cr.body.nsm?.leg, `status=${cr.status} ${JSON.stringify(cr.body).slice(0, 100)}`);
const cloudLeg = cr.body.nsm.leg;
const cloudBytes = Buffer.from(cr.body.choices[0].message.content, "utf8");
const cloudExpectation = {
  tokenizerBundleRef: "public:fixture-public-bundle",
  perInputTokenMicroTrac: 3, perOutputTokenMicroTrac: 9,
  providerPublicPem: providerPublicPem(sellerHome),
};
{
  const v = verifyInferenceLegV3({
    leg: cloudLeg, deliveredBytes: cloudBytes, promptMessages: [{ role: "user", content: "Cloud probe." }],
    offering: cloudExpectation, engine, provenanceClass: "upstream-claimed",
  });
  ok("honest ☁ leg → COUNTERSIGN (usage matches constants arithmetic)", v.decision === "countersign", JSON.stringify(v.violations).slice(0, 160));
}
{
  // template-constant drift: leg billed under DIFFERENT per-message constants
  const bad = structuredClone(cloudLeg);
  bad.meter.inputTokens += CHAT_TEMPLATE_CONSTANTS.perMessageTokens;   // one extra per-message overhead
  bad.pricing.costMicroTrac = bad.meter.inputTokens * 3 + bad.meter.outputTokens * 9;
  const v = verifyInferenceLegV3({
    leg: bad, deliveredBytes: cloudBytes, promptMessages: [{ role: "user", content: "Cloud probe." }],
    offering: cloudExpectation, engine, provenanceClass: "upstream-claimed",
  });
  ok("☁ template-constant drift → WITHHOLD E_RECOUNT_MISMATCH", v.decision === "withhold" && v.violations.some((x) => x.code === "E_RECOUNT_MISMATCH"));
}
{
  cloudMode = "429";
  const before = tabQuantities(sellerHome, tab.principal).billed;
  const r = await client.chat("gpt-fixture", [{ role: "user", content: "ratelimited" }], 8);
  const after = tabQuantities(sellerHome, tab.principal).billed;
  ok("upstream 429 → downstream 429, NO LEG, nothing billed", r.status === 429 && before === after, `status=${r.status} billed ${before}→${after}`);
  cloudMode = "500";
  const r2 = await client.chat("gpt-fixture", [{ role: "user", content: "err" }], 8);
  const after2 = tabQuantities(sellerHome, tab.principal).billed;
  ok("upstream 5xx → downstream 502, NO LEG, nothing billed", r2.status === 502 && after === after2, `status=${r2.status}`);
  cloudMode = "ok";
}

console.log("\n═══ E. secret redaction ═══");
{
  const artifacts = [];
  for (const f of ["legs.jsonl", "consumed-txhashes.jsonl", "tabs.jsonl"]) {
    const p = join(sellerHome, f);
    if (existsSync(p)) artifacts.push(readFileSync(p, "utf8"));
  }
  const meterDirP = join(sellerHome, "metering");
  if (existsSync(join(meterDirP, "read-journal.jsonl"))) artifacts.push(readFileSync(join(meterDirP, "read-journal.jsonl"), "utf8"));
  artifacts.push(JSON.stringify(hr.body), JSON.stringify(cr.body), JSON.stringify(qr.body));
  const leaked = artifacts.some((a) => a.includes(FAKE_UPSTREAM_KEY));
  ok("upstream key ABSENT from legs, journal, tabs, and responses", !leaked);
  const wleaked = artifacts.some((a) => a.includes(buyerWallet.privateKey.slice(2)));
  ok("buyer wallet key ABSENT from all seller artifacts", !wleaked);
}

console.log("\n═══ F. gateway keys + conservation ═══");
{
  const scopes = { budgetMicroTrac: 500_000, expiresAt: null, modelAllowlist: null, allowQuery: true, rps: 50 };
  const k1 = mintKey(buyerHome, scopes);
  const k2 = mintKey(buyerHome, scopes);
  ok("key plaintext shown once; record stores hash + prefix only",
    k1.plaintext.startsWith("nsm_k_") && !JSON.stringify(k1.record).includes(k1.plaintext.slice(14)));

  const gwOfferings = new Map([[chainBinding.modelId, {
    id: "fixture-chain", modelId: chainBinding.modelId, provenanceClass: "weights-pinned",
    expectation, engine,
  }]]);
  const gwDeps = { home: buyerHome, client, offerings: gwOfferings, countQuads, log: () => {} };
  const gwSrv = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const handled = await handleGateway(gwDeps, req, res, path, "/marketplace");
    if (!handled && !res.headersSent) { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((r) => gwSrv.listen(0, "127.0.0.1", r));
  const gwBase = `http://127.0.0.1:${gwSrv.address().port}/marketplace/gateway/v1`;

  const billedBefore = tabQuantities(sellerHome, tab.principal).billed;
  const c1 = await fetch(gwBase + "/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k1.plaintext}` },
    body: JSON.stringify({ model: chainBinding.modelId, messages: [{ role: "user", content: "gateway call one" }], max_tokens: 32 }),
  });
  const c1b = await c1.json();
  ok("gateway ⛓ call → 200, recounted, countersigned in-path", c1.status === 200 && c1b.nsm?.decision === "countersigned", `status=${c1.status} ${JSON.stringify(c1b).slice(0, 100)}`);
  const c2 = await fetch(gwBase + "/query", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k2.plaintext}` },
    body: JSON.stringify({ sparql: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 3" }),
  });
  ok("gateway query via key 2 → 200 countersigned", c2.status === 200 && (await c2.json()).nsm?.decision === "countersigned");

  const models = await fetch(gwBase + "/models", { headers: { authorization: `Bearer ${k1.plaintext}` } });
  const mb = await models.json();
  ok("models list badged ⛓/☁", models.status === 200 && mb.data?.[0]?.nsm?.badge === "⛓");

  // failures: 401 revoked · 402 budget · 429 rps
  revokeKey(buyerHome, k2.record.keyId);
  const r401 = await fetch(gwBase + "/models", { headers: { authorization: `Bearer ${k2.plaintext}` } });
  ok("revoked key → 401 on next call", r401.status === 401);
  const tiny = mintKey(buyerHome, { ...scopes, budgetMicroTrac: 1 });
  const r402 = await fetch(gwBase + "/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tiny.plaintext}` },
    body: JSON.stringify({ model: chainBinding.modelId, messages: [{ role: "user", content: "x" }], max_tokens: 8 }),
  });
  ok("budget-exhausted key → 402", r402.status === 402);
  const rpsKey = mintKey(buyerHome, { ...scopes, rps: 0 });
  const r429 = await fetch(gwBase + "/models", { headers: { authorization: `Bearer ${rpsKey.plaintext}` } });
  ok("rps-exceeded → 429", r429.status === 429);

  // key-conservation: sub-ledgers sum to tab billed delta from gateway usage
  const billedAfter = tabQuantities(sellerHome, tab.principal).billed;
  const kc = keyConservation(buyerHome, billedAfter - billedBefore);
  ok("key-conservation: per-key sub-ledgers sum to tab billed (gateway delta)", kc.ok, `sum=${kc.sum} tabDelta=${billedAfter - billedBefore}`);
  gwSrv.close();
}

console.log("\n═══ close ═══");
{
  // decide the replay-probe leg + query leg + cloud leg so close can commit
  const { legById, legStatus } = await import(join(DIST, "seller/front.js"));
  const legsRaw = readFileSync(join(sellerHome, "legs.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  for (const l of legsRaw.filter((r) => r.type === "leg")) {
    if (legStatus(sellerHome, l.legId).status === "open") await client.countersign(l.legId);
  }
  const cl = await client.close();
  ok("close commits with all legs decided", cl.status === 200 && !!cl.body.closeDigest, `status=${cl.status} ${JSON.stringify(cl.body).slice(0, 100)}`);
  const q = tabQuantities(sellerHome, tab.principal);
  ok("conservation: deposits == billed + balance (+0 released)", q.deposits === q.billed + q.balance, `d=${q.deposits} b=${q.billed} bal=${q.balance}`);
}

llamaSrv.close(); cloudSrv.close(); frontSrv.close();
console.log(`\n${pass}/${pass + fail} gates pass${fail ? " — " + fail + " FAILING" : ""}`);
process.exit(fail ? 1 : 0);
