import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { keccak256, hashTripleV10 } from '@origintrail-official/dkg-core';
import {
  mintMemberAttestation,
  verifyMemberAttestation,
  computeAttestationDigest,
  type MemberAttestation,
  type MemberAttestationPayload,
} from '../src/swm/member-attestation.js';

function bytesToHex(b: Uint8Array): string {
  return '0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const MEMBER_WALLET = new ethers.Wallet('0x' + '11'.repeat(32));
const OUTSIDER_WALLET = new ethers.Wallet('0x' + '22'.repeat(32));
const KAV_ADDR = '0x' + '5fbdb2315678afecb367f032d93f642f64180aa3'.padStart(40, '0');

const samplePayload: Omit<MemberAttestationPayload, 'version'> = {
  chainId: '31337',
  kavAddress: KAV_ADDR,
  contextGraphId: '42',
  batchId: '7',
  merkleRoot: '0x' + 'ab'.repeat(32),
  plaintextLeafHash: '0x' + 'cd'.repeat(32),
  attesterAddress: MEMBER_WALLET.address,
  attestedAt: 1779580000,
};

async function mint(): Promise<MemberAttestation> {
  return mintMemberAttestation({
    payload: samplePayload,
    sign: async (digest) => MEMBER_WALLET.signMessage(digest),
  });
}

describe('mintMemberAttestation', () => {
  it('produces a structurally valid token (version=1, signature, payload mirror)', async () => {
    const att = await mint();
    expect(att.payload.version).toBe(1);
    expect(att.payload.attesterAddress).toBe(MEMBER_WALLET.address);
    expect(att.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('throws when attesterAddress is malformed', async () => {
    await expect(
      mintMemberAttestation({
        payload: { ...samplePayload, attesterAddress: '0xnotvalid' } as any,
        sign: async () => '0x' + '00'.repeat(65),
      }),
    ).rejects.toThrow(/attesterAddress/);
  });

  it('throws when merkleRoot is not 32 bytes', async () => {
    await expect(
      mintMemberAttestation({
        payload: { ...samplePayload, merkleRoot: '0xabcd' } as any,
        sign: async () => '0x' + '00'.repeat(65),
      }),
    ).rejects.toThrow(/merkleRoot/);
  });
});

describe('computeAttestationDigest', () => {
  it('is deterministic for identical payloads', () => {
    const p1: MemberAttestationPayload = { ...samplePayload, version: 1 };
    const p2: MemberAttestationPayload = { ...samplePayload, version: 1 };
    expect(bytesToHex(computeAttestationDigest(p1))).toEqual(bytesToHex(computeAttestationDigest(p2)));
  });

  it('changes when any field changes', () => {
    const p1: MemberAttestationPayload = { ...samplePayload, version: 1 };
    const p2: MemberAttestationPayload = { ...samplePayload, version: 1, attestedAt: samplePayload.attestedAt + 1 };
    expect(bytesToHex(computeAttestationDigest(p1))).not.toEqual(bytesToHex(computeAttestationDigest(p2)));
  });

  it('binds chain+contract identity (changing kavAddress changes digest)', () => {
    const p1: MemberAttestationPayload = { ...samplePayload, version: 1 };
    const p2: MemberAttestationPayload = { ...samplePayload, version: 1, kavAddress: '0x' + 'ff'.repeat(20) };
    expect(bytesToHex(computeAttestationDigest(p1))).not.toEqual(bytesToHex(computeAttestationDigest(p2)));
  });
});

describe('verifyMemberAttestation', () => {
  it('roundtrips: minted by member, recovers to member, ok=true', async () => {
    const att = await mint();
    const res = await verifyMemberAttestation({ attestation: att });
    expect(res.ok).toBe(true);
    expect(res.recoveredSigner.toLowerCase()).toBe(MEMBER_WALLET.address.toLowerCase());
    expect(res.signerMatchesAttester).toBe(true);
    expect(res.leafCheck).toBe('skipped');
  });

  it('rejects when the signature was made by a different wallet', async () => {
    const att = await mintMemberAttestation({
      payload: samplePayload,
      sign: async (d) => OUTSIDER_WALLET.signMessage(d),
    });
    const res = await verifyMemberAttestation({ attestation: att });
    expect(res.ok).toBe(false);
    expect(res.signerMatchesAttester).toBe(false);
    expect(res.reason).toMatch(/does not match/);
  });

  it('rejects when the signature is tampered', async () => {
    const att = await mint();
    const corrupted: MemberAttestation = {
      ...att,
      signature: att.signature.slice(0, -4) + '0000',
    };
    const res = await verifyMemberAttestation({ attestation: corrupted });
    expect(res.ok).toBe(false);
  });

  it('rejects when the payload is tampered (signature stays the same but digest moves)', async () => {
    const att = await mint();
    const tampered: MemberAttestation = {
      ...att,
      payload: { ...att.payload, attestedAt: att.payload.attestedAt + 1 },
    };
    const res = await verifyMemberAttestation({ attestation: tampered });
    expect(res.ok).toBe(false);
  });

  it('leafCheck=match when caller supplies the right leaf bytes', async () => {
    const leafBytes = hashTripleV10('urn:s', 'urn:p', '"o"');
    const leafHashHex = bytesToHex(keccak256(leafBytes));
    const att = await mintMemberAttestation({
      payload: { ...samplePayload, plaintextLeafHash: leafHashHex },
      sign: async (d) => MEMBER_WALLET.signMessage(d),
    });
    const res = await verifyMemberAttestation({ attestation: att, candidateLeaf: leafBytes });
    expect(res.ok).toBe(true);
    expect(res.leafCheck).toBe('match');
  });

  it('leafCheck=mismatch and ok=false when wrong leaf bytes are supplied', async () => {
    const leafBytes = hashTripleV10('urn:s', 'urn:p', '"o"');
    const otherLeaf = hashTripleV10('urn:s', 'urn:p', '"different"');
    const att = await mintMemberAttestation({
      payload: { ...samplePayload, plaintextLeafHash: bytesToHex(keccak256(leafBytes)) },
      sign: async (d) => MEMBER_WALLET.signMessage(d),
    });
    const res = await verifyMemberAttestation({ attestation: att, candidateLeaf: otherLeaf });
    expect(res.ok).toBe(false);
    expect(res.leafCheck).toBe('mismatch');
  });

  it('membership=confirmed when resolver returns true', async () => {
    const att = await mint();
    const res = await verifyMemberAttestation({
      attestation: att,
      membershipResolver: async () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.membership).toBe('confirmed');
  });

  it('membership=denied flips ok to false', async () => {
    const att = await mint();
    const res = await verifyMemberAttestation({
      attestation: att,
      membershipResolver: async () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.membership).toBe('denied');
    expect(res.reason).toMatch(/not a CG member/);
  });

  it('membership=unknown when resolver returns undefined (does not flip ok)', async () => {
    const att = await mint();
    const res = await verifyMemberAttestation({
      attestation: att,
      membershipResolver: async () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(res.membership).toBe('unknown');
  });

  // Codex PR #609 R2 — verifyMemberAttestation must NOT throw on
  // malformed caller-controlled payloads. Both "throws inside digest"
  // (non-numeric chainId/contextGraphId/attestedAt) and "permissive
  // parser coerces malformed hex to zero bytes → false positive"
  // paths now produce a structured ok=false instead of a 500.
  it('returns structured failure on non-numeric chainId (was: throws 500)', async () => {
    const att = await mint();
    const corrupt: MemberAttestation = {
      ...att,
      payload: { ...att.payload, chainId: 'not-a-number' as any },
    };
    const res = await verifyMemberAttestation({ attestation: corrupt });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/chainId|malformed/);
  });

  it('returns structured failure on malformed merkleRoot hex', async () => {
    const att = await mint();
    const corrupt: MemberAttestation = {
      ...att,
      payload: { ...att.payload, merkleRoot: '0xabcd' as any },
    };
    const res = await verifyMemberAttestation({ attestation: corrupt });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/merkleRoot|malformed/);
  });

  it('returns structured failure on non-integer attestedAt', async () => {
    const att = await mint();
    const corrupt: MemberAttestation = {
      ...att,
      payload: { ...att.payload, attestedAt: 12.5 as any },
    };
    const res = await verifyMemberAttestation({ attestation: corrupt });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/attestedAt|malformed/);
  });
});
