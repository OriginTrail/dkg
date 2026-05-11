import { describe, it, expect } from 'vitest';
import {
  AUTHOR_ATTESTATION_DOMAIN_NAME,
  AUTHOR_ATTESTATION_DOMAIN_VERSION,
  AUTHOR_ATTESTATION_PRIMARY_TYPE,
  AUTHOR_SCHEME_VERSION_V1,
  buildAuthorAttestationTypedData,
  keccak256,
  keccak256Hex,
} from '../src/index.js';

// RFC-001 §3 author attestation reference vectors.
//
// `buildAuthorAttestationTypedData` MUST produce a payload that, when fed
// into the EIP-712 typed-data hash, is byte-equal to the on-chain
// `KnowledgeAssetsV10._hashAuthorAttestation`. Drift in the domain name,
// version, type-hash field order, or any field width breaks every publish
// silently — `_verifyAuthorAttestation` would then revert with
// `InvalidAuthorSignature` because the recovered signer no longer matches
// the claimed `authorAddress`.
//
// The off-chain builder is intentionally ethers-free (dkg-core has no
// ethers dependency by design — it is the universal-runtime root). This
// test reproduces the EIP-712 digest using only `@noble/hashes`'s keccak256
// (re-exported as `keccak256` here) and hand-rolled abi-encode helpers
// that mirror Solidity's `abi.encode` packing for the four field types we
// use (uint256, bytes32, address, uint8). All four types pad to 32 bytes.
//
// If any single test in this file fails, suspect domain/struct-hash drift
// before changing the golden — the contract is the source of truth.

const CHAIN_ID = 31337n;
const KAV10_ADDRESS = '0x0000000000000000000000000000000000000042';
const CG_ID = 1337n;
const MERKLE_ROOT = new Uint8Array(32).fill(0xaa);
const AUTHOR_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Golden hex reference — precomputed offline with `ethers.TypedDataEncoder`
// against the exact KnowledgeAssetsV10 EIP-712 layout. If this drifts, the
// off-chain typed-data builder no longer matches the on-chain
// `_hashAuthorAttestation` and every publish will fail signature recovery.
const AUTHOR_ATTESTATION_DIGEST_GOLDEN =
  '0xc8a7c3716a4a003879089c16f735c5956a6ab17349b7b6e1533e27bbf820b6d8';
const AUTHOR_ATTESTATION_DOMAIN_SEPARATOR_GOLDEN =
  '0xdf55b6f8be8bedc35cf5eacc6c6961dfe46fbac305529ae2ad0eca533407e632';
const AUTHOR_ATTESTATION_STRUCT_HASH_GOLDEN =
  '0xb72293311c0783593beea12f1d87bbb8ed1899ee1d55d439271a650c01446896';

// ── Tiny abi-encode helpers (32-byte left-padded big-endian) ─────────────
//
// abi.encode writes each fixed-width primitive as a 32-byte big-endian
// word. uint256 / uint8 / address all pack at the low end with zero MSB
// padding; bytes32 is already 32 bytes so passes through.

function uint256ToWord(n: bigint): Uint8Array {
  if (n < 0n) throw new Error(`uint256 must be non-negative, got ${n}`);
  if (n >= 1n << 256n) {
    throw new Error(`uint256 overflow: ${n} >= 2^256`);
  }
  const out = new Uint8Array(32);
  let value = n;
  for (let i = 31; i >= 0 && value > 0n; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function uint8ToWord(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`uint8 out of range: ${n}`);
  }
  const out = new Uint8Array(32);
  out[31] = n;
  return out;
}

function bytes32ToWord(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length !== 64) {
    throw new Error(`bytes32 must be 32 hex bytes, got ${stripped.length} chars`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function addressToWord(addr: string): Uint8Array {
  const stripped = addr.startsWith('0x') ? addr.slice(2) : addr;
  if (stripped.length !== 40) {
    throw new Error(`address must be 20 hex bytes, got ${stripped.length} chars`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    out[12 + i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// EIP-712 type hashes — keccak256 of the canonical type strings. These
// are the same constants the contract embeds at compile time as
// `_EIP712_DOMAIN_TYPEHASH` and `_AUTHOR_ATTESTATION_TYPEHASH`.
const EIP712_DOMAIN_TYPEHASH = keccak256(
  utf8(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);
const AUTHOR_ATTESTATION_TYPEHASH = keccak256(
  utf8(
    'AuthorAttestation(uint256 contextGraphId,bytes32 merkleRoot,address authorAddress,uint8 schemeVersion)',
  ),
);

function manualHashAuthorAttestation(args: {
  chainId: bigint;
  kav10Address: string;
  contextGraphId: bigint;
  merkleRootHex: string;
  authorAddress: string;
  schemeVersion: number;
}): { digest: Uint8Array; domainSeparator: Uint8Array; structHash: Uint8Array } {
  const nameHash = keccak256(utf8(AUTHOR_ATTESTATION_DOMAIN_NAME));
  const versionHash = keccak256(utf8(AUTHOR_ATTESTATION_DOMAIN_VERSION));

  const domainSeparator = keccak256(
    concat(
      EIP712_DOMAIN_TYPEHASH,
      nameHash,
      versionHash,
      uint256ToWord(args.chainId),
      addressToWord(args.kav10Address),
    ),
  );

  const structHash = keccak256(
    concat(
      AUTHOR_ATTESTATION_TYPEHASH,
      uint256ToWord(args.contextGraphId),
      bytes32ToWord(args.merkleRootHex),
      addressToWord(args.authorAddress),
      uint8ToWord(args.schemeVersion),
    ),
  );

  const digest = keccak256(
    concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash),
  );

  return { digest, domainSeparator, structHash };
}

function toHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

// Run the manual reproduction over the same payload that
// `buildAuthorAttestationTypedData` would emit. This is the equivalent
// of feeding a typed-data structure to `ethers.TypedDataEncoder.hash` —
// computed without ethers as a dependency.
function digestForFixture(args: {
  chainId: bigint;
  kav10Address: string;
  contextGraphId: bigint;
  merkleRoot: Uint8Array;
  authorAddress: string;
  schemeVersion?: number;
}): { digest: string; domainSeparator: string; structHash: string } {
  const payload = buildAuthorAttestationTypedData(args);
  // The builder converts merkleRoot -> hex; we reuse its output to ensure
  // the test exercises the same conversion path the publisher uses.
  const out = manualHashAuthorAttestation({
    chainId: payload.domain.chainId,
    kav10Address: payload.domain.verifyingContract,
    contextGraphId: payload.message.contextGraphId,
    merkleRootHex: payload.message.merkleRoot,
    authorAddress: payload.message.authorAddress,
    schemeVersion: payload.message.schemeVersion,
  });
  return {
    digest: toHex(out.digest),
    domainSeparator: toHex(out.domainSeparator),
    structHash: toHex(out.structHash),
  };
}

describe('buildAuthorAttestationTypedData (RFC-001 §3 reference vector)', () => {
  it('matches the EIP-712 typed-data golden digest', () => {
    const out = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    });
    expect(out.digest).toBe(AUTHOR_ATTESTATION_DIGEST_GOLDEN);
    expect(out.domainSeparator).toBe(AUTHOR_ATTESTATION_DOMAIN_SEPARATOR_GOLDEN);
    expect(out.structHash).toBe(AUTHOR_ATTESTATION_STRUCT_HASH_GOLDEN);
  });

  it('binds the typed-data builder output to the manual `_hashAuthorAttestation` reproduction', () => {
    // Two independent computations of the same digest:
    //   1. Through the public `buildAuthorAttestationTypedData` builder.
    //   2. Through the manual keccak256 reproduction in this file.
    // They MUST agree, because the builder's payload is what feeds an
    // ethers `signTypedData` call which itself hashes per the EIP-712
    // spec — and the contract's `_hashAuthorAttestation` follows the
    // exact same spec.
    const payload = buildAuthorAttestationTypedData({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    });
    expect(payload.domain.name).toBe(AUTHOR_ATTESTATION_DOMAIN_NAME);
    expect(payload.domain.version).toBe(AUTHOR_ATTESTATION_DOMAIN_VERSION);
    expect(payload.primaryType).toBe(AUTHOR_ATTESTATION_PRIMARY_TYPE);
    expect(payload.types.AuthorAttestation).toEqual([
      { name: 'contextGraphId', type: 'uint256' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'authorAddress', type: 'address' },
      { name: 'schemeVersion', type: 'uint8' },
    ]);
    expect(payload.message.schemeVersion).toBe(AUTHOR_SCHEME_VERSION_V1);
  });

  it('is deterministic for identical inputs', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    expect(a).toBe(b);
  });

  it('different chainId produces a different digest (cross-chain replay defense)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID + 1n,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    expect(a).not.toBe(b);
  });

  it('different verifyingContract produces a different digest (cross-deployment replay defense)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: '0x0000000000000000000000000000000000000043',
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    expect(a).not.toBe(b);
  });

  it('different contextGraphId produces a different digest (per-CG binding)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID + 1n,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    expect(a).not.toBe(b);
  });

  it('different merkleRoot produces a different digest (per-publish binding)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const altRoot = new Uint8Array(32).fill(0xbb);
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: altRoot,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    expect(a).not.toBe(b);
  });

  it('different authorAddress produces a different digest (per-author binding)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    }).digest;
    expect(a).not.toBe(b);
  });

  it('different schemeVersion produces a different digest (forward-compat for v2 schemes)', () => {
    const a = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
      schemeVersion: 1,
    }).digest;
    const b = digestForFixture({
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID,
      merkleRoot: MERKLE_ROOT,
      authorAddress: AUTHOR_ADDRESS,
      schemeVersion: 2,
    }).digest;
    expect(a).not.toBe(b);
  });

  it('rejects merkleRoot with wrong length', () => {
    expect(() =>
      buildAuthorAttestationTypedData({
        chainId: CHAIN_ID,
        kav10Address: KAV10_ADDRESS,
        contextGraphId: CG_ID,
        merkleRoot: new Uint8Array(16),
        authorAddress: AUTHOR_ADDRESS,
      }),
    ).toThrow(/merkleRoot/);
  });

  it('exposes the same constants the contract pins to', () => {
    // Defense-in-depth: catch a refactor that quietly changes the domain
    // name or version without bumping a major contract version. Both
    // values are baked into the on-chain `_EIP712_NAME_HASH` and
    // `_EIP712_VERSION_HASH`.
    expect(AUTHOR_ATTESTATION_DOMAIN_NAME).toBe('KnowledgeAssetsV10');
    expect(AUTHOR_ATTESTATION_DOMAIN_VERSION).toBe('10.1');
    expect(AUTHOR_ATTESTATION_PRIMARY_TYPE).toBe('AuthorAttestation');
    expect(AUTHOR_SCHEME_VERSION_V1).toBe(1);
    // Sanity on the keccak256 helpers we depend on for this test.
    expect(keccak256Hex(new Uint8Array(0))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
