# RC12 Context Graph Counts Regression

## Issue Summary

Branch `release/rc.12` shows every context graph in the Node UI dashboard with `0 entities` and `0 triples`, even when the same local context graphs are known to contain WM/SWM/VM data. The same UI surfaces work on `main`.

Risk classification: Medium. The fix touches query routing used by the UI and API consumers, and must preserve scoped-query isolation while restoring known-good count behavior.

## Observed Behavior

- Dashboard "My Context Graphs" rows render exact `0 entities - 0 triples`.
- Dashboard "Context Graph Size" renders `0 entities / Knowledge Assets` and `0 triples`.
- A selected context graph overview can still show activity and subgraph metadata, which indicates the context graph itself is present but the live count query path is returning empty data.

## Expected Behavior

- Context graphs with local data should show nonzero entity and triple counts.
- Empty context graphs should remain zero.
- Query scoping must not leak unrelated context graph data.

## Reproduction Notes

The provided screenshots characterize the regression. Local code comparison also reproduces the failure mode at the query-engine boundary:

- Node UI count queries use `GRAPH ?g` to enumerate named graphs inside a context graph.
- On `release/rc.12`, the query engine constrains `?g` to a small static graph set for `contextGraphId` scoped queries.
- That constraint filters out assertion graphs, subgraph SWM graphs, and subgraph VM graphs before the UI can count them.

Manual daemon verification, if a populated daemon is available:

```powershell
$body = @{
  contextGraphId = "<CG_ID>"
  sparql = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:<CG_ID>")) } LIMIT 100'
} | ConvertTo-Json

Invoke-RestMethod "http://127.0.0.1:<PORT>/api/query" -Method Post -Headers @{ Authorization = "Bearer <TOKEN>" } -ContentType "application/json" -Body $body
```

## Branch Comparison Notes

- Fix branch: `codex/rc12-context-graph-counts`, created from `origin/release/rc.12`.
- `main` is used only as a known-good reference.
- `DashboardView.tsx` and the dashboard count math are materially the same between `release/rc.12` and `main`.
- `packages/node-ui/src/ui/hooks/useMemoryEntities.ts` builds the WM/SWM/VM count queries using `GRAPH ?g` and graph URI filters.
- `packages/query/src/dkg-query-engine.ts` differs substantially. `release/rc.12` contains scoped graph-variable hardening for no-view `contextGraphId` queries; `main` no longer applies that clamp in the same way.

## Suspected Areas

- Primary: `packages/query/src/dkg-query-engine.ts`
  - `assertExplicitGraphIrisAllowed`
  - `constrainGraphVariablesToAllowedSet`
  - default no-view `contextGraphId` routing
  - `GRAPH ?g` handling
- Secondary: `packages/node-ui/src/ui/hooks/useMemoryEntities.ts`
  - Query shape and response mapping, likely a victim rather than root cause.
- Unlikely: `packages/node-ui/src/ui/views/DashboardView.tsx`
  - Rendering converts successful empty bindings into exact zeros, but does not appear to manufacture zeros from populated data.
- Unlikely: `postQueryDeduped`
  - It changes request coalescing but still sends the same `/api/query` body; evidence points to backend empty results.

## Confirmed Root Cause

`release/rc.12` query hardening constrains `GRAPH ?g` variables for `contextGraphId` scoped, no-view queries to an allow-list that defaults to the root context graph data graph and selected metadata graphs. The Node UI count queries intentionally need to enumerate all same-context-graph named graphs, including:

- `did:dkg:context-graph:<id>/assertion/...`
- `did:dkg:context-graph:<id>/_shared_memory`
- `did:dkg:context-graph:<id>/<subgraph>/_shared_memory`
- `did:dkg:context-graph:<id>/<subgraph>`

The injected graph-variable constraint leaves the UI queries with no matching rows for those content partitions. The requests succeed, so the UI treats the result as authoritative empty data and displays `0 entities - 0 triples`.

## Implementation Plan

- [x] Add targeted query-engine regression coverage for the exact Node UI `GRAPH ?g` query shape against populated WM, SWM, and VM named graphs.
- [x] Patch `packages/query/src/dkg-query-engine.ts` so self-scoped same-context-graph `GRAPH ?g` scans used by the UI are not clamped to only the root/static graph allow-list.
- [x] Preserve explicit cross-context-graph rejection for direct `GRAPH <other-cg>` scoped queries.
- [x] Preserve view-based routing behavior for `working-memory`, `shared-working-memory`, and `verified-memory`.
- [x] Run focused query tests first, then targeted Node UI count tests if the query fix is isolated.
- [x] GitHub review follow-up: gate same-CG partition enumeration behind explicit `includeContextGraphPartitions` opt-in, and use it only from UI/subgraph count surfaces.
- [x] GitHub review follow-up: restrict child context graph discovery to canonical candidate `/_meta` facts so arbitrary user triples cannot poison the parent count allow-list.
- [x] GitHub review follow-up: mark widened UI count reads partial when a successful layer reaches its fixed SPARQL `LIMIT`, so clipped totals are displayed as lower bounds rather than exact.
- [x] GitHub review follow-up: memoize same-CG partition allow-list discovery for concurrent count scans to avoid repeating full named-graph discovery for WM/SWM/VM in the same render.

Implementation note: explicit `GRAPH <...>` targets still use the static route-specific allow-list. Only `GRAPH ?g` bindings receive the expanded allow-list, and that expansion is limited to same-context root protocol content partitions, registered assertion graphs, and registered subgraph partitions. Subgraph metadata and private partitions remain excluded from broad graph-variable scans.

## Verification Plan

- [x] `pnpm --filter @origintrail-official/dkg-query exec vitest run test/query-engine.test.ts`
- [x] `pnpm --filter @origintrail-official/dkg-query run build`
- [x] `pnpm --filter @origintrail-official/dkg-node-ui exec vitest run test/use-memory-entities-counts.test.ts test/context-graph-ia-overview.test.ts test/subgraph-overview-grid.test.ts test/sub-graph-bar-layer-scope.test.ts test/ui-api-pure.test.ts`
- [x] `pnpm --filter @origintrail-official/dkg-node-ui run build`
- [ ] Generate a PR diff and run the local PR reviewer using `.codex/review-prompt.md` and `.codex/review-schema.json`.
- [ ] Re-run any tests affected by valid local review findings.

## Local PR Review Results

Completed with the local `.codex` review prompt and schema against `pr-diff.patch`.

- Round 1 found two valid blockers:
  - `_verified_memory/staging/*` graphs were admitted by the widened `GRAPH ?g` allow-list.
  - same-prefix child context graph roots could be misclassified as parent subgraph partitions.
- Round 2 found one valid blocker:
  - once a child context graph root was known, its child partitions such as `_shared_memory` and `_verified_memory/*` still needed to be excluded.
- Round 3 returned `{"comments":[]}`.

All valid findings were addressed with regression coverage before push.

GitHub review follow-up for PR #844:

- Valid finding: broad same-CG partition enumeration was available on every scoped `GRAPH ?g` query, widening legacy `{ contextGraphId }` and `{ includeSharedMemory: true }` semantics. Fix: added `includeContextGraphPartitions` and threaded it only through count callers.
- Valid finding: child context graph discovery trusted `?ctxGraph a dkg:ContextGraph` triples in arbitrary graphs. Fix: child discovery now accepts `rdf:type dkg:ContextGraph` or `registrationStatus` only from the candidate context graph's own `/_meta` graph.
- Added regression tests proving legacy routes stay narrow, count callers opt in explicitly, and non-canonical user data cannot hide registered parent partitions.
- Local follow-up review against `pr-diff.patch` returned `{"comments":[]}`.
- Second Codex Review sweep found two valid follow-ups: typed `ApiClient.query()` did not expose/send `includeContextGraphPartitions`, and `/api/sub-graph/list` lacked route-level coverage for forwarding the flag. Both were fixed with focused CLI tests.
- Local second follow-up review against `pr-diff.patch` returned `{"comments":[]}`.
- Third Codex Review sweep found two valid follow-ups: widened UI fetches could clip at fixed `LIMIT`s while still looking exact, and each count query rebuilt the same partition allow-list. Both were fixed with focused UI/query tests.
- Third local follow-up review found one valid cache-staleness issue: a TTL cache could hide a just-created graph from an immediate post-write count refresh. Fix: make the allow-list memoization in-flight-only and add coverage proving a completed scan is not reused after new graph registration.
- Final third follow-up local review against regenerated `pr-diff.patch` returned `{"comments":[]}`.

## Final Outcome

Implemented on `codex/rc12-context-graph-counts` for PR into `release/rc.12`.

PR opened: https://github.com/OriginTrail/dkg/pull/844

Verification passed:

- `pnpm --filter @origintrail-official/dkg-core run build` (refreshes local workspace declarations used by query build)
- `pnpm --filter @origintrail-official/dkg-query exec vitest run test/query-engine.test.ts`
- `pnpm --filter @origintrail-official/dkg-query run build`
- `pnpm --filter @origintrail-official/dkg-node-ui exec vitest run test/use-memory-entities-counts.test.ts test/context-graph-ia-overview.test.ts test/subgraph-overview-grid.test.ts test/sub-graph-bar-layer-scope.test.ts test/ui-api-pure.test.ts`
- `pnpm --filter @origintrail-official/dkg-node-ui run build`
- `pnpm --filter @origintrail-official/dkg-agent run build`
- `pnpm --filter @origintrail-official/dkg run build`
- `node node_modules/.pnpm/vitest@4.0.18_.../node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts test/api-client.test.ts test/context-graph-write-path-validation.test.ts`
- Production UI build verified by direct Vite invocation after the local `node_modules/.bin/vite` shim was missing: `node node_modules/.pnpm/vite@6.4.2_.../node_modules/vite/bin/vite.js build`
- `git diff --check`

The fix restores same-context-graph count visibility for registered WM/SWM/VM content partitions while preserving explicit cross-CG rejection, excluding VM staging graphs, and refusing slash-ID child context graph collisions.
