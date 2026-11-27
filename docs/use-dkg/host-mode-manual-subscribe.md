---
status: current
version: v10
audience: human+agent
doc_type: runbook
---

# Host-Mode Manual Subscribe

**Scope.** Operator playbook for `POST /api/shared-memory/host-mode/subscribe`, the manual path that asks a Core daemon to host a context graph's Shared Working Memory (SWM) traffic in host mode. It covers what the endpoint does under the default OT-RFC-49 policy, why it no longer helps curated context graphs, how a late-joining member recovers private SWM instead, and what the legacy `swmHostMode.stripCiphertext: false` kill-switch changes.

> **Operator-only — NOT an agent MCP tool.** This endpoint changes _which node hosts_ a context graph's SWM traffic, which is a trust-boundary decision the curator owns. Always invoke it via a direct `curl` (or wrap it in the operator's `dkg` CLI / deploy scripts). It is intentionally **not** registered as an MCP tool on `mcp-dkg`, so an agent cannot autonomously enroll its connected core as a host. The earlier `dkg_request_hosting` tool was removed in the PR #672 Codex review pass for exactly this reason (review comment `id=3302086584`); the `requestHostMode` client method in `packages/mcp-dkg/src/client.ts` stays only for use inside operator scripts.

## TL;DR

* **Non-member Cores do not host curated context graphs.** With the default configuration (`swmHostMode.stripCiphertext` unset or `true`), a Core that is not a member keeps no private SWM ciphertext for a curated (`accessPolicy = 1`) context graph and serves none back ("hosting follows access", OT-RFC-49 WS-A). Every automatic hosting path declines curated graphs, and this manual endpoint refuses them.
* **Late joiners recover from members.** A member that missed SWM writes catches up from the curator or another member with `POST /api/shared-memory/catchup`. Non-member Cores cannot fill that gap: if no authorized member is reachable, the member waits until one is.
* **Plan redundancy around members.** Copies of a curated graph's SWM exist only on the curator and its members. Non-member Cores keep only public data for the graph, such as the `_catalog` they verified when they acknowledged its publishes, which is what random sampling proves. A Core can still be one of those members by joining the graph like any other member node (SCENARIO B of `scripts/devnet-test-rfc38-late-joiner.sh` uses one).
* **The manual endpoint is now public-only.** With the strip on, it only wires a host-mode handler for a graph this node can prove is public on-chain (`accessPolicy = 0`). Public graphs already have plaintext SWM distribution, so they do not need an opaque host.

## What a non-member Core does with a curated context graph

A Core that is not a member can learn about a context graph through four paths. With the strip on (the default), none of them leads to custody of curated data:

<table><thead><tr><th width="40">#</th><th width="176">Path</th><th width="239">Wired at</th><th>With the strip on (default)</th></tr></thead><tbody><tr><td>1</td><td><strong>Chain-event auto-subscribe</strong></td><td><code>packages/agent/src/dkg-agent-cg-chain-observation.ts</code> (<code>nudgeOnChainContextGraphHostMode</code>, for an observed <code>accessPolicy=1</code> graph with a <code>nameHash</code>)</td><td>Calls <code>reconcileSwmHostModeSubscription</code>, which declines the curated graph.</td></tr><tr><td>2</td><td><strong>Discovery beacon</strong></td><td><code>packages/agent/src/dkg-agent-swm-host.ts</code> (<code>handleIncomingCgDiscoveryBeacon</code> on <code>DKG_CG_DISCOVERY_TOPIC</code>; re-announce timer in <code>dkg-agent-lifecycle.ts</code>)</td><td>Calls <code>reconcileSwmHostModeSubscription</code>, which declines the curated graph.</td></tr><tr><td>3</td><td><strong>Periodic reconciler</strong></td><td><code>packages/agent/src/dkg-agent-swm-host.ts</code> (<code>reconcileHostModeSubscriptions</code>, driven by <code>hostModeReconcilerTimer</code>)</td><td>Calls <code>reconcileSwmHostModeSubscription</code>, which declines the curated graph.</td></tr><tr><td>4</td><td><strong>Operator-driven manual subscribe</strong> <em>(this runbook)</em></td><td><code>packages/cli/src/daemon/routes/memory.ts</code> (<code>POST /api/shared-memory/host-mode/subscribe</code>) → <code>enableSwmHostModeFor</code> in <code>packages/agent/src/dkg-agent-swm-host.ts</code></td><td>Refused unless the graph is provably public. See <a href="#calling-the-manual-endpoint">Calling the manual endpoint</a>.</td></tr></tbody></table>

The automatic paths never host public graphs either: `reconcileSwmHostModeSubscription` only considers curated ones. With the strip on, they wire nothing at all.

Three more gates apply while the strip is on:

* **Restart.** `restoreSwmHostModeSubscriptions` skips every host-mode subscription persisted on disk, including ones written by older builds. A manual subscription therefore does not survive a restart; repeat the call if you still need it.
* **Ingest.** A host-mode handler that is already wired drops every envelope unless its graph is explicitly classified as non-curated, which only a manual subscription to a provably public graph does (`createSwmHostModeHandler` in `packages/agent/src/internal/gossip/host-mode-handler.ts`).
* **Serving.** The host-mode catch-up responder (`/dkg/10.0.1/swm-host-catchup`, `handleSwmHostCatchup`) and the ciphertext-chunk responder (`/dkg/10.0.2/get-ciphertext-chunk`, `handleGetCiphertextChunk`) deny every request before decoding it, so a Core serves no host-mode ciphertext back over the wire.

Log lines that show the strip at work:

* `SWM host-mode subscription DECLINED for "<id>": private-ciphertext strip is ON …` (paths 1–3)
* `SWM host-mode subscribe REFUSED for "<id>": private-ciphertext strip requires exact public access policy` (path 4)
* `Skipping restore of <n> persisted host-mode subscription(s): private-ciphertext strip is ON …` (startup)

## Recovering a late-joining member

Run catch-up on the **member** node that fell behind (which may itself be a Core that is a member):

```bash
# Use the member daemon's own auth token and API port (default 9200). If you
# run several nodes via scripts/devnet.sh, node N has its own auth.token under
# .devnet/nodeN/ and listens on port 9200+N.
AUTH="$(tail -1 ~/.dkg/auth.token)"

curl -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<curator-agent>/lj-A-1717000000" }' \
  http://127.0.0.1:9200/api/shared-memory/catchup
```

* Without `peerId`, the daemon chooses peers itself; for a curated graph it prefers the curator's peers when it can resolve them. To recover from a specific member instead, for example while the curator is offline, add `"peerId": "<member peer id>"`.
* Only the curator and other members hold the data, and their sync responder checks the signed request against the graph's allowlist (`authorizePrivateSyncRequest`) before serving it. An outsider gets a denial, and a non-member Core returns nothing for a curated graph.
* `totalInsertedTriples` in the response reports how many triples were applied.

If catch-up inserts nothing, check that the curator or at least one other member is online and connected, and that the requesting agent is on the graph's allowlist. Subscribing a Core in host mode will not help. `scripts/devnet-test-rfc38-late-joiner.sh` exercises these cases: SCENARIO A (from the curator), B (from another member while the curator is offline), C (an outsider gets nothing from the Cores), and D (a reconnecting member stays behind while the curator is offline and catches up once it returns).

## Calling the manual endpoint

### Preconditions

* The target daemon must be a **core** node (`nodeRole === 'core'`) with host mode enabled (`swmHostMode.enabled` is not `false`) and a data directory. Edge nodes never create a host-mode store, so the endpoint answers `hostingEnabled: false` there. For registered-graph hosting and node-operator authorization, the Core should also have a non-zero node profile `identityId`; see [Core Node Profile Registration](run-node.md#core-node-profile-registration).
* The operator must have the daemon's `~/.dkg/auth.token` (the same `Bearer` scheme every other `/api/*` route uses).
* With the strip on, the target must be a context graph this node can prove is public: it must already know the graph's on-chain id and name hash, and have its on-chain access policy cached as `0` (`isExactPublicManualSwmHostMode` in `packages/agent/src/dkg-agent-swm-host.ts`). Curated graphs, and graphs whose access policy this node cannot prove, are refused.

### How to call it

```bash
AUTH="$(tail -1 ~/.dkg/auth.token)"

# `contextGraphId` is the id the curator used at `dkg context-graph create`
# time, or the curator-committed `nameHash` (the on-chain wire id) when the
# Core only knows the graph by its hash.
curl -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<curator-agent>/public-1717000000" }' \
  http://127.0.0.1:9200/api/shared-memory/host-mode/subscribe
```

### Responses

Every `200` response echoes `contextGraphId` next to these fields:

* `{"subscribed": true, "alreadySubscribed": false, "hostingEnabled": true}` — the handler was wired by this call. The daemon logs `SWM host-mode subscription explicitly enabled for "<id>" via API (role=core)`.
* `{"subscribed": false, "alreadySubscribed": true, "hostingEnabled": true}` — this node already hosts the graph. Safe; idempotent.
* `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": true, "memberMode": true}` — the local node is a **member** of this graph. Its member handler already covers it, and the daemon refuses to wire a second handler.
* `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": true}` — **refused or skipped, with no reason field.** With the strip on, this is what a curated graph, or a graph whose public access policy this node cannot prove, returns. The same shape is also returned for system context graphs, for graphs whose OT-RFC-64 catalog authority disallows legacy SWM gossip, when the graph's binding changed while the call ran, and when another local graph already owns the host-mode handler for that wire id. The daemon log tells them apart: a strip refusal logs `SWM host-mode subscribe REFUSED for "<id>": private-ciphertext strip requires exact public access policy`.
* `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": false}` — this node has no host-mode store (not a core node, `swmHostMode.enabled: false`, or no data directory), or its gossip session is not active.

Error responses:

* HTTP `400` — missing or blank `contextGraphId`.
* HTTP `501` — the daemon build does not expose `enableSwmHostModeFor`.
* HTTP `500` — `enableSwmHostModeFor` threw. The body's `error` field carries the underlying message; the daemon log has the full trace.

## Checking host-mode state

`GET /api/shared-memory/host-mode/stats` is the host-mode store diagnostics endpoint, served by `packages/cli/src/daemon/routes/memory.ts` and backed by `DKGAgent.getSwmHostModeStats()`. It returns:

```json
{
  "enabled": true,
  "cgCount": 0,
  "totalBytes": 0,
  "totalEntries": 0,
  "perCg": {},
  "subscribedCgIds": []
}
```

* `subscribedCgIds` lists the graphs this node currently hosts in host mode, always as the **canonical wire-form** id (the curator-committed `nameHash`, lowercase 0x-prefixed 32-byte hex), whichever path subscribed them. See `canonicalSwmHostModeKey` in `packages/agent/src/dkg-agent-cg-resolve.ts` (PR #672 review `id=3302086589`). If you subscribed with a cleartext id, expect its hash here.
* `perCg` maps each stored graph id to `{ entries, bytes, registered }`. Read it rather than the global totals when you check one graph.

With the strip on, curated graphs should have no `perCg` entries: the host-mode store keeps nothing for them. SCENARIOS D and E of `scripts/devnet-test-rfc38-late-joiner.sh` assert this after a manual subscribe and after automatic discovery. A graph that a manual subscription wired as public and that later turns out to be curated can stay listed in `subscribedCgIds`, but its handler drops every envelope.

## Legacy custody: `stripCiphertext: false`

Setting `"swmHostMode": { "stripCiphertext": false }` in the daemon's `config.json` (forwarded to the agent by `packages/cli/src/daemon/lifecycle.ts`) restores the pre-OT-RFC-49 behaviour. The three automatic paths auto-host curated graphs as opaque ciphertext again, persisted host-mode subscriptions are restored at startup, this endpoint accepts curated graphs, and the catch-up and ciphertext-chunk responders serve stored ciphertext to authorized requesters.

It exists as a rolling-upgrade kill-switch and A/B baseline. The [OT-RFC-49 catalog cutover runbook](../../packages/evm-module/scripts/RFC49_CATALOG_CUTOVER_RUNBOOK.md#6-known-gaps-at-cutover-do-not-skip) lists the strip-off custody path as unverified and says not to rely on it. Do not plan redundancy around it.

## How to stop hosting

The current daemon exposes a manual subscribe route and a stats route; it does **not** expose a `POST /api/shared-memory/host-mode/unsubscribe` route. With the strip on, a manual subscription ends at the next restart, because persisted host-mode subscriptions are not restored. With the strip off, disable `swmHostMode` for the daemon and restart to stop host-mode handlers, or perform a reviewed cleanup of the persisted host-mode store record and restart. Do not script a manual unsubscribe curl against this daemon version.

## Anti-patterns

* **Don't** subscribe a Core in host mode to fix a late-joining member. Non-member Cores hold and serve no private SWM for curated graphs; recover from the curator or another member instead.
* **Don't** turn the strip off to add redundancy. The strip-off custody path is unverified; add members if a curated graph needs more copies.
* **Don't** call this on a graph the node is a member of. The daemon answers with `memberMode: true`; your member handler is already authoritative.
* **Don't** wire it into MCP-tool calling patterns that an agent invokes automatically. Operator-only by design: an agent that reaches for host mode is bypassing the curator's authority over who hosts the graph. The previous `dkg_request_hosting` MCP tool was removed in PR #672 (Codex review `id=3302086584`) for this exact reason, and there is no agent-facing entrypoint. If you want a friendlier CLI wrapper, add it to the operator-side `dkg` CLI (which is human-invoked), not to `mcp-dkg` (which agents drive).

## Related

* `packages/cli/src/daemon/routes/memory.ts` — the subscribe, stats and catch-up endpoints.
* `packages/agent/src/dkg-agent-swm-host.ts` — `enableSwmHostModeFor`, `reconcileSwmHostModeSubscription`, `restoreSwmHostModeSubscriptions`, the serve responders, and `swmHostModeStripCiphertext`.
* `packages/agent/src/dkg-agent-types.ts` — the `swmHostMode.stripCiphertext` config documentation.
* `scripts/devnet-test-rfc38-late-joiner.sh` — end-to-end member recovery and zero-custody checks.
* [OT-RFC-49 catalog cutover runbook](../../packages/evm-module/scripts/RFC49_CATALOG_CUTOVER_RUNBOOK.md) — the public `_catalog` commitment that replaced non-member Core custody of curated data.
