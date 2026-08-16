// Gateway keys — nsm_k_… credentials a buyer node mints for its local
// consumers (Odysseus, scripts, agents). NEVER the deposit key: a gateway key
// spends the buyer's tab through the buyer node; it cannot touch the wallet.
//
//   · hashed at rest (sha256) — the plaintext is shown exactly once at mint
//   · scopes: budget µTRAC, expiry, model allowlist, query y/n, rps
//   · revocation takes effect on the next call
//   · per-key sub-ledgers must sum to tab billed (key-conservation fixture)
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KeyScopes {
  budgetMicroTrac: number;
  expiresAt: string | null;        // ISO or null = no expiry
  modelAllowlist: string[] | null; // null = all funded offerings
  allowQuery: boolean;
  rps: number;                     // requests per second ceiling
}

export interface KeyRecord {
  keyId: string;                   // "nsm_k_" + 8-hex prefix — safe to log
  keyHash: string;                 // sha256 of the full secret
  scopes: KeyScopes;
  mintedAt: string;
  implicit?: boolean;              // the co-located default key (Odysseus)
}

const keysPath = (home: string) => join(home, "gateway-keys.jsonl");
const usagePath = (home: string) => join(home, "gateway-usage.jsonl");

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

const hash = (secret: string) => "sha256:" + createHash("sha256").update(secret).digest("hex");

/** Mint a key. Returns the PLAINTEXT exactly once — it is never stored. */
export function mintKey(home: string, scopes: KeyScopes, implicit = false): { plaintext: string; record: KeyRecord } {
  const secret = "nsm_k_" + randomBytes(24).toString("hex");
  const record: KeyRecord = {
    keyId: secret.slice(0, 14),          // "nsm_k_" + 8 hex — prefix only
    keyHash: hash(secret),
    scopes,
    mintedAt: new Date().toISOString(),
    ...(implicit ? { implicit: true } : {}),
  };
  appendLine(keysPath(home), { type: "mint", ...record });
  return { plaintext: secret, record };
}

export function revokeKey(home: string, keyId: string): boolean {
  const known = readLines(keysPath(home)).some((r) => r.type === "mint" && r.keyId === keyId);
  if (!known) return false;
  appendLine(keysPath(home), { type: "revoke", keyId, at: new Date().toISOString() });
  return true;
}

export function listKeys(home: string): Array<KeyRecord & { revoked: boolean }> {
  const rows = readLines(keysPath(home));
  const revoked = new Set(rows.filter((r) => r.type === "revoke").map((r) => r.keyId));
  return rows.filter((r) => r.type === "mint").map((r) => ({ ...(r as unknown as KeyRecord), revoked: revoked.has(r.keyId) }));
}

export type KeyVerdict =
  | { ok: true; record: KeyRecord }
  | { ok: false; status: 401 | 402 | 429; code: "E_KEY_UNKNOWN" | "E_KEY_REVOKED" | "E_KEY_EXPIRED" | "E_BUDGET" | "E_RPS" | "E_MODEL_SCOPE" | "E_QUERY_SCOPE" };

/** Authorize one call. Budget is checked against the key's sub-ledger BEFORE the call. */
export function authorizeKey(home: string, a: {
  presented: string; model?: string; isQuery: boolean; estCostMicroTrac: number; now?: number;
}): KeyVerdict {
  const rows = readLines(keysPath(home));
  const mint = rows.find((r) => r.type === "mint" && r.keyHash === hash(a.presented)) as (KeyRecord & { type: string }) | undefined;
  if (!mint) return { ok: false, status: 401, code: "E_KEY_UNKNOWN" };
  if (rows.some((r) => r.type === "revoke" && r.keyId === mint.keyId)) return { ok: false, status: 401, code: "E_KEY_REVOKED" };
  const now = a.now ?? Date.now();
  const s = mint.scopes;
  if (s.expiresAt && now > Date.parse(s.expiresAt)) return { ok: false, status: 401, code: "E_KEY_EXPIRED" };
  if (a.isQuery && !s.allowQuery) return { ok: false, status: 401, code: "E_QUERY_SCOPE" };
  if (a.model && s.modelAllowlist && !s.modelAllowlist.includes(a.model)) return { ok: false, status: 401, code: "E_MODEL_SCOPE" };
  // rps: count usage records in the last 1000ms
  const recent = readLines(usagePath(home)).filter((r) => r.keyId === mint.keyId && now - Date.parse(String(r.at)) < 1000);
  if (recent.length >= s.rps) return { ok: false, status: 429, code: "E_RPS" };
  const spent = keySpent(home, mint.keyId);
  if (spent + a.estCostMicroTrac > s.budgetMicroTrac) return { ok: false, status: 402, code: "E_BUDGET" };
  return { ok: true, record: mint };
}

/** Record actual billed cost for a key (called after the seller leg lands). */
export function recordKeyUsage(home: string, a: { keyId: string; legId: string; costMicroTrac: number; kind: "inference" | "query" }): void {
  appendLine(usagePath(home), { keyId: a.keyId, legId: a.legId, costMicroTrac: a.costMicroTrac, kind: a.kind, at: new Date().toISOString() });
}

export function keySpent(home: string, keyId: string): number {
  return readLines(usagePath(home)).filter((r) => r.keyId === keyId)
    .reduce((s, r) => s + Number(r.costMicroTrac ?? 0), 0);
}

/** Key-conservation: per-key sub-ledgers must sum to the given tab-billed total. */
export function keyConservation(home: string, tabBilledMicroTrac: number): { ok: boolean; sum: number; tabBilled: number } {
  const sum = readLines(usagePath(home)).reduce((s, r) => s + Number(r.costMicroTrac ?? 0), 0);
  return { ok: sum === tabBilledMicroTrac, sum, tabBilled: tabBilledMicroTrac };
}
