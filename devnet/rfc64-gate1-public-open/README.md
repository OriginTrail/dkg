# OT-RFC-64 Gate 1 public/open production harness

This harness has a closed evidence schema and a real process boundary. It boots
an author and receiver as separate `DKGAgent` OS processes, connects them over
libp2p, derives the same open policy independently on both nodes, exercises the
production RFC-64 catalog APIs, kills the receiver with `SIGKILL`, restarts it
against the same durable directory, and requires explicit reannouncement plus
idempotent replay.

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

At combined base `591ff321e9cd88f91206d15a87c882873f005c37`, only
genesis publication exists on `DKGAgent`; the other product methods are being
assembled in the native-wiring lane. The harness therefore boots and connects
real agents, then exits non-zero with the exact missing method list. It does not
write a raw or verdict artifact on that base. A follow-up composition against
the native-wiring commit completes the six-operation scenario and result
mapping.

The preserved raw schema requires production-returned evidence for:

- distinct real peer identities;
- exact successor head, catalog-row, bundle, public-content, UAL, and SWM graph;
- one inventory row and exact activated triple count;
- durable applied-head and exact semantic post-read;
- forged author-transfer rejection with the positive activation and applied head
  exactly unchanged;
- a real `SIGKILL`, restart with the same peer identity and durable directory,
  explicit reannouncement, and exact replay without duplicate activation.

The replay successor deliberately reuses the same row/content/bundle. Its head
and version advance, while the product inventory digest remains equal because
the digest commits to catalog scope plus row/content/seal/UAL/count—not head.
No durable repair intent or automatic startup repair is claimed.

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
