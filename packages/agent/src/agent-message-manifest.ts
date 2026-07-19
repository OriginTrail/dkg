import { ethers } from 'ethers';

/**
 * Agent-addressed direct messaging (V1).
 *
 * The existing chat transport is node-addressed: a message is sent to a
 * libp2p `peerId` and encrypted to that node's key. This module layers an
 * *agent identity* on top without touching the transport or the encryption:
 * the sender stamps a small signed manifest — `{ from, to, ts, sig }` — into
 * the (already encrypted) chat payload, where `from`/`to` are agent EVM
 * addresses (`0x…`). The receiver verifies the signature to learn *which
 * agent* sent the message, independently of which node relayed it.
 *
 * Confidentiality is unchanged — the manifest rides inside the existing
 * XChaCha20-Poly1305 payload. What this adds is authenticated agent-level
 * `from`/`to`. The `sig` is an EIP-191 signature produced by the sender's
 * agent key via `ChainAdapter.signMessageAs(from, digest)` (the same
 * primitive the publisher uses to sign author seals), so a hosting/relaying
 * node cannot forge a `from` it does not control.
 *
 * ## Freshness binding
 *
 * The signature covers `messageId` and `ts` in addition to `from`/`to`/`text`.
 * Without this the manifest would be a context-free bearer token: "0xA said
 * 'hi' to 0xB" could be re-presented by anyone who observed it. Today the
 * node-keyed ciphertext incidentally blocks cross-node replay, but V2
 * (agent-keyed end-to-end + store-and-forward mailboxes) removes that
 * accident — so we anchor the signature to the persistent `messageId` dedup
 * key and a timestamp skew window *now*, while the wire format is still ours
 * to define. `recipientPeerId` is deliberately NOT bound: it is a transport
 * detail that will not survive V2 forwarding, and binding it would re-couple
 * the agent-level auth token to the node it is meant to be independent of.
 */

/** Domain-separation tag + wire version for the signed manifest digest. */
export const AGENT_MESSAGE_MANIFEST_VERSION = 'dkg-agent-msg:v1';

/**
 * Max clock skew tolerated between the signed `ts` and the receiver's clock.
 * Combined with the persistent per-node `messageId` dedup, this bounds replay:
 * a re-presented manifest is either a `messageId` the receiver has already
 * stored (dropped) or one whose `ts` has aged out of the window (rejected).
 * 5 minutes is generous for NTP-synced nodes without making the replay window
 * meaningfully large.
 */
export const AGENT_MESSAGE_MAX_SKEW_MS = 5 * 60_000;

export interface AgentMessageManifest {
  /** Checksummed sender agent EVM address. */
  from: string;
  /** Checksummed recipient agent EVM address. */
  to: string;
  /** Signed millisecond epoch — freshness bound. */
  ts: number;
  /** 65-byte serialized EIP-191 signature over {@link agentManifestDigestBytes}. */
  sig: string;
}

/**
 * The 32-byte digest the sender signs and the receiver recovers. Every field
 * that must be authenticated is bound here: the domain tag, both agent
 * addresses (checksum-normalized so both sides hash identical bytes), the
 * message id, the timestamp, and a hash of the message text. Returns the raw
 * 32 bytes — callers MUST pass this `Uint8Array` to BOTH `signMessageAs` and
 * `ethers.verifyMessage`; hexlifying first would make ethers treat it as a
 * UTF-8 string and every verification would (fail-closed) never match.
 */
export function agentManifestDigestBytes(input: {
  from: string;
  to: string;
  messageId: string;
  ts: number;
  text: string;
}): Uint8Array {
  const canonical = [
    AGENT_MESSAGE_MANIFEST_VERSION,
    ethers.getAddress(input.from),
    ethers.getAddress(input.to),
    input.messageId,
    String(input.ts),
    ethers.id(input.text), // keccak256(utf8(text)) — binds content, bounds length
  ].join('|');
  return ethers.getBytes(ethers.id(canonical));
}

/**
 * Reassemble the chain adapter's compact `{ r, vs }` (EIP-2098) return shape
 * into a 65-byte serialized signature that `ethers.verifyMessage` accepts.
 */
export function serializeCompactSignature(sig: { r: Uint8Array; vs: Uint8Array }): string {
  return ethers.Signature.from({
    r: ethers.hexlify(sig.r),
    yParityAndS: ethers.hexlify(sig.vs),
  }).serialized;
}

export interface VerifiedAgentManifest {
  from: string;
  to: string;
  ts: number;
}

export type AgentManifestVerification =
  | { ok: true; manifest: VerifiedAgentManifest }
  | { ok: false; reason: string };

/**
 * Verify a manifest carried on an inbound chat. Fail-closed: any missing
 * field, stale/absent timestamp, malformed signature, or signer≠`from`
 * mismatch returns `{ ok: false }` with a reason (the caller rejects the
 * chat). On success the returned `from`/`to` are checksummed and safe to
 * treat as the authenticated sender / claimed recipient agent identities.
 *
 * `messageId` is sourced from the (already-parsed) payload rather than the
 * manifest itself so that the value the receiver dedups on is the value that
 * was signed — an attacker cannot change the payload's `messageId` without
 * invalidating the signature.
 */
export function verifyAgentMessageManifest(input: {
  from?: unknown;
  to?: unknown;
  sig?: unknown;
  ts?: unknown;
  messageId?: unknown;
  text: string;
  nowMs: number;
  maxSkewMs?: number;
}): AgentManifestVerification {
  const { from, to, sig, ts, messageId, text } = input;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof sig !== 'string' ||
    typeof ts !== 'number' ||
    typeof messageId !== 'string'
  ) {
    return { ok: false, reason: 'incomplete agent manifest' };
  }
  const maxSkew = input.maxSkewMs ?? AGENT_MESSAGE_MAX_SKEW_MS;
  if (!Number.isFinite(ts) || Math.abs(input.nowMs - ts) > maxSkew) {
    return { ok: false, reason: 'timestamp outside skew window' };
  }
  let recovered: string;
  try {
    const digest = agentManifestDigestBytes({ from, to, messageId, ts, text });
    recovered = ethers.verifyMessage(digest, sig);
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  let normalizedFrom: string;
  let normalizedTo: string;
  try {
    normalizedFrom = ethers.getAddress(from);
    normalizedTo = ethers.getAddress(to);
  } catch {
    return { ok: false, reason: 'malformed agent address' };
  }
  if (recovered.toLowerCase() !== normalizedFrom.toLowerCase()) {
    return { ok: false, reason: 'signature does not match sender' };
  }
  return { ok: true, manifest: { from: normalizedFrom, to: normalizedTo, ts } };
}
