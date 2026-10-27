# OT-RFC-27 marketplace — seller connectors, pinned-tokenizer metering, buyer gateway

Status: implementation spec for branch `prototype/rfc27-sellers-gateway` (branched
from `prototype/rfc27-marketplace-protocol`). Read
`agent-docs/plans/2026-10-25-rfc27-marketplace-protocol.md` first, including its
§10 post-review amendments. That doc covers the protocol layer, which is
unchanged here: session-key authorizations, seller receipts, the on-chain pool
and QIF rewards.

This spec ports the buyer/seller-facing layer of the private fork
`/home/user/neurosymbolic-marketplace` ("Prototype 5", `packages/marketplace/src`)
on top of that protocol. The port covers real LLM seller connectors, metering
against a pinned tokenizer with a buyer-side recount, the static SPARQL cost
schedule, and an OpenAI-compatible buyer gateway with scoped API keys. Five
engineers implement it in parallel in five slices (§14). Each slice owns its
files exclusively. Slices interact only through the contracts in §14.3.

Conventions used throughout:

- **Money and units are `bigint`** in every TS API (wei, units). Token engines
  count with JS `number` internally (bounded by text length). The formula layer
  converts to `bigint` at its boundary. No float money math. `temperature` and
  `top_p` are the only floats, and they are sampler knobs, not money.
- **Digests** in RDF, JSON and APIs are strings `sha256:<64 lowercase hex>`.
  Protocol digests (`authDigest`, `resultCommitment`) stay `0x…` bytes32, as they are today.
- **"MUST"** marks an interface or behavior another slice depends on.
- **Golden vectors** in §3 are the single source of truth for the A, C and E
  tests. Copy the numbers. Do not recompute them independently.

---

## 0. What exists and what changes, in one paragraph

Today a seller serves `stub-inference` (deterministic echo, `countTokens =
ceil(utf8/4)`) and `local-query` (SPARQL over its VM of the marketplace CG,
`queryUnits = 10 + ceil(bytes/100) + rows`). A buyer invokes through
`POST /api/marketplace/invoke` (node-admin token) with a raw JSON payload.

After this work:

- A seller can also mount a **chat connector**: an OpenAI-compatible upstream,
  a loopback llama.cpp server, or Codex over OAuth. Its offer KA publishes a
  **tokenizer pin**, a **chat template pin** and model facts.
- The seller meters chat with the pinned engine and caps the completion so that
  `servedUnits ≤ maxUnits` holds by construction.
- The buyer **recounts** every pinned delivery and keeps a local per-seller
  standing that steers its router.
- SPARQL is metered by the content-addressed **query cost schedule**, whose
  digest is pinned in the offer.
- Any OpenAI SDK can call the buyer node through
  `/api/marketplace/gateway/v1`, authenticated by **scoped gateway keys**
  (`dkg_gw_…`) instead of the node token. This is the only auth carve-out in the daemon.

The core proto envelope and `MARKETPLACE_SERVE_VERSION` do **not** change (§7.1).

## 1. Port map: fork → dkg

| Fork module (`packages/marketplace/src/…`) | Disposition | Lands in |
|---|---|---|
| `seller/connector-openai.ts` | port (connector "openai-compatible") | C `agent/src/marketplace/connectors/openai-compatible.ts` |
| `seller/connector-llamacpp.ts` | port; drop `/apply-template` + `/tokenize` (metering uses the pinned engine, so the server's ids are not needed) | C `connectors/llamacpp.ts` |
| `seller/connector-codex-oauth.ts` | port (Responses-API SSE accumulate, refresh-on-401) | C `connectors/codex-oauth.ts` |
| `seller/oauth-flow.ts` | port (PKCE loopback flow), injectable endpoints and port | D `cli/src/marketplace-codex-oauth-flow.ts` |
| `seller/streaming.ts` | port as a pure util, no consumer in this phase (§9.4) | A `stream-chain.ts` |
| `seller/model-ka.ts` | **partial**: family inference only. No separate Model KA; model facts go on the offer KA (§5.4) | A `model-id.ts` |
| `seller/offering.ts` | **replaced** by the existing `offer-publisher.ts` plus the new RDF fields (§5.4). Never publish endpoints or `apiBase` | C |
| `core/inference-meter.ts` | **partial**: the canonicalization rules (§5.5 R1–R4) carry over as prose. Legs, evidence, policy pricing and µTRAC arithmetic are **not ported** | A (rules in docs and tests) |
| `core/read-meter.ts` | not ported (tab-era read pricing; the query schedule supersedes it) | — |
| `buyer/bpe.ts` | port verbatim (HF byte-level BPE with Qwen2 split; tiktoken with the o200k split) behind a `TokenCountEngine` interface, plus a new `stub-words-v1` engine | A `token-engines.ts` |
| `buyer/recount.ts` | **re-designed**: Ed25519 legs and withhold codes do not exist here. The recount compares against the receipt's `servedUnits` and drives local standing (§8.3) | A `recount.ts` + C wiring |
| `subs/messages.ts` | port verbatim (normalizers, tool policy, prompt-tool transport). Rename `E_BAD_*` codes and the `nsm` strings (§14.3) | A `chat-messages.ts` |
| `subs/serve.ts` | `boundCompletion` ported verbatim. `serveChat` / `serveQuery` are re-implemented as executors (§5.6, §6) | A `chat-metering.ts` + C executors |
| `subs/query-cost.ts` | port. `analyzeQuery` stays **verbatim**. The schedule becomes integer-only (`rowsPerDeliveryUnit: 100` replaces `perReturnedResult: 0.01`), so it gets a new version string and digest (§6.1) | A `query-cost.ts` |
| `gateway/keys.ts` | **re-designed**: same scope set, but budget in wei, an in-memory ledger with JSON persistence, key reservations, timing-safe hash compare | A `gateway-keys.ts` + D store |
| `plugin.ts` gateway routes | re-implemented as daemon routes behind the carve-out (§9, §11) | D |
| `packages/marketplace/scripts/llm-stub.mjs` | port, plus the tool-call reply and test seams (§13.1) | B `devnet/marketplace-rfc27/llm-stub.mjs` |
| `subs/purchase*.ts`, `enrollments.ts`, `payment-verify.ts`, `chain-verify.ts`, `checkpoint.ts`, `statement.ts`, `dispute/*`, `seller/auth.ts` (EIP-191 wallet binding), `subs/serve-auth.ts` (`x-nsm-serve-sig`), `shelf.ts`, `registry.ts`, `asks.ts`, `plan.ts`, `journal.ts`, `gateway.ts` (allowances/admit), `core/evm-binding.ts`, `calibration*` | **not ported**. Session-key authorizations, seller receipts and the on-chain pool replace all of it | — |
| fork `node-ui` views, fork CLAUDE.md UI rules | not in this workflow (a later phase). The fork's UI rules govern only the fork's UI | — |

## 2. Module placement and dependency direction

```
@origintrail-official/dkg-marketplace   (A, pure domain: zero workspace deps; ethers + node:crypto only)
        ▲
        │ imports
@origintrail-official/dkg-agent         (C, runtime: connectors, executors, offer RDF, buyer chat/recount, mixin)
        ▲   (re-exports the A symbols D needs, §14.3.3; the cli package does NOT add a direct
        │    dependency on dkg-marketplace, so there is no lockfile churn)
@origintrail-official/dkg (packages/cli) (D, HTTP: gateway routes, auth carve-out, key store file, config, CLI)
        ▲
devnet/marketplace-rfc27                (B stub, E seed/console/e2e; talk to the daemon over HTTP only)
```

Invariants:

1. `packages/marketplace` adds no workspace dependency and no I/O. Exceptions:
   `node:crypto` (hashing, `randomBytes`, `timingSafeEqual`) and `Buffer`.
   File reading, `fetch` and timers belong to C or D.
2. `packages/core` is **not changed** (§7.1). No new protocol id, no proto field, no version bump.
3. No cycles. C never imports from cli. D talks to the runtime only through
   `DKGAgent` methods and the agent package's exports.
4. **Each slice's changes are additive to every exported surface another slice
   already consumes.** The branch builds after every slice commit. Concretely:
   - A keeps `countTokens` and `queryUnits` exported. `queryUnits` gets
     `@deprecated`. Its only consumer (`agent/executors.ts`) is switched by C.
   - C keeps existing agent exports and mixin signatures. It only adds optional fields and methods.
5. File budgets (`node scripts/audit-file-size.mjs`): new files must stay under
   800 lines. Files **at budget** that this work must not grow:
   - `packages/cli/src/auth.ts` (1979/1979)
   - `packages/cli/src/config.ts` (2691/2691)
   - `packages/agent/src/dkg-agent.ts` (4442/4442)
   - `packages/cli/src/api-client.ts` (2600/2602)

   Headroom elsewhere:
   - `packages/cli/src/daemon/lifecycle.ts` (3798/3919): ≤ 15 added lines.
   - `packages/agent/src/dkg-agent-types.ts` (2056/2062): do not touch. The
     marketplace config types live in `agent/src/marketplace/config.ts`.

   Non-baselined files near 800 lines must not cross it. Move new logic into new modules:
   - `agent/src/marketplace/buyer-service.ts` (706)
   - `agent/src/marketplace/seller-service.ts` (661)
6. New mixin methods go on the **existing** `MarketplaceMethods` class
   (`agent/src/dkg-agent-marketplace.ts`, 488 lines; keep it < 800 by
   delegating to modules). `dkg-agent.ts` is at budget, so add no new mixin
   holder. The `DKGAgent` interface already extends `MarketplaceMethods`.

## 3. Shared constants and golden vectors (the source of truth for tests)

### 3.1 Identifiers and digests

| Name | Value |
|---|---|
| Chat payload schema | `openai-chat/v1` |
| Chat result schema | `openai-chat-result/v1` |
| Query result schema | `sparql-result/v1` |
| Chat template id | `openai-chat-count/v1` = `{ version: 'openai-chat-count/v1', perMessageTokens: 3, perReplyPrimerTokens: 3 }` |
| `CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST` | `sha256:53662e1fb5c8ef588e2d3e3b8fc9025e25a7a4caf0650842a64323b29c71cee8` = sha256 of `JSON.stringify({version,perMessageTokens,perReplyPrimerTokens})` **in that key order** (byte-identical to the fork's `templateConstantsDigest`) |
| Tokenizer kinds | `hf-bpe-v1` (fork `hfEngine`: HF `tokenizer.json`, byte-level BPE, Qwen2 split + individual digits), `tiktoken-o200k-v1` (fork `tiktokenEngine`: `.tiktoken` rank file, o200k split), `stub-words-v1` (whitespace word count, no file) |
| File-kind pin digest | `sha256:` + sha256(raw bytes of the ONE file the engine loads), i.e. `tokenizer.json` or the `.tiktoken` file. Not the fork's directory-bundle digest: the engine reads one file, so the pin covers exactly the bytes that determine the count |
| `STUB_WORDS_DIGEST` | `sha256:77c4f56809020ef019a66d94aeb5e2f45cd300521472a4418c7ab4e502215c95` = sha256(utf8 `dkg-mkt-count/stub-words-v1`) |
| Query schedule | `QUERY_COST_SCHEDULE_V1 = { version: 'dkg-mkt-query-cost/1', base: 2, perTriplePattern: 1, perJoinVar: 2, perPropertyPath: 3, perOptionalOrUnion: 3, perFilter: 1, perAggregation: 5, missingLimitSurcharge: 10, rowsPerDeliveryUnit: 100 }` |
| Schedule canonical JSON | `{"base":2,"missingLimitSurcharge":10,"perAggregation":5,"perFilter":1,"perJoinVar":2,"perOptionalOrUnion":3,"perPropertyPath":3,"perTriplePattern":1,"rowsPerDeliveryUnit":100,"version":"dkg-mkt-query-cost/1"}` (keys sorted, `JSON.stringify`) |
| `QUERY_COST_SCHEDULE_V1_DIGEST` | `sha256:70beea38241810353b4934b29627f4ef0699d6b0159d33ccf0357b070f7b0642` |
| `DEFAULT_QUERY_GUARDS` | `{ timeoutMs: 10_000, maxRows: 10_000 }` |
| `QUERY_MAX_SPARQL_BYTES` | `8192` (UTF-8 bytes). A wire limit, not a schedule term (not in the digest). `analyzeQuery` is quadratic on adversarial input (measured: 8 KiB → 75 ms, 32 KiB → 1.3 s), so both seats refuse longer queries before analysing them (§6.1) |
| `MAX_SERVE_RESULT_BYTES` | `8 * 1024 * 1024`. Seller-side cap on result bytes, checked before a receipt is signed. The protocol router's read cap is 10 MiB, so a larger result would be signed and claimed but never delivered (§5.6, §6.2) |
| `TOOL_CALL_SLACK_UNITS` | `128n`. Extra authorized units when native tool calls may be returned (§8.1) |
| Gateway base path | `/api/marketplace/gateway/v1` |
| Gateway key format | `dkg_gw_<8 lowercase hex>_<43 base64url chars>`. Regex `^dkg_gw_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$`; `keyId = 'gw_' + group1` |
| Prompt-tool transport key | `__dkg_tool_calls__` (fork: `__nsm_tool_calls__`); generated call ids `call_dkg_<24 hex>` |

### 3.2 Golden vectors (copy these numbers into tests)

`stub-words-v1` `encodeCount(text)` = `text.trim() === '' ? 0 : text.trim().split(/\s+/).length`.
This is byte-identical to `words(text).length` in `llm-stub.mjs`.

| GV | Input | Expected |
|---|---|---|
| GV-1 | `''`, `'   '`, `'hello marketplace world'`, `'  multiple   spaces\tand\nnewlines  '`, `'STUB:WORLD MARKETPLACE HELLO :: ok'`, `'{"a":1}'` | 0, 0, 3, 4, 5, 1 |
| GV-2 | messages `[{role:'system',content:'You are terse.'},{role:'user',content:'hello marketplace world'}]`, no tools, stub-words, template v1 | promptUnits **17**, toolUnits **0**. llm-stub reply `STUB:WORLD MARKETPLACE HELLO :: ok`, finish `stop`, completionUnits **5**, servedUnits **22**. llm-stub usage `{prompt_tokens:17, completion_tokens:5, total_tokens:22}` (identical) |
| GV-3 | GV-2 with `max_tokens: 3` | llm-stub reply `STUB:WORLD MARKETPLACE HELLO`, finish `length`, usage `{17, 3, 20}` |
| GV-4 | `[{role:'user',content:'  multiple   spaces\tand\nnewlines  '}]` | prompt 11. Reply `STUB:NEWLINES AND SPACES MULTIPLE :: ok` (6). Usage `{11, 6, 17}` |
| GV-5 | `[{role:'user',content:''}]` | prompt 7. Reply `STUB: :: ok` (3) |
| GV-6 | `chatPromptUpperBound(GV-2 messages, {})` | **56**. Breakdown: `(14+6+3) + (23+4+3) + 3`. Formula: `Σ_m (utf8Bytes(m.content) + utf8Bytes(m.role) + T.perMessageTokens) + T.perReplyPrimerTokens + utf8Bytes(toolEnvelopeText(messages, options))` |
| GV-7 | `boundCompletion(stubWords, 'a b c d e', 3n)` | `{ text: 'a b c ', truncated: true }`. The trailing space is kept: it is the longest code-point prefix whose count ≤ 3 |
| GV-8 | `queryAdmissionUnits(…)` | `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5` → **3**. Same without `LIMIT 5` → **13**. `PREFIX mkt: <https://w3id.org/dkg/marketplace#> SELECT ?o ?a WHERE { ?o a mkt:Offer . ?o mkt:askPerUnitWei ?a . } LIMIT 10` → **6**. `SELECT ?s WHERE { ?s <http://x/p>/<http://x/q>* ?o . OPTIONAL { ?s ?p2 ?o2 } FILTER(?o > 3) } LIMIT 3` → **17** |
| GV-9 | `queryDeliveryUnits(rows)` | rows 0→0, 1→1, 100→1, 101→2, 10000→100 |
| GV-10 | `queryWorstCaseUnits('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5', 100)` | 4. With 10000 → 103 |

Tokenizer-file fixtures for `hf-bpe-v1` and `tiktoken-o200k-v1` are synthetic and
tiny (§15.1). A authors them and pins their counts and digests in A's tests.
Other slices generate their own inline fixtures. They never import A's test files.

## 4. Seller connectors

### 4.1 Interface (C, `agent/src/marketplace/connectors/types.ts`)

```ts
export type ChatConnectorKind = 'openai-compatible' | 'llamacpp' | 'codex-oauth';

export interface ConnectorChatRequest {
  upstreamModel: string;
  messages: ChatMessage[];          // normalized wire messages (A), string content
  maxTokens: number;                // ≥ 1, already capped by the executor (§5.6)
  temperature?: number; topP?: number; seed?: number; stop?: string[];
  tools?: ChatTool[]; toolChoice?: ChatToolChoice; parallelToolCalls?: boolean; // native transport only
}

export type ConnectorChatOutcome =
  | { ok: true; content: string; toolCalls?: ChatToolCall[];
      finishReason: string;          // raw upstream value; the executor normalizes it
      providerUsage?: { promptTokens: number; completionTokens: number } }
  | { ok: false;
      code: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_AUTH' | 'CONTEXT_EXCEEDED';
      status: number;                // upstream HTTP status, 0 for transport faults
      detail: string };              // ≤ 240 chars, secret-redacted, never prompt/completion text

export interface ConnectorDescription {
  kind: ChatConnectorKind;
  toolTransport: 'native' | 'prompt' | 'none';
  provenanceClass: 'weights-pinned' | 'upstream-claimed' | 'stub';
  upstreamModel: string;
  upstreamOrigin: string;            // scheme://host[:port] only (status surfaces; NEVER published)
  contextLength?: bigint;
  weightsDigest?: string;            // llamacpp: sha256 of the GGUF
  servingSeed?: bigint; servingTemperature?: string;   // llamacpp: published verbatim
  secretConfigured: boolean;
}

export interface ChatConnector {
  readonly description: ConnectorDescription;
  complete(req: ConnectorChatRequest): Promise<ConnectorChatOutcome>;  // never throws for upstream faults
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

export function mountChatConnector(
  config: MarketplaceConnectorConfig,
  deps: { dataDir?: string; fetch?: typeof fetch; now?: () => number; log: MarketplaceLogger },
): Promise<ChatConnector>;           // throws MarketplaceConnectorMountError { code, message }
```

`MarketplaceConnectorMountError.code` takes one of these values:

- `CONNECTOR_CONFIG`
- `CONNECTOR_NOT_LOOPBACK`
- `CONNECTOR_SECRET_ABSENT`
- `CONNECTOR_SECRET_PERMS`
- `CONNECTOR_TOKENIZER`
- `CONNECTOR_GGUF_ABSENT`
- `CONNECTOR_UNHEALTHY`
- `CONNECTOR_AUTH_ABSENT`
- `CONNECTOR_SCOPE`

### 4.2 Config shapes (C types in `agent/src/marketplace/config.ts`; D parses JSON into them)

```ts
export type MarketplaceConnectorConfig =
  | { kind: 'openai-compatible';
      baseUrl: string;               // e.g. https://api.openai.com/v1 ; http allowed (admin-configured)
      upstreamModel: string;
      secretEnvFile?: string;        // ABSOLUTE path; omitted → no Authorization header
      secretEnvKey?: string;         // default 'OPENAI_API_KEY'
      toolTransport?: 'native' | 'prompt' | 'none';  // default 'native'
      maxTokensField?: 'max_tokens' | 'max_completion_tokens'; // default 'max_tokens'; OpenAI reasoning models reject max_tokens
      contextLength?: bigint;
      timeoutMs?: number; }          // default 120_000, range 1_000..600_000
  | { kind: 'llamacpp';
      baseUrl: string;               // loopback only
      ggufPath: string;              // ABSOLUTE
      settings: { seed: number; temperature: string; ctx: number }; // temperature as decimal string
      timeoutMs?: number; }          // default 120_000
  | { kind: 'codex-oauth';
      upstreamModel: string;
      authFile?: string;             // default defaultCodexAuthFile(dataDir)
      baseUrl?: string;              // default CODEX_DEFAULT_BASE
      reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // default 'low'
      acknowledgeSubscriptionScope: true;   // REQUIRED literal true (§4.5)
      timeoutMs?: number; };         // default 180_000

export interface MarketplaceOfferingConfig {            // existing fields unchanged, plus:
  executor?: 'stub-inference' | 'local-query' | 'chat-connector';
  connector?: MarketplaceConnectorConfig;               // present ⇔ executor 'chat-connector' (default when present)
  metering?: { tokenizer?: { kind: TokenizerKind; path?: string } }; // path required unless 'stub-words-v1'
  allowedBuyers?: string[];                             // EVM addresses; non-empty ⇒ offer access 'restricted'
  model?: { displayName?: string; family?: string; contextLength?: bigint; quantization?: string };
}
```

Validation is split between two places.

**D parses structure.** Types, absolute paths, URL syntax, enum values, and
`acknowledgeSubscriptionScope === true`.

**C validates semantics at mount.** A connector offering must have:

- `serviceType 'inference'` and `unit 'token'`;
- a `modelId` that canonicalizes (§5.3).

Per connector kind:

- **llamacpp** requires `metering.tokenizer.kind === 'hf-bpe-v1'`.
- **codex-oauth** requires `metering.tokenizer.kind === 'tiktoken-o200k-v1'` and a non-empty `allowedBuyers`.
- **openai-compatible**: `metering` is optional. Without it, the basis is `provider-reported` (§5.7).

### 4.3 Where secrets live (fork `secretEnvFile` approach, kept)

- Upstream credentials are **never** stored in node `config.json`, offer KAs,
  status or route responses, logs, or error details. Config holds only the **path**.
- **openai-compatible.** `secretEnvFile` is an absolute path to a `KEY=value`
  file (`#` comments, blank lines allowed). The connector reads
  `secretEnvKey` (default `OPENAI_API_KEY`) **at call time**, so rotation needs no restart.
  - **Mount fails** if the file is missing (`CONNECTOR_SECRET_ABSENT`), if it is
    group/world accessible (`(mode & 0o077) !== 0` → `CONNECTOR_SECRET_PERMS`),
    or if the key line is absent or empty.
  - **Never echoed.** `replaceAll(secret, '[redacted]')` runs on the **whole**
    upstream error body first, and only then is the result cut to 160 chars.
    Truncating first could leave a partial key at the cut.
  - **Mount errors name the file and the key, never content.** A parse fault
    reports `secretEnvFile line <n>`, never the line itself.
- **codex-oauth.** Tokens live in the auth file (`{ tokens: { access_token,
  refresh_token, account_id, id_token }, last_refresh }`), mode 0600, under a
  `.secrets/` dir with mode 0700.
  - The default is `defaultCodexAuthFile(dataDir) =
    <dataDir>/marketplace/.secrets/codex-auth.json` (exported by C, used by D's OAuth flow).
  - The connector reads at call time, refreshes proactively when the
    access-token JWT `exp` is under 5 min away, and refreshes once on an
    upstream 401/403.
  - **Refresh is single-flight per auth file.** Concurrent callers await one
    in-process refresh promise. Refresh tokens rotate (single use), so two
    parallel refreshes would invalidate the token family and strand the
    connector until a new login.
  - It writes refreshed tokens back atomically (tmp file with mode 0600, then
    rename, then `chmod 0600`; `writeFileSync`'s `mode` applies only on
    create). D's OAuth flow writes the file the same way and creates `.secrets/`
    with mode 0700.
  - `detail` strings redact the values of `access_token`, `refresh_token`,
    `id_token` and `account_id` (redact first, then truncate).
- **llamacpp** has no secret.
- `status` surfaces report only `secretConfigured: boolean`. They report
  `upstreamOrigin` (scheme://host:port), never the full URL, path, query, or
  file path.

### 4.4 Mount, health, timeouts

Mount happens:

- at runtime start, for config offerings, asynchronously;
- inside `marketplaceSetOfferings`, awaited.

`marketplaceSetOfferings` is **all-or-nothing**. It mounts every connector in
the new set first. Then it swaps the served set and publishes. If any mount
fails, it throws `MarketplaceConnectorMountError` and the old set stays in force.

A config offering whose connector fails at boot is held `failed`:

- it is not served (quote → `available:false, declineCode:'CONNECTOR_UNAVAILABLE'`;
  serve → `UNKNOWN_OFFERING`);
- it is not published;
- it is reported by `marketplaceConnectorStatus()`;
- it is **retried** in the background with backoff (60 s, doubling, capped at
  10 min). A local llama.cpp server that starts after the daemon is the common
  case. A successful retry swaps the offering into the served set. It does not
  publish: boot never publishes, as today. A later `marketplaceSetOfferings`
  cancels pending retries.

| Connector | Mount checks (no spend) | Health probe (on demand) | Call timeout |
|---|---|---|---|
| openai-compatible | URL rules (§4.5). Secret file (§4.3). Tokenizer file loads and digests. **No upstream call**: an upstream outage must not unpublish an offer | `GET {baseUrl}/models` with the bearer, 10 s | `timeoutMs` (120 s) |
| llamacpp | Loopback URL. GGUF exists. GGUF sha256 is streamed (createReadStream) and cached in `<dataDir>/marketplace/connector-digests.json` keyed by `{path,size,mtimeMs}`. `tokenizer.json` loads. `GET {baseUrl}/v1/models` must answer 200 within 30 s (fork lesson: a 5 s probe aborts while a 9 GB hash runs) | `GET /v1/models`, 10 s | 120 s |
| codex-oauth | `acknowledgeSubscriptionScope === true`, `allowedBuyers` non-empty. Auth file present with `access_token`, `refresh_token`, `account_id`. `.tiktoken` loads. No network | JWT expiry check. Refresh if expired | 180 s |

- Upstream response bodies are read with an **8 MiB cap**.
- `fetch` uses `redirect: 'error'`. A redirect counts as `UPSTREAM_ERROR`.
- Classification:
  - 429 → `UPSTREAM_RATE_LIMITED`
  - 401/403 → `UPSTREAM_AUTH`
  - other non-2xx → `UPSTREAM_ERROR`
  - abort or timeout → `UPSTREAM_TIMEOUT`
  - llama.cpp `"request (N tokens) exceeds the available context size (M tokens)"`
    → `CONTEXT_EXCEEDED` (port `classifyLlamaCppError`)
- Upstream failures produce **no receipt** (§5.6).
- The buyer's chat serve timeout default (§8.1) is 200 s, larger than every
  default connector timeout. An operator who raises a connector `timeoutMs`
  above ~190 s risks buyer-side `DELIVERY_UNKNOWN`. Document this in the config reference.

### 4.5 SSRF and trust stance

- Only the **node admin** sets base URLs and file paths, through `config.json`
  or the node-admin-gated `POST /api/marketplace/seller/offerings`. The
  node-admin token already equals full node control, so pointing a connector at
  any URL or file is within its authority. The routes stay node-admin-only.
- **Buyers can never influence an upstream URL.** Offer KAs carry no endpoints
  (the fork's `apiBase` and serve-endpoint literals are dropped). Transport is
  libp2p. A request's `model` only selects among discovered offers. Seller
  upstreams are seller-local config.
- URL rules:
  - **openai-compatible.** `http:` or `https:` only. No userinfo, no query, no
    fragment. Trailing slash stripped.
  - **llamacpp.** `http://127.0.0.1|localhost|[::1][:port]` only
    (`CONNECTOR_NOT_LOOPBACK`).
  - **codex-oauth.** `https:`, or `http:` to a loopback host only (the test seam).
- **Codex scope (carried from the fork, enforced).** Reselling a personal Codex
  subscription to third parties breaches upstream terms. A codex-oauth offering
  therefore needs all three of the following:
  1. `acknowledgeSubscriptionScope: true` in config.
  2. A non-empty `allowedBuyers`. The seller refuses any other buyer with
     `BUYER_NOT_ALLOWED`. The check runs **after** the authorization signature
     verifies and before execution (§7.5). Running it earlier would let an
     unauthenticated prober test arbitrary addresses against the private list.
  3. Publication with `mkt:access "restricted"`, so routers of buyers who did
     not allow-list this seller skip it (§8.2).

  `allowedBuyers` also works on any other connector.

### 4.6 Connector specifics (port notes)

- **openai-compatible.** `POST {baseUrl}/chat/completions` with
  `{ model: upstreamModel, messages, [maxTokensField]: maxTokens, stream: false,
  temperature?, top_p?, seed?, stop?, tools?, tool_choice?, parallel_tool_calls? }`.
  - Every sampler field is sent **only when the request carries it**. The
    fork's forced `temperature: 0` is dropped: OpenAI reasoning models reject
    any value but the default, and reject `max_tokens` (hence `maxTokensField`).
  - Tool fields are sent only when `toolTransport === 'native'`.
  - Response: `choices[0].message.content` (null → `''`; any other non-string →
    `UPSTREAM_ERROR`), `tool_calls`, `finish_reason`, and
    `usage.prompt_tokens/completion_tokens` (non-negative safe integers or absent).
  - `tool_calls` that is **absent, null or `[]`** means no tool calls. vLLM
    returns `[]` on every plain reply, and the fork's `normalizeToolCalls`
    rejects empty arrays. Otherwise normalize with A `normalizeToolCalls`;
    invalid → `UPSTREAM_ERROR`.
- **llamacpp.** `POST {baseUrl}/v1/chat/completions` with `{ model: <server model id>,
  messages, max_tokens, temperature: Number(settings.temperature), seed:
  settings.seed, stop?, stream: false }`.
  - Request `temperature`, `top_p` and `seed` are **ignored**: serving settings
    are pinned and published.
  - `toolTransport` is fixed to `'prompt'`.
  - `contextLength = settings.ctx`.
  - The model id comes from the server's `/v1/models` and is used only
    upstream. The marketplace `modelId` comes from offering config. Never
    publish the server's file-path id (fork note).
- **codex-oauth.** Port `completeCodexOAuth` verbatim apart from these changes:
  - Accumulation covers `response.output_text.delta`, `response.completed`,
    `response.incomplete` and `response.failed`.
  - `system` maps to `developer`. Headers are kept.
  - **No `max_output_tokens` is sent** (the backend rejects it). The output is
    bounded by the executor's `boundCompletion`.
  - `toolTransport` is fixed to `'prompt'`.
  - `providerUsage` is informational only (reasoning tokens are invisible in
    the delivered bytes).
  - The token URL and base are injectable through `deps` for tests. Do not use
    the fork's `NSM_CODEX_TOKEN_URL` env var.
  - Export `CODEX_OAUTH_CLIENT_ID`, `CODEX_DEFAULT_BASE`, `CODEX_TOKEN_URL` and
    `defaultCodexAuthFile` from the agent.

## 5. Metering

### 5.1 Count engines (A, `token-engines.ts`)

```ts
export interface TokenCountEngine {
  readonly kind: TokenizerKind;
  readonly digest: string;            // the pin digest (§3.1)
  encodeCount(text: string): number;  // deterministic, pure; count(text) ≤ utf8Bytes(text) for every kind
}
```

- `createHfBpeEngine(bytes)` and `createTiktokenO200kEngine(bytes)`: port of
  fork `bpe.ts`. Keep `bytesToUnicode`, `QWEN_SPLIT`, `O200K_SPLIT`, the
  merge-rank semantics and the tiktoken rank parse verbatim. HF merges accept
  both `"a b"` strings and `[a,b]` pairs. Construction throws on unparseable
  input. `encodeCount` counts unknown pieces as one each, which keeps it
  deterministic.
- **Bounded cost (MUST).** The fork's merge loops are O(n²) per pre-tokenized
  piece: they rescan and rebuild the whole symbol array on every merge. One
  long `\p{L}+` run, such as 2 MB of concatenated words, then blocks the event
  loop for minutes to hours. Sellers count prompts after admission, and the
  buyer gateway counts per candidate offer, so this is a DoS on both seats.
  - Implement both merge loops with a doubly-linked symbol list plus a min-heap
    keyed `(rank, leftmost position)` with lazy invalidation, which is
    O(n log n). This is the HF tokenizers / tiktoken "large piece" algorithm.
    For BPE-consistent merge lists it is result-identical to the fork loops: a
    merge involving a merged symbol always ranks after the merge that created it.
  - Keep the verbatim fork loops in `test/` only, as an oracle. The
    differential test is in §15.1.
  - Both seats run the same A code, so the heap implementation *is* the count
    definition for every `hf-bpe-v1` / `tiktoken-o200k-v1` pin.
- `createStubWordsEngine()`: §3.2 formula, digest `STUB_WORDS_DIGEST`. This is
  the devnet engine. It reproduces the llm-stub `usage` formula exactly, so
  both seats and the stub agree on GV-2..GV-5.
- `TokenizerRegistry`: digest-keyed engine lookup. `stub-words-v1` is
  pre-registered. C loads files and registers engines.

### 5.2 The pin in the offer

`OfferMetering` (A `types.ts`):

```ts
export type OfferMetering =
  | { basis: 'pinned';
      tokenizer: { kind: TokenizerKind; digest: string };
      chatTemplate?: { id: 'openai-chat-count/v1'; digest: string } }   // required for apiShape openai-chat/v1
  | { basis: 'provider-reported' };
```

The seller computes the pin at mount: it loads the file, digests the bytes and
builds the engine. A seller pin whose file digest changes after a restart
changes offer content, so the next publish **updates the KA** (new revision).
This is intended: the pin is a public commitment.

### 5.3 modelId canonicalization (A `model-id.ts`)

`canonicalModelId(raw: unknown): string | undefined` computes
`String(raw).normalize('NFC').trim().toLowerCase()`. The result is valid iff it
matches `^[a-z0-9][a-z0-9._:@+\/-]{0,127}$`. Anything else returns `undefined`.

Apply it at every boundary:

- **Publish side (C).** A connector offering's `modelId` must canonicalize or
  mount fails with `CONNECTOR_CONFIG`. The canonical form is published.
  Non-connector offerings keep their existing `modelId` handling, canonicalized
  when valid.
- **Discovery side (C).** `offer.modelId = canonicalModelId(raw)`. An invalid
  value drops `modelId` (the offer stays, unroutable by model).
- **Buyer requests (C).** `invoke({modelId})`, gateway `model`, and policy
  `bucket.match.modelId` (D parse) are all canonicalized. If canonicalization
  fails → `MarketplaceRequestError('invalid_model')` (C) or 400 (D).

Model family inference is `inferModelFamily(modelId)`, a port of the fork's
`known` table: qwen, openai, deepseek, meta, mistral. Logos and display
assets are a UI-phase concern and are **not** ported.

### 5.4 New offer RDF fields (C: `offer-publisher.ts`, or a new `offer-rdf.ts` it imports)

Namespace `https://w3id.org/dkg/marketplace#`. Every value is a plain string
literal, as today. Numerics are decimal strings parsed with `BigInt`.

| Predicate | When | Value |
|---|---|---|
| `mkt:apiShape` | chat-connector offerings | `openai-chat/v1` |
| `mkt:toolTransport` | chat-connector | `native` \| `prompt` \| `none` |
| `mkt:meteringBasis` | chat-connector | `pinned` \| `provider-reported` |
| `mkt:tokenizerKind`, `mkt:tokenizerDigest` | basis pinned | §3.1 |
| `mkt:chatTemplate`, `mkt:chatTemplateDigest` | basis pinned | `openai-chat-count/v1`, §3.1 digest |
| `mkt:queryCostSchedule`, `mkt:queryCostScheduleDigest` | `local-query` offerings | `dkg-mkt-query-cost/1`, §3.1 digest |
| `mkt:provenanceClass` | chat-connector | `weights-pinned` (llamacpp) \| `upstream-claimed` (openai-compatible, codex-oauth) |
| `mkt:upstreamModel` | openai-compatible, codex-oauth | upstream model string (an honest label, not a secret) |
| `mkt:weightsDigest`, `mkt:servingSeed`, `mkt:servingTemperature` | llamacpp | GGUF digest, seed, temperature string |
| `mkt:contextLength` | when known | decimal |
| `mkt:modelFamily`, `mkt:modelDisplayName`, `mkt:quantization` | when known/configured | strings |
| `mkt:access` | when `allowedBuyers` is non-empty | `restricted`. Absent means open |

Rules:

- **Never published:** base URLs, file paths, secret env keys, upstream
  origins, `allowedBuyers` contents.
- **Publish side.** `buildMarketplaceOfferQuads` adds these when present.
  `offerContentKey` already compares every non-revision predicate, so a pin or
  model change republishes as a KA update and an unchanged offer still sends no transaction.
- **Discovery side.** Extend the parse with these fields. Malformed metering or
  model fields drop **only the extension group** (`metering`, `model`,
  `queryCost`, `apiShape`, `toolTransport`), and the offer itself is kept.
  Malformed means any of:
  - an unknown enum;
  - a digest not matching `^sha256:[0-9a-f]{64}$`;
  - non-decimal numerics;
  - `pinned` without kind+digest;
  - `tokenizerKind 'stub-words-v1'` with a digest ≠ `STUB_WORDS_DIGEST`;
  - `chatTemplate 'openai-chat-count/v1'` with a digest ≠ `CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST`;
  - a `queryCostSchedule` id/digest pair that is not exactly V1's (the group is
    dropped, so recount reports `schedule-drift`).

  Malformed core fields still skip the offer (existing rule).
- **Discovery query (MUST be a triple scan).** Use:
  `SELECT ?g ?offer ?p ?o WHERE { GRAPH ?g { ?offer a mkt:Offer ; ?p ?o . FILTER(STRSTARTS(STR(?p), "https://w3id.org/dkg/marketplace#")) } }`,
  grouped by `(g, offer)` in TS.
  - **Do not extend the existing SELECT with OPTIONALs.** The `marketplace` CG
    has an open publish policy, and the authority check runs in TS *after* the
    engine has produced the rows. One KA carrying k values for each of ~20
    OPTIONAL predicates makes every buyer's discovery materialize k^20 rows.
  - **No `LIMIT`.** A truncating LIMIT with no ORDER BY would let junk triples
    push real offers out of the result.
  - **Bounded TS work.** A `(g, offer)` group with more than 64 triples is
    skipped. A core predicate with more than one distinct value skips the
    offer. An extension predicate with more than one distinct value drops its
    extension group.
  - The existing authority rule (graph author == `sellerAddress`) and the
    newest-revision and per-node monotonic rules MUST be preserved unchanged.

`MarketplaceOffer` additions (A `types.ts`, all optional):

```ts
apiShape?: 'openai-chat/v1';
toolTransport?: 'native' | 'prompt' | 'none';
metering?: OfferMetering;
model?: { provenanceClass?: 'weights-pinned' | 'upstream-claimed' | 'stub'; family?: string; displayName?: string;
          contextLength?: bigint; quantization?: string; weightsDigest?: string; upstreamModel?: string;
          servingSeed?: bigint; servingTemperature?: string };
queryCost?: { schedule: string; digest: string };
access?: 'open' | 'restricted';
```

### 5.5 Canonical counting rules (carried from the fork's `CANONICALIZATION_CANONICAL`)

- **R1. Delivered text.** The delivered completion is
  `choices[0].message.content` of the seller result JSON. It is taken
  **verbatim** after the JSON parser's own unescaping.
- **R2. No mutation.** Encoding is UTF-8, with no normalization (NFC/NFKC), no
  trim and no whitespace mutation.
- **R3. Empty output.** An empty delivered completion is legal and counts 0
  completion units.
- **R4. Tool calls.** Tool calls count as
  `encodeCount(JSON.stringify(tool_calls))`.
  - The seller counts the normalized array it serializes.
  - The buyer counts `JSON.stringify` of the array **as JSON-parsed from the
    result bytes**, with no re-normalization.
  - `parseChatServeResult` rejects tool calls with missing or extra keys.
  - For a conforming result the two strings are identical.

The fork's token-id-sequence evidence and round-trip requirement are **not**
ported. Both seats count with the same pinned engine over the same committed
bytes (`resultCommitment = sha256(result bytes)`), which makes the count
reproducible without carrying ids.

### 5.6 How the seller computes `servedUnits` for chat (C `chat-executor.ts`)

Units are defined as follows (A `chat-metering.ts`, all `bigint`). `E` is the
pinned engine and `T` is template v1.

```
promptUnits     = Σ_{m ∈ wireMessages} ( E(m.content) + E(m.role) + T.perMessageTokens ) + T.perReplyPrimerTokens
toolUnits       = toolEnvelopeText(wireMessages, wireOptions) === '' ? 0 : E(toolEnvelopeText(...))
completionUnits = E(deliveredContent ?? '') + (toolCalls?.length ? E(JSON.stringify(toolCalls)) : 0)
servedUnits     = promptUnits + toolUnits + completionUnits
```

`toolEnvelopeText` ports the fork's `chatToolReservationUnits` payload. It returns `''` when there is no metadata and no tool option. Otherwise it returns
`JSON.stringify({ messageMetadata, ...(tools?{tools}:{}), ...(toolChoice!==undefined?{tool_choice}:{}),
...(parallelToolCalls!==undefined?{parallel_tool_calls}:{}) })`, where
`messageMetadata[i] = { name?, tool_call_id?, tool_calls? }`, built in that key
order from each normalized message.

`chatPromptUpperBound` is the GV-6 formula: utf8 bytes in place of `E` for
content, role and the tool envelope, plus the template constants. It bounds
every engine's `promptUnits + toolUnits`, because each engine counts ≤ utf8 bytes.

The executor algorithm, for one serve. It runs after the existing seller
admission, which proceeds in this order: replay, `UNDERFUNDED`, auth signature,
and then the new `allowedBuyers` check (`BUYER_NOT_ALLOWED`, §7.5).

1. **Parse the payload.** Use A `parseChatServePayload` with `allowParts:false`,
   `maxMessages 256` and `maxBytes 2_000_000`.
   - Schema not `openai-chat/v1`, or any shape fault → `BAD_PAYLOAD`.
   - Canonical `payload.model` ≠ the offering's `modelId` → `MODEL_MISMATCH`.
2. **Tool fields.** Tool fields present, or messages carrying
   `tool_calls`/`tool_call_id`, while the connector's `toolTransport !== 'native'`
   → `TOOLS_UNSUPPORTED`.
3. **Pinned basis.** Let `fixed = promptUnits + toolUnits`.
   - `fixed ≥ maxUnits` → `OVER_MAX_UNITS`. At least one completion unit must fit.
   - `contextLength` known and `fixed + 1 > contextLength` → `CONTEXT_EXCEEDED`.
   - Otherwise `budget = min(payload.max_tokens, maxUnits − fixed, contextLength ? contextLength − fixed : ∞)`.

   **provider-reported basis:** `budget = payload.max_tokens`.
4. **Call upstream.** `connector.complete({ …, maxTokens: Number(budget) })`.
   If the outcome is `ok:false`, throw `MarketplaceExecutionError(outcome.code)`.
   That means **no receipt**, and the buyer voids its reservation.
5. **Validate tool calls.** Run `normalizeToolCalls` and
   `validateToolCallsAgainstOptions` against the payload's tool options. A
   failure → `UPSTREAM_ERROR`, fail closed with no receipt. A provider must never
   name a tool the caller did not expose.
6. **Pinned basis.**
   - Compute `toolCallUnits = toolCalls ? E(JSON.stringify(toolCalls)) : 0`.
   - If `fixed + toolCallUnits > maxUnits` → `OVER_MAX_UNITS` (fail closed:
     tool calls cannot be truncated).
   - Bound the content: `{text, truncated} = boundCompletion(E, content, min(budget, maxUnits − fixed) − toolCallUnits)`.
     A cap below 0 is treated as 0.
   - `completionUnits = E(text) + toolCallUnits`.
   - `servedUnits = fixed + completionUnits`, which is ≤ `maxUnits` by construction.

   **provider-reported basis:**
   - `providerUsage` absent or invalid → `UPSTREAM_ERROR`.
   - `servedUnits = promptTokens + completionTokens`.
   - `servedUnits > maxUnits` → `METERING_OVERRUN` (fail closed, 0 units).
     This is a **seller** fault, not `OVER_MAX_UNITS`. The buyer sized
     `maxUnits` from the strict byte bound. A provider prompt count above it
     comes from the provider's hidden template or system prompt, and raising
     `max_tokens` cannot fix it.
   - `servedUnits === 0` → `EMPTY_RESULT` (existing check).
7. **Normalize `finish_reason`.** `tool_calls` if tool calls are present, else
   `length` if truncated or upstream said `length`, else `stop`.
8. **Emit the result.** Write the result JSON (§7.3) as UTF-8 `JSON.stringify`
   with no whitespace. `unitsServed = servedUnits`.
   - If `resultBytes.byteLength > MAX_SERVE_RESULT_BYTES`, refuse with
     `UPSTREAM_ERROR` before any receipt exists. JSON escaping can grow an
     8 MiB upstream body past the router's 10 MiB read cap. A signed claim for
     an undeliverable response would charge the buyer for nothing.

**"Overrun fails closed with 0 units"** means:

- Any path where the delivered work cannot be metered within the authorization
  produces a refusal `errorCode`. That is either `OVER_MAX_UNITS` (pinned
  tool-call overflow, a caller-addressable bound) or `METERING_OVERRUN`
  (provider-reported total above `maxUnits`).
- The seller signs no receipt and the buyer is charged nothing.
- The authorization stays burned. This is the existing fail-closed replay rule.
- The seller absorbs the upstream cost.

### 5.7 Provider-reported fallback (no pin)

This applies only to openai-compatible offerings configured without
`metering.tokenizer`.

- The offer publishes `mkt:meteringBasis "provider-reported"` and no tokenizer or template fields.
- `servedUnits` equals upstream `usage` (step 6). The result's `metering.basis`
  is `provider-reported`. `providerUsage` is echoed.
- **Buyer recount is off.** The verdict is `unverifiable` with reason
  `provider-reported`, and these calls never move standing.
- The buyer sizes `maxUnits` with the strict byte bound (§8.1).
- The gateway `/models` surfaces `metering_bases: ['provider-reported']` so a
  key holder can see the label.

## 6. Query metering

### 6.1 Schedule (A `query-cost.ts`)

- Port `analyzeQuery` **verbatim**. Both seats run the same function over the
  same bytes. Its approximations are part of the schedule, so do not "fix" them.
- **Size gate (MUST).** `assertQueryWithinLimit(sparql)` throws
  `QueryTooLargeError` when `utf8Bytes(sparql) > QUERY_MAX_SPARQL_BYTES`, and
  every exported function that analyses a query calls it first. The
  property-path and triple-pattern regexes backtrack quadratically on long
  whitespace runs and undotted bodies.
  - Buyer: `MarketplaceRequestError('invalid_sparql', …, 'sparql')`, sent
    before routing.
  - Seller: `BAD_PAYLOAD`, sent before analysis.
- `queryAdmissionUnits(sparql, s)` returns `bigint` and computes:
  ```
  base + triplePatterns·perTriplePattern + joinVars·perJoinVar
       + propertyPaths·perPropertyPath + (optionals+unions)·perOptionalOrUnion
       + filters·perFilter + aggregations·perAggregation
       + (hasLimit ? 0 : missingLimitSurcharge)
  ```
  All terms are integers, so there is no ceil.
- `queryDeliveryUnits(rows, s) = ceilDiv(rows, rowsPerDeliveryUnit)`.
- `queryWorstCaseUnits(sparql, maxRows, s) = admission + delivery(maxRows)`.
- `queryRowCap(sparql, maxUnits, guardMaxRows, s)` returns
  `{ admit: false }` when `maxUnits < admission`. Otherwise it returns
  `{ admit: true, admissionUnits, rowCap }` with
  `rowCap = min(guardMaxRows, (maxUnits − admission) · rowsPerDeliveryUnit)`.
- `countResultRows(result)` is
  `(Array.isArray(result?.bindings) ? result.bindings.length : 0) + (Array.isArray(result?.quads) ? result.quads.length : 0)`.

### 6.2 Seller `local-query` executor (C, replaces the placeholder `queryUnits`)

1. Parse `{ sparql }` (non-empty string) as today.
2. Call `queryRowCap(sparql, maxUnits, guards.maxRows)`. If `admit:false` →
   `OVER_MAX_UNITS` before execution. Nothing runs and nothing is charged.
3. Execute through the injected query fn with a guard. Pass `{ timeout:
   guards.timeoutMs, signal: AbortSignal.timeout(guards.timeoutMs) }` through to
   `agent.query` (`QueryOptions.timeout`/`signal` exist).
4. Outcomes. `rows` is **`countResultRows(value)` over the exact value the
   seller serializes as `result`**, never the query fn's own `rowCount`. Today's
   mixin counts only `bindings`, while the buyer recount also counts `quads`.
   - **Delivered** (`rows ≤ rowCap`): `servedUnits = admission + delivery(rows)`.
     The result is `{ schema, result, rowCount, metering: { scheduleDigest,
     admissionUnits, deliveryUnits, servedUnits, rowCount } }`.
   - **Guard abort** (timeout, or `rows > rowCap`): this is the fork's split
     decrement, so **admission is still owed** (`admission ≥ base = 2 > 0`).
     `servedUnits = admission`. The result is `{ schema, result: null, rowCount: 0,
     metering: { …, deliveryUnits: 0, servedUnits: admission, aborted: { reason:
     'timeout' | 'row-cap' | 'size-cap' } } }`. The receipt settles admission only.
   - **Size-cap abort**: the delivered result would serialize past
     `MAX_SERVE_RESULT_BYTES`. It is handled exactly like a guard abort, with
     reason `'size-cap'`, and the check runs before signing.
   - **Backend failure** (not a guard): `EXECUTION_FAILED`, no receipt.
5. Seller guards come from config `marketplace.seller.queryGuards` and default to `DEFAULT_QUERY_GUARDS`.

### 6.3 Pin and buyer sizing

`local-query` offerings publish `mkt:queryCostSchedule` +
`mkt:queryCostScheduleDigest`. Existing query offers republish once, as a KA
update, on the next `setOfferings`.

Buyer `maxUnits` for a query is
`queryWorstCaseUnits(sparql, maxRows ?? DEFAULT_QUERY_GUARDS.maxRows)`.

- If the offer's schedule digest differs from `QUERY_COST_SCHEDULE_V1_DIGEST`,
  the buyer still sizes with V1. The seller may then refuse `OVER_MAX_UNITS`.
  The recount verdict is `unverifiable` with reason `schedule-drift`.

## 7. Wire

### 7.1 Envelope decision: unchanged

The `MarketplaceServeRequest.payload` and `MarketplaceServeResponse.result` are
already opaque JSON bytes, and the receipt commits to `sha256(result bytes)`. So:

- **No proto field is added.**
- **`MARKETPLACE_SERVE_VERSION` stays `1`.**
- **`payloadKind` stays `'inference'` for chat.**

The JSON `schema` discriminator inside the payload and result carries the new
shapes. Offers advertise `mkt:apiShape`, so a new buyer never sends a chat
payload to an offer without it.

An old seller that receives one anyway answers `BAD_PAYLOAD` (its stub executor
requires `prompt`). That is a refusal, so the buyer voids and nothing is
charged. `packages/core` is untouched.

### 7.2 Chat payload (buyer → seller; A `ChatServePayload`, `parseChatServePayload`)

```json
{ "schema": "openai-chat/v1",
  "model": "<canonical modelId>",
  "messages": [ { "role": "user", "content": "…", "name"?: "…", "tool_call_id"?: "…", "tool_calls"?: [ … ] } ],
  "tools"?: [ … ], "tool_choice"?: "auto"|"none"|"required"|{ "type":"function","function":{"name":"…"} },
  "parallel_tool_calls"?: true|false,
  "max_tokens": 1..1000000,
  "temperature"?: 0..2, "top_p"?: 0..1, "seed"?: <safe int>, "stop"?: [ "…" ]   // stop: ≤ 4 strings, each 1..256 chars
}
```

- `messages` are the **wire** messages. The prompt-tool transport is already
  applied for `toolTransport: 'prompt'` offers (§8.4).
- `content` is always a string on the wire. The gateway flattens text parts
  (`allowParts:true` at the edge, `false` at the seller, as in the fork).
- `parseChatServePayload` returns `{ ok: true; payload; options: ChatToolOptions } | { ok: false; detail }`.

### 7.3 Chat result (seller → buyer; committed by `resultCommitment`)

```json
{ "schema": "openai-chat-result/v1",
  "model": "<canonical modelId>",
  "choices": [ { "index": 0,
                 "message": { "role": "assistant", "content": "<string|null>", "tool_calls"?: [ … ] },
                 "finish_reason": "stop"|"length"|"tool_calls" } ],
  "usage": { "prompt_tokens": n, "completion_tokens": n, "total_tokens": n },
  "metering": { "basis": "pinned"|"provider-reported",
                "tokenizer"?: { "kind": "…", "digest": "sha256:…" },
                "chatTemplate"?: { "id": "openai-chat-count/v1", "digest": "sha256:…" },
                "promptUnits": n, "toolUnits": n, "completionUnits": n, "servedUnits": n,
                "truncated": bool,
                "providerUsage"?: { "prompt_tokens": n, "completion_tokens": n } } }
```

- `content` is `null` only when `tool_calls` is non-empty and the upstream
  content was empty.
- Under the **pinned** basis: `usage.prompt_tokens = promptUnits + toolUnits`,
  `usage.completion_tokens = completionUnits`, `total_tokens = servedUnits`.
- Under the **provider-reported** basis: `usage` equals `providerUsage`.
- `metering.servedUnits` MUST equal the receipt's `servedUnits`.
- Numbers are JSON safe integers. Parsers (`parseChatServeResult`) reject
  anything else and convert to `bigint` immediately.

### 7.4 Query payload and result

- **Payload:** unchanged `{ sparql }`.
- **Result:** `{ schema: 'sparql-result/v1', result, rowCount, metering }` (§6.2).
  This is additive to the old `{ result }`. Consumers that read `.result` keep working.

### 7.5 New seller `errorCode` values (refusals; no receipt)

| Code | Raised by |
|---|---|
| `BUYER_NOT_ALLOWED` | seller-service, **after** `#verifyAuthSignature` and before `executor.execute` (no membership oracle for unauthenticated probers) |
| `METERING_OVERRUN` | chat executor step 6, provider-reported total above `maxUnits` (seller fault) |
| `TOOLS_UNSUPPORTED` | chat executor step 2 |
| `MODEL_MISMATCH` | chat executor step 1 |
| `CONTEXT_EXCEEDED` | executor step 3, or llama.cpp classification |
| `UPSTREAM_RATE_LIMITED`, `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `UPSTREAM_AUTH` | connector outcome |
| `CONNECTOR_UNAVAILABLE` | quote `declineCode` for an unmounted or failed connector offering |

Extend `MarketplaceExecutionErrorCode` to cover every value above.

**Caller-fault codes** must **not** count as seller delivery failures in buyer
delivery history (C):

- `BAD_PAYLOAD`
- `MODEL_MISMATCH`
- `TOOLS_UNSUPPORTED`
- `CONTEXT_EXCEEDED`
- `OVER_MAX_UNITS`
- `UNDERFUNDED`
- `BUYER_NOT_ALLOWED`

`METERING_OVERRUN`, `UPSTREAM_*` and `EXECUTION_FAILED` **do** count as
seller delivery failures.

## 8. Buyer runtime (C)

### 8.1 Per-request `maxUnits` derivation

Routing must size the authorization **per offer**, because two offers for one
model can pin different tokenizers. The router (A) gains
`RouteRequest.maxUnitsFor?(offer): bigint`.

For chat, C supplies the callback below. `bucketCap` is
`policy.buckets[matchPolicyBucket(policy, {serviceType:'inference', modelId})].maxUnitsPerCall`.
If no bucket matches → `MarketplaceRouteError('no-bucket')`.

```
wireFor(offer):                          // the ONLY place wire messages/options are built
  transport = offer.toolTransport ?? 'none'
  native    → { wire: messages, wireOpts: options }
  prompt    → { wire: (requestHasTools || hasToolHistory(messages)) ? buildPromptToolTransport(messages, options) : messages,
                wireOpts: {} }
  none      → { wire: messages, wireOpts: {} }      // reached only when requiresTools is false: tool fields are STRIPPED
                                                     // (tools + tool_choice 'none' would otherwise hit seller TOOLS_UNSUPPORTED)
maxUnitsFor(offer):
  { wire, wireOpts } = wireFor(offer)
  engine   = offer.metering?.basis === 'pinned' ? registry.get(offer.metering.tokenizer.kind, offer.metering.tokenizer.digest) : undefined
  fixed    = engine ? countChatPromptUnits(engine, wire) + countChatToolUnits(engine, wire, wireOpts)
                    : chatPromptUpperBound(wire, wireOpts)           // strict: count ≤ utf8 bytes for every engine
  wanted   = explicitMaxTokens ?? defaultMaxTokens (256)
  slack    = (offer.toolTransport === 'native' && wireOpts.tools?.length && wireOpts.toolChoice !== 'none') ? TOOL_CALL_SLACK_UNITS : 0n
  units    = fixed + wanted + slack
  if (explicitMaxTokens === undefined && units > bucketCap && bucketCap − fixed − slack ≥ 1) units = bucketCap   // clamp only a DEFAULT
  return units          // router rejects 'max-units' when units ≤ 0 or > bucketCap
```

- The payload `max_tokens = decision.maxUnits − fixed(chosen offer) − slack(chosen offer)`.
- The authorization carries `decision.maxUnits` (§8.2).
- **Why the slack.** R4 counts `JSON.stringify(tool_calls)`, which includes
  provider ids and wrapper keys that the upstream's own `max_tokens` does not
  bound. Without slack, a tool call near `max_tokens` fails closed with
  `OVER_MAX_UNITS` after the upstream work is done. The slack is usable only by
  tool calls, because the content cap stays `max_tokens − toolCallUnits`
  (§5.6 step 6).
- **Validate before routing (MUST).** For each candidate offer,
  `parseChatServePayload(JSON.parse(JSON.stringify(payloadFor(offer))))` must
  succeed. Otherwise throw `MarketplaceRequestError` (400) before any
  reservation or quote probe. This covers every seller-side limit: stop
  lengths, `maxBytes` after the prompt transport adds the tool system message,
  and enum ranges.
- **Count exactly what is sent (MUST).** `fixed`, the payload, and the recount
  (§8.3) all use the **same** `wire`/`wireOpts` objects that are serialized
  into the payload. A adds a property test that
  `normalizeChatMessages(JSON.parse(JSON.stringify(m)), {allowParts:false})`
  deep-equals `m` for every normalized `m`. The seller re-normalizes, so any
  non-idempotence would make an honest seller's prompt count differ from the
  buyer's.
- **Unicode.** `normalizeChatMessages` rejects strings that are not
  well-formed UTF-16 (lone surrogates → `invalid_messages`). Upstreams reject
  them, and the engines would see U+FFFD.
- **Memoize.** Memoize `fixed` per `(engine digest | 'upper', transport)`
  within one request. Up to 8 offers are evaluated and most share a pin.
- **Authorization TTL floor for chat.** `expiry = chainNow +
  max(authTtlSeconds, ceil(chatServeTimeoutMs / 1000) + 300)`. A seller checks
  the batching margin at admission, *before* a ≤ 200 s upstream call. A short
  operator TTL would otherwise let the claim expire in the batcher and be
  dropped as a revert.
- For the generic `invoke()` path and the query path, `request.maxUnits` keeps
  its current meaning. The query gateway passes `queryWorstCaseUnits` (§6.3).
- Timeouts:
  - New buyer config `chatServeTimeoutMs` (default 200_000) applies to chat serves.
  - `serveTimeoutMs` keeps applying to everything else. Its default is
    unchanged: the messenger default when unset.

### 8.2 Router changes (A `router.ts`, `types.ts`; additive)

```ts
interface RouteRequest {                                 // existing fields unchanged, plus:
  maxUnitsFor?: (offer: MarketplaceOffer) => bigint;     // per-offer grant; the global max-units early return is skipped when set
  requireApiShape?: 'openai-chat/v1';
  requiresTools?: boolean;                               // tools requested (toolChoice ≠ 'none') or tool history present
  sellerStanding?: ReadonlyMap<string, SellerStanding>;  // keyed by sellerIdentityId decimal; absent = 'trusted'
}
// api-shape is SYMMETRIC: offer.apiShape !== request.requireApiShape (undefined on both sides = equal) → 'api-shape'.
// The generic invoke() therefore never routes a { prompt }/{ sparql } payload to a chat offer, which would refuse
// BAD_PAYLOAD. The buyer's quote-probe prefilter (#probeQuotes) applies the same predicate, so probes are not wasted.
type RouteRejectionReason = /* existing */ | 'max-units' | 'api-shape' | 'tools-unsupported' | 'recount-denied' | 'restricted';
// RouteDecision (ok:true) gains   maxUnits: bigint    (request.maxUnits, or maxUnitsFor(chosen offer))
```

The per-offer evaluation order is the following. The first failing check names the rejection.

1. service-mismatch
2. model-mismatch
3. api-shape: `offer.apiShape !== requireApiShape` (symmetric; both undefined is a pass)
4. tools-unsupported: `requiresTools` and `toolTransport` not `native`/`prompt`
5. offer-expired
6. restricted: `offer.access === 'restricted'` and `policy.sellerAllow` lacks the seller
7. deny-list
8. allow-list
9. recount-denied: standing `denied`
10. max-units (per-offer mode only)
11. no-quote
12. unavailable
13. price-cap
14. capacity: against the per-offer units
15. soft-ceiling: worst case = per-offer units × quoted ask

Preference order:

1. Standing tier: `trusted` before `deprioritized`.
2. Lowest `worstCaseCostWei` (= units × live ask).
3. Lowest live ask.
4. Net delivery score (existing).
5. Lexicographic `sellerPeerId`.

Comparing raw asks across offers that pin different tokenizers is
apples-to-oranges. The per-offer worst case prices the request's own prompt
under each pin. When units are uniform (the generic path), step 2 orders
exactly as the old lowest-ask rule did, so the existing router tests are unchanged.

### 8.3 Recount and seller standing

The RFC fixes the consequence: a receipt that is seller-signed and
buyer-authorized **settles regardless** of what the buyer recounts. The meter
settles `receiptValueWei` exactly as today, and the result is returned to the
caller. Recount drives **local** observations only.

**Verdicts** (A `recount.ts`):

```ts
type RecountVerdict = {
  verdict: 'match' | 'mismatch' | 'unverifiable';
  reason?: 'no-engine' | 'provider-reported' | 'not-metered' | 'tokenizer-drift' | 'template-drift'
         | 'schedule-drift' | 'malformed-result' | 'units-differ' | 'metering-block-differs';
  servedUnits: bigint;                 // receipt
  recountUnits?: bigint;
};
recountChat({ engine, offerMetering, wireMessages, wireOptions, result, receiptServedUnits }): RecountVerdict
recountQuery({ sparql, offerQueryCost, result, receiptServedUnits, schedule? }): RecountVerdict
```

The chat rules, in order:

| Condition | Verdict | Reason |
|---|---|---|
| Result malformed (`parseChatServeResult` fails on a receipt-verified result) | `mismatch` (no `recountUnits`) | `malformed-result` |
| Basis `provider-reported` | `unverifiable` | `provider-reported` |
| Buyer lacks the engine for the pinned digest | `unverifiable` | `no-engine` |
| `result.metering.tokenizer.digest ≠ offer pin` | `mismatch` | `tokenizer-drift` |
| Template digest differs | `mismatch` | `template-drift` |
| `result.metering.servedUnits ≠ receipt.servedUnits` | `mismatch` | `metering-block-differs` |
| `recount = meterChat(engine, {wire, wireOpts, delivered content, delivered tool_calls})` ≠ `receipt.servedUnits` | `mismatch` | `units-differ` |
| Otherwise | `match` | — |

A malformed result counts against the seller, not as `unverifiable`. The seller
was paid for bytes that do not conform to the `apiShape` it advertised. If this
row were `unverifiable`, a dishonest seller could dodge every recount simply by
emitting slightly malformed results. C still surfaces the call as a failure.
The receipt is valid and charged, so C throws `MarketplaceInvokeError('MALFORMED_RESULT', …, 'served')`
after recording the verdict. The same rule applies to a malformed query result
(`parseQueryServeResult` fails).

`wireMessages`/`wireOptions` passed to `recountChat` are the exact objects that
were serialized into the payload (§8.1).

The query rules are the same shape, in order:

- The offer has no `queryCost` group (a pre-schedule seller) → `unverifiable`,
  reason `not-metered`. The result is **not parsed**, so a legacy `{ result }`
  never counts as malformed.
- Offer schedule digest ≠ V1 → `unverifiable`, reason `schedule-drift`.
- `parseQueryServeResult` fails → `mismatch`, reason `malformed-result`.
- Otherwise recount = `admission(sparql) + delivery(countResultRows(result.result))`.
- An aborted result recounts to admission only.

`stub-inference` and other non-pinned payloads return `unverifiable`, reason
`not-metered`, before any parse. The malformed-result rule applies only to
offers that advertise `apiShape` or `queryCost`.

**Standing data and thresholds** (A `SellerStandingBook`; C persists it):

```ts
interface RecountPolicy { window: number; deprioritizeAt: number; denyAt: number; denyCooldownSeconds: number }
DEFAULT_RECOUNT_POLICY = { window: 20, deprioritizeAt: 1, denyAt: 3, denyCooldownSeconds: 86_400 };

interface SellerRecountRecord {
  sellerIdentityId: string;            // decimal
  recounted: number; matches: number; mismatches: number; unverifiable: number;
  overbilledUnits: bigint;             // Σ max(0, served − recount) over mismatches with a recount
  underbilledUnits: bigint;            // Σ max(0, recount − served)
  recent: Array<'match' | 'mismatch'>; // last `window` match/mismatch verdicts, oldest first (unverifiable excluded)
  lastMismatchAt: number | null;       // unix seconds
  lastVerdictAt: number | null;
}
```

The standing function is pure and evaluated at `now`:

```
m = count('mismatch' in recent)
denied        if m ≥ denyAt && lastMismatchAt !== null && now − lastMismatchAt < denyCooldownSeconds
deprioritized else if m ≥ deprioritizeAt
trusted       otherwise (also for unknown sellers)
```

Denial expires through the cool-down because a denied seller gets no calls, so
its window cannot roll. Once the cool-down passes, the seller is still
`deprioritized` until 20 clean recounts push the mismatches out of the window.

**Wiring (C):**

- Every successful invoke records its verdict through
  `book.record(sellerIdentityId, verdict, nowSeconds)`. This covers the generic
  invoke, gateway chat and gateway query.
- The book persists atomically to `<dataDir>/marketplace/seller-standing.json`
  (mode 0600) after each record, and is loaded at runtime start.
- `book.standings(now)` feeds `RouteRequest.sellerStanding`.
- A mismatch logs one warning line, naming `sellerIdentityId`, the units and
  the reason. Never log content.

**Surfaces:**

- `marketplaceMeter()` returns `{ state?, summary?, recount: Array<SellerRecountRecord & { standing }> }`.
- `marketplaceStatus().buyer.recount` is `{ sellers, deprioritized, denied }`.
- Invoke and gateway results carry `recount: RecountVerdict`.
- `marketplaceResetSellerStanding(id)` clears a seller (operator override).

### 8.4 Tool transport at the buyer

| Offer `toolTransport` | Request carries tools or tool history | Buyer behavior |
|---|---|---|
| `native` | yes | Send normalized `tools` / `tool_choice` / `parallel_tool_calls` and messages unchanged. Validate the result's `tool_calls` with `validateToolCallsAgainstOptions` |
| `prompt` | yes | `wire = buildPromptToolTransport(messages, options)`, no tool fields on the wire. On the result, `parsePromptToolTransport(content, options)`. Returned tool calls make `message.content = null` and `finish_reason = 'tool_calls'` |
| `none` / absent | `requiresTools` (tools with `tool_choice ≠ 'none'`, or tool history) | Router rejects `tools-unsupported` |
| `none` / absent | tools present but `tool_choice: 'none'`, no history | Routable. `wireFor` **strips** `tools` / `tool_choice` / `parallel_tool_calls` (§8.1) |
| any | no | Plain messages |

All wire shapes come from `wireFor(offer)` (§8.1). This table describes it.

Recount always uses the seller-delivered result, not the buyer's transformed
message.

If buyer-side tool validation fails on a served result, the call is charged,
because the receipt is valid. C throws `MarketplaceInvalidToolResponseError`
carrying the invoke result. The gateway maps it to 502
`invalid_tool_response` with `charged_wei` (§9.6).

### 8.5 Spend guard hook (C, consumed by D for key budgets)

```ts
export interface MarketplaceSpendGuard {
  /** Once, after routing and BEFORE the plan reservation / authorization signing. Throw to refuse. */
  admit(worstCaseCostWei: bigint): void;
  /** Exactly once iff admit() returned. */
  settle(outcome: { costWei: bigint; servedUnits: bigint; delivery: 'served' | 'not-served' | 'ambiguous' }): void;
}
```

Call order: route → `guard.admit(decision.worstCaseCostWei)` → `plan.meter.reserve` → sign → serve. `settle` runs in a `finally`, once:

| Outcome | `settle(…)` |
|---|---|
| Success | `{receiptValueWei, servedUnits, 'served'}` |
| Receipt verified, then a post-receipt failure (`MarketplaceInvalidToolResponseError`, `MALFORMED_RESULT` from a chat/query parse) | `{receiptValueWei, servedUnits, 'served'}`: the receipt is trusted, so the actual charge is known. This matches the error's `charged_wei = cost` |
| Plan reserve throws, or `not-served` | `{0n, 0n, 'not-served'}` |
| `served` failure before the receipt verified (`BAD_RECEIPT`, `MALFORMED_RECEIPT`, `UNVERIFIABLE_SELLER`, result JSON unparseable) | `{worstCaseCostWei, 0n, 'served'}` |
| `ambiguous` | `{worstCaseCostWei, 0n, 'ambiguous'}` |

- **Admit errors propagate unchanged.** If `admit` throws, C rethrows the same
  error object (no wrapping), calls no `settle`, records no delivery failure
  and no recount, and leaves the plan meter untouched.
- **Settle errors are swallowed.** If `settle` throws, C logs one warning (keyId
  is unknown to C, so it logs the callId only) and swallows the error, so the
  caller still sees the invoke outcome.

The ambiguous case counts the worst case against the key, permanently. That is
a conservative sub-cap. Document it.

## 9. Buyer gateway (D routes over C methods)

### 9.1 Routes

Base: `/api/marketplace/gateway/v1`. An OpenAI SDK `baseURL` of
`http://<host>:<port>/api/marketplace/gateway/v1` works unchanged.

| Method + path | Auth | Agent call |
|---|---|---|
| `GET  …/models` | gateway key | `marketplaceGatewayModels()` filtered by the key's allowlist |
| `POST …/chat/completions` | gateway key + `checkScope({kind:'inference', modelId})` | `marketplaceChatCompletion(input)` |
| `POST …/query` | gateway key + `allowQuery` | `marketplaceGatewayQuery(input)` |
| anything else under the base | gateway key → 404 `unknown_url` (405 for a known path with the wrong method) | — |

### 9.2 Chat request handling (order matters)

1. **Authenticate the key** (§11). Fail → 401. No body is read.
   - The key is taken **only** from `Authorization: Bearer <key>`: scheme
     case-insensitive, exactly one token, surrounding whitespace trimmed.
   - It is never taken from the query string, the body, cookies or
     `x-api-key`. A key-shaped `?api_key=`/`?key=` parameter is ignored, never
     logged, and the request is judged on its header alone.
   - Every response sent before the body is read (401/404/405/429/503) carries
     `Connection: close`. An unread request body must not pin the socket or the
     admission slot.
   - A 401 also carries `WWW-Authenticate: Bearer realm="dkg-marketplace-gateway"`.
2. **Per-key rps.** `SlidingWindowRateLimiter.tryAcquire(keyId, record.scopes.rps, now)`.
   Fail → 429 `rate_limit_exceeded` with `Retry-After: 1`.
3. **Gateway concurrency.** Fewer than `maxConcurrent` (default 16) requests
   may be in flight, else 503 `gateway_busy` with `Retry-After: 1`. Release on response `close`.
4. **Read the body.** Limit `maxBodyBytes` (default 4 MiB) → 413
   `request_too_large`. Bad JSON → 400 `invalid_json`.
5. **Field checks (D):**
   - `model` must be a string.
   - `messages` must be present.
   - `stream` must be a boolean if present.
   - `n` ∉ {undefined, 1} → 400 `unsupported_parameter` (param `n`).
   - `logprobs === true` → same.
   - `response_format` other than absent or `{type:'text'}` → same.
   - `max_tokens ?? max_completion_tokens` must be an integer 1..1_000_000 → else 400 `invalid_parameter`.
   - `temperature` must be finite 0..2; `top_p` 0..1; `seed` a safe integer;
     `stop` a string or ≤ 4 strings.
   - Ignored, never forwarded: `user`, `frequency_penalty`, `presence_penalty`,
     `logit_bias`, `stream_options`, and every unknown field.
6. **Scope (D).** `canonicalModelId(model)` → `ledger.checkScope(record, {kind:'inference', modelId})`.
   Fail → 403 `model_not_allowed`.
7. **Call the agent.** `agent.marketplaceChatCompletion({ model, messages,
   tools, toolChoice: tool_choice, parallelToolCalls: parallel_tool_calls,
   maxTokens, defaultMaxTokens, temperature, topP: top_p, seed, stop, spendGuard })`.
   The spend guard wraps `ledger.reserve(keyId, resId, wei)` /
   `settle` / `release` (§10.3). C normalizes `messages` and tools with
   `allowParts:true` and throws `MarketplaceRequestError` on bad shapes.
8. **Respond** (§9.3 / §9.4). Map errors with the §9.6 table.

`/query` follows the same steps with these differences:

- Body `{ sparql: string, max_rows?: 1..10000 }`.
- Scope check is `allowQuery`.
- Agent call `marketplaceGatewayQuery({ sparql, maxRows, spendGuard })`.

### 9.3 Non-stream responses

Chat:

```json
{ "id": "chatcmpl-<callId without 0x>", "object": "chat.completion", "created": <unix s>, "model": "<canonical>",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…"|null, "tool_calls"?: [ … ] },
                 "finish_reason": "stop"|"length"|"tool_calls", "logprobs": null } ],
  "usage": { "prompt_tokens": n, "completion_tokens": n, "total_tokens": n },
  "system_fingerprint": null,
  "dkg": <DkgCallBlock> }
```

Query:

```json
{ "object": "dkg.query.result", "id": "<callId>", "result": <seller result.result | null>, "row_count": n,
  "aborted": null | { "reason": "timeout"|"row-cap"|"size-cap" },
  "usage": { "admission_units": n, "delivery_units": n, "total_units": n },
  "dkg": <DkgCallBlock> }
```

`DkgCallBlock` is snake_case, and every bigint is a decimal string:

```json
{ "call_id": "0x…", "offering_id": "0x…",
  "seller": { "identity_id": "1", "peer_id": "12D3…", "address": "0x…" },
  "served_units": "22", "ask_per_unit_wei": "500000000000", "cost_wei": "11000000000000",
  "receipt": { "auth_digest": "0x…", "result_commitment": "0x…", "seller_sig": "0x…" },
  "metering": { "basis": "pinned", "tokenizer_kind": "stub-words-v1", "tokenizer_digest": "sha256:…",
                "chat_template": "openai-chat-count/v1", "prompt_units": "17", "tool_units": "0",
                "completion_units": "5", "truncated": false,
                "provider_usage": { "prompt_tokens": 17, "completion_tokens": 5 } },   // query: { schedule_digest, admission_units, delivery_units }
  "recount": { "verdict": "match", "reason": null, "recount_units": "22" },
  "key": { "key_id": "gw_1a2b3c4d", "spent_wei": "…", "remaining_wei": "…" } }
```

### 9.4 Streaming decision: buffered SSE for this phase

**Decision.** `stream: true` is served as **buffered SSE**. The gateway completes
the whole p2p call and verifies the receipt. Only then does it emit the SSE
event sequence. This matches the fork's `sendChatCompletion`.

**Why true end-to-end streaming is out of scope for this phase:**

- `MarketplaceMessenger.sendRequestOwned` is a framed request/response.
  Streaming would need a new duplex libp2p protocol through the router (raw
  `dialProtocol` is banned by audit).
- The receipt commits to `sha256(result bytes)`. A frame-by-frame commitment
  (the fork's `streaming.ts` chain, ported to A as `stream-chain.ts` for that
  phase) would have to be bound into the receipt digest. That is a protocol change.
- The seller would need incremental metering with a hard cutoff at `maxUnits`.

**Event sequence.** Every event is a `data: <json>\n\n` line.

- **Headers:** `content-type: text/event-stream; charset=utf-8`,
  `cache-control: no-cache`, `connection: keep-alive`, `x-accel-buffering: no`,
  plus CORS.
- **Events, in order:**
  1. `{id, object:'chat.completion.chunk', created, model, choices:[{index:0, delta:{role:'assistant', content:''}, finish_reason:null}]}`
  2. If content is non-empty, ONE chunk with `delta:{content:<full content>}`.
  3. If there are tool calls, ONE chunk with `delta:{tool_calls:[{index:i, id, type:'function', function:{name, arguments}}…]}`.
  4. `delta:{}` with `finish_reason`.
  5. A usage chunk `{…, choices:[], usage, dkg}`. It is always sent, as in the
     fork, whether or not `stream_options.include_usage` is set.
  6. `data: [DONE]`.

**Errors.** Every error happens before the first byte, so errors are plain JSON
responses with their HTTP status, never SSE.

**Client disconnect.** A disconnect mid-call does not cancel the p2p call. It
completes, and its charge stands.

### 9.5 `/models`

Built from `marketplaceGatewayModels()`. It covers offers with
`apiShape === 'openai-chat/v1'`, grouped by canonical `modelId`, then filtered
by the key's `modelAllowlist`.

```json
{ "object": "list",
  "data": [ { "id": "stub-chat", "object": "model", "created": 0, "owned_by": "dkg-marketplace",
              "context_length"?: <min advertised contextLength>,
              "dkg": { "offers": 2, "sellers": ["1","3"], "min_ask_per_unit_wei": "500000000000",
                       "metering_bases": ["pinned"], "tokenizer_kinds": ["stub-words-v1"],
                       "provenance_classes": ["upstream-claimed"], "tool_transports": ["native"],
                       "routable": true } } ] }
```

`context_length` is a JSON **number**: discovery already rejects values above
2^53. Every other bigint in `dkg` is a decimal string.

`routable` is true when the active plan has a bucket matching
`{serviceType:'inference', modelId}`. When unsubscribed, the list is still
returned and every model has `routable:false`.

### 9.6 Error objects and mapping

Every gateway error body has this shape:

```json
{ "error": { "message": "…", "type": "<class>", "param": null|"<field>", "code": "<code>",
             "dkg": { "reason"?: "…", "rejections"?: [ {"offerId","reason"} ], "charged_wei": "0", "retryable": bool } } }
```

`charged_wei` is non-zero only for served-but-failed calls and ambiguous holds.
It is **always the `costWei` that this call's spend guard `settle` received**:
D's guard closure records it, and D never infers it from the error code.
`MALFORMED_RESULT` is the case that needs this. Before the receipt verifies,
the charge is the worst case; after it verifies, the charge is the receipt
value (§8.5).

| Condition | HTTP | type | code |
|---|---|---|---|
| Missing, malformed or unknown key, or a node or agent token presented | 401 | authentication_error | `invalid_api_key` |
| Revoked / expired key | 401 | authentication_error | `key_revoked` / `key_expired` |
| rps exceeded | 429 | rate_limit_error | `rate_limit_exceeded` |
| Gateway concurrency cap | 503 | api_error | `gateway_busy` |
| Unknown path / wrong method | 404 / 405 | invalid_request_error | `unknown_url` / `method_not_allowed` |
| Body too large / bad JSON | 413 / 400 | invalid_request_error | `request_too_large` / `invalid_json` |
| `MarketplaceRequestError` | 400 | invalid_request_error | its `code` (`invalid_messages`, `invalid_tools`, `invalid_parameter`, `unsupported_parameter`, `invalid_model`, `invalid_sparql`) with `param` |
| Model not in key allowlist / query not allowed | 403 | permission_error | `model_not_allowed` / `query_not_allowed` |
| `MarketplaceModelNotFoundError` (no chat offer for the model) | 404 | invalid_request_error | `model_not_found` |
| `MarketplaceNotSubscribedError` | 403 | permission_error | `not_subscribed` |
| NO_ROUTE `no-bucket` | 403 | permission_error | `no_plan_bucket` |
| NO_ROUTE `max-units`, or every rejection `max-units` | 400 | invalid_request_error | `max_units_exceeded` (param `max_tokens`) |
| NO_ROUTE where every rejection is `soft-ceiling` | 429 | insufficient_quota | `soft_ceiling` |
| NO_ROUTE `no-offers` | 503 | service_unavailable | `no_offers` |
| NO_ROUTE other `no-eligible-offer` | 503 | service_unavailable | `no_route` (+ `rejections`) |
| `MarketplaceSpendRefusedError` (key budget) | 429 | insufficient_quota | `key_budget_exceeded` |
| Invoke `UNDERFUNDED` | 429 | insufficient_quota | `underfunded` |
| Invoke `CONTEXT_EXCEEDED` | 400 | invalid_request_error | `context_length_exceeded` |
| Invoke `OVER_MAX_UNITS` | 400 | invalid_request_error | `max_units_exceeded` |
| Invoke `BAD_PAYLOAD` / `MODEL_MISMATCH` / `TOOLS_UNSUPPORTED` | 400 | invalid_request_error | `seller_rejected_request` (`dkg.reason` = code) |
| Invoke `UPSTREAM_RATE_LIMITED` | 429 | rate_limit_error | `upstream_rate_limited` |
| Invoke `UPSTREAM_TIMEOUT` | 504 | api_error | `upstream_timeout` |
| Invoke `UPSTREAM_ERROR` / `UPSTREAM_AUTH` / `EXECUTION_FAILED` / `CONNECTOR_UNAVAILABLE` / `SELLER_NOT_READY` / `EMPTY_RESULT` / `METERING_OVERRUN` | 502 | api_error | `upstream_error` (`dkg.reason`) |
| `QueryTooLargeError` surfaced as `MarketplaceRequestError('invalid_sparql')` | 400 | invalid_request_error | `invalid_sparql` (param `sparql`) |
| Invoke `DELIVERY_UNKNOWN` (ambiguous) | 504 | api_error | `delivery_unknown` (`charged_wei` = worst case held) |
| Invoke `BAD_RECEIPT` / `MALFORMED_RECEIPT` / `MALFORMED_RESULT` / `UNVERIFIABLE_SELLER` | 502 | api_error | `bad_receipt` (`charged_wei` = what the guard settled: worst case, or the receipt value for a post-receipt `MALFORMED_RESULT`) |
| Any other seller refusal code (`EXPIRED`, `STALE_AUTHORIZATION`, `REPLAYED_CALL_ID`, `BAD_AUTH`, `WRONG_SELLER`, `BAD_ASK`, `SETTLEMENT_CLOSED`, `UNKNOWN_OFFERING`, `UNSUPPORTED_VERSION`, `MALFORMED_REQUEST`, `WRONG_PAYLOAD_KIND`, `BUYER_NOT_ALLOWED`, `NOT_DELIVERED`) | 502 | api_error | `seller_refused` (`dkg.reason`) |
| `MarketplaceInvalidToolResponseError` | 502 | api_error | `invalid_tool_response` (`charged_wei` = cost) |
| Runtime off (existing `isMarketplaceOff` patterns) | 503 | service_unavailable | `marketplace_unavailable` |
| Anything else | 500 | api_error | `internal_error`. The message is generic; details are logged with callId and keyId only |

D matches errors by `err.name` (the existing pattern in `routes/marketplace.ts`).
It never uses `instanceof` across the package boundary.

## 10. Scoped API keys

### 10.1 Fields (A `GatewayKeyLedger`)

```ts
interface GatewayKeyScopes {
  label: string;                   // display only (≤ 64 chars), never auth
  budgetWei: bigint;               // sub-cap of the plan; > 0
  expiresAt: number | null;        // unix seconds; null = no expiry
  modelAllowlist: string[] | null; // canonical modelIds; null = every model
  allowQuery: boolean;
  rps: number;                     // 1..1000
}
interface GatewayKeyUsage { spentWei: bigint; reservedWei: bigint; calls: number; inferenceCalls: number;
                            queryCalls: number; servedUnits: bigint; lastUsedAt: number | null }
interface GatewayKeyRecord { keyId: string; keyHash: string; scopes: GatewayKeyScopes; mintedAt: number;
                             revokedAt: number | null; usage: GatewayKeyUsage }
```

### 10.2 Storage (D `marketplace-gateway-key-store.ts` over A's ledger)

- **File:** `<dkgDir>/marketplace/gateway-keys.json`, mode 0600. The directory
  is created with mode 0700 if absent. Written atomically
  (`daemon/atomic-write.ts` `writeFileAtomicWith`) after every mint, revoke and
  settle. Loaded once at daemon start. Two properties of that helper need care:
  - **Mode.** It takes an `io` whose `writeFile(path, data)` has no mode
    argument. D's `io.writeFile` must pass `{ mode: 0o600 }`, and D chmods the
    final file to 0600 after the rename.
  - **Serialized writes (MUST).** The helper's tmp name is
    `${path}.tmp.${pid}.${Date.now().toString(36)}`, so two writes in the same
    millisecond collide on one tmp file, and unordered async writes can land an
    older snapshot last. All writes go through one per-store queue: at most one
    write in flight, and at most one pending write that serializes the
    *latest* ledger state when it starts.
- **Mint is durable before it returns.** `mint` resolves only after its write
  completed. A plaintext is never returned for a key that a crash could forget.
  A `keyId` that collides with an existing record is re-drawn.
- **Malformed file: fail closed, keep booting.** At start the store records the
  error and logs it once, naming the file. The daemon still boots.
  - Every gateway path answers 503 `marketplace_unavailable`.
  - The key admin routes answer 500 with the file path and parse error.
  - Mint refuses.
  - The file is never overwritten. The operator fixes or removes it, then restarts.
- **Content:** `GatewayKeyLedgerJson = { version: 1, keys: [...] }`. Bigints are
  decimal strings. `reservedWei` and reservations are **not persisted**: they
  are in-flight state.
- **Hashed at rest.** `keyHash = 'sha256:' + sha256hex(plaintext)`. The
  plaintext is returned exactly once, by mint, and never stored or logged.
- **Lookup (order is normative):**
  1. Match the §3.1 regex.
  2. Find the record by `keyId`.
  3. Compare `timingSafeEqual(sha256(presented), storedHashBytes)`. For an
     unknown `keyId`, compare against a fixed dummy hash, so both paths hash
     and compare.
  4. **Only after the hash matches**, check revoked → `key_revoked`, then
     expired → `key_expired`.

  Any failure in steps 1–3 is `invalid_api_key`. The distinct revoked/expired
  codes are therefore only ever shown to a holder of the correct secret, and a
  prober cannot enumerate which `keyId`s exist or were revoked.
- **Singleton:** `openGatewayKeyStore(dir)` caches one store per path, so the
  gateway dispatch and the key admin routes share in-memory state. That makes
  revocation effective on the **next call**. Calls already in flight complete.

### 10.3 Admission and accounting relative to the plan

- **Key spend is plan spend.** Gateway calls go through the buyer's plan meter
  like any invoke. The key budget is an additional sub-cap:
  `remaining = budgetWei − spentWei − reservedWei`.
- **Admit.** `spendGuard.admit(worstCaseCostWei)` →
  `ledger.reserve(keyId, resId, worstCaseCostWei)`. If
  `worstCaseCostWei > remaining` → throw
  `MarketplaceSpendRefusedError('key_budget_exceeded')`. Nothing is reserved on the plan meter.
- **Settle (`served`/`ambiguous`).**
  `ledger.settle(resId, {costWei, servedUnits, kind}, now)`:
  - `spentWei += costWei`, `calls += 1`, `inferenceCalls|queryCalls += 1`;
  - `servedUnits += units`, `lastUsedAt = now`;
  - release the reservation.
- **Settle (`not-served`).** `ledger.release(resId)`. No usage change.
- **Conservation invariant (tested in A).** For a ledger driven only through
  reserve and settle/release: `Σ_keys usage.spentWei == Σ settled costWei`, and
  `reservedWei` returns to 0 once every reservation resolves.
- The node-admin `/api/marketplace/invoke` rail does not use keys. It is
  unchanged.

### 10.4 Admin routes (D; node-admin token; NOT under the gateway prefix)

| Route | Body / response |
|---|---|
| `GET /api/marketplace/keys` | `{ keys: PublicGatewayKeyRecord[] }`. Records exclude `keyHash`; bigints are strings |
| `POST /api/marketplace/keys` | body `{ label?, budgetWei? \| budgetTrac?, expiresAt? (unix s) \| expiresInSeconds?, modelAllowlist?: string[] \| null, allowQuery?: boolean (default true), rps?: number (default 5) }`. Exactly one budget field is required. Each allowlist entry must canonicalize. → 201 `{ key: "<plaintext>", record: PublicGatewayKeyRecord }` |
| `POST /api/marketplace/keys/:keyId/revoke` | → 200 `{ keyId, revokedAt }`. Unknown → 404. Already revoked → 200 with the original `revokedAt` (idempotent) |

## 11. Daemon auth carve-out

### 11.1 How the daemon authenticates today

Request pipeline (`packages/cli/src/daemon/lifecycle.ts`, `createServer` callback, ≈ lines 3390–3560):

1. Parse URL. Resolve the CORS origin (`resolveCorsOrigin`).
2. Per-IP rate limit (`HttpRateLimiter`; loopback bypass via `shouldBypassRateLimitForLoopbackTraffic`).
3. Admission control (`admitRequest` / `InFlightLimiter`).
4. `OPTIONS` preflight → 204, or 403 for a disallowed origin.
5. **`authenticateHttpRequest`** (`packages/cli/src/auth.ts`):
   - Calls `evaluateHttpCredential`, which reads the bearer from `Authorization`.
   - Disabled auth → mode `disabled`.
   - `isPublicPath` (`PUBLIC_GET_PATHS` / `PUBLIC_GET_PREFIXES` / `PUBLIC_HEAD_PATHS`) → mode `public`.
   - Otherwise the token must be in `validTokens`, or be the `?token=` on `/api/events` only.
   - Also handles the signed-request scheme (`x-dkg-timestamp` / `x-dkg-nonce` / `x-dkg-signature`).
   - Returns 401 itself on failure.
   - Classifies the accepted token through `createAllowedHttpAuthentication` +
     `resolveAgentByToken` into principal `nodeOperator` | `agent` | `anonymous`.
6. Post-auth surfaces: the rpc-usage snapshot, `/api/apps` 410, the `/api/events`
   SSE, the shared-memory TTL routes, and `handleNodeUIRequest` (node-UI static
   files + API).
7. `handleRequest` (`daemon/handle-request.ts`) builds the `RequestActor`
   (`routes/context.ts createRequestActor`), runs the route modules in order
   (including `handleMarketplaceRoutes`), then route plugins, then 404.

Within routes, `canAdministerNode(authentication)` is true for disabled auth or
the `nodeOperator` principal. That is what `requireNodeAdmin` checks in
`routes/marketplace.ts`.

### 11.2 Design: one explicit path prefix, one handler, before step 5

Add `packages/cli/src/daemon/marketplace-gateway-dispatch.ts` (D):

```ts
export const MARKETPLACE_GATEWAY_BASE_PATH = '/api/marketplace/gateway/v1';
/** Exact base or a subpath of it. Operates on the WHATWG-parsed pathname (dot segments already resolved). */
export function isMarketplaceGatewayPath(pathname: string): boolean {
  return pathname === MARKETPLACE_GATEWAY_BASE_PATH || pathname.startsWith(`${MARKETPLACE_GATEWAY_BASE_PATH}/`);
}
export interface MarketplaceGatewayDispatch {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, corsOrigin: string | null): Promise<void>; // never throws; always ends res
}
/** undefined ⇔ gateway disabled (marketplace off, or marketplace.buyer.gateway.enabled === false). */
export function createMarketplaceGatewayDispatch(input: {
  agent: DKGAgent; gateway: ResolvedMarketplaceGatewayConfig | undefined; dataDir: string; log: (line: string) => void;
}): MarketplaceGatewayDispatch | undefined;
```

`lifecycle.ts` changes, in two places and at most 15 lines in total:

1. Build the dispatch once, after the agent exists:
   `const marketplaceGateway = createMarketplaceGatewayDispatch({ agent, gateway: resolveMarketplaceGatewayConfig(config.marketplace), dataDir: dkgDir(), log })`.
2. In the request callback, **immediately after the OPTIONS block and before
   `authenticateHttpRequest`**:

```ts
      // OT-RFC-27 buyer gateway — the ONLY pre-auth carve-out: requests under
      // /api/marketplace/gateway/v1 authenticate by a scoped gateway key inside
      // the dedicated handler and NEVER reach the token-authenticated surfaces.
      if (marketplaceGateway && isMarketplaceGatewayPath(reqUrl.pathname)) {
        await marketplaceGateway.handle(req, res, reqUrl, reqCorsOrigin);
        return;
      }
```

**Gateway enablement.** It is on by default when `marketplace.enabled`, and
off with `marketplace.buyer.gateway.enabled: false` or
`DKG_MARKETPLACE_GATEWAY_ENABLED=0`. The surface is inert without keys: every
request is 401 until a node admin mints one.

**When disabled**, the dispatch is `undefined`. The prefix then falls through to
normal token auth, and `handleMarketplaceRoutes` answers 404 with
`{ error: 'marketplace gateway is disabled on this node' }` for any path under
the prefix. This is defense in depth: no other route module may claim it.

**No `auth.ts` change** (it is at budget, and it is not needed). Gateway keys
are never added to `validTokens`.

### 11.3 Security invariants (each pinned by a test, §15.4)

- **S1 Narrow match.** Only a WHATWG pathname equal to the base or starting
  with `base + '/'` takes the carve-out. Not carved out:
  - case variants;
  - `/api/marketplace/gateway/v10`;
  - `/api/marketplace/gateway/v1x/…`;
  - `/api/marketplace/gateway`;
  - every other path.

  Percent-encoded separators stay encoded in the pathname. A subpath like
  `…/v1/chat%2F..%2F..%2Fstatus` lands **in** the gateway handler and is 404
  after key auth. It never reaches another route.

  Dot segments are resolved before the match, and both outcomes are safe:
  `…/v1/../../status` and `…/v1/%2e%2e/%2e%2e/status` both normalize to
  `/api/marketplace/status` and take normal token auth. A leading `//api/…`
  parses as host `api` with pathname `/marketplace/…`, so it is not carved out.
- **S2 Sole owner.** A carved-out request is handled only by
  `MarketplaceGatewayDispatch.handle`, which always ends the response (500 JSON
  on an internal error). It never calls any of these:
  - `authenticateHttpRequest`
  - `handleRequest` or any route module
  - `handleNodeUIRequest`
  - route plugins
  - the SSE / apps / TTL handlers

  It builds no `RequestActor` and no `AllowedHttpAuthentication`.
- **S3 Key first.** Except `OPTIONS` (generic preflight, no data), every
  carved-out request is rejected 401 unless it carries a valid, unrevoked,
  unexpired gateway key. The check happens **before** reading the body and
  **before** any agent call. Unknown subpaths are 404 only **after** key
  verification, so the route table cannot be enumerated without a key.
- **S4 Keys authenticate nothing else.** A gateway key on any other path is
  evaluated by the unchanged `authenticateHttpRequest` and is 401, because it is
  not in `validTokens`. That includes the key admin routes, `/api/marketplace/*`
  and `/api/query`.
- **S5 Node tokens do not spend through the gateway.** The node-operator token
  and agent tokens presented on gateway paths are 401 `invalid_api_key`. There
  is no implicit operator key (the fork's `gatewayOperatorImplicitKey` defaults
  false and is not ported). The node admin spends through `/api/marketplace/invoke`.
- **S6 Auth disabled does not open spend.** With `auth.enabled = false` the
  gateway still requires a key.
- **S7 Key admin needs node-admin.** Mint, list and revoke live under
  `/api/marketplace/keys…`, outside the prefix, behind `requireNodeAdmin`.
- **S8 Secrets never leak.** Plaintext keys appear only in the mint response.
  `keyHash` is never returned. `Authorization` headers, prompts and completions
  are never logged. Logs carry `keyId` and `callId` only.
- **S9 Existing gates still apply.** Rate limiting and admission control run
  before the carve-out, as for every request, plus per-key rps and the gateway
  concurrency cap. Loopback clients bypass the per-IP limiter for every
  `/api/` path, the gateway included. Brute force stays infeasible: the secret
  part has 256 bits.
- **S10 Header-only credential.** The key is read only from
  `Authorization: Bearer` (§9.2). Browsers never attach that header
  cross-site on their own, and no cookie, query or body credential exists, so
  cross-site requests (CSRF) and DNS rebinding cannot spend without the
  plaintext key. CORS headers on gateway responses come from the existing
  allowlist (`resolveCorsOrigin`), which defaults to loopback origins.
- **S11 No key-state oracle.** `key_revoked` / `key_expired` are returned only
  after the presented secret's hash matched (§10.2). Every other failure is
  `invalid_api_key`, with the same shape and the same hash-and-compare work.

## 12. Operator config reference (D parses; JSON wei amounts as decimal strings)

```jsonc
"marketplace": {
  "enabled": true,
  "seller": {
    "offerings": [
      { "offeringLocalId": "devnet-chat", "serviceType": "inference", "unit": "token", "modelId": "stub-chat",
        "askPerUnitWei": "500000000000", "executor": "chat-connector",
        "connector": { "kind": "openai-compatible", "baseUrl": "http://127.0.0.1:18080/v1", "upstreamModel": "stub-chat",
                       "secretEnvFile": "/abs/.devnet/node1/marketplace/.secrets/llm-stub.env", "toolTransport": "native",
                       "maxTokensField": "max_tokens", "timeoutMs": 120000 },
        "metering": { "tokenizer": { "kind": "stub-words-v1" } },
        "model": { "displayName": "Stub Chat", "contextLength": "32768" },
        "allowedBuyers": [] }
    ],
    "queryGuards": { "timeoutMs": 10000, "maxRows": 10000 }
  },
  "buyer": {
    "chatServeTimeoutMs": 200000,
    "tokenizers": [ { "kind": "hf-bpe-v1", "path": "/abs/qwen2.5/tokenizer.json" },
                    { "kind": "tiktoken-o200k-v1", "path": "/abs/o200k_base.tiktoken" } ],
    "recountPolicy": { "window": 20, "deprioritizeAt": 1, "denyAt": 3, "denyCooldownSeconds": 86400 },
    "gateway": { "enabled": true, "defaultMaxTokens": 256, "maxBodyBytes": 4194304, "maxConcurrent": 16 }
  }
}
```

**Agent config additions** (C, `DKGAgentMarketplaceConfig`):

- `seller.queryGuards?: { timeoutMs?: number; maxRows?: number }`
- `buyer.chatServeTimeoutMs?: number`
- `buyer.tokenizers?: Array<{ kind: TokenizerKind; path: string }>`. Loaded
  lazily on first use, digest-indexed. A load failure logs once and skips that file.
- `buyer.recountPolicy?: Partial<RecountPolicy>`

**Daemon-only** (D): `buyer.gateway`, resolved by
`resolveMarketplaceGatewayConfig(cfg, env) → ResolvedMarketplaceGatewayConfig | undefined`.
`defaultMaxTokens` is passed to the agent on each call.

**Env.** `DKG_MARKETPLACE_GATEWAY_ENABLED` follows the existing
`resolveBooleanEnvOverride` rule.

## 13. Devnet

### 13.1 `devnet/marketplace-rfc27/llm-stub.mjs` (B)

**Port the fork file verbatim**, with these renames:

- `owned_by: 'dkg-devnet-stub'`
- the header comment re-pointed at this repo's connector

Keep exactly:

- Exports: `createLlmStub`, `stubReply`, `stubUsage`, `words`, `DEFAULT_PORT = 18080`,
  `DEFAULT_MODEL = 'stub-chat'`, `PER_MESSAGE_TOKENS = 3`, `PER_REPLY_PRIMER_TOKENS = 3`.
- Routes: `GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`
  (JSON, or SSE when `stream:true`).
- Auth: any bearer, unless `LLM_STUB_ALLOW_ANON=1`. A pinned key via `LLM_STUB_API_KEY`.
- `state.lastAuthorization`.
- Loopback bind.
- Env `LLM_STUB_PORT`, `LLM_STUB_MODEL`.
- Graceful SIGINT/SIGTERM.
- `listen(0)` yields an ephemeral port and resolves the real one.

**Additions**, all documented in the header comment:

1. **Deterministic tool calls.** When `body.tools` is a non-empty array AND
   (`tool_choice === 'required'` OR `tool_choice` is
   `{type:'function',function:{name}}`), reply with:
   - `message:{role:'assistant', content:null, tool_calls:[{ id:'call_stub_' + sha256(JSON.stringify(messages)+'|'+name).hex.slice(0,16), type:'function', function:{ name, arguments: JSON.stringify({ echo: words(lastUser).length }) } }]}`
   - `name` is the named function, else `tools[0].function.name`.
   - `finish_reason:'tool_calls'`.
   - `usage.completion_tokens = words(JSON.stringify(tool_calls)).length`.
   - `prompt_tokens` keeps the original formula (tools are not counted).
   - Any other `tool_choice` gives the normal text reply.
2. **Test seams** parsed from the last user message's leading tokens:
   - `__stub_delay_ms=<n>__`: sleep `min(n, 60000)` ms before replying.
   - `__stub_status=<code>__`: for codes 400–599, respond with that status and
     `{error:{message:'stub forced status <code>', type:'stub_error'}}`.

   Seam tokens are stripped from the text used for `stubReply`. `stubUsage`
   still counts the raw messages, so usage stays equal to the seller's pinned
   count of what it sent.

**Root `package.json`:** add
`"devnet:marketplace:llm-stub": "node devnet/marketplace-rfc27/llm-stub.mjs"`
next to the other `devnet:marketplace:*` scripts. This is B's only root change.

### 13.2 Seed (E, `console/seed.mjs`)

- Keep the existing offerings exactly. **Add** `devnet-chat`:
  - Seller A at ask `500000000000`. Seller B at ask `800000000000`.
  - `modelId 'stub-chat'`, connector `openai-compatible` → the stub,
    `toolTransport 'native'`, `metering.tokenizer.kind 'stub-words-v1'`.
- Write `.devnet/node<n>/marketplace/.secrets/llm-stub.env` (mode 0600, dir
  0700) with `OPENAI_API_KEY=devnet-stub-key`. Use absolute paths in the
  connector config.
- Probe `http://127.0.0.1:${LLM_STUB_PORT ?? 18080}/healthz`. If it is down,
  print `run: LLM_STUB_API_KEY=devnet-stub-key pnpm devnet:marketplace:llm-stub`
  and still seed. Mount does not call upstream.
- Optionally mint a buyer gateway key (flag `--mint-key`) and print the curl
  snippet. The plaintext is printed once.

### 13.3 e2e additions (E, `automated.test.ts`)

**Keep the existing 9 steps.** Required adjustments for the new query schedule:

- **Step 4.** The query probe now meters `admission 3 + delivery(0|1)`, so
  servedUnits ∈ [3, 4]. Replace `≥ 11n` with `∈ [3n, 4n]` and update the comments.
- **Drill arithmetic.** The combined actuals are now ≥ `2.5e14 + 3·1.5e13 +
  6.4e14 = 9.35e14`. Set `SUB3_WEI = 20_000_000_000_000n` (2e13), which makes
  the final funded total `9.2e14 < 9.35e14`, so the over-claim still holds.
  Update `FUNDED_TOTAL_WEI` comments. Step 7's local policy budget is
  independent of `SUB3_WEI`.

**Expected interim breakage.** Between C's push and E's push, step 4 fails. E owns that fix.

**Add a second `describe('… buyer gateway (devnet e2e)')`** in the same file,
after the existing describe. Helpers go in a new
`devnet/marketplace-rfc27/gateway-helpers.ts` (fetch with a custom
`Authorization`, an SSE parser, OpenAI error assertions).

The describe is self-sufficient: its own `beforeAll` runs `detectDevnet` and
resolves nodes and tokens, so `-t gateway` runs alone on a seeded devnet.
`beforeAll` also:

- starts the stub in-process (`createLlmStub({ apiKey: 'devnet-stub-key' }).listen(0, '127.0.0.1')`);
- writes the secret files;
- is closed by `afterAll`.

| Step | Assertions |
|---|---|
| G1 publish | A: `[devnet-llm, devnet-knowledge, devnet-chat(→ stub port)]`. B: `[devnet-llm, devnet-chat]`. Publish assets show `devnet-chat` published, the others unchanged (or `devnet-knowledge` published once for its new schedule fields) |
| G2 discover | Poll `/api/marketplace/offers` until two offers have `modelId 'stub-chat'`, `apiShape 'openai-chat/v1'`, `metering.basis 'pinned'` and the stub-words digest |
| G3 subscribe | Current epoch (post-warp), `amountWei 2e15`. Policy `totalBudgetWei 2e15`, buckets: `[{inference, modelId 'stub-chat', budget 1e15, cap 1e12, maxUnitsPerCall 4000}, {query, budget 5e14, cap 2e13, maxUnitsPerCall 200}]` |
| G4 mint | `POST /api/marketplace/keys` `{label:'e2e', budgetWei:'1000000000000000', modelAllowlist:['stub-chat'], allowQuery:true, rps:5}` → 201. The plaintext matches §3.1. The list shows the key without hash or plaintext |
| G5 models | With the key → `stub-chat` present, `dkg.offers 2`, `routable true`. With no auth → 401 `invalid_api_key`. With the node token → 401 (S5) |
| G6 chat | GV-2 messages → 200. Content `STUB:WORLD MARKETPLACE HELLO :: ok`. Usage `{17,5,22}`. `dkg.seller.identity_id = A` (cheaper). `dkg.metering.provider_usage = {17,5}`. `dkg.recount.verdict 'match'`. `cost_wei = 22·5e11`. The receipt signature recovers (reuse `receiptDigest`). `stub.state.lastAuthorization === 'Bearer devnet-stub-key'`. Key `spent_wei` = cost |
| G7 stream | Same request with `stream:true`: SSE events per §9.4, concatenated deltas = G6 content, a usage chunk present, then `[DONE]` |
| G8 truncation | `max_tokens: 3` → content `STUB:WORLD MARKETPLACE HELLO`, finish `length`, usage `{17,3,20}` |
| G9 tools | `tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}], tool_choice:'required'` → finish `tool_calls`, `tool_calls[0].function.name 'lookup'`, recount `match` |
| G10 query | `/query` with `{sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5', max_rows: 100}` → 200, `usage.admission_units 3`, `total_units ∈ {3,4}`, recount `match` |
| G11 budget refusal | Mint a key with `budgetWei '10000000000000'` (1e13 < worst case 273·5e11). Chat → 429 `key_budget_exceeded`. The buyer meter `totalReservedWei` is unchanged |
| G12 scopes | A key with `allowQuery:false` → `/query` 403 `query_not_allowed`. A key with allowlist `['other-model']` → chat 403 `model_not_allowed` |
| G13 carve-out live | Gateway key on `GET /api/marketplace/status` → 401. Gateway key on `POST /api/marketplace/keys` → 401. Unknown `…/v1/keys` with a valid key → 404 |
| G14 revoke | Revoke the G4 key → the next chat is 401 `key_revoked` |
| G15 claims | Read `getSellerClaim(buyer, epoch, A).claimed` in G3 (before any gateway call). After `settle {action:'flush-receipts'}` on A, the **delta** equals Σ the A gateway costs from G6–G10. Asserting the delta keeps the step correct on re-runs within one epoch |

Also add `devnet/marketplace-rfc27/llm-stub.test.mjs` (`node:test`; routed by
the existing `devnet/**` inventory route). It asserts GV-2..GV-5 against
`stubReply` / `stubUsage`, SSE framing, the tool-call reply, the seams, and the
bearer enforcement.

### 13.4 Console (E, minimal)

- **Buyer view**, a "Gateway" panel:
  - lists keys (`GET /node/<n>/api/marketplace/keys`), and mints and revokes
    them (node token injected server-side, as today);
  - shows the minted plaintext once, with a copy button;
  - renders a curl snippet and an OpenAI SDK snippet, with `baseURL =
    http://127.0.0.1:<apiPort>/api/marketplace/gateway/v1` and
    `<key>` filled in only right after mint;
  - has a "Try chat" form that posts through the console proxy.
- **Proxy rule** (`server.mjs`). For paths under
  `/node/<n>/api/marketplace/gateway/v1/`, forward the **browser's**
  `Authorization` header and **never inject the node token**. All other proxied
  paths are unchanged.
  - The existing `checkMutationOrigin` and loopback-Host guard still apply.
  - Gateway paths use a proxy timeout ≥ 210 s. Today's `PROXY_TIMEOUT_MS` is
    180 s, below the 200 s chat serve timeout.
  - A key mint answers **201**. `rememberMutation` records 200s only, and it
    must never persist a mint response: that response holds the plaintext key.
- **Seller view.** Show `GET /node/<n>/api/marketplace/seller/connectors`
  (state, origin, metering pin).
- **README.** Document the llm-stub script, the secret files, key minting, and
  the curl snippet.

## 14. Work split

### 14.1 Order

```
A (marketplace domain) ─┐
B (llm-stub)           ─┼─► C (agent) ─► D (cli) ─► E (devnet)
```

A and B run in parallel first. C starts after A is pushed, D after C, and E after D.

### 14.2 Exclusive file ownership

| Slice | Owns (create/modify) | Must not touch |
|---|---|---|
| **A** | `packages/marketplace/src/**` (new: `chat-messages.ts`, `token-engines.ts`, `chat-metering.ts`, `query-cost.ts`, `serve-wire.ts`, `recount.ts`, `gateway-keys.ts`, `model-id.ts`, `stream-chain.ts`; modified: `types.ts`, `router.ts`, `metering.ts` (only `@deprecated` on `queryUnits`), `index.ts`), `packages/marketplace/test/**` (incl. `test/fixtures/**`), `packages/marketplace/README.md` | everything else |
| **B** | `devnet/marketplace-rfc27/llm-stub.mjs`, root `package.json` (the one script line) | everything else |
| **C** | `packages/agent/src/marketplace/**` (incl. new `connectors/**`, `chat-executor.ts`, `buyer-chat.ts`, `tokenizer-files.ts`, `seller-standing-store.ts`, `gateway-domain.ts` (§14.3.3), optional `offer-rdf.ts`), `packages/agent/src/dkg-agent-marketplace.ts`, `packages/agent/src/index.ts` (marketplace export block only; it is 713/800 lines, so add one `export * from './marketplace/gateway-domain.js'` plus the few new runtime names, not a long list), `packages/agent/test/marketplace-*.test.ts` (existing + new) | `dkg-agent.ts`, `dkg-agent-types.ts`, `dkg-agent-lifecycle.ts`, `packages/core/**`, `packages/marketplace/**` |
| **D** | `packages/cli/src/marketplace-config.ts`, new `packages/cli/src/marketplace-connector-config.ts`, new `packages/cli/src/marketplace-gateway-key-store.ts`, new `packages/cli/src/marketplace-codex-oauth-flow.ts`, new `packages/cli/src/daemon/marketplace-gateway-dispatch.ts`, new `packages/cli/src/daemon/routes/marketplace-gateway.ts` (+ optional `marketplace-gateway-errors.ts`, `routes/marketplace-keys.ts`), `packages/cli/src/daemon/routes/marketplace.ts`, `packages/cli/src/daemon/lifecycle.ts` (≤ 15 lines: dispatch build + carve-out), `packages/cli/src/api-client-marketplace.ts`, `packages/cli/src/commands/marketplace.ts`, `packages/cli/test/*marketplace*` (existing + new). New node-admin route modules (`routes/marketplace-keys.ts` etc.) are **called from `handleMarketplaceRoutes`**: `handle-request.ts` is not touched, and it already dispatches every `/api/marketplace*` path there | `auth.ts`, `config.ts`, `api-client.ts`, `handle-request.ts`, every non-marketplace route |
| **E** | `devnet/marketplace-rfc27/automated.test.ts`, new `devnet/marketplace-rfc27/gateway-helpers.ts`, new `devnet/marketplace-rfc27/llm-stub.test.mjs`, `devnet/marketplace-rfc27/vitest.config.ts` (only if needed), `devnet/marketplace-rfc27/console/**` | `llm-stub.mjs` (report stub defects to B or the orchestrator), packages |

Shared files that nobody may edit: `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`devnet/suites.json`, `scripts/**` (including `scripts/devnet.sh`: the gateway is
default-on when marketplace is enabled, so no devnet config change is needed),
and `packages/core/**`.

### 14.3 Interface contracts

#### 14.3.1 A → C, D (exported from `@origintrail-official/dkg-marketplace`)

```ts
// model-id.ts
export const MODEL_ID_PATTERN: RegExp;
export function canonicalModelId(raw: unknown): string | undefined;
export function inferModelFamily(modelId: string): string | undefined;
export type ModelProvenanceClass = 'weights-pinned' | 'upstream-claimed' | 'stub';

// token-engines.ts
export const TOKENIZER_KINDS: readonly ['hf-bpe-v1', 'tiktoken-o200k-v1', 'stub-words-v1'];
export type TokenizerKind = (typeof TOKENIZER_KINDS)[number];
export function isTokenizerKind(v: unknown): v is TokenizerKind;
export const SHA256_DIGEST_PATTERN: RegExp;            // /^sha256:[0-9a-f]{64}$/
export const STUB_WORDS_DIGEST: string;
export function sha256Digest(bytes: Uint8Array | string): string;
export interface TokenCountEngine { readonly kind: TokenizerKind; readonly digest: string; encodeCount(text: string): number }
export function createHfBpeEngine(tokenizerJson: Uint8Array): TokenCountEngine;
export function createTiktokenO200kEngine(rankFile: Uint8Array): TokenCountEngine;
export function createStubWordsEngine(): TokenCountEngine;
export function createTokenCountEngine(kind: TokenizerKind, fileBytes?: Uint8Array): TokenCountEngine; // throws when a file kind lacks bytes
export class TokenizerRegistry { constructor(); register(engine: TokenCountEngine): void; get(kind: TokenizerKind, digest: string): TokenCountEngine | undefined }

// chat-messages.ts  (fork subs/messages.ts; codes renamed)
export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage { role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: ChatToolCall[] }
export interface ChatTool { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } }
export type ChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
export interface ChatToolOptions { tools?: ChatTool[]; toolChoice?: ChatToolChoice; parallelToolCalls?: boolean }
export function normalizeChatMessages(raw: unknown, opts?: { maxMessages?: number; maxBytes?: number; allowParts?: boolean }):
  { ok: true; messages: ChatMessage[] } | { ok: false; code: 'invalid_messages'; detail: string };
export function normalizeChatTools(raw: unknown): { ok: true; tools?: ChatTool[] } | { ok: false; code: 'invalid_tools'; detail: string };
export function normalizeChatToolChoice(raw: unknown): { ok: true; toolChoice?: ChatToolChoice } | { ok: false; code: 'invalid_tools'; detail: string };
export function normalizeToolCalls(raw: unknown, label?: string): { ok: true; value: ChatToolCall[] } | { ok: false; detail: string };
export function validateToolCallsAgainstOptions(calls: ChatToolCall[] | undefined, options: ChatToolOptions, label?: string): { ok: true } | { ok: false; detail: string };
export function hasToolHistory(messages: readonly ChatMessage[]): boolean;
export function buildPromptToolTransport(messages: ChatMessage[], options: ChatToolOptions): ChatMessage[];
export function parsePromptToolTransport(text: string, options: ChatToolOptions): { ok: true; toolCalls?: ChatToolCall[] } | { ok: false; detail: string };

// chat-metering.ts
export interface ChatTemplate { readonly version: 'openai-chat-count/v1'; readonly perMessageTokens: number; readonly perReplyPrimerTokens: number }
export const CHAT_TEMPLATE_OPENAI_COUNT_V1: ChatTemplate;
export const CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST: string;
export function chatTemplateDigest(t: ChatTemplate): string;
export function toolEnvelopeText(messages: readonly ChatMessage[], options: ChatToolOptions): string;
export function countChatPromptUnits(engine: TokenCountEngine, messages: readonly ChatMessage[], template?: ChatTemplate): bigint;
export function countChatToolUnits(engine: TokenCountEngine, messages: readonly ChatMessage[], options: ChatToolOptions): bigint;
export function countChatCompletionUnits(engine: TokenCountEngine, content: string | null, toolCalls?: readonly ChatToolCall[]): bigint;
export interface ChatUnitBreakdown { promptUnits: bigint; toolUnits: bigint; completionUnits: bigint; servedUnits: bigint }
export function meterChat(engine: TokenCountEngine, input: { messages: readonly ChatMessage[]; options: ChatToolOptions;
  content: string | null; toolCalls?: readonly ChatToolCall[]; template?: ChatTemplate }): ChatUnitBreakdown;
export function chatPromptUpperBound(messages: readonly ChatMessage[], options: ChatToolOptions, template?: ChatTemplate): bigint; // GV-6 formula
export function boundCompletion(engine: Pick<TokenCountEngine, 'encodeCount'>, text: string, maxUnits: bigint): { text: string; truncated: boolean };
export const TOOL_CALL_SLACK_UNITS: bigint;             // 128n (§8.1)

// query-cost.ts
export interface QueryCostSchedule { readonly version: 'dkg-mkt-query-cost/1'; readonly base: number; readonly perTriplePattern: number;
  readonly perJoinVar: number; readonly perPropertyPath: number; readonly perOptionalOrUnion: number; readonly perFilter: number;
  readonly perAggregation: number; readonly missingLimitSurcharge: number; readonly rowsPerDeliveryUnit: number }
export const QUERY_COST_SCHEDULE_V1: QueryCostSchedule;
export const QUERY_COST_SCHEDULE_V1_DIGEST: string;
export function queryCostScheduleDigest(s: QueryCostSchedule): string;
export interface QueryComplexity { triplePatterns: number; joinVars: number; propertyPaths: number; optionalsAndUnions: number;
  filters: number; aggregations: number; hasLimit: boolean }
export function analyzeQuery(sparql: string): QueryComplexity;
export function queryAdmissionUnits(sparql: string, s?: QueryCostSchedule): bigint;
export function queryDeliveryUnits(rows: bigint | number, s?: QueryCostSchedule): bigint;
export function queryWorstCaseUnits(sparql: string, maxRows: bigint | number, s?: QueryCostSchedule): bigint;
export function queryRowCap(sparql: string, maxUnits: bigint, guardMaxRows: bigint | number, s?: QueryCostSchedule):
  { admit: false } | { admit: true; admissionUnits: bigint; rowCap: bigint };
export interface QueryGuards { timeoutMs: number; maxRows: number }
export const DEFAULT_QUERY_GUARDS: QueryGuards;
export function countResultRows(result: unknown): number;
export const QUERY_MAX_SPARQL_BYTES: 8192;
export class QueryTooLargeError extends Error { readonly name: 'QueryTooLargeError'; readonly bytes: number }
export function assertQueryWithinLimit(sparql: string): void;   // analyzeQuery / queryAdmissionUnits / queryWorstCaseUnits / queryRowCap call it first

// serve-wire.ts
export const CHAT_PAYLOAD_SCHEMA = 'openai-chat/v1';
export const CHAT_RESULT_SCHEMA = 'openai-chat-result/v1';
export const QUERY_RESULT_SCHEMA = 'sparql-result/v1';
export const MAX_SERVE_RESULT_BYTES: number;            // 8 MiB (§3.1)
export type MeteringBasis = 'pinned' | 'provider-reported';
export interface ChatServePayload { schema: 'openai-chat/v1'; model: string; messages: ChatMessage[]; tools?: ChatTool[];
  tool_choice?: ChatToolChoice; parallel_tool_calls?: boolean; max_tokens: number; temperature?: number; top_p?: number;
  seed?: number; stop?: string[] }
export function parseChatServePayload(raw: unknown, opts?: { maxMessages?: number; maxBytes?: number }):
  { ok: true; payload: ChatServePayload; options: ChatToolOptions } | { ok: false; detail: string };
export interface ChatMeteringBlock { basis: MeteringBasis; tokenizer?: { kind: TokenizerKind; digest: string };
  chatTemplate?: { id: 'openai-chat-count/v1'; digest: string }; promptUnits: number; toolUnits: number;
  completionUnits: number; servedUnits: number; truncated: boolean; providerUsage?: { prompt_tokens: number; completion_tokens: number } }
export interface ChatServeResult { schema: 'openai-chat-result/v1'; model: string;
  choices: [{ index: 0; message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }; finish_reason: 'stop' | 'length' | 'tool_calls' }];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; metering: ChatMeteringBlock }
export function parseChatServeResult(raw: unknown): { ok: true; result: ChatServeResult } | { ok: false; detail: string };
export interface QueryMeteringBlock { scheduleDigest: string; admissionUnits: number; deliveryUnits: number; servedUnits: number;
  rowCount: number; aborted?: { reason: 'timeout' | 'row-cap' | 'size-cap' } }
export interface QueryServeResult { schema: 'sparql-result/v1'; result: unknown; rowCount: number; metering: QueryMeteringBlock }
export function parseQueryServeResult(raw: unknown): { ok: true; result: QueryServeResult } | { ok: false; detail: string };

// recount.ts
export type RecountVerdictKind = 'match' | 'mismatch' | 'unverifiable';
export type RecountReason = 'no-engine' | 'provider-reported' | 'not-metered' | 'tokenizer-drift' | 'template-drift'
  | 'schedule-drift' | 'malformed-result' | 'units-differ' | 'metering-block-differs';
export interface RecountVerdict { verdict: RecountVerdictKind; reason?: RecountReason; servedUnits: bigint; recountUnits?: bigint }
export function recountChat(input: { engine: TokenCountEngine | undefined; offerMetering: OfferMetering | undefined;
  wireMessages: readonly ChatMessage[]; wireOptions: ChatToolOptions; result: unknown; receiptServedUnits: bigint }): RecountVerdict;
export function recountQuery(input: { sparql: string; offerQueryCost: OfferQueryCost | undefined; result: unknown;
  receiptServedUnits: bigint; schedule?: QueryCostSchedule }): RecountVerdict;
export type SellerStanding = 'trusted' | 'deprioritized' | 'denied';
export interface RecountPolicy { window: number; deprioritizeAt: number; denyAt: number; denyCooldownSeconds: number }
export const DEFAULT_RECOUNT_POLICY: RecountPolicy;
export interface SellerRecountRecord { /* §8.3 */ }
export interface SellerStandingBookJson { version: 1; sellers: Array</* SellerRecountRecord with bigints as strings */ Record<string, unknown>> }
export class SellerStandingBook {
  constructor(policy?: Partial<RecountPolicy>, json?: SellerStandingBookJson);
  record(sellerIdentityId: bigint, verdict: RecountVerdict, nowSeconds: number): SellerStanding;
  standing(sellerIdentityId: bigint, nowSeconds: number): SellerStanding;
  standings(nowSeconds: number): Map<string, SellerStanding>;
  reset(sellerIdentityId: bigint): boolean;
  snapshot(nowSeconds: number): Array<SellerRecountRecord & { standing: SellerStanding }>;
  toJSON(): SellerStandingBookJson;
}

// gateway-keys.ts
export const GATEWAY_KEY_PREFIX = 'dkg_gw_';
export const GATEWAY_KEY_PATTERN: RegExp;
export interface GatewayKeyScopes { /* §10.1 */ }  export interface GatewayKeyUsage { /* §10.1 */ }
export interface GatewayKeyRecord { /* §10.1 */ }
export type PublicGatewayKeyRecord = Omit<GatewayKeyRecord, 'keyHash'>;
export function publicGatewayKeyRecord(r: GatewayKeyRecord): PublicGatewayKeyRecord;
export type GatewayKeyAuthVerdict = { ok: true; record: GatewayKeyRecord } | { ok: false; code: 'invalid_api_key' | 'key_revoked' | 'key_expired' };
export type GatewayKeyScopeVerdict = { ok: true } | { ok: false; code: 'model_not_allowed' | 'query_not_allowed' };
export interface GatewayKeyLedgerJson { version: 1; keys: Array<Record<string, unknown>> }
export class GatewayKeyLedger {
  constructor(json?: GatewayKeyLedgerJson);                 // throws on a malformed file
  mint(scopes: GatewayKeyScopes, nowSeconds: number, random?: (n: number) => Uint8Array): { plaintext: string; record: GatewayKeyRecord }; // re-draws a colliding keyId
  remove(keyId: string): boolean;                           // ONLY to roll back a mint whose persist failed (§10.2)
  authenticate(presented: string | undefined, nowSeconds: number): GatewayKeyAuthVerdict; // §10.2 lookup order; revoked/expired only after the hash matched
  checkScope(record: GatewayKeyRecord, request: { kind: 'inference' | 'query'; modelId?: string }): GatewayKeyScopeVerdict;
  reserve(keyId: string, reservationId: string, worstCaseWei: bigint): { ok: true } | { ok: false; code: 'key_budget_exceeded'; remainingWei: bigint };
  settle(reservationId: string, outcome: { costWei: bigint; servedUnits: bigint; kind: 'inference' | 'query' }, nowSeconds: number): void;
  release(reservationId: string): void;
  revoke(keyId: string, nowSeconds: number): GatewayKeyRecord | undefined;
  get(keyId: string): GatewayKeyRecord | undefined;
  list(): GatewayKeyRecord[];
  remainingWei(keyId: string): bigint;
  toJSON(): GatewayKeyLedgerJson;
}
export class SlidingWindowRateLimiter { constructor(opts?: { windowMs?: number; maxKeys?: number }); tryAcquire(key: string, limit: number, nowMs: number): boolean }

// stream-chain.ts (fork streaming.ts; scheme 'dkg-mkt:stream:v1'; no consumer this phase)
export const STREAM_CHAIN_SCHEME: 'dkg-mkt:stream:v1';
export function streamChainAccumulator(): { push(frame: Uint8Array): void; root(): string; frameCount(): number; bytesDigest(): string; bytes(): Uint8Array };
export function streamChainVerifier(): { push(frame: Uint8Array): void; finalize(claim: { streamChainRoot: string; frameCount: number; bytesDigest: string }): { ok: true; bytes: Uint8Array } | { ok: false; detail: string } };

// types.ts / router.ts additions: §5.4 (MarketplaceOffer, OfferMetering, OfferQueryCost = { schedule: string; digest: string }), §8.2 (RouteRequest, RouteRejectionReason, RouteDecision.maxUnits)
// router.ts behavior: api-shape is symmetric; preference = tier → worstCaseCostWei → ask → delivery score → peerId (§8.2)
// recount.ts behavior: malformed result → { verdict: 'mismatch', reason: 'malformed-result' } (moves standing, §8.3)
```

#### 14.3.2 C → D (exported from `@origintrail-official/dkg-agent`)

Config types: `MarketplaceConnectorConfig` and the extended
`MarketplaceOfferingConfig` / `DKGAgentMarketplaceConfig` (§4.2, §12).

Runtime exports. Constructor signatures are pinned so that D's tests can
construct the same shapes C throws:

```ts
export interface MarketplaceSpendGuard { admit(worstCaseCostWei: bigint): void;
  settle(o: { costWei: bigint; servedUnits: bigint; delivery: 'served' | 'not-served' | 'ambiguous' }): void }
export class MarketplaceSpendRefusedError extends Error {           // name 'MarketplaceSpendRefusedError'
  constructor(readonly code: 'key_budget_exceeded', message: string, readonly remainingWei?: bigint) }
export class MarketplaceRequestError extends Error {               // name 'MarketplaceRequestError'
  constructor(readonly code: 'invalid_messages' | 'invalid_tools' | 'invalid_parameter' | 'unsupported_parameter'
    | 'invalid_model' | 'invalid_sparql', message: string, readonly param?: string) }
export class MarketplaceModelNotFoundError extends Error {         // name 'MarketplaceModelNotFoundError'
  constructor(readonly model: string) }
export class MarketplaceInvalidToolResponseError extends Error {   // name 'MarketplaceInvalidToolResponseError'
  constructor(message: string, readonly invoke: MarketplaceInvokeResult, readonly recount: RecountVerdict)
  get costWei(): bigint /* = invoke.costWei */; get servedUnits(): bigint /* = invoke.servedUnits */ }
export class MarketplaceConnectorMountError extends Error {        // name 'MarketplaceConnectorMountError'
  constructor(readonly code: /* §4.1 list */ string, message: string, readonly offeringLocalId?: string) }
export const CODEX_OAUTH_CLIENT_ID: string, CODEX_DEFAULT_BASE: string, CODEX_TOKEN_URL: string;
export function defaultCodexAuthFile(dataDir: string): string;
```

**Check order in `marketplaceChatCompletion`** (C; E's assertions depend on it):

1. runtime on, else the existing "not running" error → 503;
2. `MarketplaceNotSubscribedError`;
3. input normalization → `MarketplaceRequestError`;
4. model resolution: discovery returned ≥ 1 offer but none with
   `apiShape 'openai-chat/v1'` and this canonical model →
   `MarketplaceModelNotFoundError`; discovery returned 0 offers →
   `MarketplaceRouteError('no-offers')`;
5. bucket (`no-bucket`);
6. payload validation (§8.1), once per distinct `toolTransport` among that
   model's chat offers, before any quote probe;
7. route (quote probes + `selectRoute`);
8. `spendGuard.admit`;
9. plan reserve;
10. sign;
11. serve;
12. receipt verify;
13. recount + standing record;
14. tool-response validation.

`marketplaceGatewayQuery` follows the same order with
`assertQueryWithinLimit` at step 3, and it has no step 4.

Mixin methods added to `MarketplaceMethods`:

```ts
marketplaceChatCompletion(input: MarketplaceChatCompletionInput): Promise<MarketplaceChatCompletionResult>;
marketplaceGatewayQuery(input: { sparql: string; maxRows?: number; spendGuard?: MarketplaceSpendGuard }): Promise<MarketplaceGatewayQueryResult>;
marketplaceGatewayModels(): Promise<MarketplaceGatewayModel[]>;
marketplaceConnectorStatus(opts?: { probe?: boolean }): Promise<MarketplaceConnectorStatus[]>;
marketplaceResetSellerStanding(sellerIdentityId: bigint): boolean;
// extended (additive): marketplaceMeter() → { state?, summary?, recount: Array<SellerRecountRecord & { standing: SellerStanding }> }
// extended (additive): marketplaceStatus() → seller.connectors?: { mounted; failed; mounting }, buyer.recount?: { sellers; deprioritized; denied }
// extended (additive): MarketplaceInvokeResult gains recount: RecountVerdict
```

The input and result types:

```ts
export interface MarketplaceChatCompletionInput {
  model: string; messages: unknown; tools?: unknown; toolChoice?: unknown; parallelToolCalls?: unknown;
  maxTokens?: number; defaultMaxTokens?: number; temperature?: number; topP?: number; seed?: number;
  stop?: string | string[]; spendGuard?: MarketplaceSpendGuard;
}
export interface MarketplaceChatCompletionResult {
  callId: string; model: string;
  message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: 'stop' | 'length' | 'tool_calls';
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  metering: ChatMeteringBlock; recount: RecountVerdict; invoke: MarketplaceInvokeResult;
}
export interface MarketplaceGatewayQueryResult {
  callId: string; result: unknown; rowCount: number; aborted?: { reason: 'timeout' | 'row-cap' | 'size-cap' };
  metering: QueryMeteringBlock; recount: RecountVerdict; invoke: MarketplaceInvokeResult;
}
export interface MarketplaceGatewayModel {
  id: string; contextLength?: bigint; offers: number; sellers: bigint[]; minAskPerUnitWei: bigint;
  meteringBases: MeteringBasis[]; tokenizerKinds: TokenizerKind[]; provenanceClasses: string[];
  toolTransports: string[]; routable: boolean;
}
export interface MarketplaceConnectorStatus {
  offeringLocalId: string; modelId: string; kind: ChatConnectorKind; state: 'mounting' | 'mounted' | 'failed';
  detail?: string; upstreamOrigin?: string; secretConfigured: boolean;
  metering: { basis: MeteringBasis; tokenizerKind?: TokenizerKind; tokenizerDigest?: string };
  weightsDigest?: string; health?: { ok: boolean; latencyMs: number; detail?: string; checkedAt: number };
}
```

#### 14.3.3 Agent re-exports for D

The cli package has no direct `dkg-marketplace` dependency. Adding one would
need a `pnpm-lock.yaml` edit, which nobody may make.

C creates **`packages/agent/src/marketplace/gateway-domain.ts`**, a pure module
with no runtime-root imports, and the agent root re-exports it with
`export * from './marketplace/gateway-domain.js'`:

```ts
// packages/agent/src/marketplace/gateway-domain.ts
export {
  GatewayKeyLedger, SlidingWindowRateLimiter, GATEWAY_KEY_PREFIX, GATEWAY_KEY_PATTERN, publicGatewayKeyRecord,
  canonicalModelId, TOKENIZER_KINDS, isTokenizerKind, QUERY_MAX_SPARQL_BYTES,
  type GatewayKeyScopes, type GatewayKeyRecord, type PublicGatewayKeyRecord, type GatewayKeyLedgerJson,
  type GatewayKeyAuthVerdict, type GatewayKeyScopeVerdict, type TokenizerKind, type ChatToolCall,
  type ChatMeteringBlock, type QueryMeteringBlock, type RecountVerdict, type SellerStanding, type MeteringBasis,
} from '@origintrail-official/dkg-marketplace';
export {
  MarketplaceSpendRefusedError, MarketplaceRequestError, type MarketplaceSpendGuard,
} from './buyer-errors.js';                                  // C: errors live in a dependency-free module
export {
  CODEX_OAUTH_CLIENT_ID, CODEX_DEFAULT_BASE, CODEX_TOKEN_URL, defaultCodexAuthFile,
} from './connectors/codex-constants.js';                   // C: constants split from the connector
```

D imports **values** from
`@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js`. The
package's `./dist/*` export allows this, and the cli already imports
`dkg-agent/dist/...` modules elsewhere. The point is that the key store,
gateway routes and OAuth flow, together with their fast unit tests, never load
the agent runtime root. That is the same convention `routes/marketplace.ts`
documents. Types may come from the root.

#### 14.3.4 D → E (HTTP)

- The routes of §9 (gateway), §10.4 (keys), and §15.4 S-tests.
- `GET /api/marketplace/seller/connectors[?probe=1]` (node-admin) → `{ connectors: MarketplaceConnectorStatus[] }` (bigints as strings).
- `POST|GET /api/marketplace/seller/connectors/codex-oauth/login` (node-admin) → `{ status: 'idle'|'pending'|'done'|'error', authorizeUrl?, detail? }`.
- `POST /api/marketplace/recount/reset` (node-admin) `{ sellerIdentityId }` → `{ reset: boolean }`.
- The existing `GET /api/marketplace/meter`, `GET /api/marketplace/offers` and
  `GET /api/marketplace/status` gain the additive fields. Status also gains
  `gateway: { enabled: boolean, basePath, keys: number }` (merged by D).
- CLI:
  - `dkg marketplace keys list|mint|revoke`
  - `dkg marketplace connectors [--probe]`
  - `dkg marketplace gateway` (prints the base URL plus curl and SDK snippets, no key)

#### 14.3.5 B → E

The `llm-stub.mjs` exports and behaviors of §13.1, and the GV-2..GV-5 numbers.

## 15. Test plan per slice

### 15.1 A: `packages/marketplace/test/*.test.ts`

- **`token-engines.test.ts`.** GV-1. A property test: `count ≤ utf8Bytes` for
  random strings (fixed seed), all three engines. Digests (sha256 of the
  fixture bytes, `STUB_WORDS_DIGEST`). Malformed files throw. Fixtures:
  - `test/fixtures/tiny-tokenizer.json`: byte-level vocab for `a b c Ġ` + 3
    merges (`a b`, `ab c`, `Ġ a`);
  - `test/fixtures/tiny-o200k.tiktoken`: ranks for `a`,`b`,`c`,` `,`ab`,`abc`.

  Pin hand-checked counts for ~6 strings per engine, including an unknown piece
  and a multi-byte character.
  - **Differential test.** Compare against the verbatim fork loops (kept in
    `test/oracle-bpe.ts`) on the fixtures plus 500 seeded random strings over
    the fixture alphabet: equal counts.
  - **Cost gate.** Build a generated chain vocab: 26 letters, then merges that
    form every prefix of a 4096-letter pseudo-random sequence. A 2 MiB
    single-piece input made of that sequence counts in < 3 s on both engines.
    This fails loudly if an O(n²) loop is ported.
- **`chat-messages.test.ts`.** Port the fork's normalization cases:
  - string / text parts / null content;
  - image part refusal and `allowParts:false` refusal;
  - bounds;
  - tool normalization and tool_choice forms;
  - `validateToolCallsAgainstOptions` (unlisted tool, required, none, parallel);
  - prompt-transport build/parse round trip, prose-with-marker refusal, deterministic ids;
  - **idempotence**: `normalize(JSON.parse(JSON.stringify(normalize(x))), {allowParts:false})`
    deep-equals `normalize(x)` for every accepted `x`, including tool history,
    names and empty content;
  - lone surrogates → `invalid_messages`;
  - `tool_calls: []` / `null` on a message → treated as absent.
- **`chat-metering.test.ts`.** GV-2..GV-7. `toolEnvelopeText` is `''` without
  tools and stable JSON with them. `boundCompletion` invariants (prefix,
  `count ≤ cap`, no split surrogate pairs, cap 0). `meterChat` sums.
- **`query-cost.test.ts`.** GV-8..GV-10. Schedule digest and canonical JSON.
  `queryRowCap` admit/deny edges. `countResultRows` shapes.
  `QUERY_MAX_SPARQL_BYTES` boundary: 8192 bytes accepted, 8193 refused with
  `QueryTooLargeError`. The refusal comes before any regex runs: a 1 MiB
  whitespace run returns in < 50 ms.
- **`serve-wire.test.ts`.** Payload/result parse accept/reject matrix, including
  non-safe-integer units, `servedUnits` ≠ sum, an unknown schema, and
  `finish_reason` enums.
- **`recount.test.ts`.** Every verdict row of §8.3. A malformed result →
  `mismatch` / `malformed-result`, and it moves standing. Standing transitions:
  - 0 → 1 → 3 mismatches;
  - cool-down expiry → `deprioritized`;
  - 20 clean recounts → `trusted`;
  - `unverifiable` never moves standing;
  - JSON round trip.
- **`gateway-keys.test.ts`.** Format regex. Hash at rest (no plaintext in `toJSON`).
  Auth paths: unknown, malformed, revoked, expired. A revoked or expired
  `keyId` presented with a **wrong secret** → `invalid_api_key` (S11). `keyId`
  collision on mint is re-drawn (inject `random`). `remove`. Scope checks.
  Reserve/settle/release.
  Budget refusal. The conservation invariant over a randomized op sequence.
  JSON round trip drops reservations. `SlidingWindowRateLimiter` window and
  bounded key map.
- **`router.test.ts` (extend).** Each new rejection reason. Per-offer
  `maxUnitsFor` (different units per offer; `decision.maxUnits`). Standing tier
  beats a cheaper deprioritized ask. Denied rejected. Restricted vs sellerAllow.
  More cases:
  - **Symmetric api-shape**: a request without `requireApiShape` rejects
    apiShape offers.
  - **Worst-case preference**: a lower ask with more per-offer units loses to
    a higher ask whose `units × ask` is lower.

  Existing cases unchanged.
- **`stream-chain.test.ts`.** Chain root changes on a tampered, dropped or
  reordered frame. Reassembly digest.

### 15.2 B

Self-check only, not committed. Run `node --check devnet/marketplace-rfc27/llm-stub.mjs`
and a scripted smoke with `node -e`:

- start on port 0;
- GV-2/GV-3 usage;
- SSE framing;
- the tool-call reply;
- both seams;
- 401 without a bearer.

Paste the commands and outputs into the report. E commits the permanent `node:test` file.

### 15.3 C: `packages/agent/test/marketplace-*.test.ts`

The harness is the existing in-process messenger pair plus `MockChainAdapter`
(see `marketplace-flow.test.ts`). Upstreams are local `node:http` servers on
port 0. Tokenizer fixtures are written to a tmp dir from inline strings.

- **`marketplace-connectors.test.ts`.**
  - **openai-compatible**: success; usage; tool calls (valid and an unlisted
    tool → `UPSTREAM_ERROR`); 429/500/401/redirect/timeout classification; secret
    read at call time (rotate the file between calls); perms 0644 → mount fails;
    the secret never appears in `detail` (an upstream echoes the bearer in its
    error body, and the test asserts redaction). Further cases:
    - an echo placed so that the key straddles char 160 is still fully redacted;
    - `tool_calls: []` / `null` in a plain reply succeeds (vLLM shape);
    - `maxTokensField: 'max_completion_tokens'` is honored;
    - no `temperature` is sent when the request has none.
  - **llamacpp**: non-loopback refused; GGUF digest + cache hit on the second
    mount (spy on hashing); unhealthy at mount; context-overflow classification.
  - **codex-oauth**: SSE accumulate; refresh on 401 and on an expiring JWT, with
    the file rewritten 0600, including over a pre-existing 0644 file;
    `response.failed`; a missing scope ack or empty `allowedBuyers` fails mount.
    **Single-flight**: 5 concurrent calls with an expired token make exactly 1
    request to the fake token endpoint.
  - **llamacpp**: a server that comes up after the mount fails is picked up by
    the boot retry (fake timers).
- **`marketplace-chat-executor.test.ts`.**
  - The stub-words path matches GV-2/GV-3 exactly against an in-test stub
    (re-implement the 10-line stub formula inline; do not import devnet files).
  - `boundCompletion` truncation when the upstream ignores `max_tokens`.
  - `OVER_MAX_UNITS` when `fixed ≥ maxUnits`. Tool-call overflow fails closed.
  - Provider-reported: usage over `maxUnits` fails closed with
    `METERING_OVERRUN`; missing usage fails.
  - Result bytes over `MAX_SERVE_RESULT_BYTES` (inject a small cap) → refusal,
    no receipt.
  - `MODEL_MISMATCH`. `TOOLS_UNSUPPORTED` on prompt offerings.
  - The result JSON validates with `parseChatServeResult`, and
    `metering.servedUnits == unitsServed`.
- **`marketplace-query-schedule.test.ts`.** Admission, delivery and abort
  semantics (timeout through a slow query fn, row cap, size cap).
  `OVER_MAX_UNITS` before execution. Rows come from `countResultRows` of the
  served value: a query fn returning `{ quads: [...] }` with `rowCount: 0`
  still meters the quads. A SPARQL above 8192 bytes → `BAD_PAYLOAD` before
  execution. Update the existing `marketplace-flow.test.ts` query expectations
  from `queryUnits` to the schedule.
- **`marketplace-offer-publisher.test.ts` (extend).** New predicates are
  published; secrets, URLs and paths are never present in the quads (assert by
  scanning the object strings). Discovery parses the pin. A malformed extension
  drops only the extension group. A pin change → republish, unchanged → no-op.
  More cases:
  - **Triple-scan safety.** One offer with 4 values on each of 10 extension
    predicates parses in linear time and drops those groups. Assert the SPARQL
    string has no `OPTIONAL`.
  - A group with more than 64 triples is skipped.
  - A duplicated core predicate skips the offer.
  - A stub-words pin with a wrong digest drops the metering group.
- **`marketplace-buyer-chat.test.ts`.** End to end over the messenger pair:
  - the gateway chat flow with a spend guard (admit/settle exactly once per outcome);
  - per-offer `maxUnits` for two sellers with different pins;
  - prompt-transport offers;
  - recount `match`;
  - a dishonest-seller double that signs `servedUnits + 1` → receipt settles,
    verdict `mismatch`, standing moves, and after 3 such calls the seller is
    `denied` and routing skips it;
  - standings persist across a service restart;
  - caller-fault codes do not count as delivery failures;
  - `chatServeTimeoutMs` honored;
  - generic `invoke()` never routes to an `apiShape` offer (symmetric api-shape);
  - tools + `tool_choice:'none'` routed to a `toolTransport:'none'` offer sends
    no tool fields;
  - native tools add `TOOL_CALL_SLACK_UNITS` to `maxUnits` while the payload
    `max_tokens` stays at `wanted`;
  - an invalid tool response settles the spend guard at the receipt value;
  - a guard `admit` throw propagates the same error object, with no
    reservation and no delivery record;
  - the chat authorization expiry honors the TTL floor;
  - a seller that returns a non-conforming chat result → `MALFORMED_RESULT`,
    verdict `mismatch`.
- **`marketplace-agent-wiring.test.ts` (extend).**
  - Boot with a failing connector → the offering is reported `failed`, the
    quote declines `CONNECTOR_UNAVAILABLE`, and it is not published.
  - `marketplaceSetOfferings` is all-or-nothing on a mount failure.
  - `allowedBuyers` → `BUYER_NOT_ALLOWED` plus `mkt:access restricted`.
    A request carrying a **bad** auth signature from a non-allowed buyer gets
    `BAD_AUTH`, not `BUYER_NOT_ALLOWED`, which shows there is no membership oracle.
- After the export changes, run `pnpm --filter @origintrail-official/dkg-agent build`.
  Its script runs `test:types` and `test:package-root`. The agent has no
  `test:package-exports` script. The root-import check the build already
  performs is the gate. `scripts/test-package-root.mjs` is not C's file, so
  leave it unchanged.

### 15.4 D: `packages/cli/test/*marketplace*.test.ts`

- **`marketplace-gateway-dispatch.test.ts`.** Covers S1 and S3:
  - the `isMarketplaceGatewayPath` truth table: the §11.3 S1 list, plus
    `new URL(p, base).pathname` for `/api/marketplace/gateway/v1/../../status`,
    `/api/marketplace/gateway/v1/%2e%2e/%2e%2e/status` and
    `//api/marketplace/gateway/v1/models`, all resolving **outside** the prefix;
  - **body not read before auth**: send headers with an unknown key and leave
    the body stream open; the response must be 401 without waiting, with
    `Connection: close`;
  - **header-only key**: a valid key in `?api_key=`, in the body, or in
    `x-api-key`, with no `Authorization` header → 401;
  - **S11**: a revoked key's `keyId` with a wrong secret → `invalid_api_key`,
    not `key_revoked`.
- **`marketplace-gateway-auth-carveout.test.ts`.** A mini HTTP server that
  reproduces the lifecycle order (OPTIONS → carve-out → `authenticateHttpRequest`
  → `handleRequest` spy) with a fake agent, plus a **source-order pin**. It
  pins these invariants:
  - S2: the `handleRequest` and agent spies are never called for gateway paths
    without a valid key.
  - S4: a gateway key on `/api/marketplace/status` and `/api/marketplace/keys` → 401.
  - S5: the node token and an agent token on gateway paths → 401 `invalid_api_key`.
  - S6: auth disabled → the gateway still needs a key.
  - S7: mint/revoke with an agent token → 403; without a token → 401.
  - Revoked key → 401 on the next call (shared singleton store).
  - Gateway disabled → the prefix requires the node token and answers 404.
  - Unknown subpath with a valid key → 404, never reaching `handleMarketplaceRoutes`.
  - Source-order pin: read `src/daemon/lifecycle.ts` as text; assert exactly one
    `isMarketplaceGatewayPath(` call; assert its index is after the
    `req.method === "OPTIONS"` block and before `authenticateHttpRequest(`;
    assert no other non-test file under `packages/cli/src` references
    `isMarketplaceGatewayPath` except the dispatch module and `routes/marketplace.ts`.
- **`marketplace-gateway-routes.test.ts`.** With a fake agent:
  - request validation (each 400 row of §9.6);
  - the full error-mapping table (one case per row, driven by thrown errors
    with the right `name` and `code`);
  - the non-stream response shape;
  - the buffered SSE sequence (parse the events, `[DONE]`);
  - the `/models` allowlist filter;
  - per-key rps 429 and concurrency 503;
  - spend guard → ledger reserve, settle and release per delivery state;
  - the `dkg` block bigints as strings;
  - `charged_wei` equals the cost the guard settled (worst case vs receipt
    value for `MALFORMED_RESULT`);
  - the module graph of the gateway routes and the key store does not import
    the agent runtime root (assert by importing them in a test that stubs
    nothing and checks `DKGAgent` was never evaluated, or by a source scan for
    `from '@origintrail-official/dkg-agent'` value imports);
  - no `Authorization` or prompt text in captured logs.
- **`marketplace-gateway-key-store.test.ts`.** File mode 0600, atomic writes, a
  reload preserving usage, the mint response shape (plaintext once), and the
  list without hash. More cases:
  - **0600 after overwriting** a pre-existing 0644 file.
  - **Serialized writes**: 50 concurrent settles with a frozen `Date.now`
    leave one well-formed file whose usage equals the in-memory ledger, with no
    leftover `.tmp.` files.
  - **Mint durability**: when the injected write fails, mint rejects, no
    plaintext is returned, and `ledger.get(keyId)` is undefined.
  - **Malformed file**: the store opens in fail-closed mode, the gateway
    answers 503, the admin routes answer 500 naming the file, mint refuses, and
    the file is left untouched.
- **`marketplace-config.test.ts` (extend).** Connector, metering, gateway and
  `queryGuards` parsing. Relative paths rejected. `acknowledgeSubscriptionScope`
  must be literal true. `DKG_MARKETPLACE_GATEWAY_ENABLED`. Policy
  `match.modelId` canonicalized.
- **`marketplace-codex-oauth-flow.test.ts`.** PKCE challenge correctness. A
  state mismatch is refused. A fake token endpoint → the auth file is written
  0600 in the connector's shape, including over an existing 0644 file, and
  `.secrets/` is 0700. Timeout. Single flow at a time. Injectable port.
- **`daemon-marketplace-routes.test.ts` (extend).** Keys, connectors, recount
  reset, the codex login routes, and the gateway-prefix 404 guard.

### 15.5 E

- `llm-stub.test.mjs` (node:test, §13.3).
- `pnpm test:devnet:marketplace-rfc27` on a fresh devnet: all 9 existing steps
  plus G1–G15. Run: `pnpm build`, `./scripts/devnet.sh clean`,
  `./scripts/devnet.sh start 6`, then `node devnet/_bootstrap/bootstrap.cjs`.
- Console: smoke the proxy rule (the gateway path forwards the browser key and
  never the node token), using curl against the console server.
- Record a short critique of the console additions in the report. The console
  is devnet tooling; the fork's UI rules do not apply.

## 16. Gates, validation and commit protocol (every slice)

Run before committing. Report every command and its result.

1. `DKG_SKIP_EVM_BUILD=1 pnpm build:packages`
2. The vitest suites of each package you touched (`pnpm --filter <pkg> test`):
   A `@origintrail-official/dkg-marketplace`, C `@origintrail-official/dkg-agent`
   (at least `test/marketplace-*.test.ts`), D `@origintrail-official/dkg`
   (at least `test/*marketplace*`)
3. `pnpm lint` (oxlint baseline: no new findings)
4. `node scripts/audit-file-size.mjs`
5. `node scripts/audit-dial-protocol.mjs`
6. `node scripts/audit-create-random.mjs` (keys and session keys use `randomBytes`)
7. `pnpm test:inventory`
8. `pnpm test:devnet:manifest`
9. E only: the devnet e2e (§15.5)

**Commit protocol:**

- `git add <owned paths only>`. Never `git add -A`.
- One conventional commit per slice. Examples:
  - A: `feat(marketplace): chat metering, token engines, query cost schedule, gateway keys`
  - B: `feat(devnet): port the deterministic OpenAI-compatible llm-stub`
  - C: `feat(agent): marketplace chat connectors, pinned metering, buyer recount`
  - D: `feat(cli): marketplace buyer gateway with scoped keys and auth carve-out`
  - E: `test(devnet): marketplace gateway e2e, llm-stub vectors, console gateway panel`
- End the message with the two attribution lines.
- `git push origin prototype/rfc27-sellers-gateway`. On a race,
  `git pull --rebase origin prototype/rfc27-sellers-gateway` and re-run the
  build. Never force-push.
- Append progress notes to the shared scratchpad progress file.

## 17. Deferred (documented, not built here)

- True end-to-end streaming: a duplex serve protocol, a stream-chain commitment
  bound into the receipt, and incremental seller metering.
- Separate canonical Model KAs and logos (node-UI phase).
- Model aliases, multi-seller fan-out, buyer-side context-length pre-check.
- Persisting key reservations across restarts. In-flight calls are lost on restart anyway.
- Browser use of the OpenAI JS SDK. Its `x-stainless-*` headers are not in the
  CORS allowlist. Server-side SDK use is the target.
- Cancelling the p2p call on client disconnect.
- Recount evidence export and dispute: the RFC settles regardless, so standing stays local.
- Truncating (rather than aborting) a query that exceeds its row cap. V1 keeps
  the fork's abort-with-admission rule.
- Tokenizer drift during offer propagation. A seller that re-pins its tokenizer
  takes a transient `tokenizer-drift` mismatch from buyers still holding the old
  offer. Denial needs 3 mismatches within the window, so the cost is bounded.

## 18. Review amendments (adversarial review of d8629be6)

Every item below was verified against the code or measured. The sections named
carry the normative text.

1. **BPE cost bound (§5.1, §15.1).** The fork's merge loops are O(n²) per
   pre-tokenized piece, and one 2 MB letter run blocks a seller or buyer event
   loop for minutes to hours. They are now required to be heap/linked-list
   O(n log n), with the verbatim loops kept as a test oracle, a differential
   test, and a perf gate.
2. **SPARQL size gate (§3.1, §6.1).** `analyzeQuery` is quadratic: measured
   75 ms at 8 KiB and 1.3 s at 32 KiB, extrapolating to minutes at 1 MB. Both
   seats now refuse queries above 8192 bytes before analysing them.
3. **Discovery must be a triple scan (§5.4).** Adding ~20 OPTIONALs to the
   GRAPH SELECT let any publisher in the open `marketplace` CG make every buyer
   materialize k^20 rows: the authority check runs only after the engine.
   OPTIONAL extension is now forbidden. The scan has no truncating LIMIT, caps
   each group at 64 triples, applies duplicate-value rules, and checks that
   pin/digest pairs are consistent.
4. **Key store persistence (§10.2, §15.4).** `writeFileAtomicWith` has no mode
   argument, and its tmp name collides within one millisecond. Writes are now
   serialized and coalesced, the file is chmodded to 0600, mint is durable
   before it returns (`ledger.remove` rolls back), and a malformed file makes
   the gateway fail closed without failing the boot.
5. **Key auth oracle (§10.2, §11.3 S11).** `key_revoked` / `key_expired` are
   returned only after the secret's hash matched, and unknown keyIds compare
   against a dummy hash.
6. **Header-only credential (§9.2, §11.3 S10).** The key is read only from the
   `Authorization` header, never from a query, body, cookie or `x-api-key`.
   This also states the CSRF and DNS-rebinding reasoning. Pre-body rejections
   carry `Connection: close`, and 401s carry `WWW-Authenticate`.
7. **`BUYER_NOT_ALLOWED` after signature verification (§4.5, §5.6, §7.5).**
   Before verification it was an unauthenticated membership oracle for the
   private allowlist.
8. **Symmetric api-shape routing (§8.2).** The generic `invoke()` could route
   `{prompt}` payloads to chat offers, which refuse with `BAD_PAYLOAD`. The
   quote prefilter now matches the router.
9. **Preference by worst-case cost (§8.2).** Raw asks are not comparable across
   different pins. The new order is identical to the old one when units are
   uniform.
10. **Exact count inputs (§8.1, §8.3, §5.5 R4).** One `wireFor(offer)`
    function now covers all three transports. The `none` transport strips tool
    fields, which `tools` + `tool_choice:'none'` previously left in, so the
    seller answered `TOOLS_UNSUPPORTED`. Payloads are validated before any
    quote probe. Counting and recount use exactly the serialized objects, with
    a normalization-idempotence property test. Lone surrogates are rejected,
    and tool calls are counted as delivered.
11. **Tool-call slack (§3.1, §8.1).** R4 counts provider ids and wrapper keys
    that the upstream's `max_tokens` does not bound. Native tool calls get
    `TOOL_CALL_SLACK_UNITS` of authorization headroom, which only tool calls
    can use.
12. **`METERING_OVERRUN` (§5.6, §7.5, §9.6).** A provider-reported overrun is a
    seller fault, so it is a 502 that counts as a delivery failure. It was
    previously `OVER_MAX_UNITS`, a misleading 400 that blamed the caller.
13. **Result size cap (§3.1, §5.6, §6.2).** The router's read cap is 10 MiB.
    Larger results are refused (chat) or size-cap-aborted (query) before
    signing, so a buyer is never charged for an undeliverable response.
14. **Query rows from the delivered value (§6.2).** The current mixin counts
    only `bindings`, while the recount also counts `quads`. Rows are now
    `countResultRows` of the value the seller serializes.
15. **Malformed results count against the seller (§8.3).** As `unverifiable`
    they let a dishonest seller dodge every recount. They are now `mismatch`
    plus `MALFORMED_RESULT`.
16. **Spend-guard settlement (§8.5, §9.6).** A post-receipt failure settles at
    the receipt value, which is consistent with `charged_wei`. `admit` errors
    propagate unchanged, and `charged_wei` always equals what the guard settled.
17. **Secrets (§4.3, §4.6).**
    - Redaction now runs before truncation. Truncating first could leak a key
      prefix at the cut.
    - Codex token values are redacted, and mount errors never quote file content.
    - Codex refresh is single-flight, because concurrent refreshes burn the
      rotating refresh token.
    - Auth-file writes are atomic with 0600 and a chmod, and `.secrets/` is 0700.
18. **Upstream compatibility (§4.2, §4.6).**
    - `tool_calls: []` / `null` means no tool calls. vLLM sends `[]` on every
      plain reply, which used to make every call an `UPSTREAM_ERROR`.
    - The new `maxTokensField` option covers OpenAI reasoning models.
    - Sampler fields are sent only when set. The forced `temperature: 0` is
      dropped, because those models reject it.
19. **Operational fixes.**
    - Boot-time mount retry with backoff (§4.4).
    - Chat authorization TTL floor (§8.1).
    - `context_length` is a JSON number (§9.5).
    - Console proxy timeout ≥ 210 s, and mint responses are never persisted (§13.4).
    - G3 sets `totalBudgetWei` (§13.3).
20. **Contracts (§14.2, §14.3).**
    - Error constructors and the `marketplaceChatCompletion` check order are pinned.
    - New `gateway-domain.ts` module: D imports its values via
      `dkg-agent/dist/marketplace/gateway-domain.js`, so cli unit tests never
      load the agent root.
    - D's new admin routes are dispatched from `handleMarketplaceRoutes`.
    - The agent `index.ts` budget note (713/800).
    - New A exports: `QUERY_MAX_SPARQL_BYTES`, `QueryTooLargeError`,
      `assertQueryWithinLimit`, `MAX_SERVE_RESULT_BYTES`,
      `TOOL_CALL_SLACK_UNITS`, `GatewayKeyLedger.remove`, and abort reason
      `'size-cap'`.
21. **Gate fix (§15.3).** The agent has no `test:package-exports` script. Its
    build runs `test:types` + `test:package-root`.

Checked and found sound, so unchanged:
- The carve-out position and the WHATWG path cases (`..`, `%2e%2e`, `%2F`,
  `//api`, backslashes), because both the carve-out and `authenticateHttpRequest`
  parse the same `new URL(req.url, host)`.
- No route other than the gateway is reachable with a gateway key or with no
  credential.
- The template, stub-words and schedule digests, and GV-1..GV-10: recomputed;
  GV-8 was recomputed with a verbatim `analyzeQuery`.
- `boundCompletion` GV-7: no off-by-one.
- Stub-words and llm-stub usage are equal on GV-2..GV-5.
- The drill arithmetic, now 9.35e14 > 9.2e14.
- `MARKETPLACE_SERVE_VERSION` is unchanged.
- The file budgets of `lifecycle.ts`, `auth.ts`, `config.ts` and `api-client.ts`.
