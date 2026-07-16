# OKF ↔ DKG live demo runbook

End-to-end demonstration: the same portable Bitcoin Markdown, turned into
**owned, shareable** Knowledge Assets on a DKG **mainnet** node, imported into a
Context Graph, **shared through Shared Working Memory**, verified by a second
peer, and reasoned over by a Hermes agent.

**Cost model — read this first.**
- Steps 1–7 are the default demo and **spend nothing**. Working Memory (WM) and
  Shared Working Memory (SWM) are free.
- Step 8 — **Verifiable Memory (VM) promotion — is deferred.** It spends real
  **TRAC + native gas, irreversibly**, on mainnet (no faucet). It is *not* part
  of the default run; the operator triggers it deliberately, after confirming
  funds. It is documented here, clearly marked, and only its UALs/txHashes are
  recorded *if and when* it is actually run.
- This runbook is **operator-run, never CI.** The free offline correctness gate
  (`pnpm --filter @origintrail-official/dkg-okf test`) is the CI gate; it never
  touches a node and is green before any of this is attempted.

Throughout: **never imply on-chain verification for WM/SWM data.** State which
memory layer each piece of evidence lives in.

Conventions: `$CG=okf-crypto-bitcoin`, `$BUNDLE=packages/okf/test/fixtures/crypto_bitcoin`.

---

## 0. Offline correctness gate (free, no node)

```bash
pnpm --filter @origintrail-official/dkg-okf test           # 60+ golden/edge/round-trip tests
dkg okf import $BUNDLE --dry-run --print-nquads            # deterministic mapping, no node
```

Expect: 5 Knowledge Assets, 3 reserved `index.md` skipped, the reconstructed edge
graph, both citation styles, byte-stable N-Quads. Run it twice — identical output.

## 1. Launch the node on mainnet

```bash
dkg init        # choose a mainnet blockchain (e.g. mainnet-base / mainnet-gnosis / mainnet-neuroweb)
dkg start
dkg status      # daemon PID, version, listening port
dkg doctor      # health checks
```

**Verify the node is actually on mainnet, not testnet/devnet, before going
further** — confirm the active network/chain in the printed config / `dkg doctor`
output. `edge` is the default role.

## 2. Attach a Hermes agent

```bash
dkg hermes setup     # configure the Hermes-runtime agent bound to this node
dkg hermes           # run it
```

Confirm the acting agent identity (this is the agent the shared bundle is
*proposed to* in step 6):

```bash
curl -s localhost:<apiPort>/api/agent/identity   # → { agentAddress, agentDid, name, framework, peerId }
```

Record the `agentAddress`.

## 3. Import the bundle into a Context Graph (Working Memory — free)

```bash
dkg okf import $BUNDLE --context-graph-id $CG --create-context-graph
```

Import defaults to **Working Memory** — free, private, reversible. Expect the
summary: `5 concepts, 3 reserved skipped, 101 triples, 11 links resolved, 0
broken, 10 citations`, plus the deterministic `urn:okf:*` IRIs and the
`memoryLayer: "WM"` note.

Confirm the 5 assets and the reconstructed edges are present **in WM** via SPARQL
(`/api/query`, `view: working-memory`, `agentAddress` required for WM):

```bash
curl -s localhost:<apiPort>/api/query -H 'content-type: application/json' -d '{
  "contextGraphId":"okf-crypto-bitcoin",
  "view":"working-memory",
  "agentAddress":"<agentAddress>",
  "sparql":"SELECT ?s ?o WHERE { ?s <http://schema.org/mentions> ?o }"
}'
```

Expect the 11 `schema:mentions` edges (dataset→4 tables, transactions→4,
inputs→3). `tables/outputs` has none — its only links sit inside backticks
(CommonMark: literal text). All evidence here is **WM (private, free, no on-chain
verification).**

## 4. Finalize and share to Shared Working Memory (free)

```bash
dkg okf import $BUNDLE --context-graph-id $CG --share
```

`--share` seals each asset (`wm/finalize`) and advances it (`swm/share`,
`entities: "all"`). SWM is free, gossip-replicated and team-visible — this is the
moment the Bitcoin bundle becomes a **shared Context Graph** other agents can
reach. The assets are now sealed and *publish-ready*, but **publishing waits**
(step 8).

Confirm the same assets/edges in the `shared-working-memory` view:

```bash
# 11 cross-table edges
dkg query $CG -q 'SELECT ?s ?o WHERE { ?s <http://schema.org/mentions> ?o }' --include-shared-memory

# Exactly 5 concepts. Count subjects that have an rdf:type — only the 5 concepts
# do. A naive `STRSTARTS(STR(?s),"urn:okf:")` count returns ~19 because the
# daemon skolemises each concept's dkg:hasSection blank nodes into
# `urn:okf:.../.well-known/genid/...` subjects, which also match the prefix.
dkg query $CG -q 'SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?t FILTER(STRSTARTS(STR(?s), "urn:okf:")) }' --include-shared-memory
```

Evidence here is **SWM (shared, free, TTL-bounded, no on-chain verification).**

## 5. Issue a join invitation and have a second peer verify it

```bash
# Curator side — invite a peer (the V10 invite is the pair <contextGraphId>\n<curatorPeerId>):
dkg context-graph invite $CG <joiningPeerId>
# For a curated graph, allow the joining agent:
dkg context-graph add-agent $CG <joiningAgentAddress>
# …or have the joiner request-join and the curator approve-join.
```

From a **second node/agent**:

```bash
dkg subscribe okf-crypto-bitcoin          # subscribe + catch up
dkg query okf-crypto-bitcoin -q 'SELECT ?s ?o WHERE { ?s <http://schema.org/mentions> ?o }' --include-shared-memory
```

Record the invite and the second peer's query result — the shared Context Graph
is independently checkable by another peer, all in **free SWM**.

## 6. Hermes agent reasons over the shared knowledge

Have the Hermes agent answer a natural-language question through its `dkg_*`
tools over the `shared-working-memory` view, e.g. *"what does the `transactions`
table reference?"*:

```sparql
SELECT ?o WHERE { <urn:okf:tables/transactions> <http://schema.org/mentions> ?o }
```

Expect the four targets: `urn:okf:datasets/crypto_bitcoin`, `urn:okf:tables/blocks`,
`urn:okf:tables/inputs`, `urn:okf:tables/outputs`. Capture the transcript — an
agent consuming OKF-derived, provenance-bearing knowledge from the shared graph.

## 7. Recreated, visibly

Regenerate the graph from the shared Context Graph and compare it to Google's own
`viz.html`:

```bash
dkg okf export okf-crypto-bitcoin ./out --view shared-working-memory
```

`export` is the clean inverse of `import` (graph-faithful). Confirm the
regenerated bundle's `schema:mentions` structure matches the dataset→tables and
cross-table edges in the bundle's own
`okf/bundles/crypto_bitcoin/viz.html`. (`packages/graph-viz` can render the graph
view directly.)

**At this point the deliverable is complete: a shared, peer-verified,
agent-queried Context Graph in SWM. Nothing has been spent.**

---

## 8. VM promotion — staged, but it waits (DEFERRED; real TRAC + gas)

> **Do not run this as part of the demo.** The assets are sealed and
> publish-ready in SWM, so promotion to Verifiable Memory is one step away — held
> until the operator deliberately chooses to spend.

When (and only when) the operator chooses to promote:

1. **Confirm funding first** — on mainnet there is **no faucet**:
   ```bash
   dkg wallet                                   # or: curl -s localhost:<apiPort>/api/wallets/balances
   ```
   Abort if TRAC + native gas are insufficient.
2. **Publish ONE asset first** to observe real cost and validate the on-chain
   path (the dataset). The first publish transparently registers the Context
   Graph on-chain — expect gas/TRAC:
   ```bash
   # vm/publish for a single KA (gate behind explicit confirmation in your runbook).
   # The KA name is the concept ID with '/' mapped to '__' (asset names can't contain '/').
   curl -s localhost:<apiPort>/api/knowledge-assets/datasets__crypto_bitcoin/vm/publish \
     -H 'content-type: application/json' -d '{"contextGraphId":"okf-crypto-bitcoin"}'
   ```
   Record the returned UAL (`did:dkg:<chainId>/<kasAddress>/<number>`) and
   `txHash`.
3. **Then publish the rest** and re-verify via the `verifiable-memory` view.

| Asset | UAL | txHash |
|---|---|---|
| `datasets/crypto_bitcoin` | _(record if run)_ | _(record if run)_ |
| `tables/blocks` | | |
| `tables/transactions` | | |
| `tables/inputs` | | |
| `tables/outputs` | | |

Until promoted, the demo's deliverable is the **shared, peer-verified,
agent-queried** Context Graph in SWM. Only VM data carries on-chain verification;
WM/SWM data never does.

---

## Evidence log (fill in during the run)

- Node network/chain confirmed mainnet: ______
- Hermes `agentAddress`: ______
- Import summary (WM): 5 concepts / 101 triples / 11 edges / 0 broken / 10 citations
- WM SPARQL edge count: ______
- SWM SPARQL edge count: ______
- Join invitation: ______
- Second peer query result: ______
- Hermes agent transcript: ______
- Regenerated graph vs `viz.html`: ______
- (Deferred) VM UALs / txHashes: _(only if step 8 was run)_
