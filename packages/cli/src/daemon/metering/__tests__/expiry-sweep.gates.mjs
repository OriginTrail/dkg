// Durable tab openings + the expiry sweep.
//
// Both defects were found with 1 TRAC of a counterparty's real money sitting in
// a live tab on production:
//   * openings were an in-memory Map, so a restart destroyed the agreement
//     while the credit stayed durable — a real balance with no tab to spend
//     from and no refund address to return it to;
//   * refundOnExpiry and evaluateExpiry were implemented, correct and covered
//     by six passing gates, and NOTHING called either. A refund no code path
//     invokes is a promise, not a mechanism.
//
// These gates assert the outcomes, not the mechanisms: a tab survives a
// restart, and an expired tab actually gets its refund recorded.
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "sweep-"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const BUYER = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";

// A restart must be a REAL restart. Query-string cache busting does not work
// here: deposit-rail.js?v=2 still imports plain ledger.js, so the "reloaded"
// module shares the original ledger instance and the test passes without
// exercising replay at all. (Caught by a balance assertion failing against a
// ledger the code under test was not writing to.) A child process is the only
// honest simulation.
const load = async () => ({
  D: await import(join(dist, "metering/deposit-rail.js")),
  L: await import(join(dist, "metering/ledger.js")),
  S: await import(join(dist, "metering/stage3-endpoint.js")),
  RM: await import(join(dist, "metering/read-meter.js")),
});

/** Run a snippet in a FRESH node process against the same DKG_HOME. */
function inFreshProcess(bodyJs) {
  const { execFileSync } = require("node:child_process");
  const script = `
    const { join } = require("node:path");
    (async () => {
      const D = await import(${JSON.stringify(join(dist, "metering/deposit-rail.js"))});
      const L = await import(${JSON.stringify(join(dist, "metering/ledger.js"))});
      ${bodyJs}
    })();
  `;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, DKG_HOME: home } }).trim();
}

console.log("\nDurable openings + expiry sweep\n");

console.log("a funded tab survives a node restart:");
{
  const { D, L, S, RM } = await load();
  const terms = S.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, 8453);
  const artifact = D.buildOpeningArtifact(BUYER, terms);
  D.registerOpening(home, artifact);
  const transfer = { txHash: "0xaa", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
  D.creditDeposit(home, transfer, artifact, D.evaluateDeposit(transfer, artifact));
  ok("tab open and funded before the restart",
    !!D.activeOpening(home, BUYER) && L.balance(home, BUYER).balance === 1_000_000);
  ok("the opening was written to disk, not just memory",
    existsSync(join(home, "metering", "openings.jsonl")));

  // A genuinely fresh process: no shared module state of any kind.
  const out = JSON.parse(inFreshProcess(`
    const a = D.activeOpening(${JSON.stringify(home)}, ${JSON.stringify(BUYER)});
    console.log(JSON.stringify({
      found: !!a,
      refundAddress: a?.terms?.refundAddress ?? null,
      termsDigest: a?.termsDigest ?? null,
      balance: L.balance(${JSON.stringify(home)}, ${JSON.stringify(BUYER)}).balance,
      debitOk: D.debitAllowed(${JSON.stringify(home)}, ${JSON.stringify(BUYER)}, Date.now()).ok,
    }));
  `));
  ok("the opening SURVIVES a real process restart — the agreement outlives the process",
    out.found === true, JSON.stringify(out));
  ok("the recovered artifact keeps the locked refund address", out.refundAddress === BUYER);
  ok("the recovered artifact keeps the terms digest the buyer agreed to", out.termsDigest === artifact.termsDigest);
  ok("the credit was durable across the restart too", out.balance === 1_000_000, String(out.balance));
  ok("a debit is still permitted while the tab is live", out.debitOk === true);
}

console.log("\nthe sweep actually refunds — the caller that did not exist:");
{
  const { D, L } = await load();
  const live = D.sweepExpiredTabs(home, Date.now());
  ok("a LIVE tab is not swept", live.length === 0, JSON.stringify(live));
  ok("...and its balance is untouched", L.balance(home, BUYER).balance === 1_000_000);

  const artifact = D.activeOpening(home, BUYER);
  const afterExpiry = Date.parse(artifact.expiresAt) + 1000;

  ok("an expired tab refuses further debits", D.debitAllowed(home, BUYER, afterExpiry).ok === false);

  const swept = D.sweepExpiredTabs(home, afterExpiry);
  ok("the sweep refunds the expired tab", swept.length === 1 && swept[0].refundedMicroTrac === 1_000_000, JSON.stringify(swept));
  ok("it refunds to the LOCKED address, not one supplied later", swept[0].refundAddress === BUYER);
  ok("the balance goes to zero", L.balance(home, BUYER).balance === 0);

  const again = D.sweepExpiredTabs(home, afterExpiry + 60_000);
  ok("a second sweep is a no-op — idempotent by construction", again.length === 0, JSON.stringify(again));

  const journal = readFileSync(join(home, "metering", "read-journal.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const refunds = journal.filter((r) => r.kind === "refund");
  ok("EXACTLY one refund record exists, however often the sweep runs", refunds.length === 1, `${refunds.length} refund records`);
  ok("the refund record names the amount and destination", refunds[0]?.amountMicroTrac === 1_000_000 && refunds[0]?.refundAddress === BUYER);
}

console.log("\nwhat the sweep must NOT claim:");
{
  const { D } = await load();
  const src = readFileSync(join(dist, "metering/deposit-rail.js"), "utf8");
  ok("the sweep performs no chain transaction — no transfer/send in its module",
    !/\bsendTransaction\b|\btransfer\(/.test(src),
    "deposit-rail appears to contain a chain-mutating call");
  ok("sweepExpiredTabs is exported and callable", typeof D.sweepExpiredTabs === "function");
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} expiry-sweep gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
