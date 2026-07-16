import { keccak256 } from './keccak.js';

/**
 * OT-RFC-49 / WS-B Trap 3: ACK-digest domain-separation version, prepended as
 * the FIRST packed member of the publish/update ACK preimage. MUST equal the
 * `KnowledgeAssetsLifecycle.ACK_DIGEST_VERSION` constant the contract packs, or
 * every publish/update ACK fails `SignerIsNotNodeOperator` (a SILENT failure —
 * the signature simply recovers to the wrong address). Bump in lockstep with the
 * contract whenever the ACK field-set changes (here: the ciphertext→catalog
 * cutover) so an ACK signed under one field-set is unusable against another.
 */
export const ACK_DIGEST_VERSION = 1n;

/**
 * Encode a uint256 as a big-endian 32-byte Uint8Array (abi.encodePacked format).
 */
function uint256ToBytes(value: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * LEGACY 2-field / 6-field ACK digest used by the **verify-proposal** flow
 * (`verify-proposal-handler.ts`, `verify-collector.ts`). NOT used by the
 * V10 publish path — see `computePublishACKDigest` below for the
 * H5-prefixed 8-field layout that matches `KnowledgeAssetsV10.sol:362-373`.
 *
 * This function has two shapes kept for backward compatibility:
 *   - 2-field: `keccak256(abi.encodePacked(contextGraphId, merkleRoot))`
 *     when `kaCount` is omitted.
 *   - 6-field: `keccak256(abi.encodePacked(contextGraphId, merkleRoot,
 *     kaCount, byteSize, epochs, tokenAmount))` when all extra fields
 *     are supplied.
 *
 * Neither shape carries the chain/contract domain separation that the
 * V10 publish digest requires. Any V10 publish-path signer MUST use
 * `computePublishACKDigest` instead.
 *
 * Returns the inner digest only; the EIP-191 prefix is applied by the
 * signing function (e.g. `ethers.Wallet.signMessage`).
 *
 * @param contextGraphId - The uint256 context graph identifier
 * @param merkleRoot - The 32-byte merkle root of the triple set
 * @param kaCount - Optional number of knowledge assets
 * @param byteSize - Optional public byte size (uint88 on-chain, packed as uint256)
 * @param epochs - Optional number of epochs (default 1)
 * @param tokenAmount - Optional TRAC token amount
 * @returns 32-byte keccak256 digest
 */
export function computeACKDigest(
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount?: number,
  byteSize?: bigint,
  epochs?: number,
  tokenAmount?: bigint,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  if (kaCount !== undefined) {
    // 6-field V10 digest: contextGraphId + merkleRoot + kaCount + byteSize + epochs + tokenAmount
    const packed = new Uint8Array(192);
    packed.set(uint256ToBytes(contextGraphId), 0);
    packed.set(merkleRoot, 32);
    packed.set(uint256ToBytes(BigInt(kaCount)), 64);
    packed.set(uint256ToBytes(byteSize ?? 0n), 96);
    packed.set(uint256ToBytes(BigInt(epochs ?? 1)), 128);
    packed.set(uint256ToBytes(tokenAmount ?? 0n), 160);
    return keccak256(packed);
  }
  const packed = new Uint8Array(64);
  packed.set(uint256ToBytes(contextGraphId), 0);
  packed.set(merkleRoot, 32);
  return keccak256(packed);
}

/**
 * Apply the EIP-191 "personal sign" prefix and hash.
 * Equivalent to: keccak256("\x19Ethereum Signed Message:\n32" + digest)
 */
export function eip191Hash(digest: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
  const combined = new Uint8Array(prefix.length + digest.length);
  combined.set(prefix, 0);
  combined.set(digest, prefix.length);
  return keccak256(combined);
}

export { uint256ToBytes };

/**
 * Parse a 0x-prefixed 20-byte EVM address into raw bytes.
 * Throws on malformed input. Used by the V10 publish digest builders so
 * the address packs to its natural 20-byte width under abi.encodePacked.
 */
function addressToBytes(address: string): Uint8Array {
  if (typeof address !== 'string' || address.length !== 42 || !address.startsWith('0x')) {
    throw new Error(`kav10Address must be a 0x-prefixed 20-byte hex string, got: ${address}`);
  }
  const hex = address.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`kav10Address contains non-hex characters: ${address}`);
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode a uint72 value as 9 big-endian bytes (natural width under
 * Solidity `abi.encodePacked`). Throws on overflow.
 */
function uint72ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > (1n << 72n) - 1n) {
    throw new Error(`identityId must fit in uint72, got: ${value}`);
  }
  const buf = new Uint8Array(9);
  let v = value;
  for (let i = 8; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Strict-positive `tokenAmount` floor applied at every off-chain boundary
 * that hashes or sends a V10 publish/update payload.
 *
 * KAV10 10.1.1 added a `tokenAmount > 0` check inside `_validateTokenAmount`,
 * so `0n` is now an unconditional contract revert. Pre-10.1.1, the contract
 * silently rounded a 0-cost publish up to 1 wei-TRAC inside the direct-spend
 * branch (`transferFrom(..., 1n)`); free-publish flows on devnets where
 * `ask == 0` relied on that round-up. To keep those flows working without
 * loosening the 10.1.1 hardening, the off-chain stack floors `tokenAmount`
 * to `1n` at two boundaries:
 *
 *   1. Here, inside the canonical ACK-digest helpers, so every signer hashes
 *      the same value the chain will later see in `_executePublishCore` /
 *      `_executeUpdateCore`. Without the floor, an ACK signed over a `0n`
 *      digest would be unverifiable against the on-chain payload (which
 *      now carries `1n`).
 *   2. Inside `evm-adapter.ts` at the publish/update struct construction
 *      site, so the on-chain `_validateTokenAmount` floor is never tripped
 *      by an integrator who somehow bypasses the digest helpers.
 *
 * The clamp is intentionally only `0n → 1n`; non-zero amounts pass through
 * untouched so the existing `tokenAmount < expectedTokenAmount` check still
 * fires for under-paid publishes.
 */
export function floorPublishTokenAmount(tokenAmount: bigint): bigint {
  return tokenAmount > 0n ? tokenAmount : 1n;
}

/**
 * Compute the V10 publish ACK digest that each receiving core node signs.
 *
 * Layout matches `KnowledgeAssetsLifecycle._executePublishCore` exactly:
 *   keccak256(abi.encodePacked(
 *     ACK_DIGEST_VERSION,       // uint256 (32) — OT-RFC-49 Trap 3 prefix
 *     block.chainid,            // uint256 (32)
 *     address(this),            // address (20) — the deployed KAV10 address
 *     contextGraphId,           // uint256 (32)
 *     merkleRoot,               // bytes32 (32)
 *     knowledgeAssetsAmount,    // uint256 (32)
 *     uint256(byteSize),        // uint256 (32) — cast from uint88 in contract
 *     uint256(epochs),          // uint256 (32) — cast from uint40 in contract
 *     uint256(tokenAmount),     // uint256 (32) — cast from uint96 in contract
 *     uint256(merkleLeafCount), // uint256 (32) — cast from uint32 in contract
 *     catalogRoot,              // bytes32 (32) — OT-RFC-49 (was ciphertextChunksRoot)
 *     uint256(catalogLeafCount),// uint256 (32) — OT-RFC-49 (was ciphertextChunkCount)
 *     uint256(isImmutable)      // uint256 (32)
 *   ))                          // total packed width = 404 bytes
 *
 * The contract wraps this with `ECDSA.toEthSignedMessageHash` (EIP-191)
 * before recovery; off-chain, `signer.signMessage(returnedBytes)` applies
 * the same wrap.
 *
 * H5 closure: the leading (version, chainid, kav10Address) prefix pins
 * signatures to this ACK-digest version, this chain, and this contract. Replay
 * across chains / forks / contract redeployments / field-set versions is
 * rejected at signature verification.
 *
 * KAV10 10.1.1: `tokenAmount` is run through {@link floorPublishTokenAmount}
 * so a free-publish flow (`tokenAmount === 0n`) hashes the same `1n` value
 * the adapter sends on-chain.
 *
 * OT-RFC-49: `catalogRoot`/`catalogLeafCount` are the curated PUBLIC `_catalog`
 * commitment that replaced the stripped ciphertext one (same byte widths /
 * positions). `version` defaults to {@link ACK_DIGEST_VERSION}; pass it
 * explicitly only when intentionally testing a cross-version mismatch.
 */
export function computePublishACKDigest(
  chainId: bigint,
  kav10Address: string,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: bigint,
  byteSize: bigint,
  epochs: bigint,
  tokenAmount: bigint,
  merkleLeafCount: bigint,
  catalogRoot: Uint8Array = new Uint8Array(32),
  catalogLeafCount: bigint = 0n,
  isImmutable: boolean = false,
  version: bigint = ACK_DIGEST_VERSION,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  if (catalogRoot.length !== 32) {
    throw new Error(`catalogRoot must be 32 bytes, got ${catalogRoot.length}`);
  }
  const addrBytes = addressToBytes(kav10Address);
  const flooredTokenAmount = floorPublishTokenAmount(tokenAmount);

  const packed = new Uint8Array(404);
  let offset = 0;
  packed.set(uint256ToBytes(version), offset); offset += 32;
  packed.set(uint256ToBytes(chainId), offset); offset += 32;
  packed.set(addrBytes, offset); offset += 20;
  packed.set(uint256ToBytes(contextGraphId), offset); offset += 32;
  packed.set(merkleRoot, offset); offset += 32;
  packed.set(uint256ToBytes(kaCount), offset); offset += 32;
  packed.set(uint256ToBytes(byteSize), offset); offset += 32;
  packed.set(uint256ToBytes(epochs), offset); offset += 32;
  packed.set(uint256ToBytes(flooredTokenAmount), offset); offset += 32;
  packed.set(uint256ToBytes(merkleLeafCount), offset); offset += 32;
  packed.set(catalogRoot, offset); offset += 32;
  packed.set(uint256ToBytes(catalogLeafCount), offset); offset += 32;
  packed.set(uint256ToBytes(isImmutable ? 1n : 0n), offset); offset += 32;

  return keccak256(packed);
}

/**
 * Compute the V10 publish publisher digest that the publishing node's
 * operational key signs.
 *
 * Layout matches `KnowledgeAssetsV10.sol:327-335` exactly:
 *   keccak256(abi.encodePacked(
 *     block.chainid,            // uint256 (32)
 *     address(this),            // address (20) — the deployed KAV10 address
 *     publisherNodeIdentityId,  // uint72  (9)  — natural width
 *     contextGraphId,           // uint256 (32)
 *     merkleRoot                // bytes32 (32)
 *   ))                          // total packed width = 125 bytes
 *
 * N26 closure: `identityId` comes BEFORE `contextGraphId`. Swapping them
 * produces a different digest that the contract rejects at
 * `_verifySignature`.
 */
/**
 * Compute the V10 update ACK digest that core nodes sign.
 *
 * Layout matches `KnowledgeAssetsLifecycle._executeUpdateCore`:
 *   keccak256(abi.encodePacked(
 *     ACK_DIGEST_VERSION,                     // uint256 (32) — OT-RFC-49 Trap 3 prefix
 *     block.chainid,                          // uint256 (32)
 *     address(this),                          // address (20)
 *     contextGraphId,                         // uint256 (32)
 *     p.id,                                   // uint256 (32)
 *     preUpdateMerkleRootCount,               // uint256 (32)
 *     p.newMerkleRoot,                        // bytes32 (32)
 *     uint256(p.newByteSize),                 // uint256 (32)
 *     uint256(p.newTokenAmount),              // uint256 (32)
 *     p.mintKnowledgeAssetsAmount,            // uint256 (32)
 *     keccak256(abi.encodePacked(burnIds)),   // bytes32 (32)
 *     uint256(newMerkleLeafCount),            // uint256 (32) — cast from uint32
 *     newCatalogRoot,                         // bytes32 (32) — OT-RFC-49 (was newCiphertextChunksRoot)
 *     uint256(newCatalogLeafCount)            // uint256 (32) — OT-RFC-49 (was newCiphertextChunkCount)
 *   ))                                        // total packed width = 436 bytes
 */
export function computeUpdateACKDigest(
  chainId: bigint,
  kav10Address: string,
  contextGraphId: bigint,
  kaId: bigint,
  preUpdateMerkleRootCount: bigint,
  newMerkleRoot: Uint8Array,
  newByteSize: bigint,
  newTokenAmount: bigint,
  mintAmount: bigint,
  burnTokenIds: bigint[],
  newMerkleLeafCount: bigint,
  newCatalogRoot: Uint8Array = new Uint8Array(32),
  newCatalogLeafCount: bigint = 0n,
  version: bigint = ACK_DIGEST_VERSION,
): Uint8Array {
  if (newMerkleRoot.length !== 32) {
    throw new Error(`newMerkleRoot must be 32 bytes, got ${newMerkleRoot.length}`);
  }
  if (newCatalogRoot.length !== 32) {
    throw new Error(`newCatalogRoot must be 32 bytes, got ${newCatalogRoot.length}`);
  }
  const addrBytes = addressToBytes(kav10Address);
  // KAV10 10.1.1 — kept in lockstep with the adapter's update struct so the
  // signed digest matches the on-chain `newTokenAmount`. NOTE: this floor is
  // redundant for any KC that can exist on a V10 chain — the publish-time
  // floor + on-chain `_validateTokenAmount` guarantee `currentTokenAmount
  // >= 1`, and metadata-only updates skip `_validateTokenAmount` entirely.
  // It only changes a legacy `tokenAmount == 0` KC (which a fresh V10 chain
  // cannot produce). Removing it is tracked as a post-testnet follow-up
  // (#781; issue #803); see the matching note in evm-adapter.ts.
  const flooredNewTokenAmount = floorPublishTokenAmount(newTokenAmount);

  // keccak256(abi.encodePacked(burnTokenIds)) — empty uint256[] encodes to
  // zero bytes, so keccak256("") matches Solidity (verified vs ethers).
  const burnPacked = new Uint8Array(burnTokenIds.length * 32);
  for (let i = 0; i < burnTokenIds.length; i++) {
    burnPacked.set(uint256ToBytes(burnTokenIds[i]), i * 32);
  }
  const burnHash = keccak256(burnPacked);

  // Packed width = 32 (version) + 32 (chainId) + 20 (addr) + 32*12 fields = 436.
  const packed = new Uint8Array(436);
  let offset = 0;
  packed.set(uint256ToBytes(version), offset); offset += 32;
  packed.set(uint256ToBytes(chainId), offset); offset += 32;
  packed.set(addrBytes, offset); offset += 20;
  packed.set(uint256ToBytes(contextGraphId), offset); offset += 32;
  packed.set(uint256ToBytes(kaId), offset); offset += 32;
  packed.set(uint256ToBytes(preUpdateMerkleRootCount), offset); offset += 32;
  packed.set(newMerkleRoot, offset); offset += 32;
  packed.set(uint256ToBytes(newByteSize), offset); offset += 32;
  packed.set(uint256ToBytes(flooredNewTokenAmount), offset); offset += 32;
  packed.set(uint256ToBytes(mintAmount), offset); offset += 32;
  packed.set(burnHash, offset); offset += 32;
  packed.set(uint256ToBytes(newMerkleLeafCount), offset); offset += 32;
  packed.set(newCatalogRoot, offset); offset += 32;
  packed.set(uint256ToBytes(newCatalogLeafCount), offset); offset += 32;

  return keccak256(packed);
}

/**
 * @deprecated RFC-001 (Phase 1) replaced the per-publish publisher
 * signature with an EIP-712 `AuthorAttestation`. The V10 contract no
 * longer accepts a publisher digest; `publisherNodeIdentityId` is now
 * informational only. Off-chain code should switch to
 * {@link buildAuthorAttestationTypedData} / {@link AUTHOR_ATTESTATION_DOMAIN}.
 *
 * Kept for one transition release so legacy callers compile while
 * being migrated. Callers that still pack this digest will produce
 * signatures the contract rejects.
 */
export function computePublishPublisherDigest(
  chainId: bigint,
  kav10Address: string,
  publisherNodeIdentityId: bigint,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  const addrBytes = addressToBytes(kav10Address);
  const idBytes = uint72ToBytes(publisherNodeIdentityId);

  const packed = new Uint8Array(125);
  let offset = 0;
  packed.set(uint256ToBytes(chainId), offset); offset += 32;
  packed.set(addrBytes, offset); offset += 20;
  packed.set(idBytes, offset); offset += 9;
  packed.set(uint256ToBytes(contextGraphId), offset); offset += 32;
  packed.set(merkleRoot, offset); offset += 32;

  return keccak256(packed);
}

// =====================================================================
// RFC-001 §3 — EIP-712 Author Attestation
// =====================================================================

/**
 * EIP-712 domain name for the V10 author attestation. Must match
 * `KnowledgeAssetsV10._EIP712_NAME_HASH` — any drift will produce
 * signatures the contract rejects with `InvalidAuthorSignature`.
 */
export const AUTHOR_ATTESTATION_DOMAIN_NAME = 'KnowledgeAssetsLifecycle';

/**
 * EIP-712 domain version. Bound to the major.minor portion of the
 * contract's `_VERSION` literal. Patch bumps do NOT change this; only
 * major.minor changes do. See `KnowledgeAssetsV10._EIP712_VERSION_HASH`.
 *
 * BUMPED for the CG-independent `AuthorAttestation` (the `contextGraphId`
 * struct field was removed — see below). This MUST match the matching
 * smart-contract PR's new `_EIP712_VERSION` exactly, or every on-chain
 * `_verifyAuthorAttestation` reverts with `InvalidAuthorSignature`.
 * CROSS-PR COORDINATION POINT — reconcile the literal with the contract PR.
 */
export const AUTHOR_ATTESTATION_DOMAIN_VERSION = '3.0.0';

/**
 * Currently-supported `authorSchemeVersion` value. v1 is single-key
 * (EOA / EIP-1271 / EIP-7702) ECDSA recovery. Future schemes
 * (multi-sig, threshold, passkey-aggregated) bump this and replace the
 * compact `(authorR, authorVS)` pair with a `bytes` signature field —
 * see RFC-001 §9.6.
 */
export const AUTHOR_SCHEME_VERSION_V1 = 1;

/**
 * EIP-712 typed-data primary type name and field layout. Mirrors the
 * `_AUTHOR_ATTESTATION_TYPEHASH` literal in
 * `KnowledgeAssetsV10.sol`:
 *
 *   AuthorAttestation(bytes32 merkleRoot, address authorAddress,
 *                     uint8 schemeVersion, uint256 reservedKaId)
 *
 * The `contextGraphId` field was REMOVED (#1116): the seal is now
 * context-graph-independent so an assertion can be finalized before its CG
 * is registered on-chain. The CG is still bound to the publication at
 * publish time (the contract's `PublishParams.contextGraphId` + the
 * separate ACK digest) — just not by the author signature.
 *
 * OT-RFC-43 Option-1 (variant 1a): `reservedKaId` — the packed
 * `(uint160(author) << 96) | uint96(number)` slot this publish claims — is
 * bound into the attestation so the author signs the *slot*, not just the
 * content. This MUST stay byte-for-byte aligned with the on-chain
 * `abi.encode(...)` order; the field is appended LAST.
 */
export const AUTHOR_ATTESTATION_PRIMARY_TYPE = 'AuthorAttestation';

export interface AuthorAttestationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: string;
  };
  types: {
    AuthorAttestation: Array<{ name: string; type: string }>;
  };
  primaryType: typeof AUTHOR_ATTESTATION_PRIMARY_TYPE;
  message: {
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
    reservedKaId: bigint;
  };
}

/**
 * Build the EIP-712 typed-data payload for the V10 author attestation.
 *
 * Domain pins `(chainId, verifyingContract)` to defeat cross-chain and
 * cross-deployment replay. Struct hash binds the publication's `merkleRoot`
 * to a specific `(authorAddress, schemeVersion, reservedKaId)` — leaked
 * signatures cannot be redirected to a different content root, author, or
 * KA id/slot. The seal is intentionally CG-independent (#1116); CG binding
 * happens at publish (PublishParams.contextGraphId + the ACK digest).
 *
 * `reservedKaId` is the packed `(uint160(author) << 96) | uint96(number)`
 * the publish will mint; it is REQUIRED under OT-RFC-43 Option-1 variant 1a
 * and must equal the `reservedKaId` placed in `PublishParams`, or on-chain
 * recovery will revert with `InvalidAuthorSignature`.
 *
 * Pass directly to `ethers.Signer.signTypedData(domain, types, message)`
 * or to a wallet-of-record (EIP-1271 contract).
 */
export function buildAuthorAttestationTypedData(args: {
  chainId: bigint;
  kav10Address: string;
  merkleRoot: Uint8Array;
  authorAddress: string;
  reservedKaId: bigint;
  schemeVersion?: number;
}): AuthorAttestationTypedData {
  if (args.merkleRoot.length !== 32) {
    throw new Error(
      `merkleRoot must be 32 bytes, got ${args.merkleRoot.length}`,
    );
  }
  const merkleRootHex =
    '0x' +
    Array.from(args.merkleRoot)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const schemeVersion = args.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  return {
    domain: {
      name: AUTHOR_ATTESTATION_DOMAIN_NAME,
      version: AUTHOR_ATTESTATION_DOMAIN_VERSION,
      chainId: args.chainId,
      verifyingContract: args.kav10Address,
    },
    types: {
      AuthorAttestation: [
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'authorAddress', type: 'address' },
        { name: 'schemeVersion', type: 'uint8' },
        { name: 'reservedKaId', type: 'uint256' },
      ],
    },
    primaryType: AUTHOR_ATTESTATION_PRIMARY_TYPE,
    message: {
      merkleRoot: merkleRootHex,
      authorAddress: args.authorAddress,
      schemeVersion,
      reservedKaId: args.reservedKaId,
    },
  };
}

export const UPDATE_AUTHOR_ATTESTATION_PRIMARY_TYPE = 'UpdateAuthorAttestation';

export interface UpdateAuthorAttestationTypedData {
  domain: AuthorAttestationTypedData['domain'];
  types: {
    UpdateAuthorAttestation: Array<{ name: string; type: string }>;
  };
  primaryType: typeof UPDATE_AUTHOR_ATTESTATION_PRIMARY_TYPE;
  message: {
    kaId: bigint;
    newMerkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
  };
}

/**
 * EIP-712 typed data for greenfield KA updates (`UpdateAuthorAttestation`).
 * Owner commits to `(kaId, newMerkleRoot)` before the publisher runs ACK/TRAC.
 */
export function buildUpdateAuthorAttestationTypedData(args: {
  chainId: bigint;
  kav10Address: string;
  kaId: bigint;
  newMerkleRoot: Uint8Array;
  authorAddress: string;
  schemeVersion?: number;
}): UpdateAuthorAttestationTypedData {
  if (args.newMerkleRoot.length !== 32) {
    throw new Error('newMerkleRoot must be 32 bytes');
  }
  const toHex = (b: Uint8Array) =>
    '0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  const schemeVersion = args.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
  return {
    domain: {
      name: AUTHOR_ATTESTATION_DOMAIN_NAME,
      version: AUTHOR_ATTESTATION_DOMAIN_VERSION,
      chainId: args.chainId,
      verifyingContract: args.kav10Address,
    },
    types: {
      UpdateAuthorAttestation: [
        { name: 'kaId', type: 'uint256' },
        { name: 'newMerkleRoot', type: 'bytes32' },
        { name: 'authorAddress', type: 'address' },
        { name: 'schemeVersion', type: 'uint8' },
      ],
    },
    primaryType: UPDATE_AUTHOR_ATTESTATION_PRIMARY_TYPE,
    message: {
      kaId: args.kaId,
      newMerkleRoot: toHex(args.newMerkleRoot),
      authorAddress: args.authorAddress,
      schemeVersion,
    },
  };
}
