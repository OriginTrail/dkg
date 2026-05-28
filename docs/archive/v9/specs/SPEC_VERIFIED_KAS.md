# DKG V9 — Verified Knowledge Assets

**Status**: DRAFT v0.1  
**Date**: 2026-02-25  
**Scope**: Extending Knowledge Asset publishing so that storage nodes actively verify real-world claims, not just data integrity.  
**Depends on**: Part 1 (Marketplace), Part 2 (Economy), Trust Layer Spec

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Concepts](#2-concepts)
3. [Architecture Overview](#3-architecture-overview)
4. [Claim Types](#4-claim-types)
5. [Protocol Flow](#5-protocol-flow)
6. [Protobuf & Data Model Changes](#6-protobuf--data-model-changes)
7. [Verifier Interface](#7-verifier-interface)
8. [On-Chain Contract Changes](#8-on-chain-contract-changes)
9. [Economic Model](#9-economic-model)
10. [Dispute Resolution](#10-dispute-resolution)
11. [Stale Claims & Liveness](#11-stale-claims--liveness)
12. [Security Considerations](#12-security-considerations)
13. [Use Cases](#13-use-cases)
14. [Implementation Roadmap](#14-implementation-roadmap)

---

## 1. Motivation

### The integrity gap

Today, when a publisher creates a Knowledge Asset and three storage nodes sign it, those signers attest to two things:

1. **Data integrity** — the `merkleRoot` of the triples matches the claimed hash.
2. **Storage commitment** — the node will store `byteSize` bytes for the agreed epoch range.

This is sufficient for tamper-proofing and availability, but it says nothing about whether the *content* of the triples is **true**. A publisher can claim "URL https://example.com returns a 200 status," or "NFT #42 exists on Ethereum mainnet," or "this node is a functioning relay" — and nothing in the protocol verifies those assertions. The merkle root proves the data wasn't tampered with *after* publishing, but not that it was accurate *at time of publishing*.

### Why it matters

As the DKG becomes the coordination layer for AI agents, the value of knowledge depends on its reliability. Agents making real-world decisions (financial, medical, logistical) need stronger guarantees than "this hash is correct." They need to know: **did independent parties check whether this claim is actually true?**

### The opportunity

The DKG's existing 3-of-N signing protocol already has storage nodes performing work before signing. Extending this work from "verify the merkle root" to "verify the merkle root AND check a real-world claim" is an incremental change to the protocol with a massive expansion in the network's trust surface.

---

## 2. Concepts

### Verified Knowledge Asset (Verified KA)

A Knowledge Asset that includes one or more **claims** whose truthfulness has been independently verified by the signing storage nodes before finalization.

### Claim

A structured assertion embedded in the KA's triples that can be mechanically checked by a verifier. Examples:

| Claim | What a verifier does |
|---|---|
| "URL https://api.example.com/health returns HTTP 200" | Makes an HTTP GET request, checks status code |
| "NFT contract 0xABC on Ethereum has token #42 owned by 0xDEF" | Queries the ERC-721 contract |
| "Peer 12D3KooW... is reachable as a circuit relay" | Connects via libp2p, requests a relay reservation |
| "DNS A record for example.com resolves to 1.2.3.4" | Performs DNS lookup |
| "The Merkle root of IPFS CID Qm... is 0x..." | Fetches from IPFS, computes root |

### Claim Type

A registered identifier (e.g., `dkg:claim/http-liveness`, `dkg:claim/relay-reachable`) that maps to a specific verification procedure. Claim types are defined in the protocol and can be extended by contextGraph operators.

### Verifier

A module that implements the verification logic for a specific claim type. Storage nodes load verifiers as plugins — only nodes that have the relevant verifier installed will volunteer to sign Verified KAs of that type.

### Attestation

A storage node's cryptographic signature over a `(claimType, claimData, verificationResult, timestamp)` tuple, included in the finalization transaction.

---

## 3. Architecture Overview

```
Publisher                    Storage Node (Signer)               Chain
   │                              │                                │
   │  PublishRequest              │                                │
   │  + claimType                 │                                │
   │  + claimData                 │                                │
   │──────────────────────────────>                                │
   │                              │                                │
   │                     ┌────────┴─────────┐                     │
   │                     │ 1. Verify merkle │                     │
   │                     │    root (legacy) │                     │
   │                     │ 2. Load verifier │                     │
   │                     │    for claimType │                     │
   │                     │ 3. Execute       │                     │
   │                     │    verification  │                     │
   │                     │ 4. Sign result   │                     │
   │                     └────────┬─────────┘                     │
   │                              │                                │
   │  PublishAck                  │                                │
   │  + attestation               │                                │
   │<──────────────────────────────                                │
   │                                                               │
   │  finalize TX (merkleRoot + attestations[])                    │
   │───────────────────────────────────────────────────────────────>
   │                                                               │
   │                              ┌────────────────────────────────┤
   │                              │ Verify ≥ threshold attestations│
   │                              │ Store attestation hashes       │
   │                              │ Mark KA as "verified"          │
   │                              └────────────────────────────────┤
```

The protocol is **backward-compatible**: a PublishRequest without `claimType` follows the existing path. Storage nodes without verifier plugins only sign non-verified KAs.

---

## 4. Claim Types

### Type Registry

Claim types are identified by URI and registered in a Solidity mapping on-chain. Each entry records:

| Field | Type | Description |
|---|---|---|
| `claimTypeId` | `string` | URI identifier, e.g. `dkg:claim/http-liveness` |
| `verifierCodeHash` | `bytes32` | Hash of the canonical verifier implementation |
| `minSigners` | `uint8` | Minimum attestations required (may differ from default 3) |
| `registeredBy` | `address` | Who registered this claim type |
| `active` | `bool` | Whether the claim type is currently accepted |

### Built-in Claim Types (Phase 1)

| Claim Type URI | Input | Verification | Output |
|---|---|---|---|
| `dkg:claim/relay-reachable` | `peerId`, `multiaddrs[]` | Connect via libp2p, request circuit relay reservation | `reachable: bool`, `latencyMs: number` |
| `dkg:claim/http-liveness` | `url`, `expectedStatus` | HTTP GET, check status code | `alive: bool`, `actualStatus: number` |
| `dkg:claim/dns-record` | `domain`, `recordType`, `expectedValue` | DNS query | `matches: bool`, `actualValue: string` |

### ContextGraph-Specific Claim Types (Phase 2+)

ContextGraph operators can register custom claim types for their domain:

| Domain | Example Claim Type | Verification |
|---|---|---|
| DeFi | `contextGraph:defi/token-balance` | Query ERC-20 balanceOf |
| NFT | `contextGraph:nft/ownership` | Query ERC-721 ownerOf |
| Supply Chain | `contextGraph:logistics/tracking-status` | Query carrier API |
| Academic | `contextGraph:research/doi-exists` | Query CrossRef API |

---

## 5. Protocol Flow

### 5.1 Publishing a Verified KA

```
Publisher                           Network
   │
   │  1. Build KA triples (including claim triples)
   │  2. Compute merkleRoot as usual
   │  3. Set claimType + claimData in PublishRequest
   │
   │  broadcastPublish(request)
   │─────────────────────────────────────>
   │
   │         Storage nodes that have the
   │         matching verifier respond:
   │
   │  <── PublishAck (node A: verified=true,  attestation=sig_A)
   │  <── PublishAck (node B: verified=true,  attestation=sig_B)
   │  <── PublishAck (node C: verified=false, reason="timeout")
   │  <── PublishAck (node D: verified=true,  attestation=sig_D)
   │
   │  4. Collect ≥ minSigners valid attestations
   │  5. Submit finalize TX with attestations
   │
   │  finalizeMintWithAttestations(tokenId, merkleRoot, attestations[])
   │─────────────────────────────────────>
```

### 5.2 Verification Window

Each claim type defines a `maxVerificationAge` — the maximum time between verification and finalization. This prevents publishers from using stale verifications:

- `relay-reachable`: 5 minutes (relay status can change quickly)
- `http-liveness`: 10 minutes
- `dns-record`: 1 hour

The on-chain contract rejects attestations older than `maxVerificationAge` at finalization time.

### 5.3 Querying Verified Status

Agents querying the DKG can filter for verified KAs:

```sparql
PREFIX dkg: <https://dkg.origintrail.io/ontology#>

SELECT ?asset ?claimType ?verifiedAt ?signerCount
WHERE {
  ?asset dkg:claimType ?claimType .
  ?asset dkg:verifiedAt ?verifiedAt .
  ?asset dkg:attestationCount ?signerCount .
  FILTER (?signerCount >= 3)
}
```

---

## 6. Protobuf & Data Model Changes

### PublishRequest Extension

```protobuf
message KAManifestEntry {
  bytes  merkle_root = 1;
  uint64 byte_size   = 2;
  uint32 epoch_count = 3;
  // New fields for verified KAs:
  string claim_type  = 10;  // URI of the claim type, empty = legacy KA
  bytes  claim_data  = 11;  // Serialized claim-specific input
}
```

### PublishAck Extension

```protobuf
message PublishAck {
  bool   accepted    = 1;
  string reason      = 2;
  // New fields for verified KAs:
  bool   verified    = 10;
  bytes  attestation = 11;  // Signature over (claimType, claimData, result, timestamp)
  uint64 verified_at = 12;  // Unix timestamp of verification
}
```

### Attestation Structure

```protobuf
message ClaimAttestation {
  string claim_type    = 1;
  bytes  claim_data    = 2;
  bool   result        = 3;  // true = claim verified successfully
  uint64 verified_at   = 4;
  bytes  signer_pubkey = 5;
  bytes  signature     = 6;  // Ed25519 sign(claim_type || claim_data || result || verified_at)
}
```

### RDF Triples for Verified KAs

When a KA is finalized with attestations, the publisher's triples should include claim metadata using the DKG ontology:

```turtle
<did:dkg:31337/0xPublisher/42>
    dkg:claimType       "dkg:claim/relay-reachable" ;
    dkg:claimSubject    "12D3KooWAbCdEf..." ;
    dkg:verifiedAt      "2026-02-25T14:30:00Z"^^xsd:dateTime ;
    dkg:attestationCount "3"^^xsd:integer ;
    dkg:attestedBy      "12D3KooWSigner1...", "12D3KooWSigner2...", "12D3KooWSigner3..." .
```

---

## 7. Verifier Interface

### Plugin Architecture

Each verifier is a module that implements the `ClaimVerifier` interface:

```typescript
interface ClaimVerificationInput {
  claimType: string;
  claimData: Uint8Array;
  publisherPeerId: string;
  kaTriples: Uint8Array;   // full triple set for context
  merkleRoot: Uint8Array;
}

interface ClaimVerificationResult {
  verified: boolean;
  reason?: string;          // human-readable explanation
  evidence?: Uint8Array;    // optional machine-readable evidence
  durationMs: number;
}

interface ClaimVerifier {
  readonly claimType: string;
  readonly maxVerificationTimeMs: number;

  verify(input: ClaimVerificationInput): Promise<ClaimVerificationResult>;
}
```

### Verifier Registration

Storage nodes register their available verifiers at startup:

```typescript
class VerifierRegistry {
  private verifiers = new Map<string, ClaimVerifier>();

  register(verifier: ClaimVerifier): void;
  has(claimType: string): boolean;
  get(claimType: string): ClaimVerifier | undefined;
  listSupported(): string[];
}
```

### Built-in Verifiers

#### `RelayReachableVerifier`

```typescript
class RelayReachableVerifier implements ClaimVerifier {
  readonly claimType = 'dkg:claim/relay-reachable';
  readonly maxVerificationTimeMs = 30_000;

  async verify(input: ClaimVerificationInput): Promise<ClaimVerificationResult> {
    const { peerId, multiaddrs } = decode(input.claimData);
    // 1. Dial the peer via each multiaddr
    // 2. Request a relay reservation (circuit-relay-v2 HOP)
    // 3. Verify the reservation succeeds
    // 4. Measure latency
  }
}
```

#### `HttpLivenessVerifier`

```typescript
class HttpLivenessVerifier implements ClaimVerifier {
  readonly claimType = 'dkg:claim/http-liveness';
  readonly maxVerificationTimeMs = 15_000;

  async verify(input: ClaimVerificationInput): Promise<ClaimVerificationResult> {
    const { url, expectedStatus } = decode(input.claimData);
    // 1. HTTP GET with timeout
    // 2. Compare status code
    // 3. Optionally hash response body for evidence
  }
}
```

### Verifier Safety

Verifiers execute potentially untrusted network requests. Safety constraints:

- **Timeout enforcement**: `maxVerificationTimeMs` is a hard ceiling; the scheduler kills the verifier after this.
- **Resource limits**: Verifiers run in a sandboxed context with capped memory and no filesystem access.
- **Rate limiting**: A node limits how many verifications it performs per minute to prevent abuse (publisher flooding with verification-heavy KAs).
- **Allowlist/Denylist**: Node operators can configure which claim types they are willing to verify.

---

## 8. On-Chain Contract Changes

### KnowledgeAssetsStorage

Extended to store attestation metadata per KA:

```solidity
struct KAAttestation {
    string claimType;
    bytes32 claimDataHash;
    uint64 verifiedAt;
    address[] signers;      // on-chain addresses derived from Ed25519 pubkeys
    bytes32 attestationHash; // hash of all attestation signatures
}

mapping(uint256 => KAAttestation) public kaAttestations;
```

### New Functions

```solidity
function finalizeMintWithAttestations(
    uint256 tokenId,
    bytes32 merkleRoot,
    ClaimAttestation[] calldata attestations
) external;

function isVerifiedKA(uint256 tokenId) external view returns (bool);

function getAttestation(uint256 tokenId) external view returns (
    string memory claimType,
    bytes32 claimDataHash,
    uint64 verifiedAt,
    uint256 signerCount
);
```

### ClaimTypeRegistry Contract

New contract managed through the Hub:

```solidity
contract ClaimTypeRegistry {
    struct ClaimTypeInfo {
        bytes32 verifierCodeHash;
        uint8 minSigners;
        uint64 maxVerificationAge;
        address registeredBy;
        bool active;
    }

    mapping(string => ClaimTypeInfo) public claimTypes;

    function registerClaimType(
        string calldata claimTypeId,
        bytes32 verifierCodeHash,
        uint8 minSigners,
        uint64 maxVerificationAge
    ) external;

    function deactivateClaimType(string calldata claimTypeId) external;
}
```

### Validation Logic

The `finalizeMintWithAttestations` function:

1. Looks up the `ClaimTypeInfo` for the given `claimType`.
2. Verifies `attestations.length >= claimType.minSigners`.
3. Verifies each attestation's `verified_at + maxVerificationAge >= block.timestamp`.
4. Verifies each signer's Ed25519 signature over the attestation payload.
5. Verifies no duplicate signers.
6. Stores the attestation metadata and marks the KA as verified.

---

## 9. Economic Model

### Verification Pricing

Verified KAs cost more to publish than standard KAs because storage nodes perform additional work:

```
verifiedKAFee = standardKAFee + verificationPremium(claimType)
```

The `verificationPremium` varies by claim type complexity:

| Claim Type | Typical Premium | Rationale |
|---|---|---|
| `http-liveness` | 1.2x base | Simple HTTP request |
| `dns-record` | 1.2x base | Simple DNS lookup |
| `relay-reachable` | 1.5x base | Full libp2p connection + reservation |
| Custom (contextGraph) | Set by contextGraph operator | Domain-specific |

### Verifier Incentives

Storage nodes earn additional TRAC rewards for successful verifications:

- **Verification fee share**: A portion of the `verificationPremium` goes directly to the nodes that produced valid attestations.
- **Reputation boost**: Nodes with high verification accuracy earn a reputation multiplier that increases their chances of being selected as signers.
- **Slashing for false attestations**: If a dispute reveals a signer attested to a false claim, their staked TRAC is partially slashed. (See [Dispute Resolution](#10-dispute-resolution).)

### Publisher Incentives

Publishers of Verified KAs benefit from:

- **Higher query trust**: Agents can filter for verified KAs, giving verified publishers more visibility.
- **Premium pricing**: Verified private KAs can command higher access fees because buyers have stronger guarantees.
- **Conviction multiplier bonus**: Verified KAs contribute a higher conviction score to the publisher's PCA.

---

## 10. Dispute Resolution

### Challenge Mechanism

Any agent can challenge a verified KA's attestation by submitting a dispute:

```solidity
function disputeAttestation(
    uint256 tokenId,
    bytes calldata counterEvidence
) external payable;  // requires dispute bond
```

### Dispute Flow

```
Challenger                    Chain                     Arbitration
   │                           │                           │
   │ disputeAttestation(       │                           │
   │   tokenId,                │                           │
   │   counterEvidence)        │                           │
   │ + dispute bond            │                           │
   │──────────────────────────>│                           │
   │                           │                           │
   │                           │  Dispute window opens     │
   │                           │  (e.g. 7 days)            │
   │                           │                           │
   │                           │  Re-verify claim          │
   │                           │──────────────────────────>│
   │                           │                           │
   │                           │  verdict: valid/invalid   │
   │                           │<──────────────────────────│
   │                           │                           │
   │                           │  If invalid:              │
   │                           │    slash signers           │
   │                           │    reward challenger       │
   │                           │    mark KA unverified     │
   │                           │                           │
   │                           │  If valid:                │
   │                           │    slash challenger bond   │
   │                           │    reward signers          │
```

### Phase 1 Simplification

For the initial implementation, disputes are resolved by a committee of high-reputation nodes rather than a full on-chain arbitration protocol. This provides a path to decentralized arbitration without blocking the initial launch.

---

## 11. Stale Claims & Liveness

### The Freshness Problem

A claim verified at time T may become false at time T+1. A relay that was reachable yesterday may be offline today. A URL that returned 200 this morning may return 404 tonight.

### Renewal Protocol

Verified KAs can optionally specify a `renewalInterval`:

```turtle
<did:dkg:31337/0xPublisher/42>
    dkg:renewalInterval "3600"^^xsd:integer .  # re-verify every hour
```

When the renewal interval elapses:

1. The publisher (or an automated agent acting on behalf of the publisher) broadcasts a `RenewVerificationRequest`.
2. Storage nodes re-run the verification and submit fresh attestations.
3. The on-chain `verifiedAt` timestamp is updated.
4. If re-verification fails, the KA's verified status is revoked (but the KA itself remains — only the attestation is invalidated).

### Grace Period

A configurable grace period (e.g., 2x the renewal interval) allows for temporary outages. During the grace period, the KA is marked `verification-expired` rather than `unverified`, signaling to querying agents that it *was* verified but needs renewal.

### Passive Monitoring

Storage nodes holding a verified KA can perform periodic spot-checks even without a formal renewal request. If a spot-check fails, the node can:

1. Emit a `CLAIM_DEGRADED` event on the DKG EventBus.
2. Stop advertising the KA as verified in query responses.
3. Optionally initiate a dispute if the failure is persistent.

---

## 12. Security Considerations

### Collusion

If N signers collude, they can attest to a false claim. Mitigations:

- **Random signer selection**: Signers are selected pseudo-randomly from the network, not chosen by the publisher.
- **Geographic/operator diversity**: The selection algorithm prefers signers from different operators and geographic regions.
- **Minimum signer threshold**: Claim types with higher stakes require more signers (e.g., 5-of-N instead of 3-of-N).

### Verifier Manipulation

A malicious verifier module could always return `true`. Mitigations:

- **Verifier code hash**: On-chain `ClaimTypeRegistry` stores a hash of the canonical verifier code. Nodes running modified verifiers produce attestations that won't match.
- **Cross-verification**: Querying agents can independently re-run the verification to check if the attested result still holds.

### DoS via Verification Requests

Publishers could flood the network with expensive verification requests. Mitigations:

- **Per-node rate limiting**: Nodes cap verification requests per minute.
- **Upfront fee escrow**: The publisher must escrow the verification premium before nodes begin work.
- **Claim type blacklisting**: Operators can disable specific claim types on their node.

### Privacy

Some verifications may leak information (e.g., revealing that a specific URL exists, or that a wallet has a certain balance). Mitigations:

- **Verifier privacy mode**: Verifiers can be configured to check claims without recording the full input in on-chain attestations — only the hash of `claimData` is stored.
- **Zero-knowledge proofs**: Future extension for verifiers that prove a claim holds without revealing the claim details.

---

## 13. Use Cases

### 13.1 Verified Relay Nodes

**Claim**: "Peer 12D3KooW... is a functioning circuit relay server."

**Flow**:
1. Relay operator publishes a KA with `claimType: dkg:claim/relay-reachable`.
2. Three storage nodes independently connect to the relay, request a reservation.
3. All three confirm the relay is reachable and functioning.
4. The KA is finalized on-chain with attestations.
5. Edge nodes querying for relays can filter for verified relays, gaining confidence that the listed peer actually works.

**Renewal**: Every 30 minutes, ensuring stale relays are quickly de-listed.

### 13.2 API Endpoint Discovery

**Claim**: "https://api.weather.example.com/v2/forecast responds with HTTP 200 and Content-Type application/json."

**Flow**:
1. API provider publishes a KA describing their endpoint with `claimType: dkg:claim/http-liveness`.
2. Storage nodes verify the endpoint is reachable and returns the expected response.
3. Consumer agents discover the API through the DKG and trust it because it's verified.

**Renewal**: Every hour.

### 13.3 NFT Ownership Verification

**Claim**: "Wallet 0xDEF owns NFT #42 from contract 0xABC on Ethereum mainnet."

**Flow**:
1. Agent publishes a KA asserting NFT ownership with `claimType: contextGraph:nft/ownership`.
2. Storage nodes query the ERC-721 contract's `ownerOf(42)`.
3. If the result matches 0xDEF, they sign the attestation.
4. Other agents can trust this ownership claim without making their own on-chain queries.

**Renewal**: Every 6 hours (ownership can transfer).

### 13.4 Academic Citation Verification

**Claim**: "DOI 10.1234/example.2026 exists and was published by 'Nature' in 2026."

**Flow**:
1. Research agent publishes a KA citing a paper with `claimType: contextGraph:research/doi-exists`.
2. Storage nodes query the CrossRef API for the DOI.
3. They verify the DOI exists and the metadata matches.
4. AI agents building on this research can trust the citation.

### 13.5 Agent Capability Attestation

**Claim**: "Agent 12D3KooW... successfully processed an ImageAnalysis skill request within 5 seconds."

**Flow**:
1. Agent publishes a KA claiming a specific capability with `claimType: contextGraph:agent/skill-benchmark`.
2. Storage nodes send a test skill request to the agent and measure the response.
3. If the response is valid and within the claimed latency, they attest.
4. Agents searching for ImageAnalysis providers can prioritize verified agents.

---

## 14. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–4)

| Task | Description |
|---|---|
| Extend protobuf | Add `claim_type`, `claim_data` to `KAManifestEntry`; add `verified`, `attestation`, `verified_at` to `PublishAck` |
| `ClaimVerifier` interface | Define TypeScript interface and `VerifierRegistry` |
| `RelayReachableVerifier` | Implement the first built-in verifier |
| `PublishHandler` changes | Check for `claimType`, load verifier, execute, include attestation in ack |
| Publisher changes | Collect attestations, include in finalize TX |
| Backward compatibility | Ensure empty `claimType` follows existing path with zero overhead |

### Phase 2: On-Chain (Weeks 5–8)

| Task | Description |
|---|---|
| `ClaimTypeRegistry` contract | Deploy registry with built-in claim types |
| `KnowledgeAssetsStorage` extension | Add attestation storage and `isVerifiedKA` query |
| `finalizeMintWithAttestations` | New finalization function with attestation validation |
| EVMChainAdapter changes | Wire up new contract calls |
| MockChainAdapter changes | Mirror on-chain logic for testing |

### Phase 3: Additional Verifiers (Weeks 9–12)

| Task | Description |
|---|---|
| `HttpLivenessVerifier` | HTTP endpoint verification |
| `DnsRecordVerifier` | DNS record verification |
| ContextGraph claim type registration | Allow contextGraph operators to register custom types |
| SPARQL extensions | `dkg:isVerified`, `dkg:claimType` filters in queries |

### Phase 4: Economics & Renewal (Weeks 13–16)

| Task | Description |
|---|---|
| Verification pricing | Premium calculation per claim type |
| Verifier rewards | TRAC distribution to attestation signers |
| Renewal protocol | Automated re-verification with `renewalInterval` |
| Stale claim handling | Grace periods, `verification-expired` status |
| Basic dispute mechanism | Challenge + committee-based resolution |

### Phase 5: Advanced (Future)

| Task | Description |
|---|---|
| Zero-knowledge verifiers | Prove claims without revealing input |
| Cross-chain verification | Verify claims on chains other than the DKG's home chain |
| Reputation system | Verifier accuracy tracking and selection weighting |
| Full on-chain arbitration | Replace committee disputes with cryptoeconomic arbitration |

---

## Appendix A: Relationship to Existing Specs

| Spec | Relationship |
|---|---|
| Trust Layer (`SPEC_TRUST_LAYER.md`) | Verified KAs extend the existing publishing and finalization flow. All existing guarantees (merkle root, epoch commitment) remain unchanged. |
| Marketplace (`SPEC_PART1_MARKETPLACE.md`) | Verified KAs are a premium tier in the marketplace. Standard KAs continue to work as before. |
| Economy (`SPEC_PART2_ECONOMY.md`) | Verification pricing and verifier rewards integrate with the existing TRAC token economics. |
| Extensions (`SPEC_PART3_EXTENSIONS.md`) | The verifier plugin system follows the same pattern as neural query extensions — optional packages that enhance node capabilities. |

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **Attestation** | A storage node's signed statement that it independently verified a claim at a specific time. |
| **Claim** | A structured real-world assertion within a KA that can be mechanically verified. |
| **Claim Type** | A registered identifier mapping to a specific verification procedure. |
| **Renewal** | The process of re-verifying a claim after its initial verification expires. |
| **Verifier** | A plugin module implementing verification logic for a specific claim type. |
| **Verified KA** | A Knowledge Asset with claim attestations from independent storage nodes. |
| **Verification Premium** | Additional fee charged for publishing a Verified KA, compensating verifier nodes. |
