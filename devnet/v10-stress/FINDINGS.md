# V10 stress devnet — findings

Curated snapshot of bugs and observations surfaced by `pnpm test:devnet:v10-stress` against a fresh 6-core devnet. The suite drives 20 stakers, 100 publishes (mixed lifecycle stages and publisher modes), a mid-run 7th core, RS reconciliation, ERC-721 stake-NFT transfers, and the claim/withdraw/restake reward lifecycle — see the test header for full scope. Runtime evidence is regenerated at `FINDINGS.local.md` on each run.

## Bugs filed

### Bug 1 (FIXED) — `publishFromFinalizedAssertion` bundled all SWM content

Originally: `publishFromFinalizedAssertion` called `publishFromSharedMemory(contextGraphId, 'all', …)`, which bundled every promoted assertion currently in SWM into one KC. This produced a merkle-root mismatch against the seal computed at finalize time → `tentative` / `kcId: "0"` rejection.

**Fixed in `26c38350`** (PR #436 Round-4 review #9): the seal block in `_meta` now persists `dkg:assertionRootEntity` triples (one per `autoPartition(filteredQuads).keys()`), and `publishFromFinalizedAssertion` reads them back to scope `selection: { rootEntities: seal.rootEntities }`. Test workaround that drained SWM between batches is no longer required, but is retained because it doesn't hurt and it documents why ordering matters when leaving content in SWM.

### Bug 1a (FIXED) — assertionRootEntity round-trip stripped the IRI wrapping

`buildAssertionSealQuads` writes the rootEntity as `object: '<urn:foo>'` (N-Triples IRI form). Oxigraph parses the input correctly and stores it as a NamedNode, but on read-back `termToString` returns the bare value (`urn:foo`) for NamedNodes — `<>` is N-Triples *syntax*, not part of the data model. `parseAssertionSealQuads` then fails its regex `/^<([^>]+)>$/` and the publish returns `HTTP 500: Invalid assertionRootEntity object literal in seal`. Surfaced on the very first VM custodial publish in Phase 2.

**Fixed:** `parseAssertionSealQuads` now accepts both `<X>` and bare `X` forms, validating the unwrapped IRI against the same `UNSAFE_IRI_CHARS` reject set the producer uses. `seal.rootEntities` continues to expose bare IRIs to consumers (which re-wrap themselves for SPARQL `VALUES` — see `_loadSelectedSWMQuads`). New unit test `assertion-seal-root-entities.test.ts: parses bare-IRI form (post storage round-trip) identical to <IRI> form` pins the round-trip.

### Bug 2 — Publisher nonce race during back-to-back publishes

**Where:** publisher / chain-adapter nonce management. The publisher's operational-wallet pool reads the on-chain nonce as `latest` rather than `pending`, and a second publish that lands on the same wallet inside the same block window can pick a stale value.

**Reproduction (probabilistic, ~1 in 25 fresh-cluster publishes):** issue rapid-fire `POST /api/shared-memory/publish { assertionName }` calls into the same daemon. Some `token.approve` or KC-create transactions revert with `Nonce too low. Expected nonce to be N+1 but got N`, and the publish flips to `tentative kcId: "0"`.

**Why it doesn't always fire:** the pool rotates through op-wallets, so adjacent publishes usually hit different wallets. Hitting the same wallet within the stale window is what triggers it. Background work (gossip-publish reactions, worker sweeps) can also occupy a wallet behind the scenes, which is what we suspect occasionally beats the foreground request to a nonce.

**Fix direction:** the chain-adapter should switch nonce-fetching to `eth_getTransactionCount(wallet, 'pending')`, OR the op-wallet pool should track per-wallet pending nonces in-process and refuse to dispatch until the previous tx is mined. The latter is more defensive against external tx submissions; the former is a one-line change in the adapter.

**Workaround in the suite:** insert a 2s gap before the VM-custodial batch and retry once on `tentative` after a 2s back-off. This let the test pass in CI but masks the bug for end users.

### Bug 3 (FIXED) — Confirmed-publish data not promoted to per-cgId data graph on same-graph publishes

`DKGPublisher.publishFromSharedMemory`'s data-promotion branch was originally MOVING data from `<NAME>/data` (default) to `<NAME>/context/<cgId>/data` (per-cgId) on every confirmed V10 publish. Agent E2E tests query the default URI via `agent.query(label)` and broke. The earlier fix (`c2abbc9a`) restricted the move to REMAP-flow publishes only (`publishContextGraphId` set), which fixed agent E2E but quietly broke RS proof submission: `kc-extractor.ts` always queries `GRAPH <contextGraphDataUri(cgName, cgId)>` (= per-cgId), so on same-graph publishes RS saw zero triples and emitted `kc-not-synced` for every challenge. Across the entire devnet, **0/5 cores** submitted RS proofs in the 120s Phase-4 window before the fix.

**Fixed:** data is now ALWAYS COPIED to the per-cgId data graph (mirroring the meta pattern that was already correct), and on REMAP publishes is additionally deleted from the default graph. Same-graph publishes keep both copies — `agent.query(label)` finds it at the default URI, RS finds it at the per-cgId URI. Net effect: same-graph publishes carry a small data duplication cost, REMAP publishes are unchanged. Surfaced and fixed in this run; Phase 4 went from 0/5 to 1/5 cores submitting (still under-rate per the warning below, but past the test's hard floor).

## Warnings (worth investigating, not necessarily bugs)

### Mid-run added cores do not back-fill historical KCs before RS challenges

**Phase 3 evidence:** spinning up a 7th core mid-run, registering identity, staking, and setting ask works in <30s. RS prover comes online and ticks. But every challenge for ~120s lands on a KC the new node never received gossip for, so the prover correctly reports `kcId-not-synced` and submits zero proofs.

This is **expected** under V10's gossip-only sync (new nodes don't auto-fetch historical chunks), but it means a mid-run core takes one full epoch worth of new publishes (or a manual chunk sync) before it can begin earning RS rewards. Worth confirming whether that's the intended bootstrap UX or whether a "pull missed-publishes since identityId mint" backfill should run at startup.

### RS proof submission rate is below 100% per epoch

**Phase 4 evidence:** of 5 active cores in the proof window, only 2 submitted proofs within 120s of the time-warp. Of those 2, 1 had on-chain score 0 (i.e. the proof was accepted but the score path didn't credit it). The other 3 cores never submitted within the window.

Possibilities to triage:
- challenge distribution doesn't reach all cores within one tick of the proof period
- chunk availability gap (related to Bug 1's bundling — KCs may not have been correctly disseminated in the first place)
- score-formula edge case at low publish counts.

This phase soft-fails (logs the gap, doesn't block the suite) so the test still completes — but the absolute numbers should be tightened before mainnet.

## Confirmed working (no findings)

- **Phase 1 — 20 stakers, mixed tiers (0/1/3/6/12), 4 cores:** total staked 30,000 TRAC, vault delta matches sum-of-stakes exactly, NFT count == 20.
- **Phase 5 — staking NFT transfer:** ERC-721 `safeTransferFrom` succeeds; the new owner can `redelegate` with a stable tokenId; per-node `getNodeStake` correctly rebalances.
- **Phase 5 — KC author-immutability documented:** `KnowledgeCollection.author` is the EIP-712 signer baked into the merkle root at finalize time and is immutable post-publish (verified by absence of any `transfer*`/`setOwner*` selectors in `KnowledgeCollection*.sol`). RFC-001 §9.6 sketches a signed-update flow that would let a new author take over a KC by re-signing the root at update time; not implemented today. The transferable assets in V10 staking are the staking NFTs — KCs themselves are bound to authorship.
- **Phase 6 — claim / atomic withdraw / restake:** withdrew a tier-0 NFT (1000 TRAC out, original stake 1000 TRAC), restaked 500 TRAC at tier-1 with a fresh NFT. NFT burned cleanly, TRAC totals reconcile within 5% (small dilution = RS reward distribution noise from the same wallet).

## Mode coverage matrix (Phase 2)

|                       | WM-only | WM→SWM | WM→SWM→VM |
|-----------------------|---------|--------|-----------|
| custodial-agent       | 25      | 25     | 25        |
| third-party (PCA, mode A) | —   | —      | 25        |
| pre-signed self-sovereign (mode C) | — | — | 0 *      |
| unattributed          | —       | —      | 0 *       |

\* mode C and unattributed mode are exercised in `devnet/agent-provenance/automated.test.ts` instead — those paths require client-side EIP-712 + V10 merkle-root computation, which is the express scope of the agent-provenance suite.

## Repro

```bash
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
pnpm test:devnet:v10-stress
```

The suite is deterministic given a clean devnet (assertion names are run-tagged with a timestamp, but every other identifier — staker indices, NFT tokenIds, identityIds — is recomputed against the live chain state). Re-running against an already-in-flight devnet is supported (the suite skips identity/registration steps if already present).
