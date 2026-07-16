---
status: current
version: v10
audience: human+agent
doc_type: runbook
---

# Host-Mode Manual Subscribe

**Scope.** Operator playbook for the manual / fourth-resort path that asks a core daemon to start hosting a curated CG's opaque SWM ciphertext without waiting for any of the three automatic discovery paths to fire.

This runbook covers **when** to reach for it (and when not to), **how** to call it safely, and **what the four discovery paths each look like** so you can tell from a log whether the manual call is actually needed.

> **Operator-only — NOT an agent MCP tool.** This endpoint changes _which node hosts_ a curated CG's opaque ciphertext, which is a trust-boundary decision the curator owns. Always invoke it via a direct `curl` (or wrap it in the operator's `dkg` CLI / deploy scripts). It is intentionally **not** registered as an MCP tool on `mcp-dkg`, so an agent cannot autonomously enroll its connected core as a host. The earlier `dkg_request_hosting` tool was removed in the PR #672 Codex review pass for exactly this reason (review comment `id=3302086584`); the `requestHostMode` client method in `packages/mcp-dkg/src/client.ts` stays only for use inside operator scripts.

## TL;DR

Almost always you should let LU-6 Phase B's automatic discovery do its job. The manual subscribe is a last-resort tool — reach for it only when **all three** automatic paths have demonstrably failed for a CG, and a late-joining member is asking for catchup that cores can't yet serve.

## The four discovery paths

A core daemon picks up curated-CG hosting assignments through one of four mechanisms. The first three are automatic; the fourth is what this runbook covers.

<table><thead><tr><th width="40">#</th><th width="176">Path</th><th width="239">Wired at</th><th>Triggers when</th></tr></thead><tbody><tr><td>1</td><td><strong>Chain-event auto-subscribe</strong></td><td><code>packages/agent/src/dkg-agent.ts</code> (<code>ContextGraphCreated</code> handler inside the chain poller)</td><td>Curator registers an <code>accessPolicy=1</code> CG on-chain with a <code>nameHash</code> commitment. Cores in the sharding table with <code>swmHostMode</code> enabled subscribe immediately on event arrival.</td></tr><tr><td>2</td><td><strong>Discovery beacon</strong></td><td><code>packages/agent/src/dkg-agent.ts</code> (<code>DKG_CG_DISCOVERY_TOPIC</code> gossip subscription + <code>BEACON_REANNOUNCE_INTERVAL_MS</code> re-announce timer)</td><td>Curator pre-registers a CG (before any on-chain transaction) and starts re-announcing it on the discovery topic. Cores hear the beacon and subscribe. Used for pre-reg / off-chain-only CGs.</td></tr><tr><td>3</td><td><strong>Periodic reconciler</strong></td><td><code>packages/agent/src/dkg-agent.ts</code> (<code>hostModeReconcilerTimer</code>, <code>sweepSwmHostModeSubscriptions</code>)</td><td>Catches anything the first two paths missed (chain event lost in a re-org, beacon missed during a restart, etc.). Sweeps every locally-known CG and ensures host-mode subscription state is in sync. Idempotent.</td></tr><tr><td>4</td><td><strong>Operator-driven manual subscribe</strong> <em>(this runbook)</em></td><td><code>packages/cli/src/daemon/routes/memory.ts</code> (<code>POST /api/shared-memory/host-mode/subscribe</code>)</td><td>Operator explicitly POSTs a <code>contextGraphId</code>. The daemon enables host-mode for it the same way the reconciler would.</td></tr></tbody></table>

Paths 1–3 cover the documented Phase B happy path: a curator registers a CG, cores see it, cores host it. Path 4 exists for the gaps those three don't cover.

## When to reach for the manual path

Use the manual subscribe **only** when you can demonstrate at least one of:

1. **Off-chain CG / no chain commitment.** The curator did not register on-chain and does not run the discovery beacon (e.g. a one-off curated CG used inside an organization that lives entirely off-chain). Paths 1 and 2 cannot fire; path 3 only reconciles CGs the local node already knows about, so a fresh core needs to be told the id.
2. **Coverage gap during rollout.** Fewer than `minimumRequired- Signatures` capable cores are connected to the curator, and you (the operator) want to deliberately enroll a specific core as an opaque host. This is a transitional tool while testnet core capacity ramps; once enough cores are auto-subscribed via paths 1–3, this case goes away.
3. **Late-joining member catchup is failing** AND the failure log shows "no cores hold ciphertext for this CG" rather than a decryption / permission error. (If a member's catchup fails with `AEAD verify failed`, the issue is membership/key distribution, not host-mode subscription — manually subscribing more cores will not help.)

**Do not** use this as a routine subscribe call. If you find yourself reaching for it on every fresh CG, paths 1–3 are not firing correctly and that's the real bug to fix — file a ticket against the discovery poller, not against the daemon that needed the manual nudge.

## Preconditions

* Target daemon must be a **core** node (`nodeRole === 'core'`) with `swmHostMode` enabled in `~/.dkg/config.json`. Edge nodes have host mode disabled by build; the endpoint returns a no-op on those. For registered-CG hosting and node-operator authorization, the Core should also have a non-zero node profile `identityId`; see [Core Node Profile Registration](run-node.md#core-node-profile-registration).
* Operator must have the daemon's `~/.dkg/auth.token` (same `Bearer` scheme every other `/api/*` route uses).
* Target CG must be **curated** (`accessPolicy === 1`). Public CGs use the plaintext SWM substrate and don't need an opaque host.

## How to call it

```bash
# Pick up the daemon's auth token. The default location is the
# per-node ~/.dkg/auth.token; if you run multiple nodes via
# scripts/devnet.sh, each node has its own auth.token under
# .devnet/nodeN/.
AUTH="$(tail -1 ~/.dkg/auth.token)"

# `contextGraphId` is the SAME id the curator used at `dkg context-graph
# create` time. On the hosting core you'll typically supply the
# curator-committed `nameHash` (the on-chain wire id) — that's what the
# chain-event path uses internally and it's what `gossipWireIdFor`
# expects to resolve into the SWM gossip topic.
curl -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<curator-agent>/lj-A-1717000000" }' \
  http://127.0.0.1:9201/api/shared-memory/host-mode/subscribe
```

A successful response looks like:

```json
{
  "contextGraphId": "<curator-agent>/lj-A-1717000000",
  "subscribed": true,
  "alreadySubscribed": false,
  "hostingEnabled": true
}
```

Other documented response shapes:

* `{"subscribed": false, "alreadySubscribed": true, "hostingEnabled": true}` — the daemon was already subscribed to this CG (paths 1–3 already fired, or you called this twice). Safe; idempotent.
* `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": true, "memberMode": true}` — local node is already a **CG member** of this CG. Member-mode takes precedence; the daemon refuses to wire a second handler. This means you don't need host mode for this CG on this node — the member-mode handler already covers it.
* `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": false}` — node has no `swmHostModeStore`, i.e. host mode is disabled at config time. Not a core node, or `swmHostMode: false` in config.
* HTTP `400` — missing/blank `contextGraphId`.
* HTTP `501` — daemon build does not expose `enableSwmHostModeFor`.
* HTTP `500` — `enableSwmHostModeFor` threw. The body's `error` field carries the underlying message; the daemon log has the full trace.

## How to verify the subscribe took effect

After a successful POST:

1. The daemon log on the core should include `Host-mode subscribed CG=<id>` (or the persistence-queue equivalent).
2.  `GET /api/shared-memory/host-mode/stats` reports the CG in its `subscribedCgIds` array (alongside `enabled`, `cgCount`, `totalBytes`, `totalEntries`). This is the host-mode store diagnostics endpoint, served by `packages/cli/src/daemon/routes/memory.ts` and backed by `DKGAgent.getSwmHostModeStats()`. Entries in `subscribedCgIds` are always the **canonical wire-form** id (the curator-committed `nameHash`, lowercase 0x-prefixed 32-byte hex) regardless of whether the CG was subscribed via the chain-event path, the beacon, the reconciler, or a manual subscribe call — see `canonicalSwmHostModeKey` in `packages/agent/src/dkg-agent.ts` for the rationale (PR #672 review `id=3302086589`). If you POSTed a cleartext id, expect the corresponding hash to come back here, not the original cleartext. Example response after a single subscribe:

    ```json
    {
      "enabled": true,
      "cgCount": 1,
      "totalBytes": 0,
      "totalEntries": 0,
      "subscribedCgIds": ["0x4ad12a3e…0a9c1b"]
    }
    ```

    `totalBytes` / `totalEntries` stay at zero until the first gossiped SWM envelope lands and is persisted — see step 3.
3. Within a few seconds, gossiped SWM envelopes for that CG should start showing up in the core's `swm-host-mode` substrate. With no curator currently writing, you won't see ingest until the next write — that's normal.
4. A member running `POST /api/shared-memory/catchup` against this core should now get a non-zero `totalInsertedTriples` (assuming the member holds the AEAD chain key — see SCENARIO D in `scripts/devnet-test-rfc38-late-joiner.sh`).

## How to stop hosting

The current daemon exposes a manual subscribe route and a stats route; it does **not** expose a `POST /api/shared-memory/host-mode/unsubscribe` route. If you need to stop hosting before a supported per-CG unsubscribe API exists, use an operator maintenance path outside this endpoint: disable `swmHostMode` for the daemon and restart to stop host-mode handlers, or perform a reviewed cleanup of the persisted host-mode store record and restart. Do not script a manual unsubscribe curl against this daemon version.

## Anti-patterns

* **Don't** loop the manual call as a substitute for the reconciler. The reconciler is what guarantees eventual consistency for CGs whose chain event was missed; replacing it with a polling script hides whatever bug is preventing the reconciler from converging.
* **Don't** call this on a CG you're also a member of. The daemon rejects with `memberMode: true`; if you got there by misreading the topology, you don't need host mode — your member handler is already authoritative.
* **Don't** wire it into MCP-tool calling patterns that an agent invokes automatically. Operator-only by design: an agent that reaches for host mode is bypassing the curator's authority over who hosts the curated CG. The previous `dkg_request_hosting` MCP tool was removed in PR #672 (Codex review `id=3302086584`) for this exact reason — there is no agent-facing entrypoint. If you want a friendlier CLI wrapper, add it to the operator-side `dkg` CLI (which is human-invoked), not to `mcp-dkg` (which agents drive).

## Related

* `packages/cli/src/daemon/routes/memory.ts` — endpoint implementation.
* `packages/agent/src/dkg-agent.ts` — `enableSwmHostModeFor`, the agent-side handler the endpoint delegates to.
* `packages/agent/src/dkg-agent.ts` — `ContextGraphCreated` handler, discovery beacon, and host-mode reconciler — the three automatic paths this runbook supplements.
* `scripts/devnet-test-rfc38-late-joiner.sh` SCENARIO D — the end-to-end happy path this endpoint participates in.
