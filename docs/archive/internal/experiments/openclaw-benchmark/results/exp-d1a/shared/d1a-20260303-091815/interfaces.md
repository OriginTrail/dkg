# D1A Interfaces
runId: d1a-20260303-091815

## 2026-03-03T08:24:56.486476+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f2`
- stream: `r1-f2`
- note: PineconeMemoryDB class: upsert(entry: Omit<MemoryEntry, id|createdAt>): Promise<MemoryEntry>, query(vector: number[], limit?, minScore?): Promise<MemorySearchResult[]>, delete(id: string): Promise<boolean>. Config: PineconeMemoryConfig { pinecone: { apiKey, indexName, namespace? }, embedding: { apiKey, model?, baseUrl?, dimensions? }, autoCapture?, autoRecall?, captureMaxChars? }. Plugin manifest: openclaw.plugin.json with kind=memory, configSchema requiring pinecone+embedding sections.

## 2026-03-03T08:24:59.491987+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f3`
- stream: `r1-f3`
- note: SessionsExportOptions { sessionId: string, format?: 'json' | 'markdown', output?: string, limit?: number, verbose?: boolean, timeout?: number }. Export function: sessionsExportCommand(opts, runtime). CLI: openclaw sessions export --session-id <id> [--format json|markdown] [--output <path>] [--limit <n>] [--timeout <ms>]

## 2026-03-03T08:28:17.300132+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r1-f1`
- stream: `r1-f1`
- note: Config schema: channels.x-twitter.{apiKey, apiSecret, accessToken, accessTokenSecret, dmPolicy, allowFrom, defaultTo, pollIntervalMs, textChunkLimit}. Multi-account: channels.x-twitter.accounts.<id>.{...}. ResolvedXTwitterAccount type exported from accounts.ts. ChannelPlugin<ResolvedXTwitterAccount, XTwitterProbe> registered as id=x-twitter. Env vars: X_TWITTER_API_KEY, X_TWITTER_API_SECRET, X_TWITTER_ACCESS_TOKEN, X_TWITTER_ACCESS_TOKEN_SECRET.

## 2026-03-03T08:35:35.190203+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f4`
- stream: `r2-f4`
- note: Plugin manifest: openclaw.plugin.json with providers=[mistral-portal]. Provider registered with id=mistral-portal, label=Mistral, auth kind=api_key. Auth flow prompts for base URL (default https://api.mistral.ai/v1) and API key, validates via GET /v1/models. Returns ProviderAuthResult with api_key credential, configPatch with 3 models (mistral-large-latest, mistral-small-latest, codestral-latest), openai-completions API. Default model: mistral-portal/mistral-large-latest. Exported: validateMistralApiKey(apiKey, baseUrl) for testing.

## 2026-03-03T08:36:07.163247+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f2`
- stream: `r2-f2`
- note: renderMatrixCard(params: { props: ChannelsProps, matrixAccounts: ChannelAccountSnapshot[], accountCountLabel: unknown }): TemplateResult. MatrixProbeData type: { ok?: boolean, error?: string|null, status?: number|null, userId?: string|null, joinedRooms?: number|null, syncStatus?: string|null, lastSyncAt?: number|null }. Registry: case 'matrix' in channels.ts renderChannel switch, passes channelAccounts.matrix to card.

## 2026-03-03T08:39:51.849737+00:00 | interface
- runId: `d1a-20260303-091815`
- agent: `d1a-r2-f1`
- stream: `r2-f1`
- note: Config schema: channels.reddit.{clientId, clientSecret, username, password, userAgent, dmPolicy, allowFrom, defaultTo, markdown, textChunkLimit, pollIntervalMs, monitorInbox, monitorMentions}. Multi-account: channels.reddit.accounts.<id>.{...}. ResolvedRedditAccount type exported from accounts.ts. ChannelPlugin<ResolvedRedditAccount, RedditProbe> registered as id=reddit. Env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_USER_AGENT. RedditInboundMessage: {messageId, thingId, senderName, text, timestamp, kind(direct|mention), subreddit?, parentId?}. RedditProbe: {ok, username, karma?, latencyMs?, error?}.
