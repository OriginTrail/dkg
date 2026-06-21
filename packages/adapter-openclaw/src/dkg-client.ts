/**
 * Thin HTTP client for the DKG daemon API (localhost:9200 by default).
 *
 * All adapter modules (channel, memory) use this client instead of
 * embedding a second DKGAgent. The daemon owns the agent, triple store,
 * and Node UI.
 */

import { loadAuthTokenSync } from '@origintrail-official/dkg-core';

/**
 * Typed daemon HTTP error. Carries the response `status` and the parsed JSON
 * `body` (when the daemon returned JSON) so callers can branch structurally
 * (e.g. a 409 `UNSEALED_SHARE_BLOCKED` recovery hint) instead of re-parsing
 * JSON out of the message string. The human-readable `message` is preserved
 * verbatim (`DKG daemon <path> responded <status>: <text>`) for back-compat
 * with the existing `responded NNN` substring checks (e.g. the chat-turns 404
 * probe and the `wm/import-file` 404 path).
 */
export class DkgDaemonHttpError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'DkgDaemonHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Build a {@link DkgDaemonHttpError} from a non-2xx daemon response. Attempts to
 * parse `text` as JSON for the typed `body`; a non-JSON body leaves `body`
 * undefined (the raw text still appears in the message). The message format is
 * fixed â€” do NOT change it without auditing the `responded ` substring checks.
 */
function daemonHttpError(message: string, status: number, text: string): DkgDaemonHttpError {
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  return new DkgDaemonHttpError(message, status, body);
}

export interface DkgClientOptions {
  /** Base URL of the DKG daemon (default: "http://127.0.0.1:9200"). */
  baseUrl?: string;
  /** Bearer token for daemon API auth. If omitted, tries `<dkgHome>/auth.token`. */
  apiToken?: string;
  /**
   * T70 â€” DKG home directory used to read `auth.token` when `apiToken` is
   * not supplied. Caller (typically `DkgNodePlugin.register`) passes the
   * runtime-resolved home (`resolveDkgHome({daemonUrl})`) so the constructor
   * fallback reads from the right place when the active daemon is in
   * `~/.dkg-dev` (monorepo) vs `~/.dkg` (npm). Without this, an absent
   * `auth.token` in the resolved home would silently fall through to the
   * default `~/.dkg/auth.token`, picking up a stale npm-side token while
   * the live daemon is at `~/.dkg-dev` (the very bug T70 set out to fix).
   */
  dkgHome?: string;
  /** Request timeout in ms (default: 30 000). */
  timeoutMs?: number;
}

export interface OpenClawAttachmentRef {
  assertionUri: string;
  assertionName?: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  markdownHash?: string;
  markdownForm?: string;
}

export interface ImportedArtifactRequest {
  contextGraphId: string;
  assertionUri: string;
  assertionName?: string;
  fileHash?: string;
  subGraphName?: string;
}

export interface ImportedArtifactResolution {
  contextGraphId: string;
  assertionUri: string;
  assertionName?: string;
  assertionAgentAddress?: string;
  subGraphName?: string;
  fileHash: string;
  sourceFileHash: string;
  detectedContentType: string;
  sourceContentType: string;
  extractionStatus: 'completed';
  extractionMethod?: string;
  rootEntity?: string;
  sourceFileName?: string;
  tripleCount?: number;
  structuralTripleCount?: number;
  semanticTripleCount?: number;
  mdIntermediateHash?: string;
  markdownForm?: string;
  markdownHash?: string;
  canReadMarkdown: boolean;
  ownerGuardRelaxed?: boolean;
}

export interface SemanticEnrichmentWriteRequest extends ImportedArtifactRequest {
  semanticQuads: Array<{ subject: string; predicate: string; object: string }>;
  generationMethod?: string;
  agentIdentity?: string;
  generatedAt?: string;
}

export interface ChatTurnStoreStatus {
  hasAnyChatTurnData: boolean;
  existingSessionIds: string[];
}

export interface LocalAgentIntegrationCapabilities {
  localChat?: boolean;
  connectFromUi?: boolean;
  installNode?: boolean;
  dkgPrimaryMemory?: boolean;
  wmImportPipeline?: boolean;
  nodeServedSkill?: boolean;
  chatAttachments?: boolean;
}

export interface LocalAgentIntegrationTransport {
  kind?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  healthUrl?: string;
}

export interface LocalAgentIntegrationManifest {
  packageName?: string;
  version?: string;
  setupEntry?: string;
}

export interface LocalAgentIntegrationRuntime {
  status?: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
  ready?: boolean;
  lastError?: string | null;
  updatedAt?: string;
}

export interface LocalAgentIntegrationPayload {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: LocalAgentIntegrationTransport;
  capabilities?: LocalAgentIntegrationCapabilities;
  manifest?: LocalAgentIntegrationManifest;
  setupEntry?: string;
  metadata?: Record<string, unknown>;
  runtime?: LocalAgentIntegrationRuntime;
}

export interface LocalAgentIntegrationRecord extends LocalAgentIntegrationPayload {
  status?: string;
  connectedAt?: string;
  updatedAt?: string;
}

/**
 * T63 â€” Shape of `/api/agent/identity` response.
 *
 * Mirrors the daemon route handler at
 * `packages/cli/src/daemon/routes/agent-chat.ts:391`. `agentAddress` is the
 * canonical EIP-55 form (set from `verifyWallet.address` at agent
 * registration). The adapter trusts this verbatim and never re-checksums.
 */
export interface AgentIdentity {
  agentAddress: string;
  agentDid: string;
  name: string;
  framework?: string;
  peerId: string;
  nodeIdentityId: string;
}

const CHAT_TURNS_CONTEXT_GRAPH_ID = 'agent-context';
const CHAT_TURNS_ASSERTION_NAME = 'chat-turns';
const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';

export function normalizeContextGraphId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(CONTEXT_GRAPH_URI_PREFIX)
    ? trimmed.slice(CONTEXT_GRAPH_URI_PREFIX.length)
    : trimmed;
}

function optionalContextGraphId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return normalizeContextGraphId(value) || undefined;
}

function normalizeContextGraphRequest<T extends { contextGraphId: string }>(request: T): T {
  return {
    ...request,
    contextGraphId: normalizeContextGraphId(request.contextGraphId),
  };
}

function queryBindings(result: any): Array<Record<string, unknown>> {
  const candidates = [
    result?.results?.bindings,
    result?.result?.bindings,
    result?.result?.results?.bindings,
    result?.bindings,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>;
  }
  return [];
}

function bindingValue(binding: Record<string, unknown>, key: string): string | undefined {
  const value = binding[key];
  if (typeof value === 'string') return stripRdfLiteral(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.value === 'string') return stripRdfLiteral(record.value);
    if (typeof record.id === 'string') return stripRdfLiteral(record.id);
  }
  return undefined;
}

function stripRdfLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-zA-Z-]+)?$/);
  return typed ? typed[1] : value;
}

function bindingCount(result: any): number {
  const binding = queryBindings(result)[0];
  if (!binding) return 0;
  const value = bindingValue(binding, 'c') ?? bindingValue(binding, 'count');
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isChatTurnStoreNotFoundError(err: unknown): boolean {
  // Only treat a daemon 404 as "no chat-turn data yet" when the error
  // message names the specific assertion this query reads. Broader
  // substring matches (just "not found" / "context" / "graph") would
  // swallow unrelated 404s and silently clear local cursor state via
  // validateUntrustedDurableCursorsBeforeW4a, turning real daemon
  // failures into cold-start replays.
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (!lower.includes('responded 404')) return false;
  return lower.includes(CHAT_TURNS_ASSERTION_NAME);
}

/**
 * Author attestation produced by an external signer. Mirrors the
 * `packages/cli/src/api-client.ts` reference so the finalize/create KA flows
 * can carry a pre-built EIP-712 attestation instead of signing on the daemon.
 */
export interface PreSignedAuthorAttestationPayload {
  address: string;
  /**
   * OT-RFC-43 Â§F2 â€” the packed reservedKaId the author signed the
   * AuthorAttestation over, as a decimal string (uint256-safe over JSON).
   * Required: the daemon binds it into the digest and honours the reserved slot.
   */
  reservedKaId: string;
  signature: { r: string; vs: string };
}

/**
 * VM-publish controls for the finalized-assertion publish path. Mirrors
 * `KnowledgeAssetFinalizedPublishOptions` in `packages/cli/src/api-client.ts`
 * verbatim so every first-party client exposes the same surface.
 */
export interface KnowledgeAssetFinalizedPublishOptions {
  /**
   * SDK-friendly spelling for the finalized publish cleanup flag. The
   * knowledge-assets daemon route forwards `clearSharedMemoryAfter` to
   * `publishFromFinalizedAssertion`, so the client translates before POST.
   */
  clearAfter?: boolean;
  publishEpochs?: number;
  publisherNodeIdentityIdOverride?: bigint;
}

const FINALIZED_PUBLISH_OPTION_KEYS = new Set([
  'clearAfter',
  'publishEpochs',
  'publisherNodeIdentityIdOverride',
]);

function assertExclusiveAuthorFields(args: {
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
}): void {
  if (args.authorAgentAddress != null && args.preSignedAuthorAttestation != null) {
    throw new Error('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
  }
}

function assertCreateFinalizeFieldsHaveQuads(args: {
  quads?: unknown[];
  finalize?: boolean;
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
}): void {
  const hasFinalizeOnlyField =
    args.authorAgentAddress != null ||
    args.preSignedAuthorAttestation != null ||
    args.schemeVersion !== undefined;
  // These fields only take effect at finalize, so they require both non-empty
  // quads AND finalize !== false â€” mirrors the daemon create-route guard.
  const willFinalize = Array.isArray(args.quads) && args.quads.length > 0 && args.finalize !== false;
  if (hasFinalizeOnlyField && !willFinalize) {
    throw new Error('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads and finalize !== false');
  }
}

/** Translate {@link KnowledgeAssetFinalizedPublishOptions} into the daemon body. */
function finalizedPublishOptionsPayload(
  options?: KnowledgeAssetFinalizedPublishOptions,
  allowedExtraKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter(
    (key) => !FINALIZED_PUBLISH_OPTION_KEYS.has(key) && !allowedExtraKeys.includes(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const payload: Record<string, unknown> = {};
  if (options.clearAfter !== undefined) payload.clearSharedMemoryAfter = options.clearAfter;
  if (options.publishEpochs !== undefined) payload.publishEpochs = options.publishEpochs;
  if (options.publisherNodeIdentityIdOverride !== undefined) {
    payload.publisherNodeIdentityIdOverride = options.publisherNodeIdentityIdOverride.toString();
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function createAlsoPublishVmPayload(value: unknown): boolean | Record<string, unknown> {
  if (typeof value === 'boolean') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) return {};
    const payload = finalizedPublishOptionsPayload(value as KnowledgeAssetFinalizedPublishOptions);
    if (payload) return payload;
    throw new Error(
      'alsoPublishVm options object must include at least one supported option; use true to publish with defaults',
    );
  }
  throw new Error('alsoPublishVm must be a boolean or publish-options object');
}

export class DkgDaemonClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiToken: string | undefined;

  constructor(opts?: DkgClientOptions) {
    this.baseUrl = stripTrailingSlashes(opts?.baseUrl ?? 'http://127.0.0.1:9200');
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.apiToken = opts?.apiToken ?? DkgDaemonClient.loadTokenFromFile(opts?.dkgHome);
  }

  private static loadTokenFromFile(dkgHome?: string): string | undefined {
    return loadAuthTokenSync(dkgHome);
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiToken) return {};
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  getAuthToken(): string | undefined {
    return this.apiToken;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<{ ok: boolean; peerId?: string; error?: string }> {
    try {
      const data = await this.get<Record<string, unknown>>('/api/status');
      return { ok: true, peerId: data.peerId as string | undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Probe the daemon's `/api/agent/identity` route using the client's normal
   * constructor-loaded node-level Bearer token.
   *
   * The daemon resolves unknown node-level tokens to its default agent address,
   * so the response is the canonical WM identity the adapter should cache.
   * Failure shape mirrors `getStatus()`: `{ ok: false, error }` for transport,
   * 401, and 5xx responses so the probe site can branch without try/catch.
   */
  async getAgentIdentity(): Promise<{
    ok: boolean;
    identity?: AgentIdentity;
    error?: string;
  }> {
    try {
      const data = await this.get<Record<string, unknown>>('/api/agent/identity');
      return {
        ok: true,
        identity: {
          agentAddress: String(data.agentAddress ?? ''),
          agentDid: String(data.agentDid ?? ''),
          name: String(data.name ?? ''),
          framework: typeof data.framework === 'string' ? data.framework : undefined,
          peerId: String(data.peerId ?? ''),
          nodeIdentityId: String(data.nodeIdentityId ?? ''),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // SPARQL query
  // ---------------------------------------------------------------------------

  /**
   * Run a SPARQL query against the daemon. Forwards the full V10 field set
   * the `/api/query` route accepts â€” `view` (`'working-memory' | 'shared-working-memory' | 'verifiable-memory'`),
   * `agentAddress` (required for WM reads), `assertionName` (scopes WM reads
   * to a single per-agent assertion), `subGraphName`, `verifiedGraph`,
   * `graphSuffix`, `includeSharedMemory`.
   */
  async query(
    sparql: string,
    opts?: {
      contextGraphId?: string;
      graphSuffix?: string;
      includeSharedMemory?: boolean;
      view?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
      verifiedGraph?: string;
      /**
       * P-13: minimum trust level. Only meaningful for
       * `view: "verifiable-memory"`; ignored (silently) on WM/SWM views.
       *
       * The daemon implements only `SelfAttested` / `Endorsed` today â€”
       * higher tiers (Q-1 follow-up) are rejected with HTTP 400, so the
       * public client surface only advertises the implementable values.
       * See `packages/query/src/query-engine.ts QueryOptions.minTrust`.
       */
      minTrust?: 'SelfAttested' | 'Endorsed' | 0 | 1;
    },
  ): Promise<any> {
    const contextGraphId = optionalContextGraphId(opts?.contextGraphId);
    return this.post('/api/query', {
      sparql,
      contextGraphId,
      graphSuffix: opts?.graphSuffix,
      includeSharedMemory: opts?.includeSharedMemory,
      view: opts?.view,
      agentAddress: opts?.agentAddress,
      assertionName: opts?.assertionName,
      subGraphName: opts?.subGraphName,
      verifiedGraph: opts?.verifiedGraph,
      minTrust: opts?.minTrust,
    });
  }

  // ---------------------------------------------------------------------------
  // Query catalog
  // ---------------------------------------------------------------------------

  /**
   * Read saved profile query catalog entries for a context graph.
   *
   * The daemon stores these as local profile metadata in
   * `did:dkg:context-graph:<id>/meta/query-catalog`; callers usually run the
   * returned `prof:sparqlQuery` text through `query()`.
   */
  async readQueryCatalog(contextGraphId: string): Promise<Record<string, unknown>> {
    return this.post('/api/profile/query-catalog/read', { contextGraphId: normalizeContextGraphId(contextGraphId) });
  }

  /**
   * Append profile query catalog triples for a context graph.
   *
   * The daemon ignores caller-supplied graph names and writes into the
   * context graph's local `meta/query-catalog` profile graph.
   */
  async writeQueryCatalog(
    contextGraphId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
  ): Promise<Record<string, unknown>> {
    return this.post('/api/profile/query-catalog/write', { contextGraphId: normalizeContextGraphId(contextGraphId), quads });
  }

  // ---------------------------------------------------------------------------
  // Working Memory â€” assertion lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a per-agent Working Memory assertion graph inside a context graph.
   * Idempotent on the client side: 400 `"already exists"` errors from the
   * daemon are swallowed and returned as `{ assertionUri: null, alreadyExists: true }`.
   * Any other error surfaces normally.
   */
  async createAssertion(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<{ assertionUri: string | null; alreadyExists: boolean }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    try {
      const response = await this.post<{ assertionUri: string }>(
        '/api/knowledge-assets',
        { contextGraphId: cgId, name, subGraphName: opts?.subGraphName },
      );
      return { assertionUri: response.assertionUri, alreadyExists: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        return { assertionUri: null, alreadyExists: true };
      }
      throw err;
    }
  }

  /**
   * Append quads into an existing Working Memory assertion. The assertion
   * must have been created first â€” callers that create-then-write in a
   * single call should use `ensureAssertion` + `writeAssertion` together,
   * with `createAssertion` swallowing duplicates.
   */
  async writeAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { subGraphName?: string },
  ): Promise<{ written: number }> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      quads,
      subGraphName: opts?.subGraphName,
    });
  }

  /**
   * Promote a Working Memory assertion (or a subset of its root entities) to
   * Shared Working Memory. `entities` defaults to `"all"` server-side when
   * omitted; callers can pin specific root entity URIs via an array.
   */
  async promoteAssertion(
    contextGraphId: string,
    name: string,
    opts?: { entities?: string[] | 'all'; subGraphName?: string },
  ): Promise<Record<string, unknown>> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      entities: opts?.entities,
      subGraphName: opts?.subGraphName,
    });
  }

  /**
   * Discard a Working Memory assertion without promoting it. Returns
   * `{ discarded: true }` on success; the daemon surfaces 400 for invalid
   * names or missing assertions.
   */
  async discardAssertion(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<{ discarded: boolean }> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/discard`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      subGraphName: opts?.subGraphName,
    });
  }

  /**
   * Dump all quads from a single Working Memory assertion's graph. This is
   * not a SPARQL endpoint â€” the daemon returns every quad in the assertion
   * as `{ quads, count }`. For ad-hoc SPARQL use `query()` with
   * `view: 'working-memory'` + `assertionName` instead.
   */
  async queryAssertion(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<{ quads: unknown[]; count: number }> {
    const params = new URLSearchParams({
      contextGraphId: normalizeContextGraphId(contextGraphId),
    });
    if (opts?.subGraphName) params.set('subGraphName', opts.subGraphName);
    return this.get(
      `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads?${params.toString()}`,
    );
  }

  /**
   * Resolve deterministic import metadata for a completed attachment ref.
   * This does not read arbitrary paths; it only returns graph/file-store
   * metadata already attached to the imported assertion.
   */
  async resolveImportArtifact(
    request: ImportedArtifactRequest,
  ): Promise<{ artifact: ImportedArtifactResolution }> {
    return this.post('/api/knowledge-assets/import-artifact/resolve', normalizeContextGraphRequest(request));
  }

  /**
   * Read the Markdown source for a completed imported assertion. The daemon
   * resolves the markdown hash from deterministic import metadata and reads
   * the content-addressed file store; callers never supply filesystem paths.
   */
  async readImportArtifactMarkdown(
    request: ImportedArtifactRequest & { maxBytes?: number },
  ): Promise<{
    artifact: ImportedArtifactResolution;
    markdownHash: string;
    contentType: 'text/markdown';
    bytes: number;
    markdown: string;
  }> {
    return this.post('/api/knowledge-assets/import-artifact/read-markdown', normalizeContextGraphRequest(request));
  }

  /**
   * Append model-derived semantic triples into the completed imported assertion
   * with provenance. The daemon intentionally does not promote or publish.
   */
  async writeSemanticEnrichment(
    request: SemanticEnrichmentWriteRequest,
  ): Promise<Record<string, unknown>> {
    return this.post('/api/knowledge-assets/semantic-enrichment/write', normalizeContextGraphRequest(request));
  }

  /**
   * Fetch the lifecycle descriptor for an assertion (creation time, author,
   * latest extraction status, promotion state). Throws a 404-bearing error
   * when no record exists for the given (contextGraphId, name, agentAddress).
   */
  async getAssertionHistory(
    contextGraphId: string,
    name: string,
    opts?: { agentAddress?: string; subGraphName?: string },
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ contextGraphId: normalizeContextGraphId(contextGraphId) });
    if (opts?.agentAddress) params.set('agentAddress', opts.agentAddress);
    if (opts?.subGraphName) params.set('subGraphName', opts.subGraphName);
    return this.get(
      `/api/knowledge-assets/${encodeURIComponent(name)}?${params.toString()}`,
    );
  }

  /**
   * Import a document (markdown, PDF, etc.) into a Working Memory assertion
   * via multipart/form-data. The daemon runs its extraction pipeline and
   * writes the resulting triples into the assertion's graph.
   *
   * Callers pass raw file bytes (Buffer/Uint8Array) and a filename; the
   * client constructs the multipart form locally using Node 18+ globals
   * (`FormData`, `Blob`). When `contentType` is supplied, the daemon's
   * `normalizeDetectedContentType` picks it up from the explicit form field;
   * otherwise the daemon falls back to the file part's Content-Type header
   * (set here from the Blob's `type`).
   */
  async importAssertionFile(
    contextGraphId: string,
    name: string,
    fileBuffer: Buffer | Uint8Array,
    fileName: string,
    opts?: { contentType?: string; ontologyRef?: string; subGraphName?: string },
  ): Promise<Record<string, unknown>> {
    const cgId = normalizeContextGraphId(contextGraphId);
    const form = new FormData();
    // Copy into a fresh Uint8Array to satisfy TS's BlobPart union across Node Buffer / SharedArrayBuffer.
    const bytes = new Uint8Array(fileBuffer.byteLength);
    bytes.set(fileBuffer);
    const blob = new Blob([bytes], { type: opts?.contentType ?? 'application/octet-stream' });
    form.append('file', blob, fileName);
    form.append('contextGraphId', cgId);
    if (opts?.contentType) form.append('contentType', opts.contentType);
    if (opts?.ontologyRef) form.append('ontologyRef', opts.ontologyRef);
    if (opts?.subGraphName) form.append('subGraphName', opts.subGraphName);

    const res = await fetch(
      `${this.baseUrl}/api/knowledge-assets/${encodeURIComponent(name)}/wm/import-file`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', ...this.authHeaders() },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw daemonHttpError(
        `DKG daemon /api/knowledge-assets/${name}/wm/import-file responded ${res.status}: ${text}`,
        res.status,
        text,
      );
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  // ---------------------------------------------------------------------------
  // Sub-graphs
  // ---------------------------------------------------------------------------

  /**
   * Create a named sub-graph inside a context graph. Sub-graphs partition a
   * CG into organizational regions that assertions can target at
   * create/write/import time.
   */
  async createSubGraph(
    contextGraphId: string,
    subGraphName: string,
  ): Promise<{ created: string; contextGraphId: string }> {
    return this.post('/api/sub-graph/create', { contextGraphId: normalizeContextGraphId(contextGraphId), subGraphName });
  }

  /**
   * List all registered sub-graphs for a context graph, with best-effort
   * per-sub-graph entity / triple counts.
   */
  async listSubGraphs(
    contextGraphId: string,
  ): Promise<{
    contextGraphId: string;
    subGraphs: Array<{
      name: string;
      uri: string;
      description?: string;
      createdBy?: string;
      createdAt?: string;
      entityCount: number;
      tripleCount: number;
    }>;
  }> {
    const params = new URLSearchParams({ contextGraphId: normalizeContextGraphId(contextGraphId) });
    return this.get(`/api/sub-graph/list?${params.toString()}`);
  }

  // ---------------------------------------------------------------------------
  // Chat turn persistence  (reuses the existing ChatMemoryManager pathway)
  // ---------------------------------------------------------------------------

  async getChatTurnStoreStatus(sessionIds: string[]): Promise<ChatTurnStoreStatus> {
    const identity = await this.getAgentIdentity();
    const agentAddress = identity.ok ? identity.identity?.agentAddress?.trim() : '';
    if (!agentAddress) {
      throw new Error(
        `Unable to resolve daemon agent identity for chat-turn WM status: ${identity.error ?? 'missing agentAddress'}`,
      );
    }
    const wmReadOpts = {
      contextGraphId: CHAT_TURNS_CONTEXT_GRAPH_ID,
      view: 'working-memory' as const,
      assertionName: CHAT_TURNS_ASSERTION_NAME,
      agentAddress,
    };
    try {
      const countResult = await this.query(
        'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }',
        wmReadOpts,
      );
      const hasAnyChatTurnData = bindingCount(countResult) > 0;
      if (!hasAnyChatTurnData) {
        return { hasAnyChatTurnData: false, existingSessionIds: [] };
      }
      const uniqueSessionIds = Array.from(new Set(
        sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean),
      ));
      if (uniqueSessionIds.length === 0) {
        return { hasAnyChatTurnData: true, existingSessionIds: [] };
      }
      const sessionValues = uniqueSessionIds.map((sessionId) => JSON.stringify(sessionId)).join(' ');
      const sessionResult = await this.query(
        `SELECT DISTINCT ?sid WHERE {
          VALUES ?sid { ${sessionValues} }
          ?session <${RDF_TYPE}> <${SCHEMA}Conversation> .
          ?session <${DKG_ONT}sessionId> ?sid .
        }`,
        wmReadOpts,
      );
      const requested = new Set(uniqueSessionIds);
      const existingSessionIds = Array.from(new Set(
        queryBindings(sessionResult)
          .map((binding) => bindingValue(binding, 'sid'))
          .filter((value): value is string => typeof value === 'string' && requested.has(value)),
      ));
      return { hasAnyChatTurnData: true, existingSessionIds };
    } catch (err) {
      if (isChatTurnStoreNotFoundError(err)) {
        return { hasAnyChatTurnData: false, existingSessionIds: [] };
      }
      throw err;
    }
  }

  /**
   * Persist a chat turn through the daemon's `/api/openclaw-channel/persist-turn`
   * route, which delegates to `ChatMemoryManager.storeChatExchange`. As of
   * v1 of the openclaw-dkg-primary-memory work the downstream writer targets
   * the `'chat-turns'` Working Memory assertion of the `'agent-context'`
   * context graph via `agent.assertion.write`, not `agent.share`.
   */
  async storeChatTurn(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    opts?: {
      turnId?: string;
      toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
      attachmentRefs?: OpenClawAttachmentRef[];
      persistenceState?: 'stored' | 'failed' | 'pending';
      failureReason?: string | null;
    },
  ): Promise<void> {
    await this.post('/api/openclaw-channel/persist-turn', {
      sessionId,
      userMessage,
      assistantReply,
      turnId: opts?.turnId,
      toolCalls: opts?.toolCalls,
      attachmentRefs: opts?.attachmentRefs,
      persistenceState: opts?.persistenceState,
      failureReason: opts?.failureReason,
    });
  }

  // ---------------------------------------------------------------------------
  // Memory stats
  // ---------------------------------------------------------------------------

  async getMemoryStats(): Promise<{ initialized: boolean; messageCount: number; totalTriples: number }> {
    return this.get('/api/memory/stats');
  }

  // ---------------------------------------------------------------------------
  // Node status (full)
  // ---------------------------------------------------------------------------

  async getFullStatus(): Promise<Record<string, unknown>> {
    return this.get('/api/status');
  }

  // ---------------------------------------------------------------------------
  // Local agent integration registration
  // ---------------------------------------------------------------------------

  async registerAdapter(id: string): Promise<void> {
    await this.connectLocalAgentIntegration({ id });
  }

  async connectLocalAgentIntegration(payload: LocalAgentIntegrationPayload): Promise<Record<string, unknown>> {
    return this.post('/api/local-agent-integrations/connect', payload);
  }

  async getLocalAgentIntegration(id: string): Promise<LocalAgentIntegrationRecord | null> {
    try {
      const response = await this.get<{ integration?: LocalAgentIntegrationRecord }>(
        `/api/local-agent-integrations/${encodeURIComponent(id)}`,
      );
      return response.integration ?? null;
    } catch (err) {
      if (err instanceof Error && err.message.includes('responded 404')) {
        return null;
      }
      throw err;
    }
  }

  async updateLocalAgentIntegration(
    id: string,
    payload: Omit<LocalAgentIntegrationPayload, 'id'>,
  ): Promise<Record<string, unknown>> {
    return this.put(`/api/local-agent-integrations/${encodeURIComponent(id)}`, payload);
  }

  // ---------------------------------------------------------------------------
  // Context graph participant management
  // ---------------------------------------------------------------------------

  async inviteToContextGraph(
    contextGraphId: string,
    peerId: string,
  ): Promise<{ invited: string; contextGraphId: string }> {
    return this.post('/api/context-graph/invite', { contextGraphId: normalizeContextGraphId(contextGraphId), peerId });
  }

  async addParticipant(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<{ ok: boolean; contextGraphId: string; agentAddress: string }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.post(`/api/context-graph/${encodeURIComponent(cgId)}/add-participant`, { agentAddress });
  }

  async removeParticipant(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<{ ok: boolean; contextGraphId: string; agentAddress: string }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.post(`/api/context-graph/${encodeURIComponent(cgId)}/remove-participant`, { agentAddress });
  }

  async listParticipants(
    contextGraphId: string,
  ): Promise<{ contextGraphId: string; allowedAgents: string[] }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.get(`/api/context-graph/${encodeURIComponent(cgId)}/participants`);
  }

  async listJoinRequests(
    contextGraphId: string,
  ): Promise<{
    contextGraphId: string;
    requests: Array<{
      agentAddress: string;
      status: string;
      timestamp?: string;
      agentName?: string;
    }>;
  }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.get(`/api/context-graph/${encodeURIComponent(cgId)}/join-requests`);
  }

  async approveJoinRequest(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<{ ok: boolean; status: string; agentAddress: string }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.post(`/api/context-graph/${encodeURIComponent(cgId)}/approve-join`, { agentAddress });
  }

  async rejectJoinRequest(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<{ ok: boolean; status: string; agentAddress: string }> {
    const cgId = normalizeContextGraphId(contextGraphId);
    return this.post(`/api/context-graph/${encodeURIComponent(cgId)}/reject-join`, { agentAddress });
  }

  // ---------------------------------------------------------------------------
  // Agents & skills discovery
  // ---------------------------------------------------------------------------

  async getAgents(filter?: { framework?: string; skill_type?: string }): Promise<{ agents: any[] }> {
    const params = new URLSearchParams();
    if (filter?.framework) params.set('framework', filter.framework);
    if (filter?.skill_type) params.set('skill_type', filter.skill_type);
    const qs = params.toString();
    return this.get(`/api/agents${qs ? `?${qs}` : ''}`);
  }

  async getSkills(filter?: { skillType?: string }): Promise<{ skills: any[] }> {
    const params = new URLSearchParams();
    if (filter?.skillType) params.set('skillType', filter.skillType);
    const qs = params.toString();
    return this.get(`/api/skills${qs ? `?${qs}` : ''}`);
  }

  // ---------------------------------------------------------------------------
  // P2P messaging
  // ---------------------------------------------------------------------------

  async sendChat(to: string, text: string): Promise<any> {
    return this.post('/api/chat', { to, text });
  }

  async getMessages(opts?: { peer?: string; limit?: number; since?: number }): Promise<{ messages: any[] }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.since != null) params.set('since', String(opts.since));
    const qs = params.toString();
    return this.get(`/api/messages${qs ? `?${qs}` : ''}`);
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  /**
   * One-shot publish with explicit quads. This uses the daemon's direct
   * publish route, so core StorageACK requests carry the publish payload
   * instead of assuming target cores already have the data in SWM.
   */
  async publish(
    contextGraphId: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    privateQuads?: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { accessPolicy?: 'public' | 'ownerOnly' | 'allowList'; allowedPeers?: string[] },
  ): Promise<any> {
    const cgId = normalizeContextGraphId(contextGraphId);
    const wireQuads = quads.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
      graph: q.graph ?? '',
    }));
    const wirePrivateQuads = privateQuads?.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
      graph: q.graph ?? '',
    }));
    return this.post('/api/knowledge-assets/publish', {
      contextGraphId: cgId,
      quads: wireQuads,
      ...(wirePrivateQuads !== undefined ? { privateQuads: wirePrivateQuads } : {}),
      ...(opts?.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts?.allowedPeers !== undefined ? { allowedPeers: opts.allowedPeers } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Context Graphs
  // ---------------------------------------------------------------------------

  async listContextGraphs(): Promise<{ contextGraphs: any[] }> {
    return this.get('/api/context-graph/list');
  }

  async createContextGraph(
    id: string,
    name: string,
    description?: string,
    opts?: { accessPolicy?: number; allowedAgents?: string[] },
  ): Promise<{ created: string; uri: string }> {
    const body: Record<string, unknown> = { id, name, description };
    if (typeof opts?.accessPolicy === 'number') {
      body.accessPolicy = opts.accessPolicy;
    }
    if (Array.isArray(opts?.allowedAgents) && opts.allowedAgents.length > 0) {
      body.allowedAgents = opts.allowedAgents;
    }
    return this.post('/api/context-graph/create', body);
  }

  async registerContextGraph(
    id: string,
    opts?: { accessPolicy?: number },
  ): Promise<{ registered: string; onChainId: string; txHash?: string; hint?: string }> {
    return this.post('/api/context-graph/register', { id: normalizeContextGraphId(id), ...opts });
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  async subscribe(
    contextGraphId: string,
    opts?: { includeSharedMemory?: boolean },
  ): Promise<{ subscribed: string; catchup: { jobId: string; status: string; includeSharedMemory: boolean } }> {
    return this.post('/api/subscribe', {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      includeSharedMemory: opts?.includeSharedMemory,
    });
  }

  // ---------------------------------------------------------------------------
  // Wallet balances
  // ---------------------------------------------------------------------------

  async getWalletBalances(): Promise<{
    wallets: string[];
    balances: Array<{ address: string; eth: string; trac: string; symbol: string }>;
    chainId: string | null;
    rpcUrl: string | null;
    error?: string;
  }> {
    return this.get('/api/wallets/balances');
  }

  // ---------------------------------------------------------------------------
  // Skill invocation
  // ---------------------------------------------------------------------------

  async invokeSkill(peerId: string, skillUri: string, input?: string): Promise<any> {
    return this.post('/api/invoke-skill', { peerId, skillUri, input });
  }

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------

  async getWallets(): Promise<{ wallets: string[] }> {
    return this.get('/api/wallets');
  }

  // ---------------------------------------------------------------------------
  // HTTP primitives
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { 'Accept': 'application/json', ...this.authHeaders() };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw daemonHttpError(`DKG daemon ${path} responded ${res.status}: ${text}`, res.status, text);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw daemonHttpError(`DKG daemon ${path} responded ${res.status}: ${text}`, res.status, text);
    }
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw daemonHttpError(`DKG daemon ${path} responded ${res.status}: ${text}`, res.status, text);
    }
    return res.json() as Promise<T>;
  }

  // â”€â”€ OT-RFC-43 Â§10.5 â€” GitHub-shaped Knowledge Asset client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Layer-explicit wrappers over the clean /api/knowledge-assets/... surface.
  // One file = one Knowledge Asset (Design B / OT-RFC-44), carrying any number
  // of member entities. WM â†’ SWM â†’ VM via the git-shaped verbs write â†’
  // finalize â†’ share â†’ publish.

  /**
   * Create a KA + open its WM draft. Pass `quads` to atomically write+seal.
   * #1116 D5: this combined CLIENT function defaults `alsoShareSwm` to true when
   * the draft will seal (quads present and `finalize !== false`), so the
   * one-shot seals AND shares to SWM. Pass `alsoShareSwm: false` to stop at a
   * sealed WM draft, or `finalize: false` to keep an unsealed editable WM draft.
   * (The bare daemon route is a primitive â€” seal-only â€” and never auto-shares;
   * the default-share lives here in the client.)
   */
  async createKnowledgeAsset(
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      quads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
      /**
       * Seal the draft after writing `quads` (default true). `false` keeps an
       * editable WM draft that never touches the chain â€” the only lifecycle
       * available to local-only / on-chain-unregistered CGs. Cannot be combined
       * with `alsoShareSwm`/`alsoPublishVm` (those require a sealed assertion).
       */
      finalize?: boolean;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
      alsoShareSwm?: boolean;
      alsoPublishVm?: boolean | KnowledgeAssetFinalizedPublishOptions;
    },
  ): Promise<Record<string, unknown>> {
    assertExclusiveAuthorFields(opts ?? {});
    assertCreateFinalizeFieldsHaveQuads(opts ?? {});
    const payload: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      name,
      ...(opts ?? {}),
    };
    // #1116 D5: the combined client SEALS AND SHARES TO SWM by default. When
    // quads are present and the draft will seal (finalize !== false), default
    // `alsoShareSwm` to true so the one-shot lands the asset in SWM. An explicit
    // `alsoShareSwm` (true OR false, already copied by the spread) always wins;
    // never default-on when there are no quads or `finalize:false`. The bare
    // daemon route stays a primitive (seal-only); the default-share is a
    // CLIENT-side convenience.
    const sealsByDefault =
      Array.isArray(opts?.quads) && opts.quads.length > 0 && opts?.finalize !== false;
    if (opts?.alsoShareSwm === undefined && sealsByDefault) {
      payload.alsoShareSwm = true;
    }
    // Object form carries finalized-publish controls; translate to the daemon
    // body shape (mirrors the cli ApiClient). Booleans pass through.
    if (opts?.alsoPublishVm !== undefined) {
      payload.alsoPublishVm = createAlsoPublishVmPayload(opts.alsoPublishVm);
    }
    return this.post('/api/knowledge-assets', payload);
  }

  /** GET a KA's per-layer lifecycle state by name. */
  async getKnowledgeAsset(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      contextGraphId: normalizeContextGraphId(contextGraphId),
      ...(opts?.subGraphName ? { subGraphName: opts.subGraphName } : {}),
    }).toString();
    return this.get(`/api/knowledge-assets/${encodeURIComponent(name)}?${qs}`);
  }

  /** Append quads to the KA's WM draft (git add/edit). */
  async knowledgeAssetWrite(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
    opts?: { subGraphName?: string },
  ): Promise<{ written: number }> {
    // Strip any per-quad `graph` at the client (CONTRACT Â§A): the write wire
    // shape is `{subject, predicate, object}` only and the daemon pins every
    // quad to the per-KA WM graph (Â§0 invariant 2), so a caller-supplied or
    // normalizer-emitted `graph` is dropped here â€” not just in the tool schema.
    const wireQuads = quads.map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
    }));
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/write`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      quads: wireQuads,
      ...(opts ?? {}),
    });
  }

  /** Seal the WM draft â€” computes the merkle root + signs the seal (git commit). */
  async knowledgeAssetFinalize(
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
      schemeVersion?: number;
      // #1116: "wm" (default) seals the open WM draft; "swm" seals an asset
      // already shared to SWM (recover-without-recreate).
      layer?: 'wm' | 'swm';
    },
  ): Promise<{ merkleRoot: string; eip712Digest: string }> {
    assertExclusiveAuthorFields(opts ?? {});
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      ...(opts ?? {}),
    });
  }

  /** Discard the open WM draft (git checkout -- .). */
  async knowledgeAssetDiscard(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ): Promise<{ discarded: boolean }> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/discard`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      ...(opts ?? {}),
    });
  }

  /** Seed a fresh WM draft from the file's current SWM/VM state (git checkout). */
  async knowledgeAssetPullFrom(
    contextGraphId: string,
    name: string,
    layer: 'swm' | 'vm',
    opts?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
  ): Promise<Record<string, unknown>> {
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/pull-from`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      layer,
      ...(opts ?? {}),
    });
  }

  /** Advance the SWM pointer (WM â†’ SWM; git push origin <branch>). */
  async knowledgeAssetShare(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string; entities?: string[] | 'all'; skipSeal?: boolean },
  ): Promise<{ swmShared: boolean; promotedCount: number; sealed: boolean; publishReady: boolean }> {
    // Only include the optional fields when actually set â€” don't spread the whole
    // opts object (which would carry `entities: undefined` / `subGraphName:
    // undefined` keys). Parity with MCP's knowledgeAssetShare body construction.
    const body: Record<string, unknown> = {
      contextGraphId: normalizeContextGraphId(contextGraphId),
    };
    if (opts?.subGraphName) body.subGraphName = opts.subGraphName;
    if (opts?.entities !== undefined) body.entities = opts.entities;
    // #1116: a full share SEALS BY DEFAULT; `skipSeal:true` shares unsealed.
    if (opts?.skipSeal !== undefined) body.skipSeal = opts.skipSeal;
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, body);
  }

  /** Publish to VM â€” mint or update on chain (git push origin main). */
  async knowledgeAssetPublish(
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string } & KnowledgeAssetFinalizedPublishOptions,
  ): Promise<Record<string, unknown>> {
    const publishOptions = finalizedPublishOptionsPayload(opts, ['subGraphName']);
    return this.post(`/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
      contextGraphId: normalizeContextGraphId(contextGraphId),
      ...(opts?.subGraphName ? { subGraphName: opts.subGraphName } : {}),
      ...(publishOptions ? { options: publishOptions } : {}),
    });
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}
