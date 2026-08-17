// v3.5 buyer-side actions — the node-native rail behind the UI's Fund step.
//
// The browser NEVER holds keys or talks to an RPC: the buyer node signs the
// deposit with its own wallet env (same file BuyerClient reads) and the UI
// only ever gates/observes. Flow (mirrors the v3 funded-run scripts, now a
// node capability):
//
//   1. verify the seller's signed quote (unverifiable ≠ pass — no quote, no
//      transfer), take providerAddress FROM THE QUOTE, never from config
//   2. ERC-20 TRAC transfer buyer → provider on the buyer's own RPC
//   3. poll: POST {sellerApiBase}/tab/open {txHash} until the seller's
//      confirmation-depth rule admits it (E_CONFIRMATIONS → keep waiting)
//   4. persist tabId into buyer.json — the gateway remounts on mtime change
//
// Every call is loopback/token-gated by the plugin; nothing here is wire.
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BuyerClient } from "./client.js";

export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
export const DEFAULT_BASE_TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

export interface BuyerCfg {
  sellerApiBase: string;
  walletEnvFile: string;
  tabId?: string;
  rpcUrl?: string;
  tracContract?: string;
  chainId?: number;
}

const buyerCfgPath = (home: string) => join(home, "buyer.json");
const fundingPath = (home: string) => join(home, "buyer-funding.jsonl");

export function readBuyerCfg(home: string): BuyerCfg | null {
  const p = buyerCfgPath(home);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as BuyerCfg; } catch { return null; }
}

function readWalletKey(envFile: string): string {
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("BUYER_WALLET_KEY="));
  const key = line?.slice("BUYER_WALLET_KEY=".length).trim();
  if (!key) throw new Error("E_WALLET_ENV");
  return key;
}

export interface FundingRecord {
  type: "fund";
  txHash: string;
  amountMicroTrac: number;
  providerAddress: string;
  at: string;
  tabId?: string;
}

function fundingRows(home: string): FundingRecord[] {
  if (!existsSync(fundingPath(home))) return [];
  return readFileSync(fundingPath(home), "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) as FundingRecord; } catch { return null; }
  }).filter((r): r is FundingRecord => !!r);
}

/** Wallet readout for the onboarding card: address + TRAC/ETH balances from
 *  the buyer's own RPC. Read-only; display-only. */
export async function walletStatus(home: string): Promise<Record<string, unknown>> {
  const cfg = readBuyerCfg(home);
  if (!cfg) return { configured: false };
  const address = getAddress(new Wallet(readWalletKey(cfg.walletEnvFile)).address);
  const provider = new JsonRpcProvider(cfg.rpcUrl ?? DEFAULT_BASE_RPC);
  try {
    const trac = new Contract(cfg.tracContract ?? DEFAULT_BASE_TRAC, ERC20_ABI, provider);
    const [tracWei, ethWei] = await Promise.all([
      trac.balanceOf(address) as Promise<bigint>,
      provider.getBalance(address),
    ]);
    // display seed for the fund gate's "to" line — the VERIFIED providerAddress
    // from the live signed quote (fundTab re-verifies before any transfer)
    let quoteProvider: string | null = null;
    let quoteVerified = false;
    try {
      const client = new BuyerClient(cfg.sellerApiBase, cfg.walletEnvFile, null);
      const v = await client.fetchAndVerifyTerms(cfg.chainId ? { chainId: cfg.chainId } : undefined);
      quoteVerified = v.checks.every((c) => c.pass);
      if (quoteVerified) quoteProvider = String((v.quote as { providerAddress?: string }).providerAddress ?? "") || null;
    } catch { /* seller unreachable — the UI shows its offline state */ }
    return {
      configured: true, address,
      tracMicro: Number(tracWei / 10n ** 12n),      // 18-dec wei → µTRAC (1e-6)
      ethWei: ethWei.toString(),
      tabId: cfg.tabId ?? null,
      quoteProvider, quoteVerified,
    };
  } catch (e) {
    return { configured: true, address, rpcError: String((e as Error).message).slice(0, 120), tabId: cfg.tabId ?? null };
  } finally {
    provider.destroy();
  }
}

/** Step 2+3 seed: verify quote, send the deposit, journal it. Returns the tx
 *  hash immediately; confirmation + tab-open happen in fundStatus polls. */
export async function fundTab(home: string, amountMicroTrac: number): Promise<Record<string, unknown>> {
  const cfg = readBuyerCfg(home);
  if (!cfg) return { error: "E_BUYER_UNCONFIGURED" };
  if (!Number.isInteger(amountMicroTrac) || amountMicroTrac <= 0) return { error: "E_AMOUNT" };

  // quote first — providerAddress comes from the verified quote only
  const client = new BuyerClient(cfg.sellerApiBase, cfg.walletEnvFile, null);
  const verified = await client.fetchAndVerifyTerms(cfg.chainId ? { chainId: cfg.chainId } : undefined);
  const failed = verified.checks.filter((c) => !c.pass);
  if (failed.length) return { error: "E_QUOTE_UNVERIFIABLE", detail: failed.map((c) => c.name).slice(0, 3) };
  const providerAddress = String((verified.quote as { providerAddress?: string }).providerAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(providerAddress)) return { error: "E_QUOTE_PROVIDER" };

  const provider = new JsonRpcProvider(cfg.rpcUrl ?? DEFAULT_BASE_RPC);
  try {
    const wallet = new Wallet(readWalletKey(cfg.walletEnvFile), provider);
    const trac = new Contract(cfg.tracContract ?? DEFAULT_BASE_TRAC, ERC20_ABI, wallet);
    const tx = await trac.transfer(providerAddress, BigInt(amountMicroTrac) * 10n ** 12n);
    const rec: FundingRecord = {
      type: "fund", txHash: tx.hash, amountMicroTrac, providerAddress, at: new Date().toISOString(),
    };
    appendFileSync(fundingPath(home), JSON.stringify(rec) + "\n");
    return { txHash: tx.hash, amountMicroTrac, providerAddress };
  } finally {
    provider.destroy();
  }
}

/** Poll step: latest funding record; if its tab isn't open yet, try
 *  /tab/open (seller enforces confirmation depth — E_CONFIRMATIONS means
 *  "not yet", anything else is surfaced). Persists tabId on success. */
export async function fundStatus(home: string): Promise<Record<string, unknown>> {
  const cfg = readBuyerCfg(home);
  if (!cfg) return { error: "E_BUYER_UNCONFIGURED" };
  const rows = fundingRows(home);
  const last = rows[rows.length - 1];
  if (!last) return { state: cfg.tabId ? "funded" : "none", tabId: cfg.tabId ?? null };
  if (last.tabId) return { state: "funded", txHash: last.txHash, tabId: last.tabId };
  // try to open
  try {
    const res = await fetch(cfg.sellerApiBase + "/tab/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: last.txHash }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { tab?: { tabId: string }; error?: string };
    if (res.status === 200 && body.tab?.tabId) {
      const tabId = body.tab.tabId;
      appendFileSync(fundingPath(home), JSON.stringify({ ...last, tabId, at: new Date().toISOString() }) + "\n");
      writeFileSync(buyerCfgPath(home), JSON.stringify({ ...cfg, tabId }, null, 2));
      return { state: "funded", txHash: last.txHash, tabId };
    }
    // E_TX_NOT_FOUND = not yet mined/visible on the seller's RPC — keep waiting
    if (body.error === "E_TX_NOT_FOUND" || body.error === "E_RPC") {
      return { state: "confirming", txHash: last.txHash, detail: body.error };
    }
    if (body.error === "E_TXHASH_CONSUMED" && cfg.tabId) {
      return { state: "funded", txHash: last.txHash, tabId: cfg.tabId };
    }
    return { state: "error", txHash: last.txHash, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { state: "offline", txHash: last.txHash, detail: String((e as Error).message).slice(0, 120) };
  }
}
