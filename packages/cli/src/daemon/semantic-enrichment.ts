import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  assertSafeRdfTerm,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  isSafeIri,
} from '@origintrail-official/dkg-core';
import {
  DashboardDB,
  type SemanticEnrichmentEventRow,
} from '@origintrail-official/dkg-node-ui';
import type { DkgConfig, LocalAgentIntegrationConfig } from '../config.js';
import {
  type ExtractionStatusRecord,
  getExtractionStatusRecord,
  setExtractionStatusRecord,
} from '../extraction-status.js';
import {
  buildChatSemanticIdempotencyKey,
  buildFileSemanticIdempotencyKey,
  contextGraphOntologyUri,
  type ChatTurnSemanticEventPayload,
  type FileImportSemanticEventPayload,
  type SemanticEnrichmentDescriptor,
  type SemanticEnrichmentEventPayload,
  type SemanticEnrichmentKind,
  type SemanticEnrichmentStatus,
  type SemanticTripleInput,
} from '../semantic-enrichment.js';
import {
  isLoopbackClientIp,
  jsonResponse,
  readBody,
  safeDecodeURIComponent,
  safeParseJson,
  SMALL_BODY_BYTES,
  validateRequiredContextGraphId,
} from './http-utils.js';
import {
  type OpenClawAttachmentRef,
  parseOpenClawAttachmentTripleCount,
} from './openclaw.js';
import {
  getLocalAgentIntegration,
  getStoredLocalAgentIntegrations,
  inferSafeLocalAgentWakeAuthFromUrl,
  isPlainRecord,
  normalizeIntegrationId,
} from './local-agents.js';
import type { RequestContext } from './routes/context.js';

const SEMANTIC_ENRICHMENT_MAX_ATTEMPTS = 5;
const SEMANTIC_ENRICHMENT_METHOD = 'semantic-llm-agent';
const SEMANTIC_ENRICHMENT_EVENT_ID_PREDICATE = 'http://dkg.io/ontology/semanticEnrichmentEventId';
const SEMANTIC_ENRICHMENT_SOURCE_PREDICATE = 'http://dkg.io/ontology/extractedFrom';
const SEMANTIC_ENRICHMENT_SOURCE_AGENT_PREDICATE = 'http://dkg.io/ontology/sourceAgent';
const SEMANTIC_ENRICHMENT_COUNT_PREDICATE = 'http://dkg.io/ontology/semanticTripleCount';
const EXTRACTION_PROVENANCE_TYPE = 'http://dkg.io/ontology/ExtractionProvenance';
const EXTRACTION_METHOD_PREDICATE = 'http://dkg.io/ontology/extractionMethod';
const EXTRACTED_AT_PREDICATE = 'http://dkg.io/ontology/extractedAt';
const EXTRACTED_BY_PREDICATE = 'http://dkg.io/ontology/extractedBy';
const RDF_TYPE_PREDICATE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SEMANTIC_APPEND_BODY_BYTES = 8 * 1024 * 1024;

export interface LocalAgentIntegrationWakeRequest {
  kind: 'semantic_enrichment';
  eventKind: SemanticEnrichmentKind;
  eventId: string;
}

export interface LocalAgentIntegrationWakeTransportHint {
  wakeUrl?: string;
  wakeAuth?: 'bridge-token' | 'gateway' | 'none';
}

export type LocalAgentIntegrationWakeResult =
  | { status: 'delivered' }
  | { status: 'skipped'; reason: 'integration_disabled' | 'wake_unavailable' }
  | { status: 'failed'; reason: string };

export async function notifyLocalAgentIntegrationWake(
  config: DkgConfig,
  integrationId: string,
  wake: LocalAgentIntegrationWakeRequest,
  bridgeAuthToken?: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  fallbackTransport?: LocalAgentIntegrationWakeTransportHint,
): Promise<LocalAgentIntegrationWakeResult> {
  const normalizedId = normalizeIntegrationId(integrationId);
  const stored = getStoredLocalAgentIntegrations(config)[normalizedId];
  const integration = stored ? getLocalAgentIntegration(config, normalizedId) : null;
  if (stored && integration?.enabled !== true) return { status: 'skipped', reason: 'integration_disabled' };
  if (!stored && !fallbackTransport?.wakeUrl) return { status: 'skipped', reason: 'integration_disabled' };

  const wakeTransport = fallbackTransport?.wakeUrl?.trim()
    ? fallbackTransport
    : integration?.transport?.wakeUrl?.trim()
      ? integration.transport
      : undefined;
  const wakeUrl = wakeTransport?.wakeUrl?.trim();
  if (!wakeUrl) return { status: 'skipped', reason: 'wake_unavailable' };
  const inferredWakeAuth = inferSafeLocalAgentWakeAuthFromUrl(wakeUrl);
  if (!inferredWakeAuth) return { status: 'skipped', reason: 'wake_unavailable' };

  const wakeAuth = wakeTransport?.wakeAuth ?? inferredWakeAuth;
  if (wakeAuth !== inferredWakeAuth) return { status: 'skipped', reason: 'wake_unavailable' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (wakeAuth === 'gateway') {
    // The daemon does not currently own OpenClaw gateway credentials. Treat
    // gateway wake endpoints as unavailable rather than sending a request that
    // the gateway-auth route will reject.
    return { status: 'skipped', reason: 'wake_unavailable' };
  }
  if (wakeAuth === 'bridge-token') {
    if (!bridgeAuthToken?.trim()) return { status: 'failed', reason: 'missing_bridge_token' };
    headers['x-dkg-bridge-token'] = bridgeAuthToken.trim();
  }

  try {
    const response = await fetchImpl(wakeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(wake),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return {
        status: 'failed',
        reason: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim(),
      };
    }
    return { status: 'delivered' };
  } catch (err: any) {
    return { status: 'failed', reason: err?.message ?? String(err) };
  }
}

export function canQueueLocalAgentSemanticEnrichment(
  config: DkgConfig,
  integrationId: string,
  opts?: { liveSemanticEnrichmentSupported?: boolean; requestFromIntegration?: boolean },
): boolean {
  const normalizedId = normalizeIntegrationId(integrationId);
  const stored = getStoredLocalAgentIntegrations(config)[normalizedId];
  if (opts?.liveSemanticEnrichmentSupported === false && normalizedId === 'openclaw') return false;
  if (stored && stored.enabled !== true) return false;
  if (!stored) {
    return normalizedId === 'openclaw'
      && opts?.requestFromIntegration === true
      && opts?.liveSemanticEnrichmentSupported !== false;
  }
  if (opts?.liveSemanticEnrichmentSupported === true && normalizedId === 'openclaw') {
    return stored?.enabled === true;
  }
  if (stored.capabilities?.semanticEnrichment === false) return false;
  if (stored.capabilities?.semanticEnrichment === true) return true;
  return normalizedId === 'openclaw'
    && opts?.requestFromIntegration === true
    && opts?.liveSemanticEnrichmentSupported !== false;
}

export function requestTargetsLocalAgentIntegration(
  req: IncomingMessage,
  integrationId: string,
): boolean {
  const requestedIntegrationId = normalizeIntegrationId(integrationId);
  const headerIntegrationId = normalizeIntegrationId(
    readSingleHeaderValue(req.headers['x-dkg-local-agent-integration']) ?? '',
  );
  return !!requestedIntegrationId && headerIntegrationId === requestedIntegrationId;
}

export function requestHasTrustedLocalAgentBridgeAuth(
  req: IncomingMessage,
  integrationId: string,
  bridgeAuthToken: string | undefined,
): boolean {
  if (!requestTargetsLocalAgentIntegration(req, integrationId)) return false;
  const expectedToken = bridgeAuthToken?.trim();
  if (!expectedToken) return false;
  if (!isLoopbackClientIp(req.socket.remoteAddress ?? '')) return false;
  const bridgeHeader = readSingleHeaderValue(req.headers['x-dkg-bridge-token'])?.trim();
  return bridgeHeader === expectedToken;
}

export function requestLocalAgentWakeTransport(
  req: IncomingMessage,
  integrationId: string,
  opts: { bridgeAuthToken?: string; requireBridgeAuth?: boolean } = {},
): LocalAgentIntegrationWakeTransportHint | undefined {
  if (!requestTargetsLocalAgentIntegration(req, integrationId)) return undefined;
  if (
    opts.requireBridgeAuth
    && !requestHasTrustedLocalAgentBridgeAuth(req, integrationId, opts.bridgeAuthToken)
  ) {
    return undefined;
  }
  const wakeUrl = readSingleHeaderValue(req.headers['x-dkg-local-agent-wake-url'])?.trim();
  const inferredWakeAuth = wakeUrl ? inferSafeLocalAgentWakeAuthFromUrl(wakeUrl) : undefined;
  if (!wakeUrl || !inferredWakeAuth) return undefined;
  const wakeAuthHeader = readSingleHeaderValue(req.headers['x-dkg-local-agent-wake-auth'])?.trim();
  const wakeAuth = wakeAuthHeader === 'bridge-token' || wakeAuthHeader === 'gateway' || wakeAuthHeader === 'none'
    ? wakeAuthHeader
    : inferredWakeAuth;
  if (wakeAuth !== inferredWakeAuth) return undefined;
  return { wakeUrl, wakeAuth };
}

function readSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseBooleanHeaderValue(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export function requestAdvertisesLocalAgentSemanticEnrichment(
  req: IncomingMessage,
  integrationId: string,
  opts: { bridgeAuthToken?: string; requireBridgeAuth?: boolean } = {},
): boolean | undefined {
  if (!requestTargetsLocalAgentIntegration(req, integrationId)) return undefined;
  if (
    opts.requireBridgeAuth
    && !requestHasTrustedLocalAgentBridgeAuth(req, integrationId, opts.bridgeAuthToken)
  ) {
    return undefined;
  }
  return parseBooleanHeaderValue(
    readSingleHeaderValue(req.headers['x-dkg-local-agent-semantic-enrichment']),
  );
}

export function isAuthorizedLocalAgentSemanticWorkerRequest(
  config: DkgConfig,
  req: IncomingMessage,
  integrationId: string,
  opts: {
    requestToken?: string;
    bridgeAuthToken?: string;
    resolveAgentByToken?: (token: string) => unknown;
  } = {},
): boolean {
  const normalizedIntegrationId = normalizeIntegrationId(integrationId);
  if (!normalizedIntegrationId) return false;
  const storedConfig = getStoredLocalAgentIntegrations(config)[normalizedIntegrationId];
  const integration = getLocalAgentIntegration(config, normalizedIntegrationId);
  if (storedConfig) {
    if (integration?.enabled !== true) return false;
  } else if (normalizedIntegrationId !== 'openclaw') {
    return false;
  }
  const headerIntegrationId = normalizeIntegrationId(
    readSingleHeaderValue(req.headers['x-dkg-local-agent-integration']) ?? '',
  );
  if (headerIntegrationId !== normalizedIntegrationId) return false;
  if (!isLoopbackClientIp(req.socket.remoteAddress ?? '')) return false;

  const requestToken = opts.requestToken?.trim();
  const bridgeAuthToken = opts.bridgeAuthToken?.trim();
  if (!bridgeAuthToken) return false;
  const bridgeHeader = readSingleHeaderValue(req.headers['x-dkg-bridge-token'])?.trim();
  if (bridgeHeader !== bridgeAuthToken) return false;
  if (!requestToken) return true;
  return opts.resolveAgentByToken?.(requestToken) === undefined;
}

export function reconcileOpenClawSemanticAvailability(
  config: DkgConfig,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  reason = 'OpenClaw semantic enrichment is unavailable on this runtime',
): number {
  const stored = getStoredLocalAgentIntegrations(config).openclaw;
  if (!stored) return 0;
  if (stored.enabled === true && stored.capabilities?.semanticEnrichment !== false) return 0;
  if (stored.enabled === true && !isOpenClawSemanticCapabilityTerminallyUnavailable(stored)) return 0;
  if (stored.enabled !== true && !isOpenClawExplicitlyDisconnected(stored)) return 0;
  return deadLetterUnavailableOpenClawSemanticEvents(extractionStatus, dashDb, reason);
}

export async function saveConfigAndReconcileOpenClawSemanticAvailability(args: {
  config: DkgConfig;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  dashDb: DashboardDB;
  saveConfig: (config: DkgConfig) => Promise<void>;
  reason?: string;
}): Promise<number> {
  await args.saveConfig(args.config);
  try {
    return reconcileOpenClawSemanticAvailability(
      args.config,
      args.extractionStatus,
      args.dashDb,
      args.reason,
    );
  } catch (err: any) {
    console.warn(
      `[semantic-enrichment] Failed to reconcile OpenClaw semantic availability after saving config: ${err?.message ?? String(err)}`,
    );
    return 0;
  }
}

export function queueLocalAgentSemanticEnrichmentBestEffort(args: {
  config: DkgConfig;
  dashDb: DashboardDB;
  integrationId: string;
  kind: SemanticEnrichmentKind;
  payload: SemanticEnrichmentEventPayload;
  bridgeAuthToken?: string;
  skipWhenUnavailable?: boolean;
  liveSemanticEnrichmentSupported?: boolean;
  requestFromIntegration?: boolean;
  requestWakeTransport?: LocalAgentIntegrationWakeTransportHint;
  logLabel: string;
  semanticTripleCount?: number;
}): SemanticEnrichmentDescriptor | undefined {
  if (
    args.skipWhenUnavailable
    && !canQueueLocalAgentSemanticEnrichment(args.config, args.integrationId, {
      liveSemanticEnrichmentSupported: args.liveSemanticEnrichmentSupported,
      requestFromIntegration: args.requestFromIntegration,
    })
  ) {
    return undefined;
  }
  try {
    const descriptor = ensureSemanticEnrichmentEvent(
      args.dashDb,
      args.kind,
      args.payload,
      args.semanticTripleCount,
    );
    void notifyLocalAgentIntegrationWake(
      args.config,
      args.integrationId,
      {
        kind: 'semantic_enrichment',
        eventKind: args.kind,
        eventId: descriptor.eventId,
      },
      args.bridgeAuthToken,
      globalThis.fetch,
      args.requestWakeTransport,
    ).then((result) => {
      if (result.status === 'failed') {
        console.warn(
          `[semantic-enrichment] Failed to wake local agent integration "${args.integrationId}" for ${args.logLabel} ${descriptor.eventId}: ${result.reason ?? 'unknown error'}`,
        );
      }
    });
    return descriptor;
  } catch (err: any) {
    console.warn(`[semantic-enrichment] Failed to enqueue ${args.logLabel}: ${err?.message ?? String(err)}`);
    return undefined;
  }
}

export function semanticEnrichmentDescriptorFromRow(
  row: {
    id: string;
    status: SemanticEnrichmentStatus;
    semantic_triple_count?: number;
    updated_at: number;
    last_error: string | null;
  },
  semanticTripleCount = row.semantic_triple_count ?? 0,
): SemanticEnrichmentDescriptor {
  return {
    eventId: row.id,
    status: row.status,
    semanticTripleCount,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function isOpenClawExplicitlyDisconnected(stored: LocalAgentIntegrationConfig): boolean {
  if (stored.metadata?.userDisabled === true) return true;
  return Boolean(
    stored.connectedAt
    && stored.enabled === false
    && stored.runtime?.status === 'disconnected',
  );
}

function isOpenClawSemanticCapabilityTerminallyUnavailable(stored: LocalAgentIntegrationConfig): boolean {
  if (stored.capabilities?.semanticEnrichment !== false) return false;
  return stored.runtime?.status === 'degraded' || stored.runtime?.status === 'error';
}

function refreshExtractionStatusSemanticDescriptor(
  dashDb: DashboardDB,
  record: ExtractionStatusRecord,
): ExtractionStatusRecord {
  const currentSemanticEnrichment = record.semanticEnrichment;
  if (!currentSemanticEnrichment?.eventId) return record;
  const row = dashDb.getSemanticEnrichmentEvent(currentSemanticEnrichment.eventId);
  if (!row) return record;
  const semanticEnrichment = semanticEnrichmentDescriptorFromRow(row);
  if (
    currentSemanticEnrichment.status === semanticEnrichment.status
    && currentSemanticEnrichment.semanticTripleCount === semanticEnrichment.semanticTripleCount
    && currentSemanticEnrichment.updatedAt === semanticEnrichment.updatedAt
    && currentSemanticEnrichment.lastError === semanticEnrichment.lastError
  ) {
    return record;
  }
  return {
    ...record,
    semanticEnrichment,
  };
}

function parseSemanticEnrichmentEventPayload(raw: string): SemanticEnrichmentEventPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as SemanticEnrichmentEventPayload;
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) return undefined;
    if (parsed.kind === 'chat_turn' || parsed.kind === 'file_import') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function semanticEnrichmentPayloadHash(payloadJson: string): string {
  return createHash('sha256').update(payloadJson).digest('hex');
}

function normalizePayloadHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function parseExtractionStatusSnapshotRecord(raw: string): ExtractionStatusRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as ExtractionStatusRecord;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!['in_progress', 'completed', 'skipped', 'failed'].includes(parsed.status)) return undefined;
    if (typeof parsed.fileHash !== 'string' || !parsed.fileHash.trim()) return undefined;
    if (typeof parsed.detectedContentType !== 'string' || !parsed.detectedContentType.trim()) return undefined;
    if (parsed.pipelineUsed !== null && typeof parsed.pipelineUsed !== 'string') return undefined;
    if (typeof parsed.tripleCount !== 'number' || !Number.isFinite(parsed.tripleCount) || parsed.tripleCount < 0) {
      return undefined;
    }
    if (typeof parsed.startedAt !== 'string' || !parsed.startedAt.trim()) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function setPersistedExtractionStatusRecord(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  assertionUri: string,
  record: ExtractionStatusRecord,
): void {
  setExtractionStatusRecord(extractionStatus, assertionUri, record);
  dashDb.upsertExtractionStatusSnapshot({
    assertion_uri: assertionUri,
    record_json: JSON.stringify(record),
    updated_at: Date.now(),
  });
}

export function getHydratedExtractionStatusRecord(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  assertionUri: string,
): ExtractionStatusRecord | undefined {
  const current = getExtractionStatusRecord(extractionStatus, assertionUri);
  if (current) {
    const refreshed = refreshExtractionStatusSemanticDescriptor(dashDb, current);
    if (refreshed !== current) {
      setPersistedExtractionStatusRecord(extractionStatus, dashDb, assertionUri, refreshed);
    }
    return refreshed;
  }
  const snapshot = dashDb.getExtractionStatusSnapshot(assertionUri);
  if (!snapshot) return undefined;
  const parsed = parseExtractionStatusSnapshotRecord(snapshot.record_json);
  if (!parsed) return undefined;
  const refreshed = refreshExtractionStatusSemanticDescriptor(dashDb, parsed);
  setExtractionStatusRecord(extractionStatus, assertionUri, refreshed);
  if (refreshed !== parsed) {
    dashDb.upsertExtractionStatusSnapshot({
      assertion_uri: assertionUri,
      record_json: JSON.stringify(refreshed),
      updated_at: Date.now(),
    });
  }
  return refreshed;
}

export function deletePersistedExtractionStatusRecord(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  assertionUri: string,
): void {
  extractionStatus.delete(assertionUri);
  dashDb.deleteExtractionStatusSnapshot(assertionUri);
}

export function updateExtractionStatusSemanticDescriptor(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  assertionUri: string,
  descriptor: SemanticEnrichmentDescriptor,
): void {
  const current = getHydratedExtractionStatusRecord(extractionStatus, dashDb, assertionUri);
  if (!current) return;
  setPersistedExtractionStatusRecord(extractionStatus, dashDb, assertionUri, {
    ...current,
    semanticEnrichment: {
      eventId: descriptor.eventId,
      status: descriptor.status,
      semanticTripleCount: descriptor.semanticTripleCount,
      updatedAt: descriptor.updatedAt,
      ...(descriptor.lastError ? { lastError: descriptor.lastError } : {}),
    },
  });
}

function deadLetterUnavailableOpenClawSemanticEvents(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  dashDb: DashboardDB,
  reason: string,
  updatedAt = Date.now(),
): number {
  const rows = dashDb.deadLetterActiveSemanticEnrichmentEvents(updatedAt, reason);
  for (const row of rows) {
    const payload = parseSemanticEnrichmentEventPayload(row.payload_json);
    if (payload?.kind !== 'file_import') continue;
    updateExtractionStatusSemanticDescriptor(
      extractionStatus,
      dashDb,
      payload.assertionUri,
      semanticEnrichmentDescriptorFromRow(row),
    );
  }
  return rows.length;
}

export function resolveChatTurnsAssertionAgentAddress(agent: {
  peerId: string;
  getDefaultAgentAddress?: () => string | undefined;
}): string {
  const defaultAgentAddress = typeof agent.getDefaultAgentAddress === 'function'
    ? agent.getDefaultAgentAddress()?.trim()
    : '';
  return defaultAgentAddress || agent.peerId;
}

export function buildChatSemanticEventPayload(args: {
  assertionAgentAddress: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  assistantReply: string;
  attachmentRefs?: OpenClawAttachmentRef[];
  persistenceState: 'stored' | 'failed' | 'pending';
  failureReason?: string;
  projectContextGraphId?: string;
}): ChatTurnSemanticEventPayload {
  return {
    kind: 'chat_turn',
    sessionId: args.sessionId,
    turnId: args.turnId,
    contextGraphId: 'agent-context',
    assertionName: 'chat-turns',
    assertionUri: contextGraphAssertionUri('agent-context', args.assertionAgentAddress, 'chat-turns'),
    sessionUri: `urn:dkg:chat:session:${args.sessionId}`,
    turnUri: `urn:dkg:chat:turn:${args.turnId}`,
    userMessage: args.userMessage,
    assistantReply: args.assistantReply,
    ...(args.attachmentRefs?.length ? { attachmentRefs: args.attachmentRefs } : {}),
    persistenceState: args.persistenceState,
    ...(args.failureReason ? { failureReason: args.failureReason } : {}),
    ...(args.projectContextGraphId ? { projectContextGraphId: args.projectContextGraphId } : {}),
  };
}

export function buildFileSemanticEventPayload(args: {
  contextGraphId: string;
  assertionName: string;
  assertionUri: string;
  importStartedAt: string;
  sourceAgentAddress?: string;
  rootEntity?: string;
  fileHash: string;
  mdIntermediateHash?: string;
  detectedContentType: string;
  sourceFileName?: string;
  ontologyRef?: string;
}): FileImportSemanticEventPayload {
  return {
    kind: 'file_import',
    contextGraphId: args.contextGraphId,
    assertionName: args.assertionName,
    assertionUri: args.assertionUri,
    importStartedAt: args.importStartedAt,
    ...(args.sourceAgentAddress ? { sourceAgentAddress: args.sourceAgentAddress } : {}),
    ...(args.rootEntity ? { rootEntity: args.rootEntity } : {}),
    fileHash: args.fileHash,
    ...(args.mdIntermediateHash ? { mdIntermediateHash: args.mdIntermediateHash } : {}),
    detectedContentType: args.detectedContentType,
    ...(args.sourceFileName ? { sourceFileName: args.sourceFileName } : {}),
    ...(args.ontologyRef ? { ontologyRef: args.ontologyRef } : {}),
  };
}

function ensureSemanticEnrichmentEvent(
  dashDb: DashboardDB,
  kind: SemanticEnrichmentKind,
  payload: SemanticEnrichmentEventPayload,
  semanticTripleCount = 0,
): SemanticEnrichmentDescriptor {
  const now = Date.now();
  const payloadJson = JSON.stringify(payload);
  const idempotencyKey = kind === 'chat_turn' && payload.kind === 'chat_turn'
    ? buildChatSemanticIdempotencyKey(payload.turnId, semanticEnrichmentPayloadHash(payloadJson))
    : kind === 'file_import' && payload.kind === 'file_import'
      ? buildFileSemanticIdempotencyKey({
          assertionUri: payload.assertionUri,
          importStartedAt: payload.importStartedAt,
          fileHash: payload.fileHash,
          mdIntermediateHash: payload.mdIntermediateHash,
          ontologyRef: payload.ontologyRef,
        })
      : (() => {
          throw new Error(`Semantic enrichment payload kind mismatch: expected ${kind}, received ${payload.kind}`);
        })();
  const existing = dashDb.getSemanticEnrichmentEventByIdempotencyKey(idempotencyKey);
  if (existing) {
    const refreshed = refreshActiveChatSemanticEventPayloadIfNeeded(
      dashDb,
      existing,
      kind,
      payload,
      payloadJson,
      semanticTripleCount,
      now,
    );
    if (refreshed) return refreshed;
    return semanticEnrichmentDescriptorFromRow(existing);
  }

  const eventId = randomUUID();
  try {
    dashDb.insertSemanticEnrichmentEvent({
      id: eventId,
      kind,
      idempotency_key: idempotencyKey,
      payload_json: payloadJson,
      status: 'pending',
      semantic_triple_count: semanticTripleCount,
      attempts: 0,
      max_attempts: SEMANTIC_ENRICHMENT_MAX_ATTEMPTS,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    const racedExisting = dashDb.getSemanticEnrichmentEventByIdempotencyKey(idempotencyKey);
    if (racedExisting) {
      const refreshed = refreshActiveChatSemanticEventPayloadIfNeeded(
        dashDb,
        racedExisting,
        kind,
        payload,
        payloadJson,
        semanticTripleCount,
        now,
      );
      if (refreshed) return refreshed;
      return semanticEnrichmentDescriptorFromRow(racedExisting);
    }
    throw err;
  }
  const row = dashDb.getSemanticEnrichmentEvent(eventId);
  return semanticEnrichmentDescriptorFromRow(row ?? {
    id: eventId,
    status: 'pending',
    semantic_triple_count: semanticTripleCount,
    updated_at: now,
    last_error: null,
  });
}

function refreshActiveChatSemanticEventPayloadIfNeeded(
  dashDb: DashboardDB,
  row: SemanticEnrichmentEventRow,
  kind: SemanticEnrichmentKind,
  payload: SemanticEnrichmentEventPayload,
  payloadJson: string,
  semanticTripleCount: number,
  now: number,
): SemanticEnrichmentDescriptor | undefined {
  if (
    kind !== 'chat_turn'
    || payload.kind !== 'chat_turn'
    || row.payload_json === payloadJson
    || !['pending', 'leased'].includes(row.status)
  ) {
    return undefined;
  }

  const refreshed = dashDb.refreshActiveSemanticEnrichmentEventPayload(
    row.id,
    payloadJson,
    semanticTripleCount,
    now,
  );
  if (!refreshed) return undefined;

  return semanticEnrichmentDescriptorFromRow(
    dashDb.getSemanticEnrichmentEvent(row.id) ?? {
      ...row,
      payload_json: payloadJson,
      status: row.status,
      semantic_triple_count: semanticTripleCount,
      attempts: 0,
      last_error: null,
      updated_at: now,
    },
  );
}

function isSemanticTripleInput(value: unknown): value is SemanticTripleInput {
  return isPlainRecord(value)
    && typeof value.subject === 'string'
    && value.subject.trim().length > 0
    && typeof value.predicate === 'string'
    && value.predicate.trim().length > 0
    && typeof value.object === 'string'
    && value.object.trim().length > 0;
}

function isSafeSemanticObjectInput(value: string): boolean {
  if (isSafeIri(value)) return true;
  if (!value.startsWith('"')) return false;
  try {
    assertSafeRdfTerm(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeOntologyQuadObjectInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isSafeIri(trimmed)) return trimmed;
  if (trimmed.startsWith('"')) {
    try {
      assertSafeRdfTerm(trimmed);
      return trimmed;
    } catch {
      return undefined;
    }
  }
  return JSON.stringify(trimmed);
}

function normalizeSemanticTripleInputs(raw: unknown): SemanticTripleInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const triples: SemanticTripleInput[] = [];
  for (const entry of raw) {
    if (!isSemanticTripleInput(entry)) return undefined;
    const subject = entry.subject.trim();
    const predicate = entry.predicate.trim();
    const object = entry.object.trim();
    if (!isSafeIri(subject) || !isSafeIri(predicate) || !isSafeSemanticObjectInput(object)) return undefined;
    triples.push({ subject, predicate, object });
  }
  return triples;
}

function semanticCountLiteral(value: number): string {
  return `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
}

function semanticEnrichmentSourceRef(payload: SemanticEnrichmentEventPayload): string {
  return payload.kind === 'file_import' ? `urn:dkg:file:${payload.fileHash}` : payload.turnUri;
}

async function semanticEnrichmentAlreadyApplied(
  agent: Pick<DKGAgent, 'store'>,
  graph: string,
  eventId: string,
): Promise<boolean> {
  const provenanceUri = `urn:dkg:semantic-enrichment:${eventId}`;
  const result = await agent.store.query(`
    ASK {
      GRAPH <${graph}> {
        <${provenanceUri}> ?p ?o .
      }
    }
  `) as { value?: boolean };
  return result?.value === true;
}

type SemanticAppendQuad = ReturnType<typeof buildSemanticAppendQuads>[number];

function semanticAppendQuadKey(quad: SemanticAppendQuad): string {
  return `${quad.graph}\u0000${quad.subject}\u0000${quad.predicate}\u0000${quad.object}`;
}

function semanticQuadObjectSparqlTerm(object: string): string {
  return isSafeIri(object) ? `<${object}>` : object;
}

async function semanticAppendQuadExists(
  agent: Pick<DKGAgent, 'store'>,
  quad: SemanticAppendQuad,
): Promise<boolean> {
  const result = await agent.store.query(`
    ASK {
      GRAPH <${quad.graph}> {
        <${quad.subject}> <${quad.predicate}> ${semanticQuadObjectSparqlTerm(quad.object)} .
      }
    }
  `) as { value?: boolean };
  return result?.value === true;
}

async function readExistingSemanticAppendQuadKeys(
  agent: Pick<DKGAgent, 'store'>,
  quads: SemanticAppendQuad[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const seen = new Set<string>();
  for (const quad of quads) {
    const key = semanticAppendQuadKey(quad);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await semanticAppendQuadExists(agent, quad)) existing.add(key);
  }
  return existing;
}

async function cleanupSemanticAppendQuads(
  agent: Pick<DKGAgent, 'store'>,
  quads: SemanticAppendQuad[],
  preExistingKeys: Set<string>,
): Promise<void> {
  const cleaned = new Set<string>();
  for (const quad of [...quads].reverse()) {
    const key = semanticAppendQuadKey(quad);
    if (preExistingKeys.has(key) || cleaned.has(key)) continue;
    cleaned.add(key);
    await agent.store.deleteByPattern(quad);
  }
}

async function readCurrentSemanticTripleCount(
  agent: Pick<DKGAgent, 'store'>,
  contextGraphId: string,
  assertionUri: string,
): Promise<number> {
  return (await readCurrentSemanticTripleCountState(agent, contextGraphId, assertionUri)).count;
}

async function readCurrentSemanticTripleCountState(
  agent: Pick<DKGAgent, 'store'>,
  contextGraphId: string,
  assertionUri: string,
): Promise<{ exists: boolean; count: number }> {
  const result = await agent.store.query(`
    SELECT ?count WHERE {
      GRAPH <${contextGraphMetaUri(contextGraphId)}> {
        <${assertionUri}> <${SEMANTIC_ENRICHMENT_COUNT_PREDICATE}> ?count .
      }
    }
    LIMIT 1
  `) as { bindings?: Array<Record<string, string>> };
  const rawCount = result?.bindings?.[0]?.count;
  return {
    exists: rawCount !== undefined,
    count: parseOpenClawAttachmentTripleCount(rawCount) ?? 0,
  };
}

export function normalizeQueriedLiteralValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const iri = trimmed.slice(1, -1).trim();
    return iri || undefined;
  }
  if (!trimmed.startsWith('"')) return trimmed;

  let escaped = false;
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      try {
        const parsed = JSON.parse(trimmed.slice(0, i + 1));
        return typeof parsed === 'string' && parsed ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function readCurrentFileImportSourceIdentity(
  agent: Pick<DKGAgent, 'store'>,
  contextGraphId: string,
  assertionUri: string,
): Promise<{ fileHash?: string; mdIntermediateHash?: string; importStartedAt?: string } | null> {
  const result = await agent.store.query(`
    SELECT ?fileHash ?mdIntermediateHash ?importStartedAt WHERE {
      GRAPH <${contextGraphMetaUri(contextGraphId)}> {
        OPTIONAL { <${assertionUri}> <http://dkg.io/ontology/sourceFileHash> ?fileHash . }
        OPTIONAL { <${assertionUri}> <http://dkg.io/ontology/mdIntermediateHash> ?mdIntermediateHash . }
        OPTIONAL { <${assertionUri}> <http://dkg.io/ontology/importStartedAt> ?importStartedAt . }
      }
    }
    LIMIT 1
  `) as { bindings?: Array<Record<string, unknown>> };
  const binding = result?.bindings?.[0];
  if (!binding) return null;
  return {
    fileHash: normalizeQueriedLiteralValue(binding.fileHash),
    mdIntermediateHash: normalizeQueriedLiteralValue(binding.mdIntermediateHash),
    importStartedAt: normalizeQueriedLiteralValue(binding.importStartedAt),
  };
}

export function fileImportSourceIdentityMatchesCurrentState(
  payload: FileImportSemanticEventPayload,
  current: { fileHash?: string; mdIntermediateHash?: string; importStartedAt?: string } | null,
): boolean {
  if (!current?.fileHash || current.fileHash !== payload.fileHash) return false;
  const queuedMdHash = payload.mdIntermediateHash?.trim() || undefined;
  const currentMdHash = current.mdIntermediateHash?.trim() || undefined;
  if (currentMdHash !== queuedMdHash) return false;
  const queuedImportStartedAt = payload.importStartedAt.trim();
  const currentImportStartedAt = current.importStartedAt?.trim();
  return !!currentImportStartedAt && currentImportStartedAt === queuedImportStartedAt;
}

async function readSemanticProvenanceTripleCount(
  agent: Pick<DKGAgent, 'store'>,
  graph: string,
  eventId: string,
): Promise<number> {
  const provenanceUri = `urn:dkg:semantic-enrichment:${eventId}`;
  const result = await agent.store.query(`
    SELECT ?count WHERE {
      GRAPH <${graph}> {
        <${provenanceUri}> <${SEMANTIC_ENRICHMENT_COUNT_PREDICATE}> ?count .
      }
    }
    LIMIT 1
  `) as { bindings?: Array<Record<string, string>> };
  return parseOpenClawAttachmentTripleCount(result?.bindings?.[0]?.count) ?? 0;
}

export async function readSemanticTripleCountForEvent(
  agent: Pick<DKGAgent, 'store'>,
  eventPayload: SemanticEnrichmentEventPayload,
  eventId: string,
): Promise<number> {
  if (eventPayload.kind === 'file_import') {
    return readCurrentSemanticTripleCount(agent, eventPayload.contextGraphId, eventPayload.assertionUri);
  }
  return readSemanticProvenanceTripleCount(agent, eventPayload.assertionUri, eventId);
}

export function semanticWorkerDidFromLeaseOwner(leaseOwner: string): string {
  const normalized = leaseOwner.trim() || 'unknown-worker';
  return `urn:dkg:semantic-worker:${Buffer.from(normalized).toString('base64url')}`;
}

export function buildSemanticAppendQuads(args: {
  extractedByDid: string;
  sourceAgentDid?: string;
  eventId: string;
  graph: string;
  sourceRef: string;
  triples: SemanticTripleInput[];
  semanticTripleCount: number;
  extractedAt: string;
}): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  const provenanceUri = `urn:dkg:semantic-enrichment:${args.eventId}`;
  const quads = args.triples.map((triple) => ({
    subject: triple.subject,
    predicate: triple.predicate,
    object: triple.object,
    graph: args.graph,
  }));

  const sourceLinkedSubjects = new Set<string>();
  for (const triple of args.triples) {
    if (triple.subject !== args.sourceRef && isSafeIri(triple.subject)) sourceLinkedSubjects.add(triple.subject);
  }

  quads.push(
    { subject: provenanceUri, predicate: RDF_TYPE_PREDICATE, object: EXTRACTION_PROVENANCE_TYPE, graph: args.graph },
    { subject: provenanceUri, predicate: SEMANTIC_ENRICHMENT_SOURCE_PREDICATE, object: args.sourceRef, graph: args.graph },
    { subject: provenanceUri, predicate: EXTRACTED_BY_PREDICATE, object: args.extractedByDid, graph: args.graph },
    { subject: provenanceUri, predicate: EXTRACTED_AT_PREDICATE, object: `"${args.extractedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: args.graph },
    { subject: provenanceUri, predicate: EXTRACTION_METHOD_PREDICATE, object: JSON.stringify(SEMANTIC_ENRICHMENT_METHOD), graph: args.graph },
    { subject: provenanceUri, predicate: SEMANTIC_ENRICHMENT_EVENT_ID_PREDICATE, object: JSON.stringify(args.eventId), graph: args.graph },
    { subject: provenanceUri, predicate: SEMANTIC_ENRICHMENT_COUNT_PREDICATE, object: semanticCountLiteral(args.semanticTripleCount), graph: args.graph },
  );
  if (args.sourceAgentDid && isSafeIri(args.sourceAgentDid)) {
    quads.push({
      subject: provenanceUri,
      predicate: SEMANTIC_ENRICHMENT_SOURCE_AGENT_PREDICATE,
      object: args.sourceAgentDid,
      graph: args.graph,
    });
  }

  for (const subject of sourceLinkedSubjects) {
    quads.push({
      subject,
      predicate: SEMANTIC_ENRICHMENT_SOURCE_PREDICATE,
      object: args.sourceRef,
      graph: args.graph,
    });
  }

  return quads;
}

function rowLeaseOwnedBy(
  row: SemanticEnrichmentEventRow,
  leaseOwner: string,
  options: { now?: number; payloadHash?: string } = {},
): boolean {
  const now = options.now ?? Date.now();
  return row.status === 'leased'
    && row.lease_owner === leaseOwner
    && typeof row.lease_expires_at === 'number'
    && row.lease_expires_at > now
    && (!options.payloadHash || semanticEnrichmentPayloadHash(row.payload_json) === options.payloadHash);
}

function releaseSupersededSemanticLeaseIfOwned(
  dashDb: DashboardDB,
  row: SemanticEnrichmentEventRow | undefined,
  leaseOwner: string,
  options: { now?: number; payloadHash?: string } = {},
): boolean {
  const payloadHash = options.payloadHash;
  if (!row || !payloadHash) return false;
  const now = options.now ?? Date.now();
  if (
    row.status !== 'leased'
    || row.lease_owner !== leaseOwner
    || typeof row.lease_expires_at !== 'number'
    || row.lease_expires_at <= now
    || semanticEnrichmentPayloadHash(row.payload_json) === payloadHash
  ) {
    return false;
  }
  return dashDb.releaseSemanticEnrichmentLease(row.id, leaseOwner, now);
}

function failLeasedSemanticEvent(
  dashDb: DashboardDB,
  row: SemanticEnrichmentEventRow,
  leaseOwner: string,
  error: string,
  now = Date.now(),
): SemanticEnrichmentStatus | undefined {
  return dashDb.failSemanticEnrichmentEvent(
    row.id,
    leaseOwner,
    row.attempts,
    row.max_attempts,
    dashDb.getSemanticEnrichmentNextAttemptAt(now, row.attempts),
    now,
    error,
  );
}

export async function handleSemanticEnrichmentRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, config, dashDb, agent, extractionStatus, requestToken, bridgeAuthToken } = ctx;
  if (!path.startsWith('/api/semantic-enrichment/')) return;

  if (!isAuthorizedLocalAgentSemanticWorkerRequest(config, req, 'openclaw', {
    requestToken,
    bridgeAuthToken,
    resolveAgentByToken: (token) => agent.resolveAgentByToken(token),
  })) {
    return jsonResponse(res, 403, {
      error: 'Semantic enrichment worker routes are restricted to the local OpenClaw runtime',
    });
  }

  const bodyLimit = req.method === 'POST' && path === '/api/semantic-enrichment/events/append'
    ? SEMANTIC_APPEND_BODY_BYTES
    : SMALL_BODY_BYTES;
  const body = await readBody(req, bodyLimit);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/claim') {
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    if (!leaseOwner) return jsonResponse(res, 400, { error: 'Missing "leaseOwner"' });

    const now = Date.now();
    const claimed = dashDb.claimNextRunnableSemanticEnrichmentEvent(now, leaseOwner);
    if (!claimed) return jsonResponse(res, 200, { event: null });

    const eventPayload = parseSemanticEnrichmentEventPayload(claimed.payload_json);
    if (!eventPayload) {
      failLeasedSemanticEvent(dashDb, claimed, leaseOwner, 'Invalid semantic enrichment event payload', now);
      return jsonResponse(res, 200, { event: null });
    }
    if (eventPayload.kind === 'file_import') {
      const currentSource = await readCurrentFileImportSourceIdentity(
        agent,
        eventPayload.contextGraphId,
        eventPayload.assertionUri,
      );
      if (!fileImportSourceIdentityMatchesCurrentState(eventPayload, currentSource)) {
        dashDb.failSemanticEnrichmentEvent(
          claimed.id,
          leaseOwner,
          claimed.max_attempts,
          claimed.max_attempts,
          now,
          now,
          'Queued semantic source no longer matches the current assertion state',
        );
        const updated = dashDb.getSemanticEnrichmentEvent(claimed.id);
        if (updated) {
          updateExtractionStatusSemanticDescriptor(
            extractionStatus,
            dashDb,
            eventPayload.assertionUri,
            semanticEnrichmentDescriptorFromRow(updated),
          );
        }
        return jsonResponse(res, 200, { event: null });
      }
    }

    return jsonResponse(res, 200, {
      event: {
        id: claimed.id,
        kind: claimed.kind,
        payload: eventPayload,
        status: claimed.status,
        attempts: claimed.attempts,
        maxAttempts: claimed.max_attempts,
        leaseOwner: claimed.lease_owner,
        leaseExpiresAt: claimed.lease_expires_at,
        nextAttemptAt: claimed.next_attempt_at,
        payloadHash: semanticEnrichmentPayloadHash(claimed.payload_json),
        lastError: claimed.last_error ?? undefined,
      },
    });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/renew') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    const payloadHash = normalizePayloadHash(payload.payloadHash);
    if (!eventId || !leaseOwner) return jsonResponse(res, 400, { error: 'Missing "eventId" or "leaseOwner"' });
    if (!payloadHash) return jsonResponse(res, 400, { error: 'Missing or invalid "payloadHash"' });
    const row = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!row || !rowLeaseOwnedBy(row, leaseOwner, { payloadHash })) {
      releaseSupersededSemanticLeaseIfOwned(dashDb, row, leaseOwner, { payloadHash });
      return jsonResponse(res, 409, { renewed: false });
    }
    const renewed = dashDb.renewSemanticEnrichmentLease(eventId, leaseOwner, Date.now());
    return jsonResponse(res, renewed ? 200 : 409, { renewed });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/release') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    const payloadHash = normalizePayloadHash(payload.payloadHash);
    if (!eventId || !leaseOwner) return jsonResponse(res, 400, { error: 'Missing "eventId" or "leaseOwner"' });
    if (!payloadHash) return jsonResponse(res, 400, { error: 'Missing or invalid "payloadHash"' });
    const row = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!row) return jsonResponse(res, 404, { error: `Semantic enrichment event not found: ${eventId}` });
    if (!rowLeaseOwnedBy(row, leaseOwner, { payloadHash })) {
      releaseSupersededSemanticLeaseIfOwned(dashDb, row, leaseOwner, { payloadHash });
      return jsonResponse(res, 409, { released: false });
    }
    const released = dashDb.releaseSemanticEnrichmentLease(eventId, leaseOwner, Date.now());
    if (!released) return jsonResponse(res, 409, { released: false });
    const updated = dashDb.getSemanticEnrichmentEvent(eventId);
    const eventPayload = updated ? parseSemanticEnrichmentEventPayload(updated.payload_json) : undefined;
    if (updated && eventPayload?.kind === 'file_import') {
      const descriptor = semanticEnrichmentDescriptorFromRow(updated);
      updateExtractionStatusSemanticDescriptor(extractionStatus, dashDb, eventPayload.assertionUri, descriptor);
      return jsonResponse(res, 200, { released: true, semanticEnrichment: descriptor });
    }
    return jsonResponse(res, 200, {
      released: true,
      ...(updated ? { semanticEnrichment: semanticEnrichmentDescriptorFromRow(updated) } : {}),
    });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/complete') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    const payloadHash = normalizePayloadHash(payload.payloadHash);
    if (!eventId || !leaseOwner) return jsonResponse(res, 400, { error: 'Missing "eventId" or "leaseOwner"' });
    if (!payloadHash) return jsonResponse(res, 400, { error: 'Missing or invalid "payloadHash"' });
    const row = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!row) return jsonResponse(res, 404, { error: `Semantic enrichment event not found: ${eventId}` });
    if (!rowLeaseOwnedBy(row, leaseOwner, { payloadHash })) {
      releaseSupersededSemanticLeaseIfOwned(dashDb, row, leaseOwner, { payloadHash });
      return jsonResponse(res, 409, { completed: false });
    }
    const eventPayload = parseSemanticEnrichmentEventPayload(row.payload_json);
    if (!eventPayload) return jsonResponse(res, 500, { error: `Semantic enrichment event payload is invalid: ${eventId}` });
    const now = Date.now();
    if (eventPayload.kind === 'file_import') {
      const currentSource = await readCurrentFileImportSourceIdentity(
        agent,
        eventPayload.contextGraphId,
        eventPayload.assertionUri,
      );
      if (!fileImportSourceIdentityMatchesCurrentState(eventPayload, currentSource)) {
        dashDb.failSemanticEnrichmentEvent(
          eventId,
          leaseOwner,
          row.max_attempts,
          row.max_attempts,
          now,
          now,
          'Queued semantic source no longer matches the current assertion state',
        );
        const updated = dashDb.getSemanticEnrichmentEvent(eventId);
        if (updated) {
          const descriptor = semanticEnrichmentDescriptorFromRow(updated);
          updateExtractionStatusSemanticDescriptor(extractionStatus, dashDb, eventPayload.assertionUri, descriptor);
          return jsonResponse(res, 409, {
            completed: false,
            error: 'Semantic enrichment source no longer matches the current assertion state',
            semanticEnrichment: descriptor,
          });
        }
        return jsonResponse(res, 409, {
          completed: false,
          error: 'Semantic enrichment source no longer matches the current assertion state',
        });
      }
    }
    const semanticTripleCount = eventPayload
      ? await readSemanticTripleCountForEvent(agent, eventPayload, eventId)
      : 0;
    const completed = dashDb.completeSemanticEnrichmentEvent(eventId, leaseOwner, now, semanticTripleCount);
    if (!completed) return jsonResponse(res, 409, { completed: false });
    const updatedRow = dashDb.getSemanticEnrichmentEvent(eventId);
    const descriptorRow = updatedRow ?? row;
    const descriptor = semanticEnrichmentDescriptorFromRow(descriptorRow, semanticTripleCount);
    if (eventPayload?.kind === 'file_import') {
      updateExtractionStatusSemanticDescriptor(extractionStatus, dashDb, eventPayload.assertionUri, descriptor);
    }
    return jsonResponse(res, 200, { completed: true, semanticEnrichment: descriptor });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/fail') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    const errorMessage = typeof payload.error === 'string' ? payload.error.trim() : '';
    const payloadHash = normalizePayloadHash(payload.payloadHash);
    if (!eventId || !leaseOwner || !errorMessage) {
      return jsonResponse(res, 400, { error: 'Missing "eventId", "leaseOwner", or "error"' });
    }
    if (!payloadHash) return jsonResponse(res, 400, { error: 'Missing or invalid "payloadHash"' });
    const row = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!row) return jsonResponse(res, 404, { error: `Semantic enrichment event not found: ${eventId}` });
    if (!rowLeaseOwnedBy(row, leaseOwner, { payloadHash })) {
      releaseSupersededSemanticLeaseIfOwned(dashDb, row, leaseOwner, { payloadHash });
      return jsonResponse(res, 409, { status: null });
    }
    const status = failLeasedSemanticEvent(dashDb, row, leaseOwner, errorMessage);
    if (!status) return jsonResponse(res, 409, { status: null });
    const updated = dashDb.getSemanticEnrichmentEvent(eventId);
    const eventPayload = updated ? parseSemanticEnrichmentEventPayload(updated.payload_json) : undefined;
    if (updated && eventPayload?.kind === 'file_import') {
      updateExtractionStatusSemanticDescriptor(
        extractionStatus,
        dashDb,
        eventPayload.assertionUri,
        semanticEnrichmentDescriptorFromRow(updated),
      );
    }
    return jsonResponse(res, 200, {
      status,
      ...(updated ? { semanticEnrichment: semanticEnrichmentDescriptorFromRow(updated) } : {}),
    });
  }

  if (req.method === 'POST' && path === '/api/semantic-enrichment/events/append') {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
    const leaseOwner = typeof payload.leaseOwner === 'string' ? payload.leaseOwner.trim() : '';
    const payloadHash = normalizePayloadHash(payload.payloadHash);
    const triples = normalizeSemanticTripleInputs(payload.triples);
    if (!eventId || !leaseOwner || !triples) {
      return jsonResponse(res, 400, { error: 'Missing "eventId", "leaseOwner", or valid "triples"' });
    }
    if (!payloadHash) return jsonResponse(res, 400, { error: 'Missing or invalid "payloadHash"' });
    const row = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!row) return jsonResponse(res, 404, { error: `Semantic enrichment event not found: ${eventId}` });
    const eventPayload = parseSemanticEnrichmentEventPayload(row.payload_json);
    if (!eventPayload) return jsonResponse(res, 500, { error: `Semantic enrichment event payload is invalid: ${eventId}` });
    if (!rowLeaseOwnedBy(row, leaseOwner, { payloadHash })) {
      if (row.status === 'completed') {
        const semanticTripleCount = await readSemanticTripleCountForEvent(agent, eventPayload, eventId);
        return jsonResponse(res, 200, {
          applied: false,
          alreadyApplied: true,
          completed: true,
          semanticEnrichment: semanticEnrichmentDescriptorFromRow(row, semanticTripleCount),
        });
      }
      releaseSupersededSemanticLeaseIfOwned(dashDb, row, leaseOwner, { payloadHash });
      return jsonResponse(res, 409, { error: 'Semantic enrichment lease is no longer owned by this worker' });
    }

    const now = Date.now();
    const extractedAt = new Date(now).toISOString();
    const targetGraph = eventPayload.assertionUri;
    const sourceRef = semanticEnrichmentSourceRef(eventPayload);
    if (eventPayload.kind === 'file_import') {
      const currentSource = await readCurrentFileImportSourceIdentity(
        agent,
        eventPayload.contextGraphId,
        eventPayload.assertionUri,
      );
      if (!fileImportSourceIdentityMatchesCurrentState(eventPayload, currentSource)) {
        dashDb.failSemanticEnrichmentEvent(
          eventId,
          leaseOwner,
          row.max_attempts,
          row.max_attempts,
          now,
          now,
          'Queued semantic source no longer matches the current assertion state',
        );
        const updated = dashDb.getSemanticEnrichmentEvent(eventId);
        if (updated) {
          const descriptor = semanticEnrichmentDescriptorFromRow(updated);
          updateExtractionStatusSemanticDescriptor(extractionStatus, dashDb, eventPayload.assertionUri, descriptor);
          return jsonResponse(res, 409, {
            error: 'Semantic enrichment source no longer matches the current assertion state',
            semanticEnrichment: descriptor,
          });
        }
        return jsonResponse(res, 409, { error: 'Semantic enrichment source no longer matches the current assertion state' });
      }
    }

    const alreadyApplied = await semanticEnrichmentAlreadyApplied(agent, targetGraph, eventId);
    let semanticTripleCount = await readSemanticTripleCountForEvent(agent, eventPayload, eventId);

    if (!alreadyApplied && triples.length > 0) {
      const sourceAgentDid = eventPayload.kind === 'file_import' && eventPayload.sourceAgentAddress
        ? `did:dkg:agent:${eventPayload.sourceAgentAddress}`
        : undefined;
      const semanticQuads = buildSemanticAppendQuads({
        extractedByDid: semanticWorkerDidFromLeaseOwner(leaseOwner),
        sourceAgentDid,
        eventId,
        graph: targetGraph,
        sourceRef,
        triples,
        semanticTripleCount: triples.length,
        extractedAt,
      });
      if (eventPayload.kind === 'file_import') {
        const previousSemanticTripleCountState = await readCurrentSemanticTripleCountState(
          agent,
          eventPayload.contextGraphId,
          eventPayload.assertionUri,
        );
        semanticTripleCount = previousSemanticTripleCountState.count + triples.length;
        const metaGraph = contextGraphMetaUri(eventPayload.contextGraphId);
        semanticQuads.push({
          subject: eventPayload.assertionUri,
          predicate: SEMANTIC_ENRICHMENT_COUNT_PREDICATE,
          object: semanticCountLiteral(semanticTripleCount),
          graph: metaGraph,
        });
        const preExistingSemanticQuadKeys = await readExistingSemanticAppendQuadKeys(agent, semanticQuads);
        try {
          await agent.store.deleteByPattern({
            subject: eventPayload.assertionUri,
            predicate: SEMANTIC_ENRICHMENT_COUNT_PREDICATE,
            graph: metaGraph,
          });
          await agent.store.insert(semanticQuads);
        } catch (err: any) {
          try {
            await cleanupSemanticAppendQuads(agent, semanticQuads, preExistingSemanticQuadKeys);
            await agent.store.deleteByPattern({
              subject: eventPayload.assertionUri,
              predicate: SEMANTIC_ENRICHMENT_COUNT_PREDICATE,
              graph: metaGraph,
            });
          } catch (cleanupErr: any) {
            throw new Error(
              `${err?.message ?? String(err)}; semantic append cleanup failed: ${cleanupErr?.message ?? String(cleanupErr)}`,
            );
          }
          if (previousSemanticTripleCountState.exists) {
            try {
              await agent.store.insert([{
                subject: eventPayload.assertionUri,
                predicate: SEMANTIC_ENRICHMENT_COUNT_PREDICATE,
                object: semanticCountLiteral(previousSemanticTripleCountState.count),
                graph: metaGraph,
              }]);
            } catch (restoreErr: any) {
              throw new Error(
                `${err?.message ?? String(err)}; semantic count rollback failed: ${restoreErr?.message ?? String(restoreErr)}`,
              );
            }
          }
          throw err;
        }
      } else {
        semanticTripleCount = triples.length;
        const preExistingSemanticQuadKeys = await readExistingSemanticAppendQuadKeys(agent, semanticQuads);
        try {
          await agent.store.insert(semanticQuads);
        } catch (err: any) {
          try {
            await cleanupSemanticAppendQuads(agent, semanticQuads, preExistingSemanticQuadKeys);
          } catch (cleanupErr: any) {
            throw new Error(
              `${err?.message ?? String(err)}; semantic append cleanup failed: ${cleanupErr?.message ?? String(cleanupErr)}`,
            );
          }
          throw err;
        }
      }
    }

    const completed = dashDb.completeSemanticEnrichmentEvent(eventId, leaseOwner, Date.now(), semanticTripleCount);
    const updated = dashDb.getSemanticEnrichmentEvent(eventId);
    if (!updated) return jsonResponse(res, 404, { error: `Semantic enrichment event not found after append: ${eventId}` });
    const descriptor = semanticEnrichmentDescriptorFromRow(updated, semanticTripleCount);
    if (eventPayload.kind === 'file_import') {
      updateExtractionStatusSemanticDescriptor(extractionStatus, dashDb, eventPayload.assertionUri, descriptor);
    }
    return jsonResponse(res, completed ? 200 : 409, {
      applied: !alreadyApplied && triples.length > 0,
      alreadyApplied,
      completed,
      semanticEnrichment: descriptor,
    });
  }

  return jsonResponse(res, 404, { error: 'Not found' });
}

export async function handleTemporaryOntologyWriteRoute(ctx: RequestContext): Promise<void> {
  const { req, res, path, agent, requestAgentAddress } = ctx;
  if (
    req.method !== 'POST'
    || !path.startsWith('/api/context-graph/')
    || !path.endsWith('/_ontology/write')
  ) {
    return;
  }

  const contextGraphId = safeDecodeURIComponent(
    path.slice('/api/context-graph/'.length, -'/_ontology/write'.length),
    res,
  );
  if (contextGraphId === null) return;
  if (!validateRequiredContextGraphId(contextGraphId, res)) return;

  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  const quads = Array.isArray(parsed.quads) ? parsed.quads : undefined;
  if (!quads?.length) return jsonResponse(res, 400, { error: 'Missing "quads"' });

  const ontologyGraph = contextGraphOntologyUri(contextGraphId);
  const normalizedQuads: Array<{ subject: string; predicate: string; object: string }> = [];
  for (const entry of quads) {
    if (!isPlainRecord(entry)) return jsonResponse(res, 400, { error: 'Each ontology quad must be an object' });
    const subject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
    const predicate = typeof entry.predicate === 'string' ? entry.predicate.trim() : '';
    const objectRaw = typeof entry.object === 'string' ? entry.object.trim() : '';
    if (!subject || !predicate || !objectRaw) {
      return jsonResponse(res, 400, { error: 'Ontology quads require subject, predicate, and object strings' });
    }
    if (!isSafeIri(subject) || !isSafeIri(predicate)) {
      return jsonResponse(res, 400, { error: 'Ontology quad subject/predicate must be safe IRIs' });
    }
    const object = normalizeOntologyQuadObjectInput(objectRaw);
    if (!object) {
      return jsonResponse(res, 400, { error: 'Ontology quad object must be a safe IRI, valid RDF literal, or plain text' });
    }
    normalizedQuads.push({ subject, predicate, object });
  }

  try {
    const written = await agent.writeContextGraphOntology(contextGraphId, normalizedQuads, requestAgentAddress);
    res.setHeader('Deprecation', 'true');
    return jsonResponse(res, 200, {
      written,
      graph: ontologyGraph,
      deprecated: {
        currentEndpoint: 'POST /api/context-graph/{id}/_ontology/write',
        plannedReplacementEndpoint: 'POST /api/context-graph/{id}/ontology',
      },
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Only the context graph creator')) return jsonResponse(res, 403, { error: message });
    if (message.includes('does not exist')) return jsonResponse(res, 404, { error: message });
    return jsonResponse(res, 400, { error: message });
  }
}
