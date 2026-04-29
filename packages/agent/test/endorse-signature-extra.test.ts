/**
 * ENDORSE protocol — signature + replay tests.
 *
 * Audit findings covered:
 *   A-7 (HIGH / SPEC-GAP) — spec §03 and §10 require that endorsements be
 *        cryptographically bound to the endorsing agent: a signature over
 *        a canonical digest of (agentAddress, knowledgeAssetUal, ctxGraph,
 *        endorsedAt[, nonce]) so that tampering or replay can be detected.
 *
 *        The current implementation in `packages/agent/src/endorse.ts`
 *        emits only two plain RDF quads with NO signature, NO nonce and
 *        NO replay-protection nonce store. Any peer can forge an
 *        endorsement on behalf of another agent by emitting the same two
 *        quads with a different `did:dkg:agent:` subject.
 *
 *        Tests below pin the positive contract (signing over a canonical
 *        digest recovers the agent), and the negative contract (tamper →
 *        recover fails; replay → duplicate quad detected). Additionally,
 *        a RED test documents that `buildEndorsementQuads` does NOT emit
 *        any signature quad — that failure is the evidence of A-7.
 *
 * No mocks — uses real `ethers.Wallet` and `buildEndorsementQuads`.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  buildEndorsementQuads,
  buildEndorsementQuadsAsync,
  DKG_ENDORSES,
  DKG_ENDORSED_AT,
  DKG_ENDORSEMENT_NONCE,
  DKG_ENDORSEMENT_SIGNATURE,
} from '../src/endorse.js';
import {
  eip191Hash,
  keccak256,
  keccak256Hex,
} from '@origintrail-official/dkg-core';

function canonicalEndorseDigest(
  agentAddress: string,
  ual: string,
  contextGraphId: string,
  endorsedAt: string,
  nonce: string,
): Uint8Array {
  // Canonical preimage: pipe-separated, address lower-cased. Keep it
  // explicit and stable so any implementation can reproduce it.
  const preimage = [
    agentAddress.toLowerCase(),
    ual,
    contextGraphId,
    endorsedAt,
    nonce,
  ].join('|');
  return keccak256(new TextEncoder().encode(preimage));
}

describe('A-7: ENDORSE canonical digest + EIP-191 signing (proposed contract)', () => {
  it('signing the canonical digest recovers the endorsing agent', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ual = 'did:dkg:base:84532/0xabc/42';
    const cg = 'ml-research';
    const endorsedAt = '2026-04-20T12:00:00.000Z';
    const nonce = 'nonce-1';

    const digest = canonicalEndorseDigest(wallet.address, ual, cg, endorsedAt, nonce);
    const signature = await wallet.signMessage(digest);

    const recovered = ethers.verifyMessage(digest, signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

    // Digest derivation is deterministic and matches eip191Hash framing.
    expect(Buffer.from(eip191Hash(digest)).toString('hex'))
      .toBe(ethers.hashMessage(digest).replace(/^0x/, ''));
  });

  it('flipping a single bit of the signature breaks recovery', async () => {
    const wallet = ethers.Wallet.createRandom();
    const digest = canonicalEndorseDigest(
      wallet.address, 'ual:x', 'cg-1', '2026-01-01T00:00:00.000Z', 'n1',
    );
    const sig = await wallet.signMessage(digest);
    const bytes = ethers.getBytes(sig);
    bytes[0] ^= 0x01; // flip one bit in the r component
    // Tampered signature either recovers to a different address or fails
    // to parse at all — both outcomes prove the guard works.
    let recovered: string | null = null;
    try {
      recovered = ethers.verifyMessage(digest, ethers.hexlify(bytes));
    } catch {
      recovered = null;
    }
    if (recovered !== null) {
      expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
    }
  });

  it('tampering with the UAL changes the digest → recovered address mismatches', async () => {
    const wallet = ethers.Wallet.createRandom();
    const orig = canonicalEndorseDigest(
      wallet.address, 'ual:good', 'cg-1', '2026-01-01T00:00:00.000Z', 'n1',
    );
    const tampered = canonicalEndorseDigest(
      wallet.address, 'ual:evil', 'cg-1', '2026-01-01T00:00:00.000Z', 'n1',
    );
    expect(keccak256Hex(orig)).not.toBe(keccak256Hex(tampered));

    const sig = await wallet.signMessage(orig);
    const recoveredFromTampered = ethers.verifyMessage(tampered, sig);
    expect(recoveredFromTampered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('replay protection: an endorsement nonce set rejects the same (agent,ual,nonce) twice', () => {
    // Simple reference implementation of the required replay guard the
    // agent layer must apply — seen-set keyed by (agent, ual, nonce).
    const seen = new Set<string>();
    const accept = (agent: string, ual: string, nonce: string): boolean => {
      const key = `${agent.toLowerCase()}|${ual}|${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const w = ethers.Wallet.createRandom();
    expect(accept(w.address, 'ual:x', 'n1')).toBe(true);
    expect(accept(w.address, 'ual:x', 'n1')).toBe(false); // replay
    expect(accept(w.address, 'ual:x', 'n2')).toBe(true);  // new nonce is fine
  });
});

describe('A-7: buildEndorsementQuads MUST emit a signature quad (currently fails)', () => {
  // PROD-BUG: `buildEndorsementQuads` emits only DKG_ENDORSES and
  // DKG_ENDORSED_AT — it never attaches a signature over a canonical
  // endorsement digest, so any peer can forge an endorsement. This test
  // pins the spec expectation; it is RED against the current impl.
  it('includes a signature / proof quad alongside DKG_ENDORSES + DKG_ENDORSED_AT', () => {
    const quads = buildEndorsementQuads(
      '0x0000000000000000000000000000000000000001',
      'did:dkg:base:84532/0xabc/1',
      'cg-1',
    );

    // Baseline: the two known quads are still there.
    expect(quads.find(q => q.predicate === DKG_ENDORSES)).toBeDefined();
    expect(quads.find(q => q.predicate === DKG_ENDORSED_AT)).toBeDefined();

    // PROD-BUG: no signature / proof quad exists. Spec §10 ("VERIFY")
    // expects endorsements to be cryptographically bound to the agent.
    const hasProof = quads.some(q =>
      q.predicate.toLowerCase().includes('signature') ||
      q.predicate.toLowerCase().includes('proof') ||
      q.predicate.toLowerCase().includes('sig'),
    );
    expect(
      hasProof,
      'buildEndorsementQuads does not attach a signature over a canonical endorsement digest',
    ).toBe(true);
  });

  it('emits a nonce / replay-protection quad', () => {
    const quads = buildEndorsementQuads(
      '0x0000000000000000000000000000000000000002',
      'did:dkg:base:84532/0xabc/2',
      'cg-1',
    );
    // PROD-BUG: no nonce / salt is attached; identical endorsements emit
    // byte-identical quads (minus the timestamp — and two endorsements
    // emitted within the same ms produce fully identical quads). That
    // cannot serve as replay protection.
    const hasNonce = quads.some(q =>
      q.predicate.toLowerCase().includes('nonce') ||
      q.predicate.toLowerCase().includes('salt'),
    );
    expect(
      hasNonce,
      'buildEndorsementQuads does not attach a nonce',
    ).toBe(true);
  });
});

// the previous DKGAgent.endorse() implementation
// pulled the signer from `(this.wallet as { ethWallet }).ethWallet`, but
// `DKGAgentWallet` does not expose an `ethWallet` field, so the signer was
// always `undefined` in production and the signature quad silently held the
// unsigned digest hex. The fix routes through `getDefaultPublisherWallet()`
// (an `ethers.Wallet` derived from the registered local agent's privateKey).
//
// The tests below pin the contract that buildEndorsementQuadsAsync MUST honour
// when wired with a real `ethers.Wallet.signMessage` signer:
//
//   - the signature quad MUST be a 0x-prefixed EIP-191 personal-sign signature
//     (132 hex chars, not the 66-char keccak digest);
//   - `ethers.verifyMessage(canonicalDigest, signature)` MUST recover the
//     wallet's checksummed address;
//   - flipping any tuple field (UAL, agent, ctxGraph, timestamp, nonce)
//     MUST cause recovery to land on a different address.
//
// Together with the production fix in dkg-agent.ts (which now selects the
// signer via getDefaultPublisherWallet → ethers.Wallet.signMessage),
// these tests catch the canonicalisation regression.
describe('A-7 / D1: buildEndorsementQuadsAsync with a real ethers.Wallet signer', () => {
  it('emits a real EIP-191 signature that recovers to the signing wallet', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ual = 'did:dkg:base:84532/0xabc/42';
    const cg = 'ml-research';
    const fixedNow = new Date('2026-04-22T12:00:00.000Z');
    const fixedNonce = '0x' + '11'.repeat(16);

    const quads = await buildEndorsementQuadsAsync(
      wallet.address,
      ual,
      cg,
      {
        signer: (digest) => wallet.signMessage(digest),
        now: fixedNow,
        nonce: fixedNonce,
      },
    );

    const sigQuad = quads.find((q) => q.predicate === DKG_ENDORSEMENT_SIGNATURE);
    expect(sigQuad, 'must emit endorsementSignature quad').toBeDefined();

    const sigLiteral = sigQuad!.object;
    const sigHex = sigLiteral.replace(/^"/, '').replace(/"$/, '');
    expect(sigHex, 'signature must be 0x-prefixed').toMatch(/^0x[0-9a-fA-F]+$/);
    expect(sigHex.length, 'EIP-191 sig is 132 chars (0x + 65 bytes)').toBe(132);

    const { canonicalEndorseDigest } = await import('../src/endorse.js');
    const digest = canonicalEndorseDigest(wallet.address, ual, cg, fixedNow.toISOString(), fixedNonce);
    const recovered = ethers.verifyMessage(digest, sigHex);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('falls back to the digest hex (NOT a signature) when no signer is wired — proves the production fix matters', async () => {
    const wallet = ethers.Wallet.createRandom();
    const quads = await buildEndorsementQuadsAsync(
      wallet.address,
      'ual:no-sig',
      'cg-1',
      { now: new Date('2026-01-01T00:00:00.000Z'), nonce: '0x' + '22'.repeat(16) },
    );
    const sigQuad = quads.find((q) => q.predicate === DKG_ENDORSEMENT_SIGNATURE)!;
    const sigHex = sigQuad.object.replace(/^"/, '').replace(/"$/, '');
    expect(sigHex.length, 'unsigned digest hex is 66 chars (0x + 32 bytes)').toBe(66);

    let recovered: string | null = null;
    try {
      recovered = ethers.verifyMessage(new Uint8Array(0), sigHex);
    } catch {
      recovered = null;
    }
    expect(recovered === null || recovered.toLowerCase() !== wallet.address.toLowerCase()).toBe(true);
  });

  it('tampering with the UAL after signing breaks recovery (any tuple-field tamper does)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const fixedNow = new Date('2026-02-02T00:00:00.000Z');
    const fixedNonce = '0x' + '33'.repeat(16);
    const quads = await buildEndorsementQuadsAsync(
      wallet.address,
      'ual:legit',
      'cg-1',
      { signer: (digest) => wallet.signMessage(digest), now: fixedNow, nonce: fixedNonce },
    );
    const sigQuad = quads.find((q) => q.predicate === DKG_ENDORSEMENT_SIGNATURE)!;
    const sigHex = sigQuad.object.replace(/^"/, '').replace(/"$/, '');

    const { canonicalEndorseDigest } = await import('../src/endorse.js');
    const tampered = canonicalEndorseDigest(wallet.address, 'ual:tampered', 'cg-1', fixedNow.toISOString(), fixedNonce);
    const recovered = ethers.verifyMessage(tampered, sigHex);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('returns the timestamp/nonce/digest tuple aligned with the canonical preimage', async () => {
    const wallet = ethers.Wallet.createRandom();
    const fixedNow = new Date('2026-03-03T03:33:33.333Z');
    const fixedNonce = '0x' + '44'.repeat(16);
    const quads = await buildEndorsementQuadsAsync(
      wallet.address,
      'ual:tuple',
      'cg-tuple',
      { signer: (d) => wallet.signMessage(d), now: fixedNow, nonce: fixedNonce },
    );
    const tsQuad = quads.find((q) => q.predicate === DKG_ENDORSED_AT)!;
    const nonceQuad = quads.find((q) => q.predicate === DKG_ENDORSEMENT_NONCE)!;
    expect(tsQuad.object).toContain(fixedNow.toISOString());
    expect(nonceQuad.object).toContain(fixedNonce);
  });

  // the signer MUST match the
  // `agentAddress` embedded in the quads, otherwise recovery yields a
  // different address than the one peers see in the payload and the
  // endorsement is unverifiable (or worse, silently attributed to the
  // wrong identity). This test pins that mismatch mode explicitly.
  it('is NOT verifiable when the signer wallet does not match the embedded agentAddress', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    const wrongWallet = ethers.Wallet.createRandom();
    expect(agentWallet.address).not.toBe(wrongWallet.address);
    const fixedNow = new Date('2026-05-05T05:05:05.555Z');
    const fixedNonce = '0x' + '55'.repeat(16);
    const quads = await buildEndorsementQuadsAsync(
      agentWallet.address,
      'ual:mismatch',
      'cg-mismatch',
      {
        signer: (d) => wrongWallet.signMessage(d),
        now: fixedNow,
        nonce: fixedNonce,
      },
    );
    const sigQuad = quads.find((q) => q.predicate === DKG_ENDORSEMENT_SIGNATURE)!;
    const sigHex = sigQuad.object.replace(/^"/, '').replace(/"$/, '');
    const digest = canonicalEndorseDigest(
      agentWallet.address,
      'ual:mismatch',
      'cg-mismatch',
      fixedNow.toISOString(),
      fixedNonce,
    );
    const recovered = ethers.verifyMessage(digest, sigHex);
    expect(recovered.toLowerCase()).toBe(wrongWallet.address.toLowerCase());
    expect(recovered.toLowerCase()).not.toBe(agentWallet.address.toLowerCase());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — dkg-agent.ts:5424).
// Pre-fix `DKGAgent.endorse()` fell through to
// `buildEndorsementQuadsAsync(..., {})` (NO signer) when the supplied
// `opts.agentAddress` was not backed by any local wallet, publishing
// an endorsement carrying ONLY the unsigned digest hex.
// `resolveEndorsementFacts()` (`packages/agent/src/ccl-fact-resolution.ts`)
// counts `dkg:endorses` quads by joining
//   ?endorsement dkg:endorses   ?ual .
//   ?endorsement dkg:endorsedBy ?endorser .
// without verifying the EIP-191 signature on
// `dkg:endorsementSignature`, so a caller could publish endorsements
// claiming arbitrary external agent identities and inflate
// endorsement-based provenance / CCL counts.
//
// Source-level test: assert the production fix is in place. We avoid
// booting a full DKGAgent (libp2p + chain harness) for this guard
// because the bug is structural — the throw must exist on the
// fall-through path. A future regression that re-introduces the
// silent unsigned-digest branch will fail this check.
// ─────────────────────────────────────────────────────────────────────────────
describe('A-7 / r29-2: DKGAgent.endorse() refuses to publish unsigned external endorsements', () => {
  it('source guards the no-local-wallet branch with an explicit throw (no silent unsigned-digest fallthrough)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(resolve(here, '..', 'src', 'dkg-agent.ts'), 'utf8');

    // Locate the endorse() body. We can't just `indexOf('\n  }')`
    // because the parameter type literal `opts: { ... }` itself
    // contains a 2-space-indented `}`. Walk balanced braces from the
    // first `{` after the signature until depth returns to zero.
    const endorseStart = src.indexOf('async endorse(opts: {');
    expect(endorseStart, 'endorse() definition must exist').toBeGreaterThan(-1);
    const bodyOpenIdx = src.indexOf(': Promise<PublishResult> {', endorseStart);
    expect(bodyOpenIdx, 'endorse() body opener must exist').toBeGreaterThan(endorseStart);
    let depth = 0;
    let endorseEnd = -1;
    for (let i = bodyOpenIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endorseEnd = i + 1; break; }
      }
    }
    expect(endorseEnd, 'endorse() closing brace must be balanced').toBeGreaterThan(bodyOpenIdx);
    const endorseBody = src.slice(endorseStart, endorseEnd);

    // The "external agent without local wallet" branch MUST throw.
    expect(
      /throw new Error\([^)]*refusing to publish endorsement on behalf of external agent/i
        .test(endorseBody),
      'endorse() must reject external agentAddress without a recoverable signature',
    ).toBe(true);

    // And the prior silent-fall-through that built quads with `{}`
    // (no signer) must NOT survive on the no-wallet path. Pre-fix
    // shape: `signer ? { signer } : {}`. Any reappearance of that
    // ternary near `buildEndorsementQuadsAsync` indicates the
    // regression is back.
    const buildCallIdx = endorseBody.indexOf('buildEndorsementQuadsAsync(');
    expect(buildCallIdx, 'buildEndorsementQuadsAsync call must exist').toBeGreaterThan(-1);
    const callSlice = endorseBody.slice(buildCallIdx, buildCallIdx + 400);
    expect(
      /signer\s*\?\s*\{\s*signer\s*\}\s*:\s*\{\s*\}/.test(callSlice),
      'endorse() must NOT pass `{}` (no signer) to buildEndorsementQuadsAsync',
    ).toBe(false);
  });
});
