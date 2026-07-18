# OT-RFC-65 task coverage matrix

This matrix proves that the implementation backlog covers the complete RFC
system context rather than only its happy-path architecture. The full normative
text remains
[OT-RFC-65-wal-byte-set-reconciliation-sync.md](OT-RFC-65-wal-byte-set-reconciliation-sync.md);
task mappings are ownership,
not replacements for the RFC.

## RFC section coverage

| RFC section | Primary task ownership | Acceptance owner |
|---|---|---|
| Abstract | `WAL-000`, `WAL-002`, `WAL-019`, `WAL-024` | `WAL-024` proves the complete boundary. |
| 0. Decision | `WAL-002`, `WAL-019`, `WAL-023`, `WAL-024` | `WAL-023` proves one authority; `WAL-024` retires legacy only afterward. |
| 1. Scope and measurable criteria | `WAL-000`, `WAL-021`, `WAL-022`, `WAL-024` | `WAL-022` produces evidence; `WAL-024` gates release. |
| 2. Architecture | `WAL-002`–`WAL-020` | Integration in `WAL-019`; end-to-end in `WAL-024`. |
| 3. Required invariants | All tasks; detailed below | `WAL-021` adversarial suite and `WAL-024` final gate. |
| 4. Canonical encoding, hashes, signatures | `WAL-001`, `WAL-003` | Cross-implementation fixtures in `WAL-003`. |
| 5. Namespace and disclosure views | `WAL-007`, `WAL-008`, `WAL-016` | Privacy suite in `WAL-008` and `WAL-021`. |
| 6. Protocol objects | `WAL-001`, `WAL-003`, `WAL-007`, `WAL-008`, `WAL-012`, `WAL-016`, `WAL-017`, `WAL-023` | Wire vectors in `WAL-001`/`WAL-003`. |
| 7. Blob format and resumable transfer | `WAL-004`, `WAL-009`, `WAL-010` | Resume/adversarial evidence in `WAL-004`, `WAL-021`, `WAL-022`. |
| 8. Deterministic set tree | `WAL-005`, `WAL-009`, `WAL-019` | Completeness/scaling proof in `WAL-005` and `WAL-022`. |
| 9. Transport protocol | `WAL-009`, `WAL-010`, `WAL-019` | Framing/auth/abuse suite in `WAL-009` and `WAL-021`. |
| 10. Durable storage | `WAL-006`, `WAL-011`, `WAL-013` | Crash suite in `WAL-006`, `WAL-013`, `WAL-021`. |
| 11. RDF canonicalization/compiler | `WAL-012` | Semantic parity in `WAL-000`, `WAL-012`, `WAL-022`. |
| 12. Signed RDF policy | `WAL-007`, `WAL-011`, `WAL-012`, `WAL-014` | Policy negative suite in `WAL-012`/`WAL-021`. |
| 13. Reducer and conflicts | `WAL-014` | All-permutation fixtures in `WAL-014`/`WAL-021`. |
| 14. Atomic materialization | `WAL-015` | Backend fault capability suite in `WAL-015`/`WAL-021`. |
| 15. Private payloads | `WAL-001`, `WAL-008` | Non-disclosure/crypto parity in `WAL-008`, `WAL-021`, `WAL-022`. |
| 16. VM activation and reorgs | `WAL-016` | Existing chain corpus plus reorg suite in `WAL-016`/`WAL-021`. |
| 17. Deletion, expiry, snapshots, compaction, genesis, backfill | `WAL-017`, `WAL-018` | No-resurrection/backfill evidence in `WAL-017`, `WAL-018`, `WAL-022`. |
| 18. Parallel protocol and hard cutover | `WAL-002`, `WAL-013`, `WAL-019`, `WAL-023`, `WAL-024` | Shadow evidence in `WAL-022`; authority switch in `WAL-023`/`WAL-024`. |
| 19. Implementation layout/concurrency/limits | `WAL-002`–`WAL-020` | Bounds suite in `WAL-009`, `WAL-019`, `WAL-021`. |
| 20. API and readiness | `WAL-013`, `WAL-020` | Forced-state diagnostic suite in `WAL-020`/`WAL-022`. |
| 21. Acceptance tests | `WAL-021`, `WAL-022`, `WAL-024` | Final release gate in `WAL-024`. |
| 22. Implementation-freeze checklist | `WAL-001` plus specialized owners below | `WAL-001` blocks dependent work until normative closure. |
| 23. Fixed version-1 decisions | `WAL-001`–`WAL-023` | Conformance and full protocol proof in `WAL-021`/`WAL-024`. |
| 24. References | System context and informative comparison | Provenance/checksum in `README.md`. |

## Required-invariant coverage

| Invariant | Primary tasks | Required proof |
|---|---|---|
| Immutable identity | `WAL-003`, `WAL-004`, `WAL-005` | Canonical object/blob/set vectors and substitution negatives. |
| Authorization before disclosure | `WAL-007`–`WAL-010` | Private request probes return no metadata before authorization. |
| Explicit completeness | `WAL-005`, `WAL-007`, `WAL-019` | Exact vector/checkpoint/root/count convergence. |
| Pull is correctness | `WAL-010`, `WAL-019` | Lost-nudge/offline tests still converge. |
| WAL before RDF | `WAL-006`, `WAL-011`, `WAL-013`, `WAL-015` | Crash tests show no RDF before durable closed WAL state. |
| Deterministic projection | `WAL-012`–`WAL-016` | All arrival/provider permutations yield identical digests. |
| Deletion is a record | `WAL-014`, `WAL-017` | Absence never deletes; tombstone/no-resurrection tests pass. |
| No silent conflict loss | `WAL-014`, `WAL-015` | Every incompatible branch and resolution head is explicit. |
| Bounded resources | `WAL-004`–`WAL-011`, `WAL-014`, `WAL-019`, `WAL-021` | Frame/proof/blob/closure/conflict/queue resource attack tests. |
| One authoritative switch | `WAL-002`, `WAL-023`, `WAL-024` | Legacy before cutover; WAL after one signed persistent ID; never both. |

## Implementation-freeze item coverage

| Freeze item | Normative owner | Implementation owner | Acceptance proof |
|---|---|---|---|
| 0. `WalObjectV1` atom and large-object range contract | `WAL-001` | `WAL-003`, `WAL-004`, `WAL-005`, `WAL-009`, `WAL-010` | One reconciled `WalObjectId`, inline opaque payload, ephemeral range resume, bounded-memory temporary staging, complete verification, and atomic promotion; no separately addressed payload/blob/chunk. |
| 1. Signed adapter payload envelope | `WAL-001` | `WAL-003`, `WAL-008` | Envelope remains inline in `WalObjectV1.payloadBytes`; signed/AEAD metadata vectors and unsigned-side-information negatives; no independent payload identity. |
| 2. Snapshot wire schema and closure | `WAL-001` | `WAL-017`, `WAL-018` | Below-floor bootstrap, custody, GC, and closure tests. |
| 3. Set-tree/object-range conformance | `WAL-001` | `WAL-004`, `WAL-005` | Independent implementations, exact set roots/proofs, and whole-object range/reassembly vectors without chunk identities. |
| 4. Reducer conformance | `WAL-001` | `WAL-012`, `WAL-014` | Normative fixtures under all permutations. |
| 5. Cross-view `MOVE_TIER` privacy | `WAL-001` | `WAL-008`, `WAL-016` | Public target contains no private source metadata. |
| 6. Authority lifecycle/availability | `WAL-001` | `WAL-007`, `WAL-023` | Rotation, HA, revocation, rollback guard, and recovery cases. |
| 7. Provider discovery/cold start | `WAL-001` | `WAL-010`, `WAL-018` | Empty-node public/private authorized bootstrap. |
| 8. Cutover cohort/late nodes | `WAL-001` | `WAL-023`, `WAL-024` | Full-inventory, offline, decommissioned, and late-return rehearsal. |
| 9. Complete resource bounds | `WAL-001` | `WAL-004`–`WAL-011`, `WAL-014`, `WAL-019` | Adversarial bound suite in `WAL-021`. |
| 10. VM finality policy | `WAL-001` | `WAL-016` | Author cannot weaken current network/chain finality. |

## Measurable-goal coverage

| Goal | Implementation tasks | Measurement task |
|---|---|---|
| SWM/VM semantic compatibility | `WAL-012`–`WAL-019` | `WAL-000`, `WAL-022`, `WAL-024` |
| Existing crypto compatibility | `WAL-003`, `WAL-007`, `WAL-008`, `WAL-016` | `WAL-000`, `WAL-021`, `WAL-022` |
| Exact convergence | `WAL-005`, `WAL-007`, `WAL-019` | `WAL-021`, `WAL-022` |
| Equal-set cost | `WAL-005`, `WAL-019` | `WAL-022` |
| Delta-proportional work | `WAL-004`, `WAL-005`, `WAL-019` | `WAL-022` |
| Backfill and rebuild | `WAL-015`, `WAL-017`, `WAL-018` | `WAL-021`, `WAL-022` |
| Interrupted transfer efficiency | `WAL-004`, `WAL-010` | `WAL-021`, `WAL-022` |
| Crash safety | `WAL-004`, `WAL-006`, `WAL-011`, `WAL-013`, `WAL-015`, `WAL-017`–`WAL-019` | `WAL-021` |
| Conflict determinism | `WAL-012`, `WAL-014`, `WAL-015` | `WAL-021`, `WAL-022` |
| Private-data non-disclosure | `WAL-007`–`WAL-010`, `WAL-016` | `WAL-021`, `WAL-022` |
| VM safety | `WAL-016` | `WAL-021`, `WAL-022` |
| Write-path overhead | `WAL-013` | `WAL-000`, `WAL-022` |
| Operational diagnosis | `WAL-020` | `WAL-022` |
| Hard-cutover safety | `WAL-023` | `WAL-021`, `WAL-022`, `WAL-024` |

## Non-goal and boundary ownership

| Boundary | Enforced by |
|---|---|
| No global total order or consensus | `WAL-005`, `WAL-007`, `WAL-014` |
| No remote arbitrary SPARQL execution | `WAL-009`, `WAL-012` |
| No wall-clock last-write-wins | `WAL-014`, `WAL-017` |
| No database-engine WAL replication | `WAL-002`, `WAL-006` |
| No Iroh runtime dependency in v1 | `WAL-009`, `WAL-010` |
| No compression in v1 | `WAL-004`, `WAL-009` |
| No live dual authority/fallback after cutover | `WAL-002`, `WAL-023`, `WAL-024` |
