# Attested Knowledge Assets (AKA) — Protocol Specification

Status: Draft v0.2
Scope: DKG v9 protocol-level extension. Application-agnostic.

---

## 1) Problem Statement

DKG v9 paranets are open write environments. Any node in a paranet can publish Knowledge Assets. This is useful for open data sharing, but insufficient for applications that need:

- bounded participation (only specific nodes may contribute),
- deterministic state progression (all participants agree on state transitions),
- verifiable finality (state is accepted only when enough participants confirm it).

Examples: multiplayer games, collaborative agent workflows, multi-party computations, supply chain checkpoints.

### What exists today

- Knowledge Assets (KA) are published to a paranet.
- Nodes send signed ACKs back to the publisher when they agree on a Merkle hash of the data they have received.
- On-chain finalization occurs when sufficient ACKs are collected.

### What is missing

- No concept of a "session" scoping a subset of participants with shared rules.
- No mechanism to gate writes by membership.
- No application-level deterministic state validation before ACK.
- No way to distinguish "I received this data" from "I validated and agree with this state transition."

### Proposal

Introduce Attested Knowledge Assets (AKA): a new asset mode where DKG ACKs carry application-level validation semantics. A node ACKs an AKA event only if it has independently validated the state transition. On-chain finalization is gated by quorum of these validation-ACKs.

### Relationship to Verified Knowledge Assets

Verified KAs (`SPEC_VERIFIED_KAS.md`) address real-world claim verification — storage nodes check external facts (HTTP liveness, DNS records, NFT ownership) before signing.

AKA addresses a different problem: **multi-party state machine consensus** — session members validate deterministic state transitions before signing. The two specs are complementary and share the same ACK infrastructure with different validation semantics.

---

## 2) Goals and Non-Goals

### Goals

- Define a session lifecycle primitive for DKG v9.
- Reuse and extend existing DKG ACK mechanics for validation-aware corroboration.
- Provide per-session isolation inside a shared paranet.
- Support deterministic replay and recovery from the knowledge graph.
- Coexist with legacy KA publishing (no breaking changes).

### Non-Goals

- Replace DKG protocol-level UAL encoding rules.
- Require a separate paranet per session.
- Define application-specific logic (game rules, workflow steps, etc.).
- Require per-round on-chain settlement.

---

## 3) Asset Modes

Three asset modes coexist on the same paranet:

### 3.1 Legacy KA

Current behavior, unchanged. Any paranet member can publish. ACKs confirm data receipt. Useful for telemetry, analytics, open datasets.

### 3.2 Verified KA

As defined in `SPEC_VERIFIED_KAS.md`. Storage nodes verify real-world claims before ACKing.

### 3.3 AKA (Attested Knowledge Asset)

New mode. Requires:

- A valid, active session context.
- Signer is a member of that session.
- Event conforms to session schema and state linkage rules.
- ACK semantics: a node ACKs only after independent validation of the state transition via the session's reducer.

Nodes MUST track the `mode` field on each event and route processing accordingly.

---

## 4) Core Concepts

### 4.1 Session

A session is a first-class protocol object that defines a scoped consensus domain within a paranet.

A session is immutable after activation (v1: no membership changes mid-session).

#### Required fields

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Globally unique. Derived as `SHA-256(paranetId + creatorDid + createdAt + nonce)`. |
| `paranetId` | string | Parent paranet identifier. |
| `appId` | string | Application identifier (e.g. `oregon-trail-v1`, `supply-chain-v2`). |
| `createdBy` | string | Creator node PeerId. |
| `createdAt` | ISO 8601 | Creation timestamp. |
| `membership` | array | Ordered list of `{ peerId, pubKey, displayName, role }`. Roles: `creator`, `member`. |
| `membershipRoot` | string | Merkle root of the sorted membership list (hex). |
| `quorumPolicy` | object | See section 4.3. |
| `reducer` | object | `{ name, version, hash }`. See section 4.4. |
| `genesisStateHash` | string | Hash of initial state produced by the reducer with empty input (hex). |
| `roundTimeout` | integer | Milliseconds. Maximum time for a round before timeout policy applies. |
| `maxRounds` | integer or null | Upper bound on rounds (null = unlimited). |
| `status` | enum | `proposed`, `active`, `finalized`, `aborted`. |
| `configHash` | string | SHA-256 of the canonical encoding of all fields above (excluding `configHash` itself). |

#### Session creation flow

1. Creator node publishes a `SessionProposed` event to the session gossip topic, containing all session fields and the creator's Ed25519 signature.
2. Each listed member node receives the proposal via GossipSub.
3. Each member validates the proposal (checks own PeerId is listed, reducer is available locally, quorum policy is acceptable).
4. Each member publishes a `SessionAccepted` event containing `sessionId`, `configHash`, and member Ed25519 signature.
5. When the creator observes acceptance signatures from all members, the creator publishes `SessionActivated`.
6. Session status transitions to `active`. Rounds may begin.

If any member does not accept within a configurable timeout (default: 60 seconds), session transitions to `aborted`.

This ensures no node is enrolled without consent.

### 4.2 Session Namespace

Application-level semantic namespace convention:

```
did:dkg:<network>/paranets/<paranetId>/sessions/<sessionId>
did:dkg:<network>/paranets/<paranetId>/sessions/<sessionId>/rounds/<roundNumber>
```

This is an application-level convention for graph subjects and human-readable provenance. Canonical DKG UAL representation remains as defined by the protocol. Both SHOULD be stored.

### 4.3 Quorum Policy

Quorum policy defines how many validation-ACKs are needed for finality.

```json
{
  "type": "THRESHOLD",
  "numerator": 2,
  "denominator": 3,
  "minSigners": 2
}
```

- `type`: `THRESHOLD` (v1 only; future: `UNANIMOUS`, `WEIGHTED`).
- `numerator / denominator`: fraction of active members required.
- `minSigners`: absolute minimum regardless of fraction (prevents degenerate 2/3 of 1).

Quorum is met when `count >= max(ceil(N * numerator / denominator), minSigners)` where `N` is the number of active session members.

### 4.4 Reducer

A reducer is a deterministic function: `(prevState, inputSet) -> nextState`.

To ensure all nodes compute identical results:

- `reducer.name`: human-readable identifier.
- `reducer.version`: semantic version string.
- `reducer.hash`: SHA-256 of the reducer's canonical definition. For v1, this is the hash of the published reducer source or WASM binary, pinned at session creation. All session members MUST have the exact reducer version available locally.

Reducer requirements:

- MUST be a pure function (no I/O, no wall-clock reads, no randomness beyond what is included in the input set).
- MUST produce identical output for identical `(prevState, inputSet)` on any platform.
- If the reducer needs randomness, it MUST be derived deterministically from input set contents (e.g. hash of combined vote signatures as seed).

### 4.5 Rounds

A round is one cycle of: collect inputs, propose result, validate, finalize.

AKA uses "rounds" as the generic term. Applications map domain concepts to rounds (turns in a game, steps in a workflow, epochs in a simulation).

---

## 5) Event Types

All AKA events share a common envelope:

```json
{
  "mode": "AKA",
  "type": "<EventType>",
  "sessionId": "...",
  "round": 0,
  "prevStateHash": "...",
  "signerPeerId": "...",
  "signature": "...",
  "timestamp": "...",
  "nonce": "..."
}
```

### 5.1 Session Lifecycle Events

| Type | Published by | Description |
|---|---|---|
| `SessionProposed` | Creator | Proposes session with full config. |
| `SessionAccepted` | Each member | Member confirms participation. |
| `SessionActivated` | Creator | All members accepted; session is active. |
| `SessionFinalized` | Any member (after final round) | Session completed normally. |
| `SessionAborted` | Creator or quorum | Session cancelled. |

### 5.2 Round Events

| Type | Published by | Description |
|---|---|---|
| `RoundStart` | Proposer | Signals start of input collection for round N. |
| `InputSubmitted` | Any member | Signed input for this round. |
| `RoundProposal` | Proposer | Collected inputs + computed `nextStateHash`. |
| `RoundAck` | Any member | Validation-ACK confirming agreement with proposal. |
| `RoundFinalized` | Proposer (or any, on quorum) | Quorum reached; round is final. |
| `RoundTimeout` | Any member | Timeout triggered; initiates fallback. |

---

## 6) Proposer Selection

v1: deterministic round-robin rotation.

```
proposerIndex = round % N
proposer = membership[proposerIndex]
```

Where `membership` is the ordered list from the session definition.

If the proposer fails to publish `RoundStart` within `proposerGracePeriod` (default: 5 seconds after previous round finalized), the next member in rotation becomes proposer:

```
fallbackProposerIndex = (round % N + viewChangeCount) % N
```

`viewChangeCount` increments each time a proposer misses their slot for the current round.

Any member MAY publish `RoundTimeout` after `roundTimeout` elapses to trigger view change. Timeout events require `round`, `expectedProposerPeerId`, and signer's signature.

---

## 7) Input Canonicalization

Deterministic ordering of inputs is critical. Without it, different nodes compute different `inputSetHash` values and cannot reach quorum.

### 7.1 Input collection window

The proposer collects `InputSubmitted` events for `inputCollectionWindow` milliseconds (default: 80% of `roundTimeout`).

### 7.2 Canonical ordering

Inputs are ordered by:

1. `signerPeerId` (lexicographic ascending).

If a member submits multiple inputs for the same round, only the first valid one is accepted (by earliest timestamp; ties broken by lowest event hash).

### 7.3 inputSetHash computation

```
inputSetHash = SHA-256(canonicalEncode([
  input_member_0.payload,
  input_member_1.payload,
  ...
]))
```

Where inputs are in canonical order and `canonicalEncode` is deterministic JSON (RFC 8785 / JCS).

### 7.4 Missing inputs

If some members do not submit inputs within the collection window, the proposer proceeds with whatever inputs were received. The `RoundProposal` includes the list of included `signerPeerId` values so validators know the exact input set.

---

## 8) Validation and Isolation Rules

Every node maintaining an AKA session MUST run a session validator that enforces:

### 8.1 Session existence

Referenced `sessionId` exists locally and status is `active`.

### 8.2 Membership gating

`signerPeerId` is in the session's `membership` list. Signature verifies against the corresponding `pubKey` using Ed25519.

### 8.3 Schema conformance

Event has all required fields for its type. Field types and values are within expected ranges.

### 8.4 State linkage

`prevStateHash` equals the node's current finalized state hash for that session.

### 8.5 Replay protection

The tuple `(sessionId, round, signerPeerId, type)` is unique. Additionally, `nonce` MUST be unique per signer per session.

### 8.6 Timing

Event timestamp falls within `[roundStartTime - clockSkewTolerance, roundStartTime + roundTimeout + clockSkewTolerance]`.

Default `clockSkewTolerance`: 5 seconds.

### 8.7 Reducer compatibility

Event references the same `reducer.version` and `reducer.hash` as the session definition.

### 8.8 Rejection behavior

If any check fails, the event is stored in raw paranet storage (data availability) but excluded from session state progression. The node MUST NOT ACK it as a valid AKA event.

---

## 9) Finality Model

### 9.1 Mapping to DKG ACKs

This is the key integration point with existing DKG mechanics:

- When a node receives a `RoundProposal`, it runs the reducer locally with the specified inputs and `prevStateHash`.
- If the locally computed `nextStateHash` matches the proposal's `nextStateHash`, the node publishes a `RoundAck`.
- A `RoundAck` IS a DKG ACK with enriched semantics: it confirms not just data receipt but state transition validity.
- The on-chain finalization mechanism treats `RoundAck` signatures identically to existing publish ACKs. The transaction finalizes only when quorum is met.

This means:

- No new on-chain contract logic is needed for v1 (reuse existing ACK collection and threshold checks).
- The only change is that nodes add a validation step before ACKing.
- If quorum is not met (disagreement or missing acks), the on-chain transaction does not finalize, which is exactly the safety property we want.

### 9.2 Soft Finality (Off-chain)

A round is soft-finalized when a node locally observes enough valid `RoundAck` events (via GossipSub) to satisfy the quorum policy. The node MAY advance to the next round optimistically after soft finality.

### 9.3 Hard Finality (On-chain)

Hard finality occurs when the DKG publish transaction containing the `RoundProposal` + quorum ACKs settles on chain.

### 9.4 Checkpoint Batching

To reduce on-chain cost, applications MAY batch multiple rounds into a single checkpoint:

- Settle rounds individually off-chain (soft finality).
- Periodically publish a `Checkpoint` event containing the latest finalized round number, state hash, and batch Merkle root of intermediate round commitments.
- Only the checkpoint requires on-chain hard finality.

Recommended checkpoint cadence: every N rounds or on session end, where N is application-defined.

---

## 10) Failure Handling

### 10.1 Proposer timeout

| Condition | Action |
|---|---|
| Proposer does not publish `RoundStart` within `proposerGracePeriod` | Next member in rotation becomes proposer (view change). |
| View change exhausts all members for one round | Round is skipped; session pauses. After `maxConsecutiveSkips` (default: 3), any member MAY propose `SessionAborted`. |

### 10.2 Quorum not reached

| Condition | Action |
|---|---|
| `roundTimeout` expires without quorum on any proposal | Proposer MAY re-propose with a different input set (excluding late/missing members). |
| Second attempt also fails | View change to next proposer. |
| All proposers fail for one round | Round skipped; skip policy applies (see 10.1). |

### 10.3 Conflicting proposals

If multiple `RoundProposal` events exist for the same round (from different proposers due to view change race), nodes accept only the proposal from the valid proposer per the rotation rule. Proposals from non-current proposers are ignored.

### 10.4 Equivocation

If a member publishes conflicting `RoundAck` events for the same round (different `nextStateHash` values), this is recorded as fault evidence. The session MAY continue, but the equivocating member's ACKs are excluded from quorum for the remainder of the session.

### 10.5 Node crash and recovery

A crashed node recovers by:

1. Querying the paranet graph for all AKA events in its session.
2. Replaying events from genesis through each finalized round proposal + input set.
3. Rebuilding local state by running the reducer for each round.
4. Resuming participation from the current round.

This works because:

- All events are stored in the paranet (data availability).
- The reducer is deterministic.
- Finalized round proposals contain the exact input set used.

### 10.6 Late joiners (v1: not supported)

v1 sessions have frozen membership. A node that was not in the original membership list cannot join mid-session. This avoids re-keying, epoch transitions, and quorum recalculation complexity.

---

## 11) Canonical Hashing

### 11.1 Encoding

All signed payloads MUST use RFC 8785 (JSON Canonicalization Scheme / JCS) for deterministic serialization.

### 11.2 Hash algorithm

SHA-256 for all hashes (state hashes, input set hashes, config hash, reducer hash), consistent with existing `@dkg/core` crypto utilities.

### 11.3 Signature scheme

Ed25519, consistent with existing DKG node identity keys (`@noble/ed25519`).

### 11.4 Signature domain separation

To prevent cross-context signature reuse, the signed payload for every AKA signature MUST include:

```json
{
  "domain": "AKA-v1",
  "network": "<chainId or network identifier>",
  "paranetId": "...",
  "sessionId": "...",
  "round": 0,
  "type": "<EventType>",
  "payload": { ... }
}
```

The `domain` prefix ensures AKA signatures cannot be confused with signatures from other protocols.

---

## 12) Anti-Spam and Cost Model

### 12.1 Session creation cost

Creating a session SHOULD require a small stake or fee (paranet-defined) to prevent spam session creation. This can be enforced at the paranet governance level.

### 12.2 Event write cost

AKA events within an active session are written to the paranet graph. Storage cost follows the existing paranet storage model. No additional per-event fees are required at protocol level.

### 12.3 Rate limits

Nodes SHOULD enforce per-session, per-member rate limits:

- Maximum one `InputSubmitted` per member per round.
- Maximum one `RoundAck` per member per round.
- Maximum one `RoundProposal` per valid proposer per round (plus one retry).

Events exceeding these limits are dropped before validation.

---

## 13) GossipSub Integration

### 13.1 Topics

AKA introduces a new gossip topic pattern:

```
dkg/paranet/<paranetId>/sessions             — session lifecycle events
dkg/paranet/<paranetId>/sessions/<sessionId> — round events for a specific session
```

This follows the existing topic conventions in `@dkg/core/constants.ts`.

### 13.2 Message format

All AKA gossip messages are protobuf-encoded `AKAEvent` messages (see section 14).

### 13.3 Subscription behavior

- Nodes subscribed to a paranet automatically subscribe to the sessions lifecycle topic.
- When a node joins a session (accepts membership), it subscribes to that session's topic.
- When a session finalizes or aborts, nodes unsubscribe from the session topic.

---

## 14) Protobuf Schema

### 14.1 AKA Event Envelope

```protobuf
message AKAEvent {
  string mode = 1;          // "AKA"
  string type = 2;          // Event type (SessionProposed, RoundStart, etc.)
  string session_id = 3;
  uint32 round = 4;
  string prev_state_hash = 5;
  string signer_peer_id = 6;
  bytes  signature = 7;     // Ed25519 over canonical payload
  uint64 timestamp = 8;
  string nonce = 9;
  bytes  payload = 10;      // Type-specific payload (protobuf)
}
```

### 14.2 Session Payloads

```protobuf
message SessionConfig {
  string session_id = 1;
  string paranet_id = 2;
  string app_id = 3;
  string created_by = 4;
  uint64 created_at = 5;
  repeated SessionMember membership = 6;
  string membership_root = 7;
  QuorumPolicy quorum_policy = 8;
  ReducerConfig reducer = 9;
  string genesis_state_hash = 10;
  uint32 round_timeout = 11;
  uint32 max_rounds = 12;    // 0 = unlimited
  string config_hash = 13;
}

message SessionMember {
  string peer_id = 1;
  bytes  pub_key = 2;
  string display_name = 3;
  string role = 4;           // "creator" or "member"
}

message QuorumPolicy {
  string type = 1;           // "THRESHOLD"
  uint32 numerator = 2;
  uint32 denominator = 3;
  uint32 min_signers = 4;
}

message ReducerConfig {
  string name = 1;
  string version = 2;
  string hash = 3;           // SHA-256 hex of reducer source/binary
}
```

### 14.3 Round Payloads

```protobuf
message RoundStartPayload {
  uint32 round = 1;
  string prev_state_hash = 2;
  uint64 deadline = 3;       // Unix ms
}

message InputPayload {
  uint32 round = 1;
  bytes  data = 2;           // Application-specific input (opaque)
}

message RoundProposalPayload {
  uint32 round = 1;
  string prev_state_hash = 2;
  string input_set_hash = 3;
  string next_state_hash = 4;
  repeated string included_members = 5;  // PeerIds of members whose inputs were included
  repeated bytes  included_inputs = 6;   // Corresponding input payloads in canonical order
}

message RoundAckPayload {
  uint32 round = 1;
  string prev_state_hash = 2;
  string input_set_hash = 3;
  string next_state_hash = 4;
  string turn_commitment = 5;  // SHA-256(sessionId|round|prevStateHash|inputSetHash|nextStateHash|reducerVersion|membershipRoot)
}

message RoundFinalizedPayload {
  uint32 round = 1;
  string next_state_hash = 2;
  repeated string signer_peer_ids = 3;
  repeated bytes  signatures = 4;
}
```

---

## 15) API Surface

New endpoints (or extensions to existing endpoints) for AKA:

### 15.1 Session management

| Endpoint | Method | Description |
|---|---|---|
| `/api/sessions` | POST | Create (propose) a new session. |
| `/api/sessions` | GET | List sessions (filter by `paranetId`, `status`, `member`). |
| `/api/sessions/:id` | GET | Get session metadata and status. |
| `/api/sessions/:id/accept` | POST | Accept session membership. |
| `/api/sessions/:id/activate` | POST | Activate session (creator, after all accepted). |

### 15.2 Round operations

| Endpoint | Method | Description |
|---|---|---|
| `/api/sessions/:id/rounds/:n/start` | POST | Publish RoundStart (proposer). |
| `/api/sessions/:id/rounds/:n/input` | POST | Submit signed input. |
| `/api/sessions/:id/rounds/:n/propose` | POST | Publish RoundProposal (proposer). |
| `/api/sessions/:id/rounds/:n/ack` | POST | Publish RoundAck (validation-ACK). |
| `/api/sessions/:id/rounds/:n` | GET | Get round status, inputs, acks. |

### 15.3 Query helpers

| Endpoint | Method | Description |
|---|---|---|
| `/api/sessions/:id/state` | GET | Get latest finalized state hash and round. |
| `/api/sessions/:id/rounds/:n/acks` | GET | Get all acks for a round. |
| `/api/sessions/:id/replay` | GET | Get ordered event log for replay/recovery. |

---

## 16) Compatibility

AKA is additive:

- Legacy KA endpoints and behavior are unchanged.
- Verified KA endpoints and behavior are unchanged.
- Nodes that do not support AKA ignore `mode: "AKA"` events (they appear as normal graph data).
- AKA-aware nodes process all three modes.
- The `mode` field on each event is the routing discriminator.

---

## 17) Summary

Attested Knowledge Assets extend DKG v9 with session-scoped, validation-gated Knowledge Assets.

Key properties:

- Sessions provide isolation and membership boundaries within shared paranets.
- Nodes ACK only after independent state transition validation, not just data receipt.
- Existing DKG ACK and on-chain finalization mechanics are reused, with enriched ACK semantics.
- Deterministic reducers ensure all honest nodes agree on state.
- Applications define their own reducers and round semantics; the protocol is generic.
- Legacy KA and Verified KA modes are fully preserved.
