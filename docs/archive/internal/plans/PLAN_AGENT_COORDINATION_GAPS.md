# Plan: Addressing Agent Coordination Gaps

This document maps each **key gap** from the [AI Agent Coordination Assessment](./00_IMPLEMENTATION_PLAN.md#key-gaps-for-agent-coordination) to concrete deliverables, phases, and dependencies. It is the single roadmap for “how we address those gaps.”

**Last updated:** 2026-03-02

---

## Gap → Deliverables Map

| # | Gap | Primary deliverable(s) | Plan section |
|---|-----|------------------------|--------------|
| 1 | **Economic layer mostly spec** | FairSwap off-chain flow; payment proof validation; reputation | Phase 2, 3 |
| 2 | **Persistence fragile** | Atomic writes, batched flush, pluggable store wiring | Phase 1 |
| 3 | **Discovery local-only** | Federated / network-wide discovery spec + implementation | Phase 3 |
| 4 | **No structured negotiation** | Negotiation protocol spec + protocol implementation | Phase 3 |
| 5 | **No async/long-running tasks** | Async skills spec + task ID, polling, completion notifications | Phase 2 |
| 6 | **No capability attestation** | Capability attestation spec + optional challenge/endorsement | Phase 4 |
| 7 | **Private data no redundancy** | Private data redundancy spec + encrypted replication/backup | Phase 4 |

---

## Phase 1 — Foundation (crash safety & store flexibility)

**Goal:** Harden persistence and wire pluggable backends so agents can run reliably and operators can choose storage.

| Deliverable | Spec needed? | Ref | Notes |
|-------------|--------------|-----|-------|
| **1.1** Atomic writes + batched flush for Oxigraph | No | §8.1 Phase A | Temp file + rename; debounced flush; flush on close/SIGTERM; startup integrity check. |
| **1.2** Wire `createTripleStore(config)` into `DKGAgent.create()` | No | §8.1 Phase B | `storeBackend` / `storeConfig` in config; default `oxigraph-persistent`. |
| **1.3** (Optional) HTTP SPARQL adapter | Yes — SPEC_PLUGGABLE_TRIPLE_STORE.md | §8.1 Phase C | Enables Blazegraph, GraphDB, Oxigraph server, etc. |

**Outcome:** Crashes are less likely to corrupt the store; pluggable backends are possible. No new specs required for 1.1–1.2.

**Suggested order:** 1.1 → 1.2 → (later) 1.3.

---

## Phase 2 — Trusted transactions & async skills

**Goal:** Agents can transact with trust (payment escrow + validation) and support long-running skill invocations.

| Deliverable | Spec needed? | Ref | Notes |
|-------------|--------------|-----|-------|
| **2.1** FairSwap off-chain flow for skill invocations | Yes — SPEC_SKILL_PAYMENT_FLOW.md | §4.4 | Lock TRAC → invoke → reveal/dispute; MessageHandler validates payment proof before running skill handler. |
| **2.2** Agent reputation tracking | Yes — SPEC_AGENT_REPUTATION.md | §4.5 | Success/failure per offering; optional slashing; can build on FairSwap outcomes. |
| **2.3** Async / long-running skill invocations | Yes — SPEC_ASYNC_SKILLS.md | §8.6 | Task ID on accept; polling or GossipSub on completion; progress/cancel; result by task ID with TTL. |

**Outcome:** “Agents that can talk” become “agents that can transact with trust”; real ML/long-running workloads don’t time out.

**Suggested order:** 2.1 (FairSwap flow) first — unblocks 2.2 and makes paid async (2.3) meaningful. Then 2.3, then 2.2.

**Spec creation order:** SPEC_SKILL_PAYMENT_FLOW.md → SPEC_ASYNC_SKILLS.md → SPEC_AGENT_REPUTATION.md.

---

## Phase 3 — Discovery & negotiation

**Goal:** Network-wide discovery so agents find skills they haven’t synced; optional negotiation before invocation.

| Deliverable | Spec needed? | Ref | Notes |
|-------------|--------------|-----|-------|
| **3.1** Federated / network-wide discovery | Yes — SPEC_FEDERATED_DISCOVERY.md (or extend §1.7) | §1.7 | Federated query and/or DHT-backed skill index so agents can discover peers they haven’t synced. |
| **3.2** Structured negotiation protocol | Yes — SPEC_NEGOTIATION_PROTOCOL.md | §8.5 | Capability probing, price negotiation, SLA (timeout, retries), batch pricing; optional pre-invoke step. |

**Outcome:** Discovery scales beyond local sync; multi-step and marketplace-style flows are possible.

**Suggested order:** 3.1 then 3.2 (discovery enables “find then negotiate”). Specs can be written in parallel once Phase 2 specs are stable.

---

## Phase 4 — Trust signals & resilience

**Goal:** Trust bootstrapping (attestation) and fault tolerance for private data.

| Deliverable | Spec needed? | Ref | Notes |
|-------------|--------------|-----|-------|
| **4.1** Agent capability attestation | Yes — SPEC_CAPABILITY_ATTESTATION.md | §8.7 | Challenge-response, endorsement graph, verifiable credentials, or stake-backed claims; can tie into §4.5 reputation. |
| **4.2** Private data redundancy | Yes — SPEC_PRIVATE_DATA_REDUNDANCY.md | §8.4 | Encrypted replication to N peers, backup to IPFS/Arweave, or threshold secret sharing. |

**Outcome:** Agents can assess capability and reputation; private knowledge survives node failure.

**Suggested order:** 4.1 and 4.2 can proceed in parallel after Phase 2–3. 4.1 aligns with reputation (Phase 2.2).

---

## Cross-cutting and already planned

- **Private KA access (§2.1):** Completes publish → access loop; supports paid private knowledge. Implement in parallel with or just before Phase 2.
- **Crash recovery (§8.3):** Tentative KCs and partial workspace recovery. Spec: SPEC_CRASH_RECOVERY.md. Fits after Phase 1.
- **Key storage hardening (§8.8):** OS keychain / KMS for production. Spec: SPEC_KEY_MANAGEMENT.md. Phase 4 or later.
- **Log rotation (§8.2):** Simple and ready; can be done anytime.

---

## Spec creation order (summary)

To unblock implementation in the order above:

1. **SPEC_SKILL_PAYMENT_FLOW.md** — FairSwap off-chain flow (Phase 2.1).
2. **SPEC_ASYNC_SKILLS.md** — Task ID, polling, completion, TTL (Phase 2.3).
3. **SPEC_AGENT_REPUTATION.md** — Success/failure, slashing (Phase 2.2).
4. **SPEC_FEDERATED_DISCOVERY.md** (or §1.7 spec) — Network-wide discovery (Phase 3.1).
5. **SPEC_NEGOTIATION_PROTOCOL.md** — Negotiation protocol (Phase 3.2).
6. **SPEC_CAPABILITY_ATTESTATION.md** — Attestation options (Phase 4.1).
7. **SPEC_PRIVATE_DATA_REDUNDANCY.md** — Private data redundancy (Phase 4.2).

Optional / later: SPEC_PLUGGABLE_TRIPLE_STORE.md (Phase 1.3), SPEC_CRASH_RECOVERY.md, SPEC_KEY_MANAGEMENT.md.

---

## Implementation order (recommended)

| Order | Item | Phase | Rationale |
|-------|------|-------|------------|
| 1 | 1.1 Atomic writes + batched flush | 1 | Crash safety, no spec, high impact. |
| 2 | 1.2 Wire createTripleStore in agent | 1 | Unlocks pluggable backends; small refactor. |
| 3 | 2.1 FairSwap off-chain flow | 2 | Critical path to trusted agent transactions. |
| 4 | 2.1 Private KA access (publish/access loop) | — | Complements economy; use with payment proof. |
| 5 | 2.3 Async skill invocations | 2 | Required for real AI workloads. |
| 6 | 2.2 Agent reputation | 2 | Trust signal for marketplace. |
| 7 | 1.3 HTTP SPARQL adapter (optional) | 1 | Production-grade store options. |
| 8 | 3.1 Federated discovery | 3 | Network-wide skill search. |
| 9 | 3.2 Negotiation protocol | 3 | Sophisticated coordination. |
| 10 | 4.1 Capability attestation | 4 | Trust bootstrapping. |
| 11 | 4.2 Private data redundancy | 4 | Fault tolerance for private knowledge. |

---

## Success criteria per gap

| Gap | Success criteria |
|-----|------------------|
| 1. Economic layer | Payment proof validated on skill invocation; escrow flow (lock → invoke → settle/dispute) implemented and tested. |
| 2. Persistence | No flush-on-every-write; atomic persist; optional pluggable backend; agent uses factory. |
| 3. Discovery | Agents can discover skill providers beyond what they have synced (federated or DHT). |
| 4. Negotiation | Optional pre-invoke step: capability probe, price/SLA negotiation, then invoke. |
| 5. Async tasks | Invocation returns task ID; client can poll or subscribe for completion; result retrievable by ID with TTL. |
| 6. Capability attestation | At least one mechanism (challenge-response, endorsement, or stake) specified and implemented. |
| 7. Private redundancy | Private triples can be replicated or backed up so they survive single-node failure. |

---

## References

- **Master plan:** [00_IMPLEMENTATION_PLAN.md](./00_IMPLEMENTATION_PLAN.md) — full task list, status, and section refs (§1.x, §4.x, §8.x).
- **Economy:** [SPEC_PART2_ECONOMY.md](../SPEC_PART2_ECONOMY.md), [PLAN_TRUST_LAYER.md](./PLAN_TRUST_LAYER.md).
- **Cross-agent query:** [SPEC_CROSS_AGENT_QUERY.md](../specs/SPEC_CROSS_AGENT_QUERY.md).
