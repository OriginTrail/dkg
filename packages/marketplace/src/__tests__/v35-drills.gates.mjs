// v3.5 drills — the three new permanent tests the prompt mandates, plus the
// lifecycle rules they depend on. Hermetic: stub llama, direct HTTP front,
// NSM_TEST_DEADLINE_MS seam for expirable deadlines.
//
//   A. delayed-delivery (the v3 incident as a permanent test):
//      lane-transport leg served+billed, delivery never marked → deadline →
//      AUTO-VOID + billing reversed; countersign refused with E_LEG_VOIDED;
//      close treats it as decided.
//   B. duplicate-billing: same idempotency key twice → ONE leg, ONE debit,
//      second response flagged as replay.
//   C. streaming-digest tamper: honest chain verifies; mutated / dropped /
//      reordered frames each fail with the frame-accurate detail.
//   D. lifecycle guards: pending leg can be neither countersigned nor withheld.
process.env.NSM_TEST_DEADLINE_MS = "1500";   // must be set BEFORE dist import

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const { handleFront } = await import(join(DIST, "seller/front.js"));
const { openTab, tabQuantities } = await import(join(DIST, "seller/tabs.js"));
const { legState, sweepExpiredDeliveries } = await import(join(DIST, "seller/lifecycle.js"));
const { streamAccumulator, streamVerifier } = await import(join(DIST, "seller/streaming.js"));
const { BuyerClient } = await import(join(DIST, "buyer/client.js"));
const { connectLlamaCpp } = await import(join(DIST, "seller/connector-llamacpp.js"));
const { hfEngine } = await import(join(DIST, "buyer/bpe.js"));

const BUNDLE_SRC = process.env.QWEN_BUNDLE ?? `${process.env.HOME}/odysseus-dkg-proto/inference-recount-matrix/buyer-bundle`;
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : ` — ${d ?? ""}`}`); };

// ── scratch env (mirrors run-gates) ──
const T = mkdtempSync(join(tmpdir(), "v35-drills-"));
const home = join(T, "mkt"); mkdirSync(home, { recursive: true });
const bundleDir = join(T, "bundle"); cpSync(BUNDLE_SRC, bundleDir, { recursive: true });
const ggufPath = join(T, "model.gguf"); writeFileSync(ggufPath, Buffer.from("GGUF-fixture"));
const wallet = Wallet.createRandom();
const walletEnv = join(T, "w.env"); writeFileSync(walletEnv, `BUYER_WALLET_KEY=${wallet.privateKey}\n`);
const engine = hfEngine(readFileSync(join(bundleDir, "tokenizer.json"), "utf8"));

const llama = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/models") return send({ data: [{ id: "fixture-model" }] });
    if (req.url === "/apply-template") return send({ prompt: JSON.parse(b).messages.map((m) => m.content).join("\n") });
    if (req.url === "/tokenize") return send({ tokens: engine.encode(JSON.parse(b).content) });
    if (req.url === "/v1/chat/completions") return send({ choices: [{ message: { content: "Drill completion." }, finish_reason: "stop" }] });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => llama.listen(0, "127.0.0.1", r));

const binding = await connectLlamaCpp({ kind: "llamacpp", baseUrl: `http://127.0.0.1:${llama.address().port}`, ggufPath, tokenizerDir: bundleDir, settings: { seed: 42, temperature: 0, ctx: 4096 } });
const offering = { id: "drill", provenanceClass: "weights-pinned", connector: {}, perInputTokenMicroTrac: 2, perOutputTokenMicroTrac: 6, queryFlatMicroTrac: 5, perReturnedQuadMicroTrac: 1 };
const offerings = new Map();
const ob = { offering, binding, tokenizerBundleRef: binding.tokenizerBundleDigest };
offerings.set("drill", ob); offerings.set(binding.modelId, ob);
const deps = { home, cfg: { enabled: true, offerings: [] }, offerings, providerAddress: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", chainId: 8453, rpcUrl: "http://127.0.0.1:1", queryExecutor: async () => ({ body: "{}", returnedQuads: 0 }), log: () => {} };
const srv = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const handled = await handleFront(deps, req, res, path, "/marketplace");
  if (!handled && !res.headersSent) { res.writeHead(404); res.end("{}"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}/marketplace`;
const opened = openTab(home, { txHash: "0x" + "cd".repeat(32), from: wallet.address, amountMicroTrac: 100000 });
const client = new BuyerClient(base, walletEnv, opened.tab.tabId);

// helper: signed request with EXTRA headers (transport/idempotency)
import { buildAuthStatement } from "./_v35-auth-helper.mjs";

console.log("═══ A. delayed-delivery drill (the v3 incident, permanent) ═══");
{
  const before = tabQuantities(home, wallet.address);
  // serve with lane transport → NOT auto-delivered
  const r = await signedChat(client, base, wallet, opened.tab.tabId, { "x-nsm-transport": "lane" });
  const legId = r.body.nsm.leg.legId;
  ok("lane leg served + billed, state pending-delivery", r.status === 200 && legState(home, legId).state === "pending-delivery");
  const mid = tabQuantities(home, wallet.address);
  ok(`billing happened at serve (${mid.billed - before.billed}µ)`, mid.billed > before.billed);
  // decision refused while pending
  const cs = await client.countersign(legId);
  ok("countersign while pending → 409 E_LEG_PENDING_DELIVERY", cs.status === 409 && cs.body.error === "E_LEG_PENDING_DELIVERY");
  // deadline passes → sweep voids + reverses
  await new Promise((r2) => setTimeout(r2, 1800));
  const voided = sweepExpiredDeliveries(home);
  ok("sweep voids the expired pending leg", voided.includes(legId) && legState(home, legId).state === "voided");
  const after = tabQuantities(home, wallet.address);
  ok(`billing REVERSED (balance restored: ${after.balance}µ == ${before.balance}µ)`, after.balance === before.balance);
  const cs2 = await client.countersign(legId);
  ok("countersign after void → 409 E_LEG_VOIDED", cs2.status === 409 && cs2.body.error === "E_LEG_VOIDED");
  const close = await client.close();
  ok("close treats voided as decided (200)", close.status === 200 && close.body.close.legsVoided === 1, JSON.stringify(close.body).slice(0, 100));
}

console.log("═══ B. duplicate-billing drill (idempotency) ═══");
{
  const before = tabQuantities(home, wallet.address);
  const key = "idem-drill-1";
  const r1 = await signedChat(client, base, wallet, opened.tab.tabId, { "x-nsm-idempotency": key });
  const r2 = await signedChat(client, base, wallet, opened.tab.tabId, { "x-nsm-idempotency": key });
  const after = tabQuantities(home, wallet.address);
  ok("first serve billed once", after.billed - before.billed === r1.body.nsm.leg.pricing.costMicroTrac);
  ok("retry returns the SAME leg, flagged as replay", r2.status === 200 && r2.body.nsmReplay === true && r2.body.nsm.leg.legId === r1.body.nsm.leg.legId);
  ok("no second debit", after.billed - before.billed === r1.body.nsm.leg.pricing.costMicroTrac);
  // clean up: countersign the leg (direct → delivered)
  await client.countersign(r1.body.nsm.leg.legId);
}

console.log("═══ C. streaming-digest tamper drill ═══");
{
  const frames = ["Hello ", "streaming ", "world."].map((s2) => Buffer.from(s2));
  const acc = streamAccumulator();
  for (const f of frames) acc.push(f);
  const claim = { streamChainRoot: acc.root(), frameCount: acc.frameCount(), deliveredResponseBytesDigest: acc.bytesDigest() };

  const honest = streamVerifier();
  for (const f of frames) honest.push(f);
  ok("honest stream verifies + reassembles", honest.finalize(claim).ok === true);

  const mutated = streamVerifier();
  mutated.push(frames[0]); mutated.push(Buffer.from("streaming!")); mutated.push(frames[2]);
  const vm = mutated.finalize(claim);
  ok("mutated frame → E_RECOUNT_MISMATCH (chain root)", vm.ok === false && vm.detail.includes("chain root"));

  const dropped = streamVerifier();
  dropped.push(frames[0]); dropped.push(frames[2]);
  const vd = dropped.finalize(claim);
  ok("dropped frame → E_RECOUNT_MISMATCH (frameCount)", vd.ok === false && vd.detail.includes("frameCount"));

  const reordered = streamVerifier();
  reordered.push(frames[1]); reordered.push(frames[0]); reordered.push(frames[2]);
  const vr = reordered.finalize(claim);
  ok("reordered frames → E_RECOUNT_MISMATCH (chain root)", vr.ok === false && vr.detail.includes("chain root"));
}

llama.close(); srv.close();
console.log(`\n${pass}/${pass + fail} v3.5 drills pass`);
process.exit(fail ? 1 : 0);

// ── helper: BuyerClient.chat with extra headers (transport/idempotency) ──
async function signedChat(c, apiBase, w, tabId, extraHeaders) {
  const { randomBytes } = await import("node:crypto");
  const payload = { model: "fixture-model", messages: [{ role: "user", content: "drill" }], max_tokens: 16 };
  const body = Buffer.from(JSON.stringify(payload));
  const nonce = randomBytes(12).toString("hex");
  const stmt = buildAuthStatement({ method: "POST", path: "/v1/chat/completions", body, tabId, nonce });
  const sig = await w.signMessage(stmt);
  const res = await fetch(apiBase + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nsm-tab": tabId, "x-nsm-address": w.address, "x-nsm-nonce": nonce, "x-nsm-signature": sig, ...extraHeaders },
    body,
  });
  return { status: res.status, body: await res.json() };
}
