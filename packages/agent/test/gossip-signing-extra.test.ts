/**
 * Gossip envelope signing matrix — every GossipSub message must be wrapped
 * in a signed `GossipEnvelope` per packages/core/src/proto/gossip-envelope.ts
 * and dkgv10-spec §08_PROTOCOL_WIRE.md. Receivers MUST reject:
 *   - unsigned envelopes,
 *   - envelopes signed by a non-member of the Context Graph,
 *   - envelopes with a tampered payload,
 *   - envelopes with a stale timestamp (older than the configured freshness
 *     window — here 5 minutes, matching MsgValidator in gossip-validation).
 *
 * Audit findings covered:
 *   A-15 (MEDIUM / PROD-BUG) — the DKGAgent `broadcastPublish` path sends
 *        `PublishRequestMsg`s with empty `publisherSignatureR`/`Vs` and
 *        does NOT wrap them in a `GossipEnvelope`. Nothing on the receive
 *        side can authenticate the publisher. This file:
 *          1. Proves the positive envelope contract (sign → verify roundtrip).
 *          2. Pins every negative rejection path.
 *          3. Surfaces the PROD-BUG via a RED static-scan test showing
 *             neither `encodeGossipEnvelope` nor `computeGossipSigningPayload`
 *             is imported anywhere in `packages/agent/src`.
 *
 * No mocks — real `ethers.Wallet`, real envelope codec.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeGossipSigningPayload,
  decodeGossipEnvelope,
  encodeGossipEnvelope,
  type GossipEnvelopeMsg,
} from '@origintrail-official/dkg-core';
import { classifyGossipBytes } from '../src/signed-gossip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = resolve(__dirname, '..', 'src');

const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

async function signEnvelope(
  wallet: ethers.Wallet,
  params: {
    type: string;
    contextGraphId: string;
    payload: Uint8Array;
    timestamp?: string;
  },
): Promise<GossipEnvelopeMsg> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const signingPayload = computeGossipSigningPayload(
    params.type,
    params.contextGraphId,
    timestamp,
    params.payload,
  );
  const sig = await wallet.signMessage(signingPayload);
  return {
    version: '10.0.0',
    type: params.type,
    contextGraphId: params.contextGraphId,
    agentAddress: wallet.address,
    timestamp,
    signature: ethers.getBytes(sig),
    payload: params.payload,
  };
}

function verifyEnvelope(
  env: GossipEnvelopeMsg,
  opts: { allowedMembers: Set<string>; now?: number },
): { ok: true } | { ok: false; reason: string } {
  if (!env.signature || env.signature.length === 0) {
    return { ok: false, reason: 'missing signature' };
  }
  if (env.version !== '10.0.0') {
    return { ok: false, reason: 'bad version' };
  }
  const now = opts.now ?? Date.now();
  const ts = Date.parse(env.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(now - ts) > FRESHNESS_WINDOW_MS) {
    return { ok: false, reason: 'expired timestamp' };
  }
  const signingPayload = computeGossipSigningPayload(
    env.type, env.contextGraphId, env.timestamp, env.payload,
  );
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(signingPayload, ethers.hexlify(env.signature));
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  if (recovered.toLowerCase() !== env.agentAddress.toLowerCase()) {
    return { ok: false, reason: 'signer mismatch' };
  }
  if (!opts.allowedMembers.has(recovered.toLowerCase())) {
    return { ok: false, reason: 'non-member' };
  }
  return { ok: true };
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('A-15: gossip envelope signing matrix', () => {
  const CG = 'cg-v10-test';

  it('positive: signed envelope round-trips and is accepted by a CG member', async () => {
    const wallet = ethers.Wallet.createRandom();
    const members = new Set([wallet.address.toLowerCase()]);
    const payload = new TextEncoder().encode('hello v10');

    const env = await signEnvelope(wallet, { type: 'PUBLISH_REQUEST', contextGraphId: CG, payload });
    const wire = encodeGossipEnvelope(env);

    // Round-trip through the wire codec.
    const decoded = decodeGossipEnvelope(wire);
    expect(decoded.type).toBe('PUBLISH_REQUEST');
    expect(decoded.contextGraphId).toBe(CG);

    const result = verifyEnvelope(decoded, { allowedMembers: members });
    expect(result).toEqual({ ok: true });
  });

  it('negative: unsigned envelope is rejected', async () => {
    const wallet = ethers.Wallet.createRandom();
    const members = new Set([wallet.address.toLowerCase()]);
    const env: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      agentAddress: wallet.address,
      timestamp: new Date().toISOString(),
      signature: new Uint8Array(0),
      payload: new TextEncoder().encode('no sig'),
    };
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result).toEqual({ ok: false, reason: 'missing signature' });
  });

  it('negative: tampered payload — signature no longer recovers signer', async () => {
    const wallet = ethers.Wallet.createRandom();
    const members = new Set([wallet.address.toLowerCase()]);
    const env = await signEnvelope(wallet, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('original'),
    });
    env.payload = new TextEncoder().encode('tampered');
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result.ok).toBe(false);
  });

  it('negative: wrong-signer — envelope signed by a different wallet is rejected', async () => {
    const realMember = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const members = new Set([realMember.address.toLowerCase()]);
    const env = await signEnvelope(impostor, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('from impostor'),
    });
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result).toEqual({ ok: false, reason: 'non-member' });
  });

  it('negative: envelope whose `agentAddress` field disagrees with the recovered signer is rejected', async () => {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const members = new Set([wallet.address.toLowerCase(), other.address.toLowerCase()]);
    const env = await signEnvelope(wallet, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('x'),
    });
    // Impersonation attempt: claim to be `other`, but the signature is from `wallet`.
    env.agentAddress = other.address;
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result).toEqual({ ok: false, reason: 'signer mismatch' });
  });

  it('negative: expired-timestamp envelope is rejected', async () => {
    const wallet = ethers.Wallet.createRandom();
    const members = new Set([wallet.address.toLowerCase()]);
    const oldTimestamp = new Date(Date.now() - FRESHNESS_WINDOW_MS - 1_000).toISOString();
    const env = await signEnvelope(wallet, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('stale'),
      timestamp: oldTimestamp,
    });
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result).toEqual({ ok: false, reason: 'expired timestamp' });
  });

  it('negative: CG-non-member — signer not on the allowList is rejected', async () => {
    const wallet = ethers.Wallet.createRandom();
    const members = new Set<string>(); // empty allowlist
    const env = await signEnvelope(wallet, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('x'),
    });
    const result = verifyEnvelope(env, { allowedMembers: members });
    expect(result).toEqual({ ok: false, reason: 'non-member' });
  });

  it('envelope encoding is deterministic — same inputs → identical wire bytes', async () => {
    const wallet = ethers.Wallet.createRandom();
    const e1 = await signEnvelope(wallet, {
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      payload: new TextEncoder().encode('det'),
      timestamp: '2026-04-20T00:00:00.000Z',
    });
    const e2: GossipEnvelopeMsg = { ...e1 };
    expect(Buffer.from(encodeGossipEnvelope(e1)).toString('hex'))
      .toBe(Buffer.from(encodeGossipEnvelope(e2)).toString('hex'));
  });
});

describe('A-15: PROD-BUG — DKGAgent publishes gossip WITHOUT signing', () => {
  // PROD-BUG: `packages/agent/src/dkg-agent.ts` calls
  //   this.gossip.publish(topic, encodePublishRequest({ ...,
  //     publisherSignatureR: new Uint8Array(0),
  //     publisherSignatureVs: new Uint8Array(0),
  //   }))
  // and never wraps the message in a `GossipEnvelope`. Receivers therefore
  // cannot authenticate the publisher or detect replay. See
  // BUGS_FOUND.md A-15.
  //
  // Both tests in this block are expected to be RED against the current
  // implementation. They go GREEN once the agent imports
  // `encodeGossipEnvelope` + `computeGossipSigningPayload` and signs.

  it('agent source imports GossipEnvelope + computeGossipSigningPayload', () => {
    const files = walk(AGENT_SRC);
    let importsEnvelope = false;
    let importsSigningPayload = false;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/encodeGossipEnvelope|GossipEnvelopeMsg|decodeGossipEnvelope/.test(src)) {
        importsEnvelope = true;
      }
      if (/computeGossipSigningPayload/.test(src)) {
        importsSigningPayload = true;
      }
    }
    expect(
      importsEnvelope && importsSigningPayload,
      'packages/agent/src has no GossipEnvelope / computeGossipSigningPayload usage — unsigned gossip (BUGS_FOUND.md A-15)',
    ).toBe(true);
  });

  it('agent source does NOT emit PublishRequestMsg with empty publisherSignatureR/Vs', () => {
    const files = walk(AGENT_SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/publisherSignatureR\s*:\s*new Uint8Array\(0\)/.test(line)) {
          offenders.push({ file: f.replace(AGENT_SRC + '/', ''), line: i + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders.length,
      `Empty publisher signatures found (BUGS_FOUND.md A-15):\n${JSON.stringify(offenders, null, 2)}`,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR #229 bot review r3131820480 (signed-gossip.ts:136) — parsed-but-invalid
// envelopes MUST NOT be downgraded to `'raw'`. With `strictGossipEnvelope`
// off (rolling upgrade), the dispatcher accepts `'raw'` as legacy unsigned
// gossip; the original `classifyGossipBytes` branch returned `'raw'` for any
// envelope whose `version` byte didn't match `GOSSIP_ENVELOPE_VERSION`, for
// missing-signature envelopes, and for missing-payload envelopes. A peer
// could therefore bypass signing by setting `version='99.0.0'`. The fix
// classifies all such cases as `'forged'`, and the dispatcher already drops
// `'forged'`. These tests pin the new contract.
// ---------------------------------------------------------------------------
describe('classifyGossipBytes — parsed-but-invalid envelopes are FORGED, not RAW (r3131820480)', () => {
  const CG = 'cg-classify';

  function makeEnvelopeBytes(over: Partial<GossipEnvelopeMsg> = {}): Uint8Array {
    const wallet = ethers.Wallet.createRandom();
    const ts = '2026-04-20T00:00:00.000Z';
    const payload = new TextEncoder().encode('p');
    // Build a valid envelope first, then mutate.
    const signingPayload = computeGossipSigningPayload('PUBLISH_REQUEST', CG, ts, payload);
    const sigHex = wallet.signMessageSync(signingPayload);
    const env: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      agentAddress: wallet.address,
      timestamp: ts,
      signature: ethers.getBytes(sigHex),
      payload,
      ...over,
    };
    return encodeGossipEnvelope(env);
  }

  it('returns "raw" for bytes that do not decode as an envelope at all', () => {
    // Random non-protobuf bytes — `decodeGossipEnvelope` throws → 'raw'.
    // (Legacy unsigned gossip is the legitimate `'raw'` case.)
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(classifyGossipBytes(garbage)).toBe('raw');
  });

  it('returns "forged" for an envelope with a wrong version byte (was "raw" → bypass)', () => {
    const bytes = makeEnvelopeBytes({ version: '99.0.0' });
    expect(classifyGossipBytes(bytes)).toBe('forged');
  });

  it('returns "forged" for an envelope with no signature (was "raw" → bypass)', () => {
    const bytes = makeEnvelopeBytes({ signature: new Uint8Array(0) });
    expect(classifyGossipBytes(bytes)).toBe('forged');
  });

  it('returns "forged" for an envelope with no payload (was "raw" → bypass)', () => {
    const bytes = makeEnvelopeBytes({ payload: new Uint8Array(0) });
    expect(classifyGossipBytes(bytes)).toBe('forged');
  });

  it('returns "forged" for an envelope whose signer does not match agentAddress', () => {
    const wallet = ethers.Wallet.createRandom();
    const otherWallet = ethers.Wallet.createRandom();
    const ts = '2026-04-20T00:00:00.000Z';
    const payload = new TextEncoder().encode('p');
    const signingPayload = computeGossipSigningPayload('PUBLISH_REQUEST', CG, ts, payload);
    const sigHex = wallet.signMessageSync(signingPayload);
    const env: GossipEnvelopeMsg = {
      version: '10.0.0',
      type: 'PUBLISH_REQUEST',
      contextGraphId: CG,
      agentAddress: otherWallet.address, // claims someone ELSE signed it
      timestamp: ts,
      signature: ethers.getBytes(sigHex),
      payload,
    };
    expect(classifyGossipBytes(encodeGossipEnvelope(env))).toBe('forged');
  });

  it('returns "verified" for a properly-signed envelope (positive control)', () => {
    const bytes = makeEnvelopeBytes();
    expect(classifyGossipBytes(bytes)).toBe('verified');
  });
});
