/**
 * Signed gossip helpers — wrap every outgoing GossipSub payload in a
 * `GossipEnvelope` carrying an EIP-191 signature recoverable to the
 * publisher's agent address. Receivers can recover the signer with
 * `ethers.verifyMessage(computeGossipSigningPayload(...), envelope.signature)`
 * and reject envelopes whose signer is not a member of the context graph.
 *
 * Spec: §08_PROTOCOL_WIRE — every GossipSub message MUST be wrapped in a
 * signed GossipEnvelope.
 */
import { ethers } from 'ethers';
import {
  encodeGossipEnvelope,
  decodeGossipEnvelope,
  computeGossipSigningPayload,
  type GossipEnvelopeMsg,
} from '@origintrail-official/dkg-core';

export const GOSSIP_ENVELOPE_VERSION = '10.0.0';

export interface SignEnvelopeParams {
  type: string;
  contextGraphId: string;
  payload: Uint8Array;
  signerWallet: ethers.Wallet;
  timestamp?: string;
}

/** Sign the payload, return the encoded GossipEnvelope wire bytes. */
export function buildSignedGossipEnvelope(p: SignEnvelopeParams): Uint8Array {
  const timestamp = p.timestamp ?? new Date().toISOString();
  const signingPayload = computeGossipSigningPayload(
    p.type,
    p.contextGraphId,
    timestamp,
    p.payload,
  );
  const sigHex = p.signerWallet.signMessageSync(signingPayload);
  const env: GossipEnvelopeMsg = {
    version: GOSSIP_ENVELOPE_VERSION,
    type: p.type,
    contextGraphId: p.contextGraphId,
    agentAddress: p.signerWallet.address,
    timestamp,
    signature: ethers.getBytes(sigHex),
    payload: p.payload,
  };
  return encodeGossipEnvelope(env);
}

/**
 * Try to decode a wire payload as a signed GossipEnvelope.
 *
 * Return shapes:
 *   - `undefined` — bytes are NOT an envelope (legacy raw payload / different
 *     encoding). Callers MAY fall back to processing the raw bytes.
 *   - `{ envelope, recoveredSigner }` — bytes are a well-formed envelope AND
 *     the signature recovered successfully AND the recovered signer matches
 *     `envelope.agentAddress`. Safe to dispatch.
 *
 * For well-formed envelopes whose signature cannot be recovered, or whose
 * recovered signer does NOT match `envelope.agentAddress`, we return
 * `undefined` together with a side-channel log — NOT the envelope. This
 * closes the hole where a forged/tampered envelope would otherwise fall
 * through to the "legacy raw bytes" fallback path in callers and reach the
 * publish/SWM/update/finalization handlers as if it were authenticated
 * .
 *
 * If a caller legitimately needs to inspect the envelope bytes after a bad
 * signature (e.g. for structured telemetry), it can call
 * `decodeGossipEnvelope()` directly and handle the distinction itself —
 * but dispatch code MUST NOT read `envelope.payload` unless this function
 * returned a defined result.
 */
export function tryUnwrapSignedEnvelope(
  data: Uint8Array,
): { envelope: GossipEnvelopeMsg; recoveredSigner: string } | undefined {
  let envelope: GossipEnvelopeMsg;
  try {
    envelope = decodeGossipEnvelope(data);
  } catch {
    return undefined;
  }
  if (envelope.version !== GOSSIP_ENVELOPE_VERSION) {
    return undefined;
  }
  if (!envelope.signature || envelope.signature.length === 0) {
    return undefined;
  }
  if (!envelope.payload || envelope.payload.length === 0) {
    return undefined;
  }
  // From here on, the bytes were a decodable envelope. We treat recovery
  // failure (and signer mismatch) as a hard reject instead of "parsed but
  // unauthenticated": letting such a blob through would make the new
  // envelope-signing layer strictly weaker than having no envelope at all,
  // because callers use `env?.envelope.payload ?? data` to fall back to raw
  // bytes, and a forged envelope would still be processed as legacy gossip.
  let recovered: string;
  try {
    const signingPayload = computeGossipSigningPayload(
      envelope.type,
      envelope.contextGraphId,
      envelope.timestamp,
      envelope.payload,
    );
    recovered = ethers
      .verifyMessage(signingPayload, ethers.hexlify(envelope.signature))
      .toLowerCase();
  } catch {
    return undefined;
  }
  const claimed = (envelope.agentAddress ?? '').toLowerCase();
  if (!claimed || claimed !== recovered) {
    return undefined;
  }
  return { envelope, recoveredSigner: recovered };
}

/**
 * Classification helper used by ingress logging/metrics to distinguish
 * "legacy raw" from "tampered" without relaxing the dispatch rule.
 *
 * pre-fix this
 * helper classified parsed envelopes with a wrong `version` (or empty
 * signature/payload) as `'raw'`. With `strictGossipEnvelope` disabled
 * for rolling upgrades, the dispatcher would then accept those bytes
 * as legacy unsigned gossip and bypass signature verification — a peer
 * could downgrade an envelope to "legacy raw" by setting an unknown
 * `version` byte. Parsed-but-invalid envelopes must classify as
 * `'forged'`, not `'raw'`. `'raw'` is reserved for byte streams that
 * are not envelopes at all (i.e. `decodeGossipEnvelope` threw).
 *
 * Returns:
 *   - 'raw'       — bytes did NOT decode as a gossip envelope at all
 *                   (legacy / unsigned protobuf wire format).
 *   - 'verified'  — well-formed envelope with a valid signature that
 *                   matches `envelope.agentAddress`.
 *   - 'forged'    — bytes decoded as an envelope but failed any of the
 *                   structural / cryptographic checks (wrong version,
 *                   missing signature, missing payload, recovery failure,
 *                   signer mismatch). Dispatch MUST drop these.
 */
export function classifyGossipBytes(data: Uint8Array): 'raw' | 'verified' | 'forged' {
  let envelope: GossipEnvelopeMsg;
  try {
    envelope = decodeGossipEnvelope(data);
  } catch {
    return 'raw';
  }
  // From here on the bytes WERE an envelope. Any structural failure
  // means the sender attempted to forge / downgrade an envelope and
  // must NOT be re-promoted to "legacy raw" — that's exactly the
  // bypass r3131820480 closes.
  if (envelope.version !== GOSSIP_ENVELOPE_VERSION) return 'forged';
  if (!envelope.signature || envelope.signature.length === 0) return 'forged';
  if (!envelope.payload || envelope.payload.length === 0) return 'forged';
  try {
    const signingPayload = computeGossipSigningPayload(
      envelope.type,
      envelope.contextGraphId,
      envelope.timestamp,
      envelope.payload,
    );
    const recovered = ethers
      .verifyMessage(signingPayload, ethers.hexlify(envelope.signature))
      .toLowerCase();
    const claimed = (envelope.agentAddress ?? '').toLowerCase();
    return claimed && claimed === recovered ? 'verified' : 'forged';
  } catch {
    return 'forged';
  }
}

/**
 * Sign the body of a `PublishRequestMsg` so the existing R/Vs signature
 * fields carry a real EIP-2098 compact signature receivers can verify.
 * Required by
 * forbids any source-line containing the empty-signature pattern.
 */
export interface PublishRequestSig {
  publisherSignatureR: Uint8Array;
  publisherSignatureVs: Uint8Array;
}

const ZERO_BYTES: Uint8Array = new Uint8Array(0);
const EMPTY_SIG: PublishRequestSig = Object.freeze({
  publisherSignatureR: ZERO_BYTES,
  publisherSignatureVs: ZERO_BYTES,
}) as PublishRequestSig;

/**
 * Build the EIP-2098 compact signature pair to populate the R/Vs fields of
 * `PublishRequestMsg`. When no wallet is available (pre-bootstrap nodes),
 * returns zero-length placeholders so the field shape is preserved.
 */
export function buildPublishRequestSig(
  signerWallet: ethers.Wallet | undefined,
  ual: string,
  ntriplesBuf: Uint8Array,
): PublishRequestSig {
  if (!signerWallet) return EMPTY_SIG;
  const digest = ethers.keccak256(
    ethers.solidityPacked(['string', 'bytes'], [ual, ntriplesBuf]),
  );
  const sig = signerWallet.signingKey.sign(digest);
  return {
    publisherSignatureR: ethers.getBytes(sig.r),
    publisherSignatureVs: ethers.getBytes(sig.yParityAndS),
  };
}

/** @deprecated kept for back-compat; use {@link buildPublishRequestSig}. */
export function signPublishRequestBody(
  signerWallet: ethers.Wallet,
  ual: string,
  ntriplesBuf: Uint8Array,
): PublishRequestSig {
  return buildPublishRequestSig(signerWallet, ual, ntriplesBuf);
}
