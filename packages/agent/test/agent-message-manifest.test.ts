// agent-message-manifest.test.ts
//
// Unit tests for the V1 agent-addressed messaging manifest
// (packages/agent/src/agent-message-manifest.ts).
//
// The highest-risk surface is `serializeCompactSignature`: the chain
// adapter returns a compact EIP-2098 `{ r, vs }` pair, and we reassemble
// it into a 65-byte signature for `ethers.verifyMessage`. A byte-order or
// yParity bug there would fail-closed (never authenticate) rather than
// crash — so every round-trip test below deliberately produces the SAME
// `{ r: Uint8Array, vs: Uint8Array }` shape the adapter emits and runs it
// through the real serialize→verify path, not `wallet.signMessage` +
// `ethers.verifyMessage` directly (which would skip the reserialization).

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  agentManifestDigestBytes,
  serializeCompactSignature,
  verifyAgentMessageManifest,
  AGENT_MESSAGE_MAX_SKEW_MS,
} from '../src/agent-message-manifest.js';

const SENDER = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const OTHER = new ethers.Wallet(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/**
 * Sign a manifest the way `EvmAdapter.signMessageAs` does: EIP-191 over the
 * 32-byte digest, decomposed into the compact `{ r, vs }` return shape, then
 * reassembled via the code under test.
 */
async function signManifest(
  wallet: ethers.Wallet,
  input: { from: string; to: string; messageId: string; ts: number; text: string },
): Promise<string> {
  const digest = agentManifestDigestBytes(input);
  const flat = await wallet.signMessage(digest);
  const s = ethers.Signature.from(flat);
  const compact = { r: ethers.getBytes(s.r), vs: ethers.getBytes(s.yParityAndS) };
  return serializeCompactSignature(compact);
}

describe('agent-message-manifest', () => {
  const base = {
    from: SENDER.address,
    to: RECIPIENT,
    messageId: '11111111-1111-4111-8111-111111111111',
    ts: 1_700_000_000_000,
    text: 'hello 0x123',
  };

  it('round-trips a valid manifest through the compact→serialized path', async () => {
    const sig = await signManifest(SENDER, base);
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: base.to,
      sig,
      ts: base.ts,
      messageId: base.messageId,
      text: base.text,
      nowMs: base.ts + 1_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // checksummed + authenticated identities
      expect(result.manifest.from).toBe(ethers.getAddress(SENDER.address));
      expect(result.manifest.to).toBe(ethers.getAddress(RECIPIENT));
      expect(result.manifest.ts).toBe(base.ts);
    }
  });

  it('rejects a tampered message text (content is bound)', async () => {
    const sig = await signManifest(SENDER, base);
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: base.to,
      sig,
      ts: base.ts,
      messageId: base.messageId,
      text: 'hello 0xEVIL', // changed after signing
      nowMs: base.ts,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a swapped messageId (dedup key is bound)', async () => {
    const sig = await signManifest(SENDER, base);
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: base.to,
      sig,
      ts: base.ts,
      messageId: '22222222-2222-4222-8222-222222222222', // not the signed id
      text: base.text,
      nowMs: base.ts,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a spoofed `from` — signer must equal claimed sender', async () => {
    // OTHER signs, but the manifest claims it is from SENDER.
    const sig = await signManifest(OTHER, base);
    const result = verifyAgentMessageManifest({
      from: base.from, // SENDER — a lie
      to: base.to,
      sig,
      ts: base.ts,
      messageId: base.messageId,
      text: base.text,
      nowMs: base.ts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not match sender');
  });

  it('accepts a signature from the custodial keystore path (direct Wallet.signMessage)', async () => {
    // Custodial agents sign with their own keystore wallet, which returns an
    // already-serialized 65-byte signature — no compact {r,vs} reassembly.
    // This is the DEFAULT production path (see DKGAgent.sendChat), so it must
    // verify identically to the adapter's compact path exercised above.
    const digest = agentManifestDigestBytes(base);
    const sig = await SENDER.signMessage(digest);
    const result = verifyAgentMessageManifest({ ...base, sig, nowMs: base.ts });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.from).toBe(ethers.getAddress(SENDER.address));
  });

  it('accepts a delayed outbox retry whose ts is hours old', async () => {
    // The durable outbox retries with the ORIGINAL signed `ts` on a ladder that
    // reaches 2h and keeps entries for 24h. Rejecting these would make the
    // outbox faithfully redeliver messages that can never verify — defeating
    // at-least-once delivery. Guards the regression a short window would cause.
    const sig = await signManifest(SENDER, base);
    const result = verifyAgentMessageManifest({
      ...base,
      sig,
      nowMs: base.ts + 6 * 60 * 60_000, // 6h later, still inside the bound
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a stale timestamp outside the skew window', async () => {
    const sig = await signManifest(SENDER, base);
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: base.to,
      sig,
      ts: base.ts,
      messageId: base.messageId,
      text: base.text,
      nowMs: base.ts + AGENT_MESSAGE_MAX_SKEW_MS + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('skew');
  });

  it('rejects a malformed / truncated signature', () => {
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: base.to,
      sig: '0xdeadbeef',
      ts: base.ts,
      messageId: base.messageId,
      text: base.text,
      nowMs: base.ts,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an incomplete manifest (missing fields)', () => {
    const result = verifyAgentMessageManifest({
      from: base.from,
      to: undefined,
      sig: undefined,
      ts: base.ts,
      messageId: base.messageId,
      text: base.text,
      nowMs: base.ts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('incomplete');
  });
});
