// Phase-2b — the SAME two-seat purchase, but over the SWM lane (DKG-native
// transport). Buyer (node6) and seller (node5) touch ONLY their own nodes; every
// cross-device byte rides SWM gossip. No socket crosses between the seats.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Wallet, JsonRpcProvider, Contract, parseUnits } from "ethers";

const REPO = join(homedir(), "odysseus-dkg-proto/dkg");
const DIST = join(REPO, "packages/marketplace/dist");
const DEV = join(REPO, ".devnet");
const EV = join(homedir(), "odysseus-dkg-proto/nsm-v3-evidence/phase2b-lane");
mkdirSync(EV, { recursive: true });

const { LaneBuyerClient } = await import(join(DIST, "lane/client.js"));
const { hfEngine } = await import(join(DIST, "buyer/bpe.js"));
const { verifyInferenceLegV3 } = await import(join(DIST, "buyer/recount.js"));
const { providerPublicPem } = await import(join(DIST, "core/ledger.js"));

const CG = "nsm-devnet";
const RPC = "http://127.0.0.1:8545";
const TRAC = "0x70E5370b8981Abc6e14C91F4AcE823954EFC8eA3";
const t6 = readFileSync(join(DEV, "node6/auth.token"), "utf8").trim().split("\n").pop();
const BUYER_NODE = "http://127.0.0.1:9206";

const results = [];
const step = (id, name, pass, ev) => { results.push({ id, name, pass, ev }); console.log(`  ${pass ? "✓" : "✗"} [${id}] ${name}${pass ? "" : " — " + JSON.stringify(ev).slice(0, 160)}`); };
const save = (n, d) => writeFileSync(join(EV, n), JSON.stringify(d, null, 2));

const w6 = JSON.parse(readFileSync(join(DEV, "node6/wallets.json"), "utf8"));
const buyerW = (Array.isArray(w6) ? w6 : w6.wallets)[0];
const WALLET_ENV = join(DEV, "node6/.secrets-buyer-wallet.env");
writeFileSync(WALLET_ENV, `BUYER_WALLET_KEY=${buyerW.privateKey}\n`, { mode: 0o600 });

console.log("═══ Lane two-seat purchase (DKG transport, no cross-device socket) ═══");
const buyer = new LaneBuyerClient(BUYER_NODE, t6, CG, WALLET_ENV);

// B3 — /terms over the lane
const t0 = Date.now();
const terms = await buyer.terms();
save("terms.json", terms.body);
step("LANE-terms", `signed quote received over SWM (${Date.now() - t0}ms)`, terms.status === 402 && !!terms.body.signature, { status: terms.status });
if (terms.status !== 402) { finish(); }

const quote = terms.body.quote;
const providerPem = terms.body.providerPublicPem;
const chainOff = quote.offerings.find((o) => o.provenanceClass === "weights-pinned");

// B5 — real deposit + tab/open over the lane
const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(buyerW.privateKey, provider);
const erc = new Contract(TRAC, ["function transfer(address,uint256) returns (bool)"], wallet);
const tx = await erc.transfer(quote.providerAddress, parseUnits("1.0", 18));
const rcpt = await tx.wait();
const opened = await buyer.openTab(rcpt.hash);
save("tab-open.json", opened.body);
step("LANE-tab", "deposit verified + tab opened over SWM", opened.status === 200 && !!buyer.tabId, { status: opened.status, tab: buyer.tabId });

// C2 — a ⛓ inference purchase over the lane
const PROMPT = "In one sentence, what is a knowledge graph?";
const chat = await buyer.chat(chainOff.modelId, [{ role: "user", content: PROMPT }], 64);
save("chain-inference.json", chat.body);
const leg = chat.body?.nsm?.leg;
step("LANE-infer", "⛓ inference served + signed leg returned over SWM", chat.status === 200 && !!leg, { status: chat.status });

// buyer-local recount of the lane-delivered leg
if (leg) {
  const bundlePath = join(homedir(), "odysseus-dkg-proto/inference-recount-matrix/buyer-bundle/tokenizer.json");
  const engine = hfEngine(readFileSync(bundlePath, "utf8"));
  const expectation = {
    tokenizerBundleRef: chainOff.tokenizerBundleRef, providerPublicPem: providerPem ?? providerPublicPem(join(DEV, "node5/marketplace")),
    perInputTokenMicroTrac: chainOff.perInputTokenMicroTrac, perOutputTokenMicroTrac: chainOff.perOutputTokenMicroTrac,
    queryFlatMicroTrac: chainOff.queryFlatMicroTrac, perReturnedQuadMicroTrac: chainOff.perReturnedQuadMicroTrac,
  };
  const completion = chat.body.choices[0].message.content;
  const verdict = verifyInferenceLegV3({
    leg, deliveredBytes: Buffer.from(completion, "utf8"),
    promptMessages: [{ role: "user", content: PROMPT }], offering: expectation, engine, provenanceClass: "weights-pinned",
  });
  step("LANE-recount", `buyer recounts the lane-delivered leg → ${verdict.decision}`, verdict.decision === "countersign", { violations: verdict.violations });
  save("recount.json", { verdict, completion });

  // countersign + close over the lane
  const cs = await buyer.countersign(leg.legId);
  step("LANE-countersign", "countersign committed over SWM", cs.status === 200, { status: cs.status });
  const close = await buyer.close();
  save("close.json", close.body);
  step("LANE-close", "close committed over SWM; balance refundable", close.status === 200 && !!close.body.closeDigest, { status: close.status, digest: close.body?.closeDigest });
}

function finish() {
  const p = results.filter((r) => r.pass).length;
  save("SUMMARY.json", { pass: p, total: results.length, results });
  console.log(`\n${p}/${results.length} lane steps green`);
  process.exit(p === results.length ? 0 : 1);
}
finish();
