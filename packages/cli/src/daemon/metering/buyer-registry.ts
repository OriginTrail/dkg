// V2 Stage-3 — operator-approved buyer registry.
//
// Buyer-found, 2026-08-06 (Hermes/Bo, live preflight). The endpoint verified
// each delegation against the `walletPublicKeyPem` supplied IN THE REQUEST,
// with nothing tying that key to the `tabPrincipal` address it claimed. So any
// holder of a front credential could generate a fresh keypair, name any wallet
// as the tab owner, sign their own delegation, and be told OK. Authorization
// was self-asserted: the caller both made the claim and provided the evidence.
//
// My own preflight example demonstrated the attack — a throwaway key claiming
// Bo's address — and printed it as a passing case. The check was "is this
// delegation signed by the key that came with it", which is always true.
//
// The fix is an anchor the caller cannot supply. A principal must be
// registered by the OPERATOR, and verification uses the REGISTERED key; the
// request's key is ignored entirely rather than compared, so there is no path
// where caller-supplied material decides its own validity.
import { existsSync, readFileSync } from "node:fs";

export interface RegisteredBuyer {
  label: string;
  /** The ed25519 SPKI PEM the operator approved for this principal. */
  walletPublicKeyPem: string;
  /** Free-text provenance: how the operator established this binding. */
  approvedVia?: string;
  approvedAt?: string;
}

export interface BuyerRegistry {
  principals: Record<string, RegisteredBuyer>;
}

const EMPTY: BuyerRegistry = { principals: {} };

/** Addresses are compared case-insensitively; EVM hex casing is a checksum. */
const norm = (addr: string) => String(addr ?? "").trim().toLowerCase();

export function loadBuyerRegistry(home: string): BuyerRegistry {
  const p = `${home}/metering/buyer-registry.json`;
  if (!existsSync(p)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as BuyerRegistry;
    const principals: Record<string, RegisteredBuyer> = {};
    for (const [addr, entry] of Object.entries(raw.principals ?? {})) {
      if (entry?.walletPublicKeyPem) principals[norm(addr)] = entry;
    }
    return { principals };
  } catch {
    // A malformed registry must not silently become an empty allowlist that
    // then reads as "no one is registered" — but it also must not crash the
    // node. Empty is the fail-closed answer: every principal is rejected.
    return EMPTY;
  }
}

export type AnchorResult =
  | { ok: true; walletPublicKeyPem: string; label: string }
  | { ok: false; code: "E_PRINCIPAL_NOT_REGISTERED"; detail: string };

/**
 * Resolve the operator-approved key for a principal.
 *
 * Note what is deliberately absent: any use of a caller-supplied public key,
 * even as a cross-check. Comparing the request's key to the registered one
 * would be equivalent, but only as long as every future caller remembers to
 * compare rather than fall back. Returning the registered key makes the unsafe
 * version unrepresentable.
 */
export function anchorWalletKey(home: string, tabPrincipal: string): AnchorResult {
  const reg = loadBuyerRegistry(home);
  const entry = reg.principals[norm(tabPrincipal)];
  if (!entry) {
    return {
      ok: false,
      code: "E_PRINCIPAL_NOT_REGISTERED",
      detail: "This principal has no operator-approved wallet key. A delegation cannot be accepted on a key the caller supplied for itself.",
    };
  }
  return { ok: true, walletPublicKeyPem: entry.walletPublicKeyPem, label: entry.label };
}
