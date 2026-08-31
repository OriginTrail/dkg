# OT-RFC-64 Gate 1 public/open production harness

This harness has a closed evidence schema and a real process boundary. It boots
an author and receiver as separate `DKGAgent` OS processes, connects them over
libp2p, derives the same open policy independently on both nodes, exercises the
production RFC-64 catalog APIs, kills the receiver with `SIGKILL`, restarts it
against the same durable directory, and requires explicit reannouncement of the
exact accepted successor plus durable idempotent dedupe and exact unchanged SWM
readback.

There is no fixture adapter and no fallback product result. Missing methods,
unexpected return shapes, failed process cleanup, stale artifacts, and any
attempt to verify the old `not-connected` evidence fail closed.

The frozen adapter operations remain:

- `publishGenesis`
- `publishSuccessor`
- `announce`
- `appliedHeadReadback`
- `exactInventoryReadback`
- `killRestart`

The adapter currently maps those operations to:

- `DKGAgent.publishOpenAuthorCatalogGenesisV1`
- `DKGAgent.publishOpenAuthorCatalogSuccessorV1`
- `DKGAgent.announceRfc64PublicCatalogHeadV1`
- `DKGAgent.readRfc64AppliedCatalogHeadV1`
- `DKGAgent.readRfc64PublicCatalogSynchronizationEvidenceV1`
- harness-owned `SIGKILL` and process replacement

The harness maps every positive and restart field from production publication,
durable applied-head, synchronization-evidence, and staged-bundle readbacks. Its
adversarial author process stages a cryptographically valid head whose claimed
catalog author is bound to a different recovered direct-author delegation; the
real receiver must reject that mismatch without changing the previously applied
inventory or SWM projection.

The negative remains fail-closed until the product exposes the terminal typed
receiver result through
`readRfc64PublicCatalogReconciliationFailureV1(catalogHeadDigest)`. Aggregate
failure counters are insufficient evidence for the frozen authorization error
code. Missing read-only observability prevents artifact publication but does not
weaken or alter the verifier schema.

The preserved raw schema requires production-returned evidence for:

- distinct real peer identities;
- exact successor head, catalog-row, bundle, public-content, UAL, and SWM graph;
- one inventory row and exact activated triple count;
- durable applied-head and exact semantic post-read;
- forged author-transfer rejection with the positive activation and applied head
  exactly unchanged;
- a real `SIGKILL`, restart with the same peer identity and durable directory,
  explicit reannouncement, and exact replay without duplicate activation.

The restart path deliberately reannounces the same accepted successor head. It
does not invent a no-op catalog version: ordinary catalog publication correctly
rejects an unchanged bucket. The durable applied head and exact SWM projection
remain identical, the restarted receiver reports an already-applied dedupe, and
the explicit announcement is acknowledged. No durable repair intent or
automatic startup repair is claimed.

Build the agent and dependencies, then run the complete generator and verifier:

```sh
pnpm turbo run build --filter=@origintrail-official/dkg-agent...
pnpm test:gate1:rfc64-public-open-harness
```

Run only the model, verifier, product-capability, and process-lifecycle tests or
the strict harness typecheck:

```sh
pnpm test:gate1:rfc64-public-open-harness:unit
pnpm typecheck:gate1:rfc64-public-open-harness
```

Successful production runs atomically write owner-only canonical JSON:

```text
devnet/rfc64-gate1-public-open/artifacts/gate1-result.json
devnet/rfc64-gate1-public-open/artifacts/gate1-verdict.json
```

The verdict scope is `production-gate1-public-open`; fixture-era
`harness-contract-only` PASS verdicts are no longer accepted.

## Per-CG rollout transition certificate

```sh
pnpm test:rfc64-rollout-transition
```

This executable gate uses the same real `DKGAgent` process adapter and one
persistent receiver data directory. It publishes a non-empty signed catalog,
then restarts the receiver through the exact operator sequence:

1. `shadow` — legacy remains authoritative, the signed head is staged, and the
   catalog does not activate semantic triples;
2. `catalog` — legacy scope is removed and the exact staged catalog becomes the
   durable applied SWM authority;
3. `catalog` plus kill switch — Track 2 stays dormant without legacy fallback,
   while the applied head and semantic state remain durable;
4. `catalog` re-enabled — the same head is replay-safe and remains exact;
5. `legacy` — startup re-verifies and semantically deactivates the catalog-owned
   SWM projection, deletes its exact applied-head reference, and only then
   returns authority to the legacy scope; finalized VM remains intact.

Every phase also proves that finalized public VM inventory selection remains
chain-based. The adapter reports only product readbacks: service/bootstrap
liveness, configured legacy scope, manual SWM admission result, chain-VM
selection, exact staged/applied head, and exact semantic graph bytes.
