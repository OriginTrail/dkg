// P5 devnet seating — end-to-end over two real nodes. Hardhat's well-known
// test keys only (public fixtures, not secrets).
import { createRequire } from "node:module";
const require = createRequire("/Users/zigadrev/odysseus-dkg-proto/dkg-v35/packages/marketplace/package.json");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const RPC = new JsonRpcProvider("http://127.0.0.1:8545");
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const DEPLOYER = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", RPC);
const BUYER = new Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", RPC);
const SELLER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const REVENUE = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const N1 = "http://127.0.0.1:9201", N2 = "http://127.0.0.1:9202";
const abi = ["function balanceOf(address) view returns (uint256)",
             "function transfer(address,uint256) returns (bool)",
             "function mint(address,uint256)"];
const j = (r) => r.json();
const post = (base, path, body) => fetch(base + path, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(out).slice(0, 200)}`);
    return out;
  });

// 1) fund buyer with devnet TRAC
const tok0 = new Contract(TOKEN, abi, DEPLOYER);
const bal0 = await tok0.balanceOf(DEPLOYER.address);
if (bal0 < 10n ** 19n) { await (await tok0.mint(DEPLOYER.address, 100n * 10n ** 18n)).wait(); }
await (await tok0.transfer(BUYER.address, 10n * 10n ** 18n)).wait();
console.log("buyer funded:", (await tok0.balanceOf(BUYER.address)).toString());

// 2) the period payment: 3 TRAC buyer → seller revenue wallet
const tokB = new Contract(TOKEN, abi, BUYER);
const payTx = await (await tokB.transfer(REVENUE, 3n * 10n ** 18n)).wait();
const log = payTx.logs.find((l) => l.address.toLowerCase() === TOKEN.toLowerCase());
const safeHead = Math.max(payTx.blockNumber, await RPC.getBlockNumber());
console.log("payment tx:", payTx.hash, "block", payTx.blockNumber, "logIndex", log.index, "safeHead", safeHead);

// 3) seed asks on the seller
await post(N1, "/marketplace/operate/ask", { offeringId: "qwen7b", unit: "tokens",
  askMicroPerUnit: 0.5, effectiveFromCycle: 1, currentCycle: 1, seed: true });
await post(N1, "/marketplace/operate/ask", { offeringId: "devnet-knowledge", unit: "query-units",
  askMicroPerUnit: 15, effectiveFromCycle: 1, currentCycle: 1, seed: true });
console.log("asks seeded");

// 4) buyer purchases the plan (loopback rail on node2)
const asks = [
  { seller: SELLER, offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 1 },
  { seller: SELLER, offeringId: "devnet-knowledge", unit: "query-units", askMicroPerUnit: 15, effectiveFromCycle: 1 },
];
const { plan } = await post(N2, "/marketplace/subs/plan", {
  buyer: BUYER.address, periodMs: 600_000,
  lines: [
    { offeringId: "qwen7b", seller: SELLER, allocationMicroTrac: 2_500_000 },
    { offeringId: "devnet-knowledge", seller: SELLER, allocationMicroTrac: 500_000 },
  ],
  asks, paymentTxBySeller: { [SELLER]: payTx.hash },
});
console.log("plan:", plan.planId, "period", plan.periodId);

// 5) enroll at the seller with the verified transfer
const enroll = await post(N1, "/marketplace/subs/enroll", {
  plan,
  transfer: { txHash: payTx.hash, from: BUYER.address, to: REVENUE, token: TOKEN,
              amountTrac: "3", blockNumber: payTx.blockNumber, safeHeadBlock: safeHead,
              chainId: 31337, logIndex: log.index },
});
console.log("enrolled:", enroll.ok, enroll.paymentIdentity);

// 6) live traffic through the buyer gateway (operator-implicit key on loopback)
const chat = await post(N2, "/marketplace/gateway/v1/chat/completions", {
  model: "qwen7b", max_tokens: 48,
  messages: [{ role: "user", content: "In one sentence: what is a knowledge graph?" }],
});
console.log("chat:", chat.nsm?.units, "units via", chat.nsm?.servedBy, "→",
  String(chat.choices?.[0]?.message?.content ?? "").slice(0, 60) + "…");
const query = await post(N2, "/marketplace/gateway/v1/query", {
  offeringId: "devnet-knowledge",
  sparql: "SELECT ?s ?p ?o WHERE { ?s ?p ?o . } LIMIT 5",
});
console.log("query:", query.units, "units, rows", query.returnedRows);

// 7) the buyer's own status projection — the UI's data source
const status = await fetch(N2 + "/marketplace/subs/status").then(j);
console.log("meters:", status.meters.map((m) => `${m.offeringId} ${m.consumedUnits}/${m.guaranteedUnits} ${m.state}`));
console.log("summaryPct:", status.summaryPct, "· activity rows:", status.activity.length);
