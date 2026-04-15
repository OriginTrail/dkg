import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  ChatTurnSemanticEventPayload,
  DkgDaemonClient,
  FileImportSemanticEventPayload,
  SemanticEnrichmentEventLease,
  SemanticTripleInput,
} from './dkg-client.js';
import type { OpenClawPluginApi, OpenClawRuntimeSubagent } from './types.js';

export type SemanticEnrichmentWakeKind = 'chat_turn' | 'file_import';
export type SemanticEnrichmentWakeTrigger = 'direct' | 'background';

export interface SemanticEnrichmentWakeRequest {
  kind: SemanticEnrichmentWakeKind;
  eventKey: string;
  triggerSource: SemanticEnrichmentWakeTrigger;
  uiContextGraphId?: string;
  sessionKey?: string;
  payload?: Record<string, unknown>;
}

export interface SemanticEnrichmentRuntimeProbe {
  supported: boolean;
  missing: string[];
  subagent: OpenClawRuntimeSubagent | null;
}

export interface SemanticEnrichmentPendingSummary {
  eventKey: string;
  kind: SemanticEnrichmentWakeKind;
  triggerSources: SemanticEnrichmentWakeTrigger[];
  uiContextGraphId?: string;
  sessionKey?: string;
  queuedAt: number;
  updatedAt: number;
}

interface PendingWakeRecord {
  request: SemanticEnrichmentWakeRequest;
  triggerSources: Set<SemanticEnrichmentWakeTrigger>;
  queuedAt: number;
  updatedAt: number;
}

interface OntologyContext {
  source: 'override' | 'project_ontology' | 'schema_org';
  graphUri?: string;
  triples: string[];
}

const SUBAGENT_SESSION_PREFIX = 'agent';
const SUBAGENT_SESSION_SCOPE = 'subagent';
const SUBAGENT_SESSION_NAME = 'semantic-enrichment';
const CLAIM_POLL_INTERVAL_MS = 30_000;
const LEASE_RENEW_INTERVAL_MS = 60_000;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 90_000;
const DEFAULT_SUBAGENT_MESSAGE_LIMIT = 25;
const MAX_SOURCE_TEXT_CHARS = 12_000;
const MAX_ONTOLOGY_TRIPLES = 80;
const DKG_HAS_USER_MESSAGE = 'http://dkg.io/ontology/hasUserMessage';
const DKG_HAS_ASSISTANT_MESSAGE = 'http://dkg.io/ontology/hasAssistantMessage';

function contextGraphOntologyUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_ontology`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readBindingValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/[<>]/g, '').trim();
  if (isRecord(value) && typeof value.value === 'string') return value.value.replace(/[<>]/g, '').trim();
  return '';
}

function isIriLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isQuotedLiteral(value: string): boolean {
  return value.startsWith('"');
}

function toObjectTerm(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isIriLike(trimmed) || isQuotedLiteral(trimmed)) return trimmed;
  return JSON.stringify(trimmed);
}

function normalizeTriples(raw: unknown): SemanticTripleInput[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  const triples: SemanticTripleInput[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const subject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
    const predicate = typeof entry.predicate === 'string' ? entry.predicate.trim() : '';
    const object = typeof entry.object === 'string' ? toObjectTerm(entry.object) : '';
    if (!isIriLike(subject) || !isIriLike(predicate) || !object) continue;
    const key = `${subject}\u0000${predicate}\u0000${object}`;
    if (dedup.has(key)) continue;
    dedup.add(key);
    triples.push({ subject, predicate, object });
  }
  return triples;
}

function extractJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return [...new Set(candidates)];
}

export class SemanticEnrichmentWorker {
  private api: OpenClawPluginApi;
  private client: DkgDaemonClient;
  private readonly workerInstanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private stopped = false;
  private started = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private drainInFlight: Promise<void> | null = null;
  private drainRequested = false;
  private readonly pending = new Map<string, PendingWakeRecord>();

  constructor(api: OpenClawPluginApi, client: DkgDaemonClient) {
    this.api = api;
    this.client = client;
  }

  bind(api: OpenClawPluginApi, client: DkgDaemonClient): void {
    this.api = api;
    this.client = client;
  }

  getWorkerInstanceId(): string {
    return this.workerInstanceId;
  }

  getRuntimeProbe(): SemanticEnrichmentRuntimeProbe {
    const subagent = this.api.runtime?.subagent;
    const missing: string[] = [];
    if (typeof subagent?.run !== 'function') missing.push('run');
    if (typeof subagent?.waitForRun !== 'function') missing.push('waitForRun');
    if (typeof subagent?.getSessionMessages !== 'function') missing.push('getSessionMessages');
    if (typeof subagent?.deleteSession !== 'function') missing.push('deleteSession');
    return {
      supported: missing.length === 0,
      missing,
      subagent: missing.length === 0 ? subagent ?? null : null,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.started) return;
    this.started = true;
    this.scheduleTick(0);
  }

  noteWake(request: SemanticEnrichmentWakeRequest): void {
    if (this.stopped) return;
    const existing = this.pending.get(request.eventKey);
    if (existing) {
      existing.request = {
        ...existing.request,
        ...request,
        payload: {
          ...(existing.request.payload ?? {}),
          ...(request.payload ?? {}),
        },
      };
      existing.triggerSources.add(request.triggerSource);
      existing.updatedAt = Date.now();
    } else {
      this.pending.set(request.eventKey, {
        request,
        triggerSources: new Set([request.triggerSource]),
        queuedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    this.poke();
  }

  poke(): void {
    if (this.stopped) return;
    this.scheduleDrain();
  }

  getPendingSummaries(): SemanticEnrichmentPendingSummary[] {
    return Array.from(this.pending.entries()).map(([eventKey, record]) => ({
      eventKey,
      kind: record.request.kind,
      triggerSources: Array.from(record.triggerSources),
      uiContextGraphId: record.request.uiContextGraphId,
      sessionKey: record.request.sessionKey,
      queuedAt: record.queuedAt,
      updatedAt: record.updatedAt,
    }));
  }

  async flush(): Promise<void> {
    this.poke();
    await this.drainInFlight?.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.pending.clear();
    await this.drainInFlight?.catch(() => {});
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.scheduleDrain();
    }, Math.max(0, delayMs));
  }

  private scheduleDrain(): void {
    if (this.stopped) return;
    if (this.drainInFlight) {
      this.drainRequested = true;
      return;
    }

    this.drainRequested = false;
    this.drainInFlight = this.drainOnce().finally(() => {
      this.drainInFlight = null;
      if (this.stopped) return;
      if (this.drainRequested) {
        this.scheduleDrain();
        return;
      }
      this.scheduleTick(CLAIM_POLL_INTERVAL_MS);
    });
  }

  private async drainOnce(): Promise<void> {
    const probe = this.getRuntimeProbe();
    if (!probe.supported || !probe.subagent) {
      this.api.logger.warn?.(
        `[semantic-enrichment] runtime.subagent unavailable; missing ${probe.missing.join(', ') || 'subagent helpers'}`,
      );
      return;
    }

    while (!this.stopped) {
      const claimed = await this.client.claimSemanticEnrichmentEvent(this.workerInstanceId);
      if (!claimed.event) return;
      await this.processClaimedEvent(claimed.event, probe.subagent);
      this.clearWakeSummary(claimed.event);
    }
  }

  private clearWakeSummary(event: SemanticEnrichmentEventLease): void {
    if (event.payload.kind === 'chat_turn') {
      this.pending.delete(event.payload.turnId);
    }
  }

  private async processClaimedEvent(
    event: SemanticEnrichmentEventLease,
    subagent: OpenClawRuntimeSubagent,
  ): Promise<void> {
    const sessionKey = this.buildSubagentSessionKey(event);
    const stopLeaseHeartbeat = this.startLeaseHeartbeat(event.id);
    let leaseLost = false;

    try {
      const prompt = await this.buildSubagentPrompt(event);
      const runResult = await subagent.run({
        sessionKey,
        message: prompt,
        deliver: false,
      });
      const runId = typeof runResult?.runId === 'string' && runResult.runId.trim()
        ? runResult.runId.trim()
        : undefined;
      if (!runId) {
        throw new Error('OpenClaw subagent run did not return a runId');
      }

      await subagent.waitForRun({
        runId,
        timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      });
      const messages = await subagent.getSessionMessages({
        sessionKey,
        limit: DEFAULT_SUBAGENT_MESSAGE_LIMIT,
      });
      const assistantText = this.extractAssistantText(messages.messages ?? []);
      const triples = this.parseTriplesFromAssistantText(assistantText);
      const appendResult = await this.client.appendSemanticEnrichmentEvent(
        event.id,
        this.workerInstanceId,
        triples,
      );
      if (!appendResult.completed) {
        throw new Error(`Semantic append did not complete for ${event.id}`);
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      leaseLost = message.includes('responded 409');
      if (!leaseLost) {
        await this.client
          .failSemanticEnrichmentEvent(event.id, this.workerInstanceId, message)
          .catch((failErr: any) => {
            this.api.logger.warn?.(
              `[semantic-enrichment] failed to record event failure for ${event.id}: ${failErr?.message ?? String(failErr)}`,
            );
          });
      }
      this.api.logger.warn?.(
        `[semantic-enrichment] execution failed for ${event.kind}:${event.id}: ${message}`,
      );
    } finally {
      stopLeaseHeartbeat();
      await subagent.deleteSession({ sessionKey }).catch((err: any) => {
        this.api.logger.warn?.(
          `[semantic-enrichment] session cleanup failed for ${event.id}: ${err?.message ?? String(err)}`,
        );
      });
      if (leaseLost) {
        this.api.logger.warn?.(
          `[semantic-enrichment] lease for ${event.kind}:${event.id} was reclaimed before completion`,
        );
      }
    }
  }

  private startLeaseHeartbeat(eventId: string): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const renew = async (): Promise<void> => {
      if (stopped || this.stopped) return;
      try {
        const result = await this.client.renewSemanticEnrichmentEvent(eventId, this.workerInstanceId);
        if (!result.renewed) {
          stopped = true;
          return;
        }
      } catch (err: any) {
        this.api.logger.warn?.(
          `[semantic-enrichment] lease renew failed for ${eventId}: ${err?.message ?? String(err)}`,
        );
      }
      if (!stopped && !this.stopped) {
        timer = setTimeout(() => void renew(), LEASE_RENEW_INTERVAL_MS);
      }
    };

    timer = setTimeout(() => void renew(), LEASE_RENEW_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private async buildSubagentPrompt(event: SemanticEnrichmentEventLease): Promise<string> {
    const sourceSection = event.payload.kind === 'chat_turn'
      ? await this.buildChatTurnSource(event.payload)
      : await this.buildFileImportSource(event.payload);
    const ontologyContext = await this.loadOntologyContext(event.payload);

    const lines = [
      'You are a semantic extraction subagent for a DKG graph.',
      'Return JSON only. Do not wrap the answer in markdown fences.',
      'Schema: {"triples":[{"subject":"<IRI>","predicate":"<IRI>","object":"<IRI or quoted N-Triples literal>"}]}',
      'Rules:',
      '- Use only safe IRIs for subject and predicate.',
      '- For literal objects, return a quoted N-Triples literal string such as "\\"Acme\\"" or "\\"2026-04-15T00:00:00Z\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>."',
      '- Do not emit provenance triples; the storage layer adds provenance and extractedFrom links automatically.',
      '- Extend the existing graph in place. Reuse the provided source URIs and attachment/file URIs when relevant.',
      '- Do not create detached duplicate file/document entities.',
      '- Prefer the provided ontology guidance. If no ontology is available, fall back to schema.org.',
      '',
      `Worker instance: ${this.workerInstanceId}`,
      `Event kind: ${event.kind}`,
      `Event id: ${event.id}`,
      '',
      'Ontology guidance:',
      `- Source: ${ontologyContext.source}`,
      ...(ontologyContext.graphUri ? [`- Graph: ${ontologyContext.graphUri}`] : []),
      ...(ontologyContext.triples.length > 0
        ? ['- Triples:', ...ontologyContext.triples.map((triple) => `  ${triple}`)]
        : ['- Triples: none loaded; use schema.org terms where appropriate.']),
      '',
      sourceSection,
      '',
      'Output JSON only.',
    ];
    return lines.join('\n');
  }

  private async buildChatTurnSource(payload: ChatTurnSemanticEventPayload): Promise<string> {
    const attachmentLines = payload.attachmentRefs?.length
      ? payload.attachmentRefs.map((ref) => JSON.stringify(ref))
      : ['none'];
    const turnMessageAnchors = await this.loadChatTurnMessageAnchors(payload).catch(() => null);
    return [
      'Source material:',
      `- Assertion graph: ${payload.assertionUri}`,
      `- Session URI: ${payload.sessionUri}`,
      `- Turn URI: ${payload.turnUri}`,
      ...(turnMessageAnchors
        ? [
            `- User message URI: ${turnMessageAnchors.userMsgUri}`,
            `- Assistant message URI: ${turnMessageAnchors.assistantMsgUri}`,
          ]
        : []),
      `- Persistence state: ${payload.persistenceState}`,
      ...(payload.failureReason ? [`- Failure reason: ${payload.failureReason}`] : []),
      `- Project context graph for ontology selection: ${payload.projectContextGraphId ?? 'none'}`,
      '- Attachment refs:',
      ...attachmentLines.map((line) => `  ${line}`),
      '- User message:',
      truncate(payload.userMessage, MAX_SOURCE_TEXT_CHARS),
      '- Assistant reply:',
      truncate(payload.assistantReply, MAX_SOURCE_TEXT_CHARS),
    ].join('\n');
  }

  private async buildFileImportSource(payload: FileImportSemanticEventPayload): Promise<string> {
    const markdownHash = payload.mdIntermediateHash ?? payload.fileHash;
    const markdown = await this.client.fetchFileText(markdownHash, 'text/markdown');
    return [
      'Source material:',
      `- Context graph: ${payload.contextGraphId}`,
      `- Assertion graph: ${payload.assertionUri}`,
      ...(payload.rootEntity ? [`- Root entity: ${payload.rootEntity}`] : []),
      `- File hash: ${payload.fileHash}`,
      ...(payload.mdIntermediateHash ? [`- Markdown intermediate hash: ${payload.mdIntermediateHash}`] : []),
      `- Detected content type: ${payload.detectedContentType}`,
      ...(payload.sourceFileName ? [`- Source file name: ${payload.sourceFileName}`] : []),
      ...(payload.ontologyRef ? [`- Event ontologyRef override (replace-only): ${payload.ontologyRef}`] : []),
      '- Markdown source:',
      truncate(markdown, MAX_SOURCE_TEXT_CHARS),
    ].join('\n');
  }

  private async loadOntologyContext(
    payload: ChatTurnSemanticEventPayload | FileImportSemanticEventPayload,
  ): Promise<OntologyContext> {
    const explicitOntologyRef = payload.kind === 'file_import'
      ? payload.ontologyRef?.trim()
      : undefined;
    const contextGraphId = payload.kind === 'chat_turn'
      ? payload.projectContextGraphId?.trim()
      : payload.contextGraphId.trim();
    const graphUri = explicitOntologyRef || (contextGraphId ? contextGraphOntologyUri(contextGraphId) : undefined);
    if (!graphUri || !contextGraphId) {
      return { source: 'schema_org', triples: [] };
    }

    const triples = await this.queryOntologyTriples(contextGraphId, graphUri).catch(() => []);
    if (!this.hasUsableOntologyTriples(triples)) {
      return { source: 'schema_org', triples: [] };
    }
    return {
      source: explicitOntologyRef ? 'override' : 'project_ontology',
      graphUri,
      triples,
    };
  }

  private async queryOntologyTriples(contextGraphId: string, graphUri: string): Promise<string[]> {
    const sparql = `
      SELECT ?s ?p ?o WHERE {
        GRAPH <${graphUri}> {
          ?s ?p ?o .
        }
      }
      LIMIT ${MAX_ONTOLOGY_TRIPLES}
    `;
    const result = await this.client.query(sparql, {
      contextGraphId,
      view: 'working-memory',
    });
    const bindings = Array.isArray(result?.result?.bindings)
      ? result.result.bindings as Array<Record<string, unknown>>
      : Array.isArray(result?.bindings)
        ? result.bindings as Array<Record<string, unknown>>
        : [];
    return bindings
      .map((binding) => {
        const subject = readBindingValue(binding.s);
        const predicate = readBindingValue(binding.p);
        const object = readBindingValue(binding.o);
        return subject && predicate && object ? `<${subject}> <${predicate}> ${isIriLike(object) ? `<${object}>` : object} .` : '';
      })
      .filter(Boolean);
  }

  private hasUsableOntologyTriples(triples: string[]): boolean {
    if (triples.length === 0) return false;
    const usefulPatterns = [
      'rdf-syntax-ns#type',
      'rdf-schema#Class',
      'rdf-schema#subClassOf',
      'rdf-schema#subPropertyOf',
      'owl#Class',
      'owl#ObjectProperty',
      'owl#DatatypeProperty',
      'schema.org/domainIncludes',
      'schema.org/rangeIncludes',
      'schema.org/name',
      'schema.org/description',
    ];
    return triples.some((triple) => usefulPatterns.some((pattern) => triple.includes(pattern)));
  }

  private async loadChatTurnMessageAnchors(
    payload: ChatTurnSemanticEventPayload,
  ): Promise<{ userMsgUri: string; assistantMsgUri: string } | null> {
    const result = await this.client.query(
      `
        SELECT ?user ?assistant WHERE {
          GRAPH <${payload.assertionUri}> {
            <${payload.turnUri}> <${DKG_HAS_USER_MESSAGE}> ?user .
            <${payload.turnUri}> <${DKG_HAS_ASSISTANT_MESSAGE}> ?assistant .
          }
        }
        LIMIT 1
      `,
      {
        contextGraphId: payload.contextGraphId,
        view: 'working-memory',
      },
    );
    const bindings = Array.isArray(result?.result?.bindings)
      ? result.result.bindings as Array<Record<string, unknown>>
      : Array.isArray(result?.bindings)
        ? result.bindings as Array<Record<string, unknown>>
        : [];
    const binding = bindings[0];
    if (!binding) return null;
    const userMsgUri = readBindingValue(binding.user);
    const assistantMsgUri = readBindingValue(binding.assistant);
    if (!userMsgUri || !assistantMsgUri) return null;
    return { userMsgUri, assistantMsgUri };
  }

  private buildSubagentSessionKey(event: SemanticEnrichmentEventLease): string {
    return [
      SUBAGENT_SESSION_PREFIX,
      this.workerInstanceId,
      SUBAGENT_SESSION_SCOPE,
      SUBAGENT_SESSION_NAME,
      event.kind,
      event.id,
    ].join(':');
  }

  private extractAssistantText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = this.extractTextFromMessage(messages[index]);
      if (candidate) return candidate;
    }
    return '';
  }

  private extractTextFromMessage(message: unknown): string {
    if (typeof message === 'string') return message.trim();
    if (Array.isArray(message)) {
      return message
        .map((entry) => this.extractTextFromMessage(entry))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (!isRecord(message)) return '';

    const textFields = ['text', 'message', 'content'];
    for (const field of textFields) {
      const value = message[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const combined = value.map((entry) => this.extractTextFromMessage(entry)).filter(Boolean).join('\n').trim();
        if (combined) return combined;
      }
      if (isRecord(value)) {
        const nested = this.extractTextFromMessage(value);
        if (nested) return nested;
      }
    }
    if (Array.isArray(message.parts)) {
      const combined = message.parts
        .map((entry) => this.extractTextFromMessage(entry))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (combined) return combined;
    }
    return '';
  }

  private parseTriplesFromAssistantText(rawText: string): SemanticTripleInput[] {
    if (!rawText.trim()) return [];
    for (const candidate of extractJsonCandidates(rawText)) {
      try {
        const parsed = JSON.parse(candidate) as { triples?: unknown } | unknown[];
        if (Array.isArray(parsed)) {
          const triples = normalizeTriples(parsed);
          if (triples.length > 0 || parsed.length === 0) return triples;
        }
        if (isRecord(parsed) && 'triples' in parsed) {
          const triples = normalizeTriples(parsed.triples);
          if (triples.length > 0 || Array.isArray(parsed.triples)) return triples;
        }
      } catch {
        // Try the next candidate.
      }
    }
    this.api.logger.warn?.('[semantic-enrichment] subagent returned non-JSON output; treating as zero triples');
    return [];
  }
}
