# Codex review bugs from the closed PR stack (#1166–#1169) — fix before reposting

## Storage (was #1166 → graph-set-index branch)
- **B1** 🔴 `packages/storage/src/graph-set-index-store.ts:97` — the wrapper drops the `options` arg: `query()`, `listGraphs()`, `refreshIndexLoop()` don't pass `options` (incl. `AbortSignal`) through to `inner.*`. Caller cancellation no longer reaches the backend. **Fix:** thread `options` through to `inner.query`/`inner.listGraphs`.

## Catalog model + publisher (was #1167)
- **B2** 🔴 `packages/core/src/catalog.ts:29` — partition treats EVERY `rdf:type` on the catalog subject as catalog metadata → leaks arbitrary type assertions into public `_catalog`. **Fix:** special-case `rdf:type` so only allowed objects (e.g. `dcat:Dataset`) go public.
- **B3** 🔴 `packages/publisher/src/dkg-publisher.ts:1967` — writes public `_catalog` BEFORE publish is confirmed; failure paths don't roll it back → exposes a catalog entry for data that never published. **Fix:** defer the insert to the confirmed/tentative branch (or clean up on failure).
- **B4** 🔴 `packages/publisher/src/dkg-publisher.ts:1967` — only appends → repeated publishes accumulate stale catalog triples (changed `dct:publisher`/`dcat:accessService` leave old metadata queryable). **Fix:** clear/replace the catalog subject in `_catalog` before inserting.
- **B5** 🟡 `packages/publisher/src/dkg-publisher.ts:3590` — splitting `cgPath` at the last slash is ambiguous (slash-shaped root CG id vs registered sub-graph). **Fix:** derive ownership key from explicit registration metadata / exact graph-URI match.

## Agent projection + facet (was #1168)
- **B6** 🔴 `packages/agent/src/dkg-agent-publish.ts:1664` — injecting catalog quads BEFORE emptiness/reserved-subject checks makes a zero-user-triple assertion look non-empty → `finalize()` succeeds on a catalog-only assertion (regression of the "≥1 quad" contract). **Fix:** inject catalog only after validating real assertion content.
- **B7** 🔴 `packages/agent/src/dkg-agent-publish.ts:1329` — uses `result.ual` (the KA UAL) as the catalog subject instead of the CG DID/UAL → new projection subject every publish, mismatched with `did:dkg:context-graph:<id>`. **Fix:** resolve subject from `contextGraphId`.
- **B8** 🔴 `packages/agent/src/dkg-agent-publish.ts:1333` — `this.publish(target, quads)` writes catalog into the TARGET CG's `_catalog`, but open-serve reads `<source-cg>/_catalog` → outsiders get an empty catalog. **Fix:** persist under the SOURCE CG's `_catalog`.
- **B9** 🔴 `packages/agent/src/context-graph-meta-projection.ts:233` — read projection never reads `<cg>/_catalog`; catalog quads are invisible to `getCgMeta()`/`listContextGraphsFromProjection()`. **Fix:** include the catalog graph in rebuild/discovery sources + map DCAT/private-access predicates.

## Recovery (was #1169)
- **B10** 🔴 `packages/agent/src/sync/requester/swm-recovery.ts:134` — `applySwmRecovery()` runs even when `meta.completed`/`data.completed` is false; row-based pagination means a root can span the last page → clearing + reinserting only the fetched prefix truncates the entity until retry. **Fix:** only replace after both phases complete, or track per-root completeness and skip incomplete roots.
- **B11** 🔴 `packages/agent/src/dkg-agent-lifecycle.ts:4134` — cleanup deletes SWM data from subgraph/per-KA graphs, but ownership eviction only removes `workspaceOwnedEntities.get(pid)`; `${pid}\0${subGraph}`-keyed entries survive → expired roots still look owned, mis-arbitrate later writes. **Fix:** clear ownership per graph via `sharedMemoryOwnershipKeyFromGraph`.
- **B12** 🔴 `packages/agent/src/dkg-agent-lifecycle.ts:3004` — `recoverContextGraphSwmFromPeer` is orphaned (no production call sites; member-recovery authorizer only used in tests). **DESIGN NOTE:** we deliberately kept it explicit-trigger-only (NOT blanket on-connect — the advisor-caught race/clobber). Resolution is either (a) wire the explicit recovery trigger now (the node-UI milestone), or (b) keep as reviewed foundation with the wiring as the immediate next PR. **Needs user decision.**
