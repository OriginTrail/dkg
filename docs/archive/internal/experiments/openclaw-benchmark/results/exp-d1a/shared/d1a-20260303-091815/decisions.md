# D1A Decisions
runId: d1a-20260303-091815

## 2026-03-03T08:24:53.988834+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f2`
- stream: `r1-f2`
- note: Modeled extension after memory-lancedb: same plugin interface (kind=memory), same tool names (memory_recall/store/forget), same capture/recall heuristics. PineconeMemoryDB uses upsert/query/deleteOne from @pinecone-database/pinecone SDK. Config requires both pinecone (apiKey, indexName) and embedding (apiKey for OpenAI) sections. Added namespace support for memory isolation. CLI subcommand is pinecone-ltm to avoid conflict with lancedb ltm.

## 2026-03-03T08:24:54.049672+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f3`
- stream: `r1-f3`
- note: Gateway-first approach: export uses callGatewayCli RPCs (sessions.resolve then chat.history) rather than reading JSONL transcripts directly. This reuses existing sanitization/capping logic and works for both local and remote gateways. Session identifier resolution: --session-id accepts both session keys and UUIDs; tries key-based resolve first, falls back to sessionId lookup.

## 2026-03-03T08:28:15.019541+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f1`
- stream: `r1-f1`
- note: Used OAuth 1.0a (HMAC-SHA1) for X API auth since DM endpoints require user-context authentication. Chose polling-based DM monitoring (GET /2/dm_events) over streaming since X API v2 streaming does not cover DMs. Modeled after IRC extension for consistency. DM-only (no group support) since X DMs are direct conversations. Config stored under channels.x-twitter with env var support (X_TWITTER_API_KEY, X_TWITTER_API_SECRET, X_TWITTER_ACCESS_TOKEN, X_TWITTER_ACCESS_TOKEN_SECRET).

## 2026-03-03T08:31:42.282909+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f4`
- stream: `r2-f4`
- note: Using api_key auth kind (not OAuth) since Mistral uses standard API key authentication. Provider ID is mistral-portal to distinguish from core mistral provider. Validates API key by calling GET /v1/models endpoint. Uses openai-completions API format (same as core mistral). Default model is mistral-large-latest. Base URL configurable, defaults to https://api.mistral.ai/v1. Extension is self-contained, no core files modified.

## 2026-03-03T08:33:24.832289+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f1`
- stream: `r2-f1`
- note: Using snoowrap SDK for Reddit API access with OAuth2 script-type auth (client_id + client_secret + username + password). Polling-based inbox monitoring (GET /message/inbox and /message/mentions) since Reddit has no real-time streaming for messages. Supports DMs (chatTypes: direct) and mention replies. Config stored under channels.reddit with env var support (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD). Modeled after IRC extension for consistency. Reddit is not in CHAT_CHANNEL_ORDER so ChannelMeta is defined inline.

## 2026-03-03T08:36:05.075143+00:00 | decision
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f2`
- stream: `r2-f2`
- note: Followed the Telegram multi-account card pattern (render function, not Lit component class) since Matrix supports multiple accounts. Used account.baseUrl for homeserver URL, account.probe cast to MatrixProbeData for userId/joinedRooms/syncStatus/lastSyncAt. Derived sync status from running+configured+probe.ok state when probe.syncStatus is not set. Card displays: homeserver, configured, running, rooms count, sync status, last sync, last probe/inbound, error callout, probe result callout, config section, and Probe button.
