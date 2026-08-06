// V2 Stage-3 — self-proving wallet binding (EIP-191).
//
// Buyer-recommended (Hermes/Bo, 2026-08-06): "operator-vouched configuration
// alone should not be the final cryptographic identity proof."
//
// The registry fixed the hole where a caller supplied the key that validated
// its own claim, but it replaced self-assertion with operator assertion: the
// operator vouches that an ed25519 key speaks for an EVM address, and nothing
// checks that. This makes the binding prove itself — the address's OWNER signs
// a statement naming the ed25519 key, and the provider recovers the signer.
// The operator is no longer part of the identity question at all.
//
// What the statement must bind, and why each field is load-bearing:
//   * the ed25519 key    — else a proof could be replayed with a different key,
//                          which is the original vulnerability wearing a hat;
//   * the principal      — else a proof for wallet A authorises wallet B;
//   * the chain id       — else a testnet signature authorises mainnet;
//   * an expiry          — else a proof is valid forever, including after the
//                          buyer has rotated or lost the ed25519 key.
import { verifyMessage, getAddress } from "ethers";
import { createHash, createPublicKey } from "node:crypto";

export const BINDING_DOMAIN = "odysseus-dkg:wallet-binding:v1";

/**
 * Maximum authorised lifetime of a binding proof.
 *
 * Buyer-recommended (Hermes/Bo): "enforce an explicit maximum notAfter rather
 * than leave lifetime unbounded." An expiry field the buyer chooses is not a
 * limit — a proof with notAfter 9999-12-31 is a permanent grant of signing
 * authority that survives key rotation, host compromise and staff turnover,
 * and nothing about the signature says so. The ceiling is the provider's, so
 * the worst case is bounded no matter what the buyer signs.
 *
 * 30 days: long enough that re-signing is not operational friction, short
 * enough that a leaked ed25519 key stops being useful within a billing month.
 */
export const MAX_BINDING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface BindingProof {
  domain: typeof BINDING_DOMAIN;
  principal: string;
  /** The ed25519 SPKI PEM this proof authorises. */
  walletPublicKeyPem: string;
  chainId: number;
  notAfter: string;
  /** EIP-191 personal_sign over `bindingStatement(...)`. */
  evmSignature: string;
}

/** sha256 over the DER form, so PEM whitespace/line-wrapping cannot change it. */
export function ed25519Fingerprint(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(der).digest("hex");
}

/**
 * The exact bytes the buyer signs. Human-readable on purpose: this is what
 * appears in a wallet's signing dialog, and a buyer who cannot read what they
 * are signing is not meaningfully consenting to it.
 */
export function bindingStatement(a: {
  principal: string; walletPublicKeyPem: string; chainId: number; notAfter: string;
}): string {
  return [
    BINDING_DOMAIN,
    `I authorise the following key to sign metering delegations on behalf of my wallet.`,
    `principal: ${getAddress(a.principal)}`,
    `ed25519-sha256: ${ed25519Fingerprint(a.walletPublicKeyPem)}`,
    `chainId: ${a.chainId}`,
    `notAfter: ${a.notAfter}`,
    `This authorises signing only. It does not authorise any transfer of funds.`,
  ].join("\n");
}

export type BindingVerdict =
  | { ok: true; principal: string; fingerprint: string }
  | { ok: false; code: BindingCode; detail?: string };

export type BindingCode =
  | "E_BINDING_MALFORMED"
  | "E_BINDING_WRONG_DOMAIN"
  | "E_BINDING_EXPIRED"
  | "E_BINDING_WRONG_CHAIN"
  | "E_BINDING_LIFETIME_TOO_LONG"
  | "E_BINDING_SIGNER_MISMATCH"
  | "E_BINDING_BAD_SIGNATURE";

/**
 * Verify a proof. Returns the principal ONLY when the recovered signer is that
 * principal — there is no path that trusts the `principal` field as written.
 */
export function verifyBinding(proof: BindingProof, opts: { chainId: number; now?: number }): BindingVerdict {
  const now = opts.now ?? Date.now();
  if (!proof || typeof proof !== "object") return { ok: false, code: "E_BINDING_MALFORMED" };
  for (const f of ["domain", "principal", "walletPublicKeyPem", "chainId", "notAfter", "evmSignature"] as const) {
    if (proof[f] === undefined || proof[f] === null) return { ok: false, code: "E_BINDING_MALFORMED", detail: `missing ${f}` };
  }
  if (proof.domain !== BINDING_DOMAIN) return { ok: false, code: "E_BINDING_WRONG_DOMAIN" };
  if (proof.chainId !== opts.chainId) {
    return { ok: false, code: "E_BINDING_WRONG_CHAIN", detail: `proof is for chain ${proof.chainId}, this node is ${opts.chainId}` };
  }
  const exp = Date.parse(proof.notAfter);
  if (!Number.isFinite(exp)) return { ok: false, code: "E_BINDING_MALFORMED", detail: "notAfter is not a date" };
  if (now > exp) return { ok: false, code: "E_BINDING_EXPIRED" };
  // A buyer-chosen expiry is not a limit until the provider caps it.
  if (exp - now > MAX_BINDING_LIFETIME_MS) {
    return {
      ok: false, code: "E_BINDING_LIFETIME_TOO_LONG",
      detail: `notAfter is ${Math.round((exp - now) / 86_400_000)} days out; this provider accepts at most ${MAX_BINDING_LIFETIME_MS / 86_400_000} days`,
    };
  }

  let fingerprint: string;
  let statement: string;
  try {
    fingerprint = ed25519Fingerprint(proof.walletPublicKeyPem);
    statement = bindingStatement(proof);
  } catch (e) {
    return { ok: false, code: "E_BINDING_MALFORMED", detail: String((e as Error)?.message ?? e).slice(0, 120) };
  }

  let recovered: string;
  try {
    recovered = verifyMessage(statement, proof.evmSignature);
  } catch {
    return { ok: false, code: "E_BINDING_BAD_SIGNATURE" };
  }

  // The claim is only as good as the recovery. Compare checksummed forms so
  // case-variant spellings of the same address cannot be treated as different
  // principals (or, worse, as a way to dodge a revocation).
  let claimed: string;
  try { claimed = getAddress(proof.principal); } catch { return { ok: false, code: "E_BINDING_MALFORMED", detail: "principal is not an address" }; }
  if (getAddress(recovered) !== claimed) {
    return { ok: false, code: "E_BINDING_SIGNER_MISMATCH", detail: "the signature was not produced by the wallet it names" };
  }
  return { ok: true, principal: claimed, fingerprint };
}
