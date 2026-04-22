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
  DKG_ENDORSES,
  DKG_ENDORSED_AT,
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
  // See BUGS_FOUND.md A-7.
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
      'buildEndorsementQuads does not attach a signature over a canonical endorsement digest (BUGS_FOUND.md A-7)',
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
      'buildEndorsementQuads does not attach a nonce (BUGS_FOUND.md A-7)',
    ).toBe(true);
  });
});
