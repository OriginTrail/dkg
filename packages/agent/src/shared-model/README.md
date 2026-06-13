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
| `POST /api/context-graph/:id/model/invoke` | `{ messages, maxTokens?, temperature? }` | Member invokes the curator's model |

`messages` is the OpenAI shape: `[{ "role": "user", "content": "…" }]`.

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
