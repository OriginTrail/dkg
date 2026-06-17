# Shared curator AI-model access (MVP)

Let a **context-graph (CG) curator** optionally share access to the AI model
they already run — in the **same flow as inviting an agent to the CG's shared
working memory**. Members send prompts to the curator's model over the DKG P2P
substrate and get completions back. **The curator's API key never leaves the
curator's node.**

This is an additive MVP on top of `v10.0.0-rc.17`. Default behaviour is
unchanged: nothing is shared unless a curator explicitly turns it on per CG.

---

## How it works

```
 member node                         curator node
 ───────────                         ────────────
 invokeContextGraphModel()           handleSharedModelInvoke()
   │  POST /api/context-graph/:id/model/invoke
   │  { messages }
   ▼
 P2P  ──/dkg/10.0.2/shared-model-invoke──▶  1. decode request
                                            2. grant enabled for CG?      (_meta)
                                            3. is fromPeer a CG member?   (_meta delegatee peer)
                                            4. under daily quota?
                                            5. prompt within size cap?
                                            6. call curator's LLM (config.llm / sharedModel)
   ◀───────── { ok, content, model } ──────┘   (API key stays here)
```

- **Membership = the invite you already sent.** Authorization reuses the
  delegatee-peer binding written to the CG `_meta` graph at invite/join time
  (`allowedDelegateePeer` / `delegationDelegateePeer`). No new identity system.
- **The grant lives in `_meta`** as two triples
  (`sharedModelEnabled`, `sharedModelId`) — they sync to members the same way
  the rest of `_meta` does, so an invitee discovers the shared model right
  after joining. (Predicates are defined locally, **not** added to the genesis
  ontology, so the network/genesis hash is untouched.)
- **The model is the one the curator already configures** for the node-UI
  chatbot (`config.llm`); `config.sharedModel` can override/scope it. A `mock`
  provider is built in for offline testing.

## Roles

| Actor | Can do |
|---|---|
| **Curator** | `setContextGraphModelSharing(cg, true)`; invite members; their node serves invokes |
| **Member** | `invokeContextGraphModel(cg, messages)` → completion, subject to quota |
| **Non-member** | denied (`requester is not a member of this context graph`) |

## Configuration (`~/.dkg/config.json`)

```jsonc
{
  // the model the curator already uses (existing field)
  "llm": { "apiKey": "sk-…", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1" },

  // opt into sharing it with CG members (new, optional)
  "sharedModel": {
    "enabled": true,
    "provider": "openai-compatible",   // or "mock" for offline tests
    "model": "gpt-4o-mini",            // defaults to llm.model
    "baseUrl": "https://api.openai.com/v1", // defaults to llm.baseURL
    "apiKeyEnv": "DKG_SHARED_MODEL_API_KEY", // defaults to reusing llm.apiKey
    "dailyRequestQuotaPerAgent": 200,
    "maxPromptChars": 8000
  }
}
```

`enabled: false` (or omitting `sharedModel`) keeps the node a non-sharer; every
invoke is denied with a clear reason.

## HTTP API

| Method & path | Body | Purpose |
|---|---|---|
| `POST /api/context-graph/:id/invite-with-model` | `{ agentAddress, shareModel?, modelId? }` | **Same-journey**: invite a member and (optionally) share the model in one call |
| `POST /api/context-graph/:id/model/share` | `{ enabled, modelId? }` | Curator toggles sharing for a CG |
| `GET  /api/context-graph/:id/model/grant` | — | Read the grant `{ enabled, modelId }` |
| `POST /api/context-graph/:id/model/invoke` | `{ messages, maxTokens?, temperature? }` | Member invokes the curator's model (native shape) |
| `POST /api/context-graph/:id/model/v1/chat/completions` | OpenAI `{ model?, messages, max_tokens?, temperature? }` | **OpenAI-compatible** member usage (see below) |

`messages` is the OpenAI shape: `[{ "role": "user", "content": "…" }]`.

## Member usage — point any OpenAI client at the curator's model

The `…/model/v1/chat/completions` endpoint makes the curator's shared model
usable by **any OpenAI-compatible client**, so a member's agent transparently
runs *on* the curator's model (membership- and quota-gated, same as `/invoke`).
A member sets, against **their own node**:

```
OPENAI_BASE_URL = http://127.0.0.1:9200/api/context-graph/<cg-id>/model/v1
OPENAI_API_KEY  = <the member node's auth token>   # ~/.dkg/auth.token
```

- **hermes**: set those in the hermes gateway's env/config — the member's hermes
  agent now reasons on the curator's model.
- **node-UI / Cursor / OpenAI SDK**: same two values.

The endpoint maps the OpenAI request → `invokeContextGraphModel` (which routes
P2P to the curator) → an OpenAI `chat.completion` response. Errors come back in
OpenAI shape (`{ error: { message, type, code } }`). See `shared-model/openai.ts`.

## Member-usage spectrum & roadmap

How a member can *use* the curator's shared model, from simplest to most
involved. This PR ships **#1 and #2**; **#3** follows once the feature is
e2e-verified; **#4** is already covered by #2; **#5** is intentionally deferred
and tracked here so it can be picked up later.

| # | Member-usage model | Status | Notes |
|---|---|---|---|
| 1 | **Raw invoke** — `POST …/model/invoke` (native `{ messages }` shape) | ✅ Shipped | Lowest-level surface; what the P2P verb returns directly. |
| 2 | **OpenAI-compatible endpoint** — `POST …/model/v1/chat/completions` | ✅ Shipped | Point any OpenAI client (hermes, Cursor, OpenAI SDK, node-UI chat) at the curator's model via `OPENAI_BASE_URL`. |
| 3 | **Node-UI model picker** — select the curator's shared model in the UI | ⏳ Next | UI-only addition (curator model appears in the model dropdown for member CGs). Land after the cross-device e2e test passes. |
| 4 | **Tool / skill** — member's agent calls the curator model as a tool | ✅ Via #2 | No separate surface needed: any agent that speaks OpenAI consumes #2 as its model/tool backend. Documented, not separately built. |
| 5 | **Metered / paid** — usage accounting → payment | 🔜 Deferred | Needs a real settlement mechanism (x402 reserved-not-built; PCA is publish-only). Today's quota is node-local & in-memory only. **Pick up here next.** See "Known limitations". |

> **#5 (metering/payment) is out of scope for this PR by design.** It requires a
> new mechanism beyond the MVP's in-memory per-member quota — e.g. an x402
> payment channel or a PCA allowance — and should be its own RFC + PR. This is
> the explicit hand-off note so the work isn't lost.

## P2P protocol

`/dkg/10.0.2/shared-model-invoke` — request/response over the reliable
messenger substrate. Request `{ contextGraphId, messages, maxTokens?,
temperature? }`, response `{ ok, denied?, content?, model? }`. JSON-over-bytes
(`shared-model/wire.ts`).

## Security model (MVP)

- **Key isolation** — the API key stays on the curator's node; members only
  ever send prompts and receive completions.
- **Membership-gated** — only CG members (by authenticated libp2p peer matched
  to the `_meta` delegatee-peer binding) can invoke.
- **Abuse-bounded** — per-member daily request quota + prompt size cap, both
  configurable.
- **Curator-controlled** — sharing is per-CG, opt-in, and revocable
  (`setContextGraphModelSharing(cg, false)`).

### Known limitations (MVP)

- Membership on the remote path is verified by the delegatee-peer binding the
  join flow writes; CGs that allow members without that binding aren't covered
  (the curator-local path is unaffected).
- Quotas/grant are node-local and in-memory (reset on restart) — no on-chain
  accounting or payment. Monetization (x402 / PCA allowance) is a follow-up.
- No streaming; single completion per request. No tool-calls forwarded.
- Prompt/response content is end-to-end over the substrate but not separately
  encrypted at rest by this feature.
- **Cross-NAT first-sync of the grant** depends on the upstream curated-CG
  `_meta` sync (the grant triples ride along with it). A NAT'd member that
  idles out before approval — or whose post-approval sync stream resets over a
  public relay — won't see the grant until it reconnects over a stable link;
  there is no periodic re-pull. See "Cross-device test findings" for the
  reliable procedure and two upstream `_meta`-sync issues this surfaced.

## Testing

### Offline unit tests (no network, no API key)

```bash
pnpm --filter @origintrail-official/dkg-agent build
pnpm --filter @origintrail-official/dkg-agent test -- shared-model
```

Covers the mock provider, the authorization gate, the daily quota, and the
wire round-trip.

### Local two-node end-to-end (devnet, mock provider)

```bash
./scripts/devnet.sh start 2          # node 1 (curator) + node 2 (member)
# configure node 1 with sharedModel.provider = "mock", enabled = true
# curator (node 1, port 9201):
curl -s -XPOST localhost:9201/api/context-graph/create \
  -d '{"id":"demo","name":"Demo","private":true}'
curl -s -XPOST localhost:9201/api/context-graph/demo/invite-with-model \
  -d '{"agentAddress":"<member-agent-address>","shareModel":true}'
# member (node 2, port 9202):
curl -s -XPOST localhost:9202/api/context-graph/demo/model/invoke \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
# → { "ok": true, "content": "[shared-model:mock-model] hello", "model": "mock-model" }
```

Swap `provider: "mock"` for `"openai-compatible"` + a real key to use a live model.

## Cross-device test findings (live testnet)

Validated end-to-end against a live testnet curator (CG `demo`, private,
sharing on, `mock` provider):

- **Unit** — `shared-model` suite (mock provider, authorize gate, daily quota,
  wire round-trip, OpenAI request/response mapping): 10/10.
- **Build** — `pnpm --filter @origintrail-official/dkg-agent build` green;
  `build:runtime` produces a `dist-ui` that carries the curator share toggle.
- **Live single-node** — curator-local `invoke` returns a completion.
- **Live two-node (stable link)** — a *separate* member node (its own peer id +
  agent) joins `demo`, the curator approves, the authenticated post-approval
  `_meta` sync lands the grant on the first poll, and
  `POST …/model/invoke` returns
  `{"ok":true,"content":"[shared-model:mock-model] …","model":"mock-model"}`.
  This exercises the full P2P path (resolve curator peer →
  `/dkg/10.0.2/shared-model-invoke` → membership gate → model → completion).

### Two upstream `_meta`-sync issues this surfaced (NOT introduced by this feature)

The grant is just two triples in the curated CG's `_meta`; it can only reach a
member through the existing curated-CG sync. Cross-NAT first-sync exposed:

1. **Bootstrap auth deadlock.** Building an *authenticated* private meta-sync
   request needs the curator's peer id as `targetPeerId`, which a member
   resolves from its **local `_meta`** — the very thing it is trying to fetch.
   Only the `join-approved`-triggered `runImmediatePostApprovalSync` breaks the
   cycle, because it is *handed* the curator peer id by the inbound
   notification. Background- and `subscribe`-driven catchup cannot, so they
   send an unauthenticated request that a private CG rejects (`phase=meta`,
   `request-authorize.ts`).
2. **`synced`-flag poison.** `POST /api/context-graph/:id/subscribe` marks the
   CG `synced:true` even when `_meta` was denied; `buildSyncRequest`
   (`dkg-agent-cg-resolve.ts`) then derives `needsAuth` from **`synced`**, not
   `metaSynced`, so every later meta-sync — including the authenticated
   post-approval one — is sent *unauthenticated* and permanently denied.
   `subscribedContextGraphs` is in-memory, so it clears on restart.
   *Suggested upstream fix:* gate `needsAuth` on `metaSynced` for private CGs,
   and/or don't set `synced` until `_meta` actually lands.

A third, related sharp edge: a re-fired `already-member` `join-approved` is
dropped by the requester's trusted-sender guard after a restart (no local
`_meta` curator triple, no in-memory pending-request record), so re-joining an
*existing* membership does not re-trigger the sync — a **fresh, genuine**
`pending` join does.

### Reliable procedure for a NAT'd member (until the above are fixed upstream)

1. Establish a **stable** connection to the curator (a direct address, or a
   relay connection that DCUtR-upgrades to direct).
2. Submit a **genuine** join request (a member that is not yet on the allowlist
   → status `pending`, not `already-member`); have the curator approve it.
3. **Do not** call `/subscribe` before the grant lands — that poisons the
   `synced` flag and wedges the member out (restart to recover).
4. Poll `GET …/model/grant` until `enabled:true`, then `invoke`.
