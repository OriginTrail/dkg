// EIP-191 request authentication for the seller front (Appendix A):
// every post-tab request is signed by the DEPOSITING key over
//   method + path + body digest + tabId + nonce
// The nonce is single-use per tab — a replayed signature is refused even if
// byte-valid. Nonces persist in the marketplace journal namespace so a daemon
// restart cannot un-burn one.
import { createHash } from "node:crypto";
import { verifyMessage, getAddress } from "ethers";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUTH_DOMAIN = "nsm:req:v1";

export interface AuthHeaders {
  address: string;    // x-nsm-address — the depositing wallet
  nonce: string;      // x-nsm-nonce — caller-chosen, single-use per tab
  signature: string;  // x-nsm-signature — EIP-191 over the statement below
}

export function authStatement(a: {
  method: string; path: string; bodySha256: string; tabId: string; nonce: string;
}): string {
  // Fixed, versioned, newline-delimited — byte-stable across implementations.
  return [
    AUTH_DOMAIN,
    `method:${a.method.toUpperCase()}`,
    `path:${a.path}`,
    `body:${a.bodySha256}`,
    `tab:${a.tabId}`,
    `nonce:${a.nonce}`,
  ].join("\n");
}

export const bodyDigest = (body: Buffer | string): string =>
  "sha256:" + createHash("sha256").update(body).digest("hex");

function noncePath(home: string, tabId: string): string {
  // one append-only file per tab; a nonce is burned by presence
  return join(home, "auth-nonces", tabId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".jsonl");
}

function nonceBurned(home: string, tabId: string, nonce: string): boolean {
  const p = noncePath(home, tabId);
  if (!existsSync(p)) return false;
  return readFileSync(p, "utf8").split("\n").some((l) => {
    try { return (JSON.parse(l) as { nonce?: string }).nonce === nonce; } catch { return false; }
  });
}

function burnNonce(home: string, tabId: string, nonce: string): void {
  const p = noncePath(home, tabId);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ nonce, at: new Date().toISOString() }) + "\n");
}

export type AuthVerdict =
  | { ok: true; address: string }
  | { ok: false; code: "E_AUTH_MISSING" | "E_AUTH_SIGNATURE" | "E_AUTH_ADDRESS" | "E_AUTH_REPLAY"; detail: string };

/**
 * Verify one request. `expectedAddress` is the tab's depositing wallet — the only
 * key allowed to act on the tab. On success the nonce is burned atomically with
 * the verdict (synchronous section, no await between check and append).
 */
export function verifyRequestAuth(home: string, a: {
  method: string; path: string; body: Buffer | string; tabId: string;
  headers: Partial<AuthHeaders>; expectedAddress: string;
}): AuthVerdict {
  const { address, nonce, signature } = a.headers;
  if (!address || !nonce || !signature) {
    return { ok: false, code: "E_AUTH_MISSING", detail: "x-nsm-address, x-nsm-nonce, x-nsm-signature required" };
  }
  let expected: string, presented: string;
  try {
    expected = getAddress(a.expectedAddress);
    presented = getAddress(address);
  } catch {
    return { ok: false, code: "E_AUTH_ADDRESS", detail: "malformed address" };
  }
  if (presented !== expected) {
    return { ok: false, code: "E_AUTH_ADDRESS", detail: "signer is not the tab's depositing wallet" };
  }
  if (nonceBurned(home, a.tabId, nonce)) {
    return { ok: false, code: "E_AUTH_REPLAY", detail: "nonce already used on this tab" };
  }
  const statement = authStatement({
    method: a.method, path: a.path, bodySha256: bodyDigest(a.body), tabId: a.tabId, nonce,
  });
  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(statement, signature));
  } catch {
    return { ok: false, code: "E_AUTH_SIGNATURE", detail: "signature does not parse" };
  }
  if (recovered !== expected) {
    return { ok: false, code: "E_AUTH_SIGNATURE", detail: "signature not by the depositing wallet over this request" };
  }
  burnNonce(home, a.tabId, nonce);
  return { ok: true, address: recovered };
}

/** Buyer-side helper: produce the headers for a request (used by the buyer service and the runbook). */
export function buildAuthStatement(a: {
  method: string; path: string; body: Buffer | string; tabId: string; nonce: string;
}): string {
  return authStatement({ method: a.method, path: a.path, bodySha256: bodyDigest(a.body), tabId: a.tabId, nonce: a.nonce });
}
