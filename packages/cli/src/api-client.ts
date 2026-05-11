import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readApiPort, readPid, isProcessRunning } from './config.js';
import { loadTokens } from './auth.js';

export type QueryResult =
  | { type: 'bindings'; bindings: Array<Record<string, string>> }
  | { type: 'boolean'; value: boolean }
  | { type?: undefined; [key: string]: unknown };

/**
 * Response shape for `/api/random-sampling/status`. Mirrors
 * `RandomSamplingStatus` from `@origintrail-official/dkg-agent` but
 * lives here so the CLI doesn't take a runtime dep on the agent
 * package (only types). The `loop.lastOutcome` is intentionally
 * `unknown` — the CLI prints it as JSON; the structured discrimination
 * is the prover's concern, not the CLI's.
 */
export interface RandomSamplingStatusResponse {
  enabled: boolean;
  role: 'core' | 'edge';
  identityId: string;
  loop: null | {
    totalTicks: number;
    inflight: boolean;
    lastTickAt: string | null;
    lastOutcome: unknown;
    submittedCount: number;
    lastSubmittedTxHash: string | null;
    lastSubmittedAt: string | null;
  };
}

export class ApiClient {
  private baseUrl: string;
  private token?: string;

  constructor(portOrBaseUrl: number | string, token?: string) {
    this.baseUrl = typeof portOrBaseUrl === 'number'
      ? `http://127.0.0.1:${portOrBaseUrl}`
      : portOrBaseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  static async connect(): Promise<ApiClient> {
    const envPort = process.env.DKG_API_PORT
      ? parseInt(process.env.DKG_API_PORT, 10)
      : null;

    let port = envPort ?? (await readApiPort());

    if (!port) {
      const pid = await readPid();
      if (!pid || !isProcessRunning(pid)) {
        throw new Error('Daemon is not running. Start it with: dkg start');
      }
      throw new Error('Cannot read API port. Set DKG_API_PORT or restart: dkg stop && dkg start');
    }

    const tokens = await loadTokens();
    const token = tokens.size > 0 ? tokens.values().next().value : undefined;
    return new ApiClient(port, token);
  }

  async status(): Promise<{
    name: string;
    peerId: string;
    nodeRole?: string;
    networkId?: string;
    uptimeMs: number;
    connectedPeers: number;
    relayConnected: boolean;
    multiaddrs: string[];
  }> {
    return this.get('/api/status');
  }

  async agents(): Promise<{
    agents: Array<{ agentUri: string; name: string; peerId: string; framework?: string; nodeRole?: string }>;
  }> {
    return this.get('/api/agents');
  }

  /**
   * V10 Random Sampling prover snapshot. Cheap; safe to poll. Returns
   * `enabled: false` when the bind layer no-op'd (edge node, no
   * identity, or chain adapter missing methods); the `loop` field is
   * `null` in that case.
   */
  async randomSamplingStatus(): Promise<RandomSamplingStatusResponse> {
    return this.get('/api/random-sampling/status');
  }

  async peerInfo(peerId: string): Promise<{
    peerId: string;
    connected: boolean;
    connectionCount: number;
    transports: string[];
    directions: string[];
    remoteAddrs: Array<string | null>;
    protocols: string[];
    syncCapable: boolean;
    lastSeen: number | null;
    latencyMs: number | null;
  }> {
    return this.get(`/api/peer-info?peerId=${encodeURIComponent(peerId)}`);
  }

  async skills(): Promise<{
    skills: Array<{
      agentName: string; skillType: string;
      pricePerCall?: number; currency?: string;
    }>;
  }> {
    return this.get('/api/skills');
  }

  async sendChat(to: string, text: string): Promise<{ delivered: boolean; error?: string }> {
    return this.post('/api/chat', { to, text });
  }

  async messages(opts?: { peer?: string; since?: number; limit?: number }): Promise<{
    messages: Array<{
      ts: number; direction: 'in' | 'out';
      peer: string; peerName?: string; text: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.peer) params.set('peer', opts.peer);
    if (opts?.since) params.set('since', String(opts.since));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.get(`/api/messages${qs ? '?' + qs : ''}`);
  }

  /**
   * One-shot legacy publish: routed through the new assertion lifecycle
   * with an auto-generated assertion name. The seal carries the same
   * EIP-712 AuthorAttestation that the publisher used to derive at
   * chain-tx time; from a caller's perspective this is the same method
   * — only the on-the-wire route changed.
   *
   * Use `publishAssertion(contextGraphId, name, quads, opts)` directly
   * when you want to control the assertion name (for resumability,
   * audit, dedupe, etc.).
   */
  async publish(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>, privateQuads?: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>, options?: {
    accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
    publisherNodeIdentityIdOverride?: bigint;
  }): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
    batchId?: string;
    publisherAddress?: string;
  }> {
    if (privateQuads?.length || options?.accessPolicy || options?.allowedPeers?.length) {
      throw new Error(
        'privateQuads, accessPolicy, and allowedPeers are not supported in the V10 assertion-lifecycle publish flow. ' +
        'Re-think the publish: there is no longer a free-form SWM write that can carry private quads — ' +
        'every published assertion goes through finalize, which signs an EIP-712 attestation over the public quads.',
      );
    }
    const autoName = `cli-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.publishAssertion(contextGraphId, autoName, quads, {
      ...(options?.publisherNodeIdentityIdOverride !== undefined
        ? { publisherNodeIdentityIdOverride: options.publisherNodeIdentityIdOverride }
        : {}),
    });
  }

  /**
   * Direct SWM write — appends loose triples to shared memory without
   * creating a named WM assertion. Triples land ungrouped; downstream
   * selection-based publishes (see `publishFromSharedMemory`) seal
   * them at the publish boundary via the agent's selection bridge.
   *
   * Use this for "write loose content, decide what to publish later"
   * workflows (e.g. node-ui MemoryLayer, mcp `dkg_share`). For
   * sealed-from-creation provenance, use `createAssertion` /
   * `appendToAssertion` / `publishAssertion` instead — the seal then
   * binds to the named assertion at finalize time.
   */
  async sharedMemoryWrite(contextGraphId: string, quads: Array<{
    subject: string; predicate: string; object: string; graph: string;
  }>): Promise<{
    workspaceOperationId: string;
    shareOperationId?: string;
    contextGraphId: string;
    graph: string;
    triplesWritten: number;
    skolemizedBlankNodes?: number;
  }> {
    return this.post('/api/shared-memory/write', { contextGraphId, quads });
  }

  /**
   * Selection-based publish — publishes the selected SWM rootEntities
   * (or all SWM content) to verified memory. The agent mints the
   * AuthorAttestation seal inline at the selection boundary using
   * the calling agent's bearer-token identity / explicit
   * `authorAgentAddress` / `preSignedAuthorAttestation`, or falls
   * back to the publisher's wallet. The publisher refuses any
   * on-chain publish without a seal — sign-at-creation is preserved
   * at the daemon boundary regardless of which fork the caller used
   * to put content into SWM.
   *
   * For finalized-assertion publishes (seal from creation), use
   * `publishFromFinalizedAssertion` instead — that path threads the
   * already-signed seal through verbatim with no re-signing.
   */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] } = 'all',
    clearAfter = true,
    options?: { subGraphName?: string; publisherNodeIdentityIdOverride?: bigint },
  ): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    return this.post('/api/shared-memory/publish', {
      contextGraphId,
      selection,
      clearAfter,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
      ...(options?.publisherNodeIdentityIdOverride !== undefined
        ? { publisherNodeIdentityIdOverride: options.publisherNodeIdentityIdOverride.toString() }
        : {}),
    });
  }

  /**
   * Create an assertion in WM, optionally writing quads + finalizing +
   * promoting in the same call. Maps directly to the extended
   * `POST /api/assertion/create` body.
   *
   * RFC-001 §9.x — the assertion lifecycle is the canonical entry
   * point for staging content for VM publish. Callers that previously
   * went through the legacy `/api/shared-memory/write` (now removed)
   * use this method instead.
   */
  async createAssertion(
    contextGraphId: string,
    name: string,
    options?: {
      subGraphName?: string;
      quads?: Array<{ subject: string; predicate: string; object: string; graph: string }>;
      finalize?: boolean;
      promote?: boolean;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: {
        address: string;
        signature: { r: string; vs: string };
      };
      schemeVersion?: number;
    },
  ): Promise<{
    assertionUri: string;
    written?: number;
    seal?: {
      merkleRoot: string;
      authorAddress: string;
      schemeVersion: number;
      chainId: string;
      kav10Address: string;
      eip712Digest: string;
    };
    promotedCount?: number;
  }> {
    return this.post('/api/assertion/create', {
      contextGraphId,
      name,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
      ...(options?.quads ? { quads: options.quads } : {}),
      ...(options?.finalize !== undefined ? { finalize: options.finalize } : {}),
      ...(options?.promote !== undefined ? { promote: options.promote } : {}),
      ...(options?.authorAgentAddress
        ? { authorAgentAddress: options.authorAgentAddress }
        : {}),
      ...(options?.preSignedAuthorAttestation
        ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
        : {}),
      ...(options?.schemeVersion !== undefined
        ? { schemeVersion: options.schemeVersion }
        : {}),
    });
  }

  /**
   * Append quads to an existing WM assertion. Wraps
   * `POST /api/assertion/:name/write`. Used by batched ingest paths
   * (e.g. `dkg index`) that materialize a single named assertion
   * across many round-trips before finalize.
   */
  async appendToAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
    options?: { subGraphName?: string },
  ): Promise<{ written: number }> {
    return this.post(`/api/assertion/${encodeURIComponent(name)}/write`, {
      contextGraphId,
      quads,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
    });
  }

  /**
   * Finalize a previously-created assertion. RFC-001 §9.x — computes
   * the canonical merkleRoot, builds the EIP-712 AuthorAttestation,
   * signs (custodial / pre-signed / publisher fallback), and stamps
   * the seal triples to `_meta`.
   */
  async finalizeAssertion(
    contextGraphId: string,
    name: string,
    options?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: {
        address: string;
        signature: { r: string; vs: string };
      };
      schemeVersion?: number;
    },
  ): Promise<{
    assertionUri: string;
    merkleRoot: string;
    authorAddress: string;
    schemeVersion: number;
    chainId: string;
    kav10Address: string;
    eip712Digest: string;
  }> {
    return this.post(
      `/api/assertion/${encodeURIComponent(name)}/finalize`,
      {
        contextGraphId,
        ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
        ...(options?.authorAgentAddress
          ? { authorAgentAddress: options.authorAgentAddress }
          : {}),
        ...(options?.preSignedAuthorAttestation
          ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
          : {}),
        ...(options?.schemeVersion !== undefined
          ? { schemeVersion: options.schemeVersion }
          : {}),
      },
    );
  }

  /**
   * Publish a previously-finalized assertion to the verified-memory
   * chain. The seal in `_meta` (written by `finalizeAssertion`)
   * supplies the AuthorAttestation; the publisher forwards it
   * verbatim and never re-signs.
   *
   * Pre-condition: the assertion must be both finalized AND promoted
   * to SWM. The high-level `publishAssertion` helper handles the
   * whole sequence in one call.
   */
  async publishFromFinalizedAssertion(
    contextGraphId: string,
    assertionName: string,
    options?: {
      subGraphName?: string;
      clearAfter?: boolean;
      publisherNodeIdentityIdOverride?: bigint;
    },
  ): Promise<{
    kcId: string;
    status: 'tentative' | 'confirmed';
    assertionUri: string;
    authorAddress: string;
    merkleRoot: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
    contextGraphError?: string;
  }> {
    return this.post('/api/shared-memory/publish', {
      contextGraphId,
      assertionName,
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
      ...(options?.clearAfter !== undefined ? { clearAfter: options.clearAfter } : {}),
      ...(options?.publisherNodeIdentityIdOverride !== undefined
        ? { publisherNodeIdentityIdOverride: options.publisherNodeIdentityIdOverride.toString() }
        : {}),
    });
  }

  /**
   * High-level convenience: create → write → finalize → promote →
   * publish, all in two HTTP round-trips. The composite mirrors what
   * a typical OpenClaw/Hermes client does — stage content, commit it,
   * push it on-chain. Use this unless you need fine-grained control
   * over the individual steps.
   */
  async publishAssertion(
    contextGraphId: string,
    name: string,
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
    options?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: {
        address: string;
        signature: { r: string; vs: string };
      };
      schemeVersion?: number;
      clearAfter?: boolean;
      publisherNodeIdentityIdOverride?: bigint;
    },
  ): Promise<{
    assertionUri: string;
    kcId: string;
    status: 'tentative' | 'confirmed';
    authorAddress: string;
    merkleRoot: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
  }> {
    const created = await this.createAssertion(contextGraphId, name, {
      ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
      quads,
      finalize: true,
      promote: true,
      ...(options?.authorAgentAddress
        ? { authorAgentAddress: options.authorAgentAddress }
        : {}),
      ...(options?.preSignedAuthorAttestation
        ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
        : {}),
      ...(options?.schemeVersion !== undefined
        ? { schemeVersion: options.schemeVersion }
        : {}),
    });
    const published = await this.publishFromFinalizedAssertion(
      contextGraphId,
      name,
      {
        ...(options?.subGraphName ? { subGraphName: options.subGraphName } : {}),
        ...(options?.clearAfter !== undefined
          ? { clearAfter: options.clearAfter }
          : {}),
        ...(options?.publisherNodeIdentityIdOverride !== undefined
          ? { publisherNodeIdentityIdOverride: options.publisherNodeIdentityIdOverride }
          : {}),
      },
    );
    return {
      assertionUri: created.assertionUri,
      kcId: published.kcId,
      status: published.status,
      authorAddress: published.authorAddress,
      merkleRoot: published.merkleRoot,
      kas: published.kas,
      ...(published.txHash !== undefined ? { txHash: published.txHash } : {}),
      ...(published.blockNumber !== undefined
        ? { blockNumber: published.blockNumber }
        : {}),
    };
  }

  // ─── Publishing Conviction Account (PCA) ────────────────────────────

  async createPca(request: {
    tokens: string;
    lockEpochs: number;
  }): Promise<{
    accountId: string;
    txHash: string;
    blockNumber: number;
    committedTokens: string;
    lockEpochs: number;
  }> {
    return this.post('/api/pca', request);
  }

  async addPcaFunds(accountId: string, tokens: string): Promise<{
    accountId: string;
    addedTokens: string;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post(`/api/pca/${encodeURIComponent(accountId)}/funds`, { tokens });
  }

  async authorizePcaKey(accountId: string, key: string): Promise<{
    accountId: string;
    key: string;
    authorized: boolean;
    txHash: string;
    blockNumber: number;
  }> {
    return this.post(`/api/pca/${encodeURIComponent(accountId)}/authorize`, { key });
  }

  async getPcaInfo(accountId: string, probeKey?: string): Promise<{
    accountId: string;
    admin: string;
    balance: string;
    balanceTrac: string;
    initialDeposit: string;
    initialDepositTrac: string;
    lockEpochs: number;
    conviction: string;
    discountBps: number;
    probedKey?: { key: string; authorized: boolean; adapterSupported?: boolean; error?: string };
  }> {
    const qs = probeKey ? `?key=${encodeURIComponent(probeKey)}` : '';
    return this.get(`/api/pca/${encodeURIComponent(accountId)}${qs}`);
  }

  async publisherEnqueue(request: {
    contextGraphId: string;
    shareOperationId: string;
    roots: string[];
    namespace: string;
    scope: string;
    authorityProofRef: string;
    swmId?: string;
    transitionType?: 'CREATE' | 'MUTATE' | 'REVOKE';
    authorityType?: 'owner' | 'multisig' | 'quorum' | 'capability';
    priorVersion?: string;
  }): Promise<{ jobId: string; contextGraphId: string; shareOperationId: string; rootsCount: number }> {
    return this.post('/api/publisher/enqueue', request);
  }

  async publisherJobs(status?: string): Promise<{ jobs: any[] }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.get(`/api/publisher/jobs${qs}`);
  }

  async publisherJob(jobId: string): Promise<{ job: any }> {
    return this.get(`/api/publisher/job?id=${encodeURIComponent(jobId)}`);
  }

  async publisherJobPayload(jobId: string): Promise<{ job: any; payload: any }> {
    return this.get(`/api/publisher/job-payload?id=${encodeURIComponent(jobId)}`);
  }

  async publisherStats(): Promise<Record<string, number>> {
    return this.get('/api/publisher/stats');
  }

  async publisherCancel(jobId: string): Promise<{ cancelled: string }> {
    return this.post('/api/publisher/cancel', { jobId });
  }

  async publisherRetry(status: 'failed' = 'failed'): Promise<{ retried: number }> {
    return this.post('/api/publisher/retry', { status });
  }

  async publisherClear(status: 'failed' | 'finalized'): Promise<{ cleared: number; status: 'failed' | 'finalized' }> {
    return this.post('/api/publisher/clear', { status });
  }

  // ───────────────────────── EPCIS ─────────────────────────────────────

  async captureEpcis(request: {
    epcisDocument: unknown;
    contextGraphId?: string;
    subGraphName?: string;
    publishOptions?: {
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: string[];
    };
  }): Promise<{
    captureID: string;
    receivedAt: string;
    eventCount: number;
    status: 'accepted';
  }> {
    return this.post('/api/epcis/capture', request);
  }

  async getEpcisCapture(captureID: string): Promise<{
    captureID: string;
    state: 'accepted' | 'claimed' | 'validated' | 'broadcast' | 'included' | 'finalized' | 'failed';
    receivedAt: string;
    finalizedAt: string | null;
    error: string | null;
  }> {
    return this.get(`/api/epcis/capture/${encodeURIComponent(captureID)}`);
  }

  async queryEpcisEvents(params: {
    contextGraphId?: string;
    subGraphName?: string;
    finalized?: boolean;
    epc?: string;
    bizStep?: string;
    bizLocation?: string;
    from?: string;
    to?: string;
    eventID?: string;
    eventType?: string;
    action?: string;
    disposition?: string;
    readPoint?: string;
    parentID?: string;
    childEPC?: string;
    inputEPC?: string;
    outputEPC?: string;
    anyEPC?: string;
    perPage?: number;
    nextPageToken?: string;
  } = {}): Promise<{
    body: unknown;
    nextPageUrl: string | null;
  }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return this.queryEpcisEventsByPath(`/api/epcis/events${qs ? `?${qs}` : ''}`);
  }

  async queryEpcisEventsByPath(path: string): Promise<{
    body: unknown;
    nextPageUrl: string | null;
  }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(body, res.statusText), body);
    }
    const body = (await res.json()) as unknown;
    const linkHeader = res.headers.get('Link') ?? res.headers.get('link');
    const nextPageUrl = parseNextLink(linkHeader);
    return { body, nextPageUrl };
  }

  /**
   * Run SPARQL via the daemon. `opts` covers the full /api/query surface —
   * memory-layer routing (`view`, `graphSuffix`, `verifiedGraph`,
   * `subGraphName`, `includeSharedMemory`, `agentAddress`,
   * `assertionName`), and P-13's `minTrust` (only meaningful on
   * `view: "verified-memory"`; ignored elsewhere). `contextGraphId` stays
   * in the 2nd positional slot for backwards compatibility.
   */
  async query(
    sparql: string,
    contextGraphId?: string,
    opts?: {
      graphSuffix?: string;
      includeSharedMemory?: boolean;
      view?: 'working-memory' | 'shared-working-memory' | 'verified-memory';
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
      verifiedGraph?: string;
      /**
       * P-13: implementable tiers are `SelfAttested` (0) and `Endorsed`
       * (1) only. `PartiallyVerified` / `ConsensusVerified` fail fast
       * with a 400 at the daemon until Q-1 lands.
       */
      minTrust?: 'SelfAttested' | 'Endorsed' | 0 | 1;
    },
  ): Promise<{ result: QueryResult }> {
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

  async readQueryCatalog(contextGraphId: string): Promise<{ result: QueryResult }> {
    return this.post('/api/profile/query-catalog/read', { contextGraphId });
  }

  async queryRemote(peerId: string, request: {
    lookupType: string;
    contextGraphId?: string;
    ual?: string;
    entityUri?: string;
    rdfType?: string;
    sparql?: string;
    limit?: number;
    timeout?: number;
  }): Promise<{
    operationId: string;
    status: string;
    ntriples?: string;
    bindings?: string;
    entityUris?: string[];
    truncated: boolean;
    resultCount: number;
    gasConsumed?: number;
    error?: string;
  }> {
    return this.post('/api/query-remote', { peerId, ...request });
  }

  async subscribeToContextGraph(contextGraphId: string, options?: { includeSharedMemory?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        syncCapablePeers: number;
        peersTried: number;
        dataSynced: number;
        sharedMemorySynced: number;
        denied: boolean;
        deniedPeers: number;
        diagnostics?: {
          noProtocolPeers: number;
          durable: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            emptyResponses: number;
            metaOnlyResponses: number;
            dataRejectedMissingMeta: number;
            rejectedKcs: number;
            failedPeers: number;
          };
          sharedMemory: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            emptyResponses: number;
            droppedDataTriples: number;
            failedPeers: number;
          };
        };
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.post('/api/context-graph/subscribe', { contextGraphId, includeWorkspace: options?.includeSharedMemory });
  }

  /** @deprecated Use subscribeToContextGraph */
  async subscribe(contextGraphId: string, options?: { includeWorkspace?: boolean }): Promise<{
    subscribed: string;
    catchup?:
      | {
        connectedPeers: number;
        syncCapablePeers: number;
        peersTried: number;
        dataSynced: number;
        sharedMemorySynced: number;
        denied: boolean;
        deniedPeers: number;
        diagnostics?: {
          noProtocolPeers: number;
          durable: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            emptyResponses: number;
            metaOnlyResponses: number;
            dataRejectedMissingMeta: number;
            rejectedKcs: number;
            failedPeers: number;
          };
          sharedMemory: {
            fetchedMetaTriples: number;
            fetchedDataTriples: number;
            insertedMetaTriples: number;
            insertedDataTriples: number;
            bytesReceived: number;
            resumedPhases: number;
            emptyResponses: number;
            droppedDataTriples: number;
            failedPeers: number;
          };
        };
      }
      | {
        status: 'queued';
        includeWorkspace: boolean;
        jobId: string;
      };
  }> {
    return this.subscribeToContextGraph(contextGraphId, { includeSharedMemory: options?.includeWorkspace });
  }

  async catchupStatus(contextGraphId: string): Promise<{
    jobId: string;
    contextGraphId: string;
    includeWorkspace: boolean;
    status: 'queued' | 'running' | 'done' | 'denied' | 'failed' | 'unreachable';
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: {
      connectedPeers: number;
      syncCapablePeers: number;
      peersTried: number;
      peersSucceeded: number;
      dataSynced: number;
      sharedMemorySynced: number;
      denied: boolean;
      deniedPeers: number;
      diagnostics?: {
        noProtocolPeers: number;
        durable: {
          fetchedMetaTriples: number;
          fetchedDataTriples: number;
          insertedMetaTriples: number;
          insertedDataTriples: number;
          bytesReceived: number;
          resumedPhases: number;
          emptyResponses: number;
          metaOnlyResponses: number;
          dataRejectedMissingMeta: number;
          rejectedKcs: number;
          failedPeers: number;
        };
        sharedMemory: {
          fetchedMetaTriples: number;
          fetchedDataTriples: number;
          insertedMetaTriples: number;
          insertedDataTriples: number;
          bytesReceived: number;
          resumedPhases: number;
          emptyResponses: number;
          droppedDataTriples: number;
          failedPeers: number;
        };
      };
    };
    error?: string;
  }> {
    return this.get(`/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`);
  }

  async connect(multiaddr: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { multiaddr });
  }

  /**
   * V10 DHT-based dial: hand the daemon a peer id, and it resolves the
   * peer's current multiaddrs via libp2p Kademlia
   * (`peerRouting.findPeer`) before dialling. Used by invites that carry
   * only a peer id so they survive relay rotations.
   */
  async connectByPeerId(peerId: string): Promise<{ connected: boolean }> {
    return this.post('/api/connect', { peerId });
  }

  async createContextGraph(id: string, name: string, description?: string, options?: {
    private?: boolean;
    accessPolicy?: number;
    allowedAgents?: string[];
    participantAgents?: string[];
    participantIdentityIds?: Array<string | number | bigint>;
    requiredSignatures?: number;
  }, allowedPeers?: string[]): Promise<{
    created: string;
    uri: string;
  }> {
    return this.post('/api/context-graph/create', {
      id,
      name,
      description,
      ...(allowedPeers?.length ? { allowedPeers } : {}),
      ...(options?.accessPolicy != null ? { accessPolicy: options.accessPolicy } : {}),
      ...(options?.allowedAgents?.length ? { allowedAgents: options.allowedAgents } : {}),
      ...(options?.participantAgents?.length ? { participantAgents: options.participantAgents } : {}),
      ...(options?.private ? { private: true } : {}),
      ...(options?.participantIdentityIds?.length
        ? { participantIdentityIds: options.participantIdentityIds.map((id) => id.toString()) }
        : {}),
      ...(options?.requiredSignatures != null ? { requiredSignatures: options.requiredSignatures } : {}),
    });
  }

  async createSubGraph(contextGraphId: string, subGraphName: string): Promise<{
    created: string;
    contextGraphId: string;
  }> {
    return this.post('/api/sub-graph/create', { contextGraphId, subGraphName });
  }

  async registerContextGraph(id: string, opts?: {
    /** @deprecated V10 ContextGraphs registration ignores metadata reveal. */
    revealOnChain?: boolean;
    accessPolicy?: number;
    publishPolicy?: number;
  }): Promise<{
    registered: string;
    onChainId: string;
    hint?: string;
  }> {
    return this.post('/api/context-graph/register', {
      id,
      ...(opts?.accessPolicy != null ? { accessPolicy: opts.accessPolicy } : {}),
      ...(opts?.publishPolicy != null ? { publishPolicy: opts.publishPolicy } : {}),
    });
  }

  /** @deprecated Use addAgent instead. */
  async inviteToContextGraph(contextGraphId: string, peerId: string): Promise<{
    invited: string;
    contextGraphId: string;
  }> {
    return this.post('/api/context-graph/invite', { contextGraphId, peerId });
  }

  async addAgent(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    contextGraphId: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/add-participant`, { agentAddress });
  }

  async removeAgent(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    contextGraphId: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/remove-participant`, { agentAddress });
  }

  async listAgents(contextGraphId: string): Promise<{
    contextGraphId: string;
    allowedAgents: string[];
  }> {
    return this.get(`/api/context-graph/${encodeURIComponent(contextGraphId)}/participants`);
  }

  async signJoinRequest(contextGraphId: string): Promise<{
    ok: boolean;
    status?: string;
    contextGraphId?: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/sign-join`, {});
  }

  async approveJoin(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    status: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/approve-join`, { agentAddress });
  }

  async rejectJoin(contextGraphId: string, agentAddress: string): Promise<{
    ok: boolean;
    status: string;
    agentAddress: string;
  }> {
    return this.post(`/api/context-graph/${encodeURIComponent(contextGraphId)}/reject-join`, { agentAddress });
  }

  async listJoinRequests(contextGraphId: string): Promise<{
    contextGraphId: string;
    requests: Array<{
      agentAddress: string;
      status: string;
      timestamp?: string;
      agentName?: string;
    }>;
  }> {
    return this.get(`/api/context-graph/${encodeURIComponent(contextGraphId)}/join-requests`);
  }

  async getAgentIdentity(): Promise<{
    agentAddress: string;
    agentDid: string;
    name: string;
    peerId: string;
  }> {
    return this.get('/api/agent/identity');
  }

  async listContextGraphs(): Promise<{
    contextGraphs: Array<{
      id: string;
      uri: string;
      name: string;
      description?: string;
      creator?: string;
      createdAt?: string;
      isSystem: boolean;
      subscribed?: boolean;
      synced?: boolean;
      curator?: string;
      accessPolicy?: string;
      callerInvolved?: boolean;
    }>;
  }> {
    return this.get('/api/context-graph/list');
  }

  async contextGraphExists(id: string): Promise<{ id: string; exists: boolean }> {
    return this.get(`/api/context-graph/exists?id=${encodeURIComponent(id)}`);
  }

  async verify(request: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: string;
    timeoutMs?: number;
    requiredSignatures?: number;
  }): Promise<{ txHash: string; blockNumber: number; verifiedMemoryId: string; signers: string[] }> {
    return this.post('/api/verify', request);
  }

  async endorse(request: {
    contextGraphId: string;
    ual: string;
    /**
     * Optional. If supplied it MUST match the address resolved from
     * the bearer token; the daemon rejects any mismatch with 403.
     * Prefer omitting and relying on the token — see A-12 review on
     * /api/endorse for the provenance-forgery rationale.
     */
    agentAddress?: string;
  }): Promise<{ endorsed: boolean; endorserAddress: string }> {
    return this.post('/api/endorse', request);
  }

  async importAssertionFile(name: string, request: {
    filePath: string;
    contextGraphId: string;
    contentType?: string;
    ontologyRef?: string;
    subGraphName?: string;
  }): Promise<{
    assertionUri: string;
    fileHash: string;
    detectedContentType?: string;
    extraction?: {
      status: string;
      tripleCount?: number;
      pipelineUsed?: string;
      mdIntermediateHash?: string;
      error?: string;
    };
  }> {
    const fileBytes = await readFile(request.filePath);
    const form = new FormData();
    const contentType = request.contentType ?? inferUploadContentType(request.filePath);
    const file = contentType
      ? new Blob([fileBytes], { type: contentType })
      : new Blob([fileBytes]);

    form.append('file', file, basename(request.filePath));
    form.append('contextGraphId', request.contextGraphId);
    if (request.contentType) form.append('contentType', request.contentType);
    if (request.ontologyRef) form.append('ontologyRef', request.ontologyRef);
    if (request.subGraphName) form.append('subGraphName', request.subGraphName);

    return this.postForm(`/api/assertion/${encodeURIComponent(name)}/import-file`, form);
  }

  async assertionExtractionStatus(name: string, contextGraphId: string, subGraphName?: string): Promise<{
    assertionUri?: string;
    fileHash?: string;
    status?: string;
    tripleCount?: number;
    pipelineUsed?: string;
    mdIntermediateHash?: string;
    error?: string;
  }> {
    const params = new URLSearchParams({ contextGraphId });
    if (subGraphName) params.set('subGraphName', subGraphName);
    return this.get(
      `/api/assertion/${encodeURIComponent(name)}/extraction-status?${params.toString()}`,
    );
  }

  async promoteAssertion(name: string, request: {
    contextGraphId: string;
    entities?: 'all' | string[];
    subGraphName?: string;
  }): Promise<{
    promoted?: boolean;
    promotedCount?: number;
    contextGraphId?: string;
    count?: number;
    sharedMemoryGraph?: string;
    rootEntities?: string[];
  }> {
    return this.post(`/api/assertion/${encodeURIComponent(name)}/promote`, request);
  }

  async queryAssertion(name: string, request: {
    contextGraphId: string;
    subGraphName?: string;
  }): Promise<{
    quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
    count: number;
  }> {
    return this.post(`/api/assertion/${encodeURIComponent(name)}/query`, request);
  }

  async publishCclPolicy(request: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    return this.post('/api/ccl/policy/publish', request);
  }

  async approveCclPolicy(request: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    return this.post('/api/ccl/policy/approve', request);
  }

  async revokeCclPolicy(request: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    return this.post('/api/ccl/policy/revoke', request);
  }

  async listCclPolicies(opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<{ policies: any[] }> {
    const params = new URLSearchParams();
    if (opts.contextGraphId) params.set('contextGraphId', opts.contextGraphId);
    if (opts.name) params.set('name', opts.name);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.status) params.set('status', opts.status);
    if (opts.includeBody) params.set('includeBody', 'true');
    const qs = params.toString();
    return this.get(`/api/ccl/policy/list${qs ? `?${qs}` : ''}`);
  }

  async resolveCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<{ policy: any | null }> {
    const params = new URLSearchParams({ contextGraphId: opts.contextGraphId, name: opts.name });
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.includeBody) params.set('includeBody', 'true');
    return this.get(`/api/ccl/policy/resolve?${params.toString()}`);
  }

  async evaluateCclPolicy(request: {
    contextGraphId: string;
    name: string;
    facts?: Array<[string, ...unknown[]]>;
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
    publishResult?: boolean;
  }): Promise<{
    policy: any;
    context: any;
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'manual' | 'snapshot-resolved';
    result: any;
  }> {
    return this.post('/api/ccl/eval', request);
  }

  async listCclEvaluations(opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<{ evaluations: any[] }> {
    const params = new URLSearchParams({ contextGraphId: opts.contextGraphId });
    if (opts.policyUri) params.set('policyUri', opts.policyUri);
    if (opts.snapshotId) params.set('snapshotId', opts.snapshotId);
    if (opts.view) params.set('view', opts.view);
    if (opts.contextType) params.set('contextType', opts.contextType);
    if (opts.resultKind) params.set('resultKind', opts.resultKind);
    if (opts.resultName) params.set('resultName', opts.resultName);
    return this.get(`/api/ccl/results?${params.toString()}`);
  }

  async shutdown(): Promise<void> {
    try {
      await this.post('/api/shutdown', {});
    } catch {
      // Connection may close before response
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(body, res.statusText), body);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  private async postForm<T>(path: string, body: FormData): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw ApiClient.httpError(res.status, ApiClient.errorMessageFromBody(data, res.statusText), data);
    }
    return res.json() as Promise<T>;
  }

  /** Create an Error with an `httpStatus` property so callers can distinguish
   *  application-level responses from connection failures. */
  static httpError(status: number, message?: string, responseBody?: unknown): Error & { httpStatus: number; responseBody?: unknown } {
    const err = new Error(message ?? `HTTP ${status}`) as Error & { httpStatus: number; responseBody?: unknown };
    err.httpStatus = status;
    if (responseBody !== undefined) err.responseBody = responseBody;
    return err;
  }

  private static errorMessageFromBody(body: unknown, fallback?: string): string | undefined {
    if (!body || typeof body !== 'object') return fallback;
    const record = body as Record<string, unknown>;
    const extraction = record.extraction;
    if (extraction && typeof extraction === 'object') {
      const extractionError = (extraction as Record<string, unknown>).error;
      if (typeof extractionError === 'string' && extractionError.length > 0) {
        return extractionError;
      }
    }
    if (typeof record.error === 'string' && record.error.length > 0) {
      return record.error;
    }
    return fallback;
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const segments = linkHeader.split(',');
  for (const segment of segments) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (!match) continue;
    const target = match[1];
    if (!target) continue;
    if (target.startsWith('http://') || target.startsWith('https://')) {
      try {
        const url = new URL(target);
        return `${url.pathname}${url.search}`;
      } catch {
        return null;
      }
    }
    return target;
  }
  return null;
}

// NOTE: mirrored in `packages/adapter-openclaw/src/DkgNodePlugin.ts`
// (`UPLOAD_CONTENT_TYPES` there). `adapter-openclaw` can't import this
// directly (circular workspace dep), so update both tables together when
// adding a new format until a shared upload module lives in `dkg-core`.
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.epub': 'application/epub+zip',
};

function inferUploadContentType(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const [ext, ct] of Object.entries(UPLOAD_CONTENT_TYPES)) {
    if (lower.endsWith(ext)) return ct;
  }
  return undefined;
}
