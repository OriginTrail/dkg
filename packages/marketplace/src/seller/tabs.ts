// Tab lifecycle for the v3 seller front.
//
// A tab opens from an on-chain deposit the SELLER verifies on its own RPC —
// never from the buyer's word. The tx hash is CONSUMED on first use: a durable
// registry refuses every later attempt to open (or re-open) a tab with it,
// across restarts. The depositing wallet becomes the tab principal — the only
// key that can act on the tab (enforced by EIP-191 auth) — and the ledger core
// (ported Iteration-2 journal) holds the money truth.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonRpcProvider, getAddress, id as topicId } from "ethers";
import { credit, readJournal } from "../core/ledger.js";
import { TRAC_CONTRACT } from "../core/inference-quote.js";

export interface OpenTab {
  tabId: string;
  principal: string;          // depositing wallet (checksummed)
  txHash: string;
  depositMicroTrac: number;
  openedAt: string;
  identityKaUal?: string;     // buyer identity KA (wallet↔node), recorded verbatim
}

const consumedPath = (home: string) => join(home, "consumed-txhashes.jsonl");
const tabsPath = (home: string) => join(home, "tabs.jsonl");

function appendLine(p: string, rec: Record<string, unknown>): void {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(rec) + "\n");
}

function readLines(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; }
  });
}

export function txHashConsumed(home: string, txHash: string): boolean {
  return readLines(consumedPath(home)).some((r) => r.txHash === txHash.toLowerCase());
}

export function tabById(home: string, tabId: string): OpenTab | null {
  const rows = readLines(tabsPath(home)).filter((r) => r.tabId === tabId);
  return rows.length ? (rows[rows.length - 1] as unknown as OpenTab) : null;
}

export function tabsAll(home: string): OpenTab[] {
  return readLines(tabsPath(home)) as unknown as OpenTab[];
}

export type DepositCheck =
  | { ok: true; from: string; amountMicroTrac: number }
  | { ok: false; code: "E_TX_NOT_FOUND" | "E_TX_FAILED" | "E_TX_NO_TRANSFER" | "E_TX_WRONG_RECIPIENT" | "E_RPC"; detail: string };

const TRANSFER_TOPIC = topicId("Transfer(address,address,uint256)");

/**
 * Verify a TRAC deposit on the seller's OWN RPC: the tx must be mined and
 * successful, and must carry an ERC-20 Transfer of the TRAC contract to the
 * provider address. Amount converts 1 TRAC = 1e18 wei → 1e6 µTRAC (integer
 * floor — dust below 1 µTRAC never credits).
 */
export async function verifyDepositOnchain(a: {
  rpcUrl: string; txHash: string; providerAddress: string; tracContract?: string;
}): Promise<DepositCheck> {
  let receipt;
  try {
    const provider = new JsonRpcProvider(a.rpcUrl);
    receipt = await provider.getTransactionReceipt(a.txHash);
  } catch (e) {
    return { ok: false, code: "E_RPC", detail: String((e as Error).message).slice(0, 120) };
  }
  if (!receipt) return { ok: false, code: "E_TX_NOT_FOUND", detail: a.txHash };
  if (receipt.status !== 1) return { ok: false, code: "E_TX_FAILED", detail: `status=${receipt.status}` };

  const trac = getAddress(a.tracContract ?? TRAC_CONTRACT);
  const to = getAddress(a.providerAddress);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== trac) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const logTo = getAddress("0x" + log.topics[2].slice(26));
    if (logTo !== to) continue;
    const from = getAddress("0x" + log.topics[1].slice(26));
    const wei = BigInt(log.data);
    const microTrac = Number(wei / 1_000_000_000_000n); // 1e18 wei/TRAC ÷ 1e6 µTRAC/TRAC
    return { ok: true, from, amountMicroTrac: microTrac };
  }
  // distinguish "no TRAC transfer at all" from "transfer to someone else"
  const anyTrac = receipt.logs.some((l) => getAddress(l.address) === trac && l.topics[0] === TRANSFER_TOPIC);
  return anyTrac
    ? { ok: false, code: "E_TX_WRONG_RECIPIENT", detail: `no TRAC transfer to ${to}` }
    : { ok: false, code: "E_TX_NO_TRANSFER", detail: "no TRAC Transfer event in receipt" };
}

/**
 * Open a tab from a verified deposit. Synchronous critical section: consumed-
 * check → burn → tab append → ledger credit, no await between them. The ledger
 * credit carries the tx evidence so replay reconstructs the same state.
 */
export function openTab(home: string, a: {
  txHash: string; from: string; amountMicroTrac: number; identityKaUal?: string;
}): { ok: true; tab: OpenTab } | { ok: false; code: "E_TXHASH_CONSUMED" } {
  const txHash = a.txHash.toLowerCase();
  if (txHashConsumed(home, txHash)) return { ok: false, code: "E_TXHASH_CONSUMED" };
  appendLine(consumedPath(home), { txHash, at: new Date().toISOString() });

  const principal = getAddress(a.from);
  const tabId = "tab_" + createHash("sha256").update(txHash + "|" + principal).digest("hex").slice(0, 16);
  const tab: OpenTab = {
    tabId, principal, txHash,
    depositMicroTrac: a.amountMicroTrac,
    openedAt: new Date().toISOString(),
    identityKaUal: a.identityKaUal,
  };
  appendLine(tabsPath(home), tab as unknown as Record<string, unknown>);
  credit(home, principal, a.amountMicroTrac, {
    kind: "nsm-v3-deposit", txHash, tabId, identityKaUal: a.identityKaUal ?? null,
  });
  return { ok: true, tab };
}

/** Ledger-truth quantities for one tab principal — a projection of the ported
 *  Iteration-2 journal grammar: `credit` records carry amountMicroTrac; `debit`
 *  records carry the signed leg, whose cost is leg.pricing.costMicroTrac. */
export function tabQuantities(home: string, principal: string): {
  deposits: number; billed: number; released: number; balance: number;
} {
  let deposits = 0, billed = 0, released = 0;
  for (const r of readJournal(home)) {
    if (r.principal !== principal) continue;
    const kind = r.kind;
    if (kind === "credit") deposits += Number(r.amountMicroTrac ?? 0);
    else if (kind === "debit") {
      const leg = r.leg as { pricing?: { costMicroTrac?: number } } | undefined;
      billed += Number(leg?.pricing?.costMicroTrac ?? 0);
    } else if (kind === "release" || kind === "refund") {
      released += Number(r.amountMicroTrac ?? 0);
    }
  }
  return { deposits, billed, released, balance: deposits - billed - released };
}
