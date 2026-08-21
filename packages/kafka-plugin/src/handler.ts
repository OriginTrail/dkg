import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, readBody } from '@origintrail-official/dkg/daemon/plugin-api';
import type { PublishAsyncAdmission } from '@origintrail-official/dkg/daemon/plugin-api';
import { coreSchema, CORE_FIELDS, type CoreFields } from './schema.js';
import { buildKa, mergeAugmentFragment } from './ka-builder.js';
import type { KafkaPluginExtension } from './extension.js';
import { parsePagination, PaginationError } from './pagination.js';
import {
  buildListQuery,
  buildCountQuery,
  buildSingleByUalQuery,
  buildPageContentQuery,
  bindingsToKa,
} from './discovery.js';

export interface KafkaPluginCtx {
  req: IncomingMessage;
  res: ServerResponse;
  agent: {
    publishAsync(
      admission: PublishAsyncAdmission,
      contextGraphId: string,
      content: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ): Promise<{ captureID: string }>;
    query(
      sparql: string,
      opts?: { contextGraphId?: string; [k: string]: unknown },
    ): Promise<{ bindings: Array<Record<string, unknown>> }>;
  };
  publisherControl: {
    getStatus(captureID: string): Promise<KafkaJobStatus | null>;
  };
  publisherRuntime: { walletIds: string[] } | null;
  config: {
    kafka?: { contextGraphId?: string };
    [k: string]: unknown;
  };
  requestAgentAddress: string;
  url?: URL;
  path?: string;
}

export interface KafkaJobStatus {
  status: string;
  request?: unknown;
  timestamps: { acceptedAt: number; finalizedAt?: number };
  finalization?: { ual?: string };
  failure?: { message?: string };
}

interface KafkaJobScope {
  contextGraphId?: string;
  subGraphName?: string;
}

export interface CreateHandlerOptions {
  basePath: string;
  contextGraphId?: string;
  publishOptions?: Record<string, unknown>;
  extension?: KafkaPluginExtension<Record<string, unknown>>;
}

export function createHandler(opts: CreateHandlerOptions) {
  const basePath = stripTrailingSlash(opts.basePath);
  const registerPath = `${basePath}/register`;
  const registerPathPrefix = `${registerPath}/`;
  const basePathPrefix = `${basePath}/`;
  const loggedCollisionKeys = new Set<string>();
  const mergedSchema = opts.extension
    ? (coreSchema as unknown as { merge: (s: unknown) => { strict: () => typeof coreSchema } })
        .merge(opts.extension.schema)
        .strict()
    : coreSchema;

  return async function handle(ctx: KafkaPluginCtx): Promise<void> {
    const path = ctx.path ?? new URL(ctx.req.url ?? '/', `http://${ctx.req.headers.host ?? 'localhost'}`).pathname;

    if (ctx.req.method === 'POST' && path === registerPath) {
      return handlePostRegister(ctx, opts, mergedSchema, loggedCollisionKeys);
    }
    if (ctx.req.method === 'GET' && path.startsWith(registerPathPrefix)) {
      const captureID = decodePathSegment(path.slice(registerPathPrefix.length));
      return handleGetCapture(ctx, opts, captureID);
    }
    if (ctx.req.method === 'GET' && (path === basePath || path === basePathPrefix)) {
      return handleGetList(ctx, opts);
    }
    if (ctx.req.method === 'GET' && path.startsWith(basePathPrefix)) {
      const segment = path.slice(basePathPrefix.length);
      if (segment === 'register' || segment.startsWith('register/')) return;
      const ual = decodePathSegment(segment);
      return handleGetSingle(ctx, opts, ual);
    }
  };
}

async function handlePostRegister(
  ctx: KafkaPluginCtx,
  opts: CreateHandlerOptions,
  mergedSchema: typeof coreSchema,
  loggedCollisionKeys: Set<string>,
): Promise<void> {
  const cgId = opts.contextGraphId ?? ctx.config.kafka?.contextGraphId;
  if (!cgId) {
    return jsonResponse(ctx.res, 503, {
      error: 'PluginMisconfigured',
      message: 'kafka-plugin has no configured contextGraphId',
    });
  }
  if (!ctx.publisherRuntime || ctx.publisherRuntime.walletIds.length === 0) {
    return jsonResponse(ctx.res, 503, {
      error: 'PublisherUnavailable',
      message: 'kafka-plugin requires the publisher runtime to be running with at least one configured publisher wallet',
    });
  }

  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (err) {
    return jsonResponse(ctx.res, 400, {
      error: 'InvalidContent',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  let parsedJson: unknown;
  try {
    parsedJson = raw.length ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(ctx.res, 400, {
      error: 'InvalidContent',
      message: 'Invalid JSON in request body',
    });
  }

  const result = await mergedSchema.safeParseAsync(parsedJson);
  if (!result.success) {
    return jsonResponse(ctx.res, 400, {
      error: 'InvalidContent',
      message: 'Request body failed schema validation',
      details: flattenIssues(result.error),
    });
  }

  const parsedData = result.data as Record<string, unknown>;
  const coreFields = pickCoreFields(parsedData);
  const baseKa = buildKa(coreFields);
  const streamId = `urn:dkg:kafka-stream:${randomUUID()}`;
  baseKa['@id'] = streamId;
  let ka: Record<string, unknown> = baseKa as unknown as Record<string, unknown>;
  if (opts.extension) {
    const extensionFields = pickExtensionFields(parsedData);
    let fragment;
    try {
      fragment = opts.extension.augment(extensionFields);
    } catch (err) {
      return jsonResponse(ctx.res, 400, {
        error: 'InvalidContent',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    ka = mergeAugmentFragment(baseKa, fragment, loggedCollisionKeys) as unknown as Record<
      string,
      unknown
    >;
  }
  // Keep connection details private while exposing one application-level
  // discovery/challenge triple on the same subject. V2 metadata points to the
  // exact public and private graphs, so no rootEntity rows are required.
  const publishContent = {
    public: {
      '@context': { dkg: 'http://dkg.io/ontology/' },
      '@id': streamId,
      'dkg:privateDataAnchor': 'true',
    },
    private: ka,
  } as unknown as Record<string, unknown>;
  let publishResult: { captureID: string };
  try {
    // A Kafka stream request is externally authenticated, so the job belongs to the agent that
    // submitted it. The identity is DECLARED rather than merged into the options bag, so no
    // spread ordering decides authorization and a client-supplied option cannot name an owner.
    publishResult = await ctx.agent.publishAsync(
      { kind: 'agent', agentAddress: ctx.requestAgentAddress },
      cgId,
      publishContent,
      opts.publishOptions,
    );
  } catch (err) {
    const code = (err as { code?: string; name?: string })?.code ?? (err as { name?: string })?.name;
    if (code === 'ContextGraphNotFound') {
      return jsonResponse(ctx.res, 404, {
        error: 'ContextGraphNotFound',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (code === 'InvalidContent' || code === 'InvalidContentError') {
      return jsonResponse(ctx.res, 400, {
        error: 'InvalidContent',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return jsonResponse(ctx.res, 503, {
      error: 'EnqueueFailed',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return jsonResponse(ctx.res, 202, {
    captureID: publishResult.captureID,
    contextGraphId: cgId,
    receivedAt: new Date().toISOString(),
  });
}

async function handleGetCapture(
  ctx: KafkaPluginCtx,
  opts: CreateHandlerOptions,
  captureID: string,
): Promise<void> {
  const cgId = opts.contextGraphId ?? ctx.config.kafka?.contextGraphId;
  if (!cgId) {
    return jsonResponse(ctx.res, 503, {
      error: 'PluginMisconfigured',
      message: 'kafka-plugin has no configured contextGraphId',
    });
  }
  if (!captureID) {
    return jsonResponse(ctx.res, 404, { error: 'CaptureNotFound' });
  }
  let job;
  try {
    job = await ctx.publisherControl.getStatus(captureID);
  } catch (err) {
    return jsonResponse(ctx.res, 503, {
      error: 'StatusLookupFailed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const jobScope = resolveJobRequestScope(job?.request);
  const subGraphName = resolvePublishSubGraphName(opts);
  if (
    !job ||
    jobScope.contextGraphId !== cgId ||
    (jobScope.subGraphName ?? undefined) !== subGraphName
  ) {
    return jsonResponse(ctx.res, 404, { error: 'CaptureNotFound' });
  }
  return jsonResponse(ctx.res, 200, {
    captureID,
    state: job.status,
    contextGraphId: jobScope.contextGraphId ?? null,
    ual: job.finalization?.ual ?? null,
    receivedAt: new Date(job.timestamps.acceptedAt).toISOString(),
    finalizedAt: job.timestamps.finalizedAt
      ? new Date(job.timestamps.finalizedAt).toISOString()
      : null,
    error: job.status === 'failed' ? (job.failure?.message ?? 'Async capture failed') : null,
  });
}

async function handleGetList(ctx: KafkaPluginCtx, opts: CreateHandlerOptions): Promise<void> {
  const cgId = opts.contextGraphId ?? ctx.config.kafka?.contextGraphId;
  if (!cgId) {
    return jsonResponse(ctx.res, 503, {
      error: 'PluginMisconfigured',
      message: 'kafka-plugin has no configured contextGraphId',
    });
  }

  const searchParams = parseSearchParams(ctx);
  let pagination;
  try {
    pagination = parsePagination(searchParams);
  } catch (err) {
    if (err instanceof PaginationError) {
      return jsonResponse(ctx.res, 400, {
        error: 'InvalidContent',
        message: err.message,
        details: [{ path: err.field, message: err.message }],
      });
    }
    throw err;
  }

  const subGraphName = resolvePublishSubGraphName(opts);
  let countQuery: string;
  let listQuery: string;
  try {
    countQuery = buildCountQuery({ contextGraphId: cgId, subGraphName });
    listQuery = buildListQuery({
      contextGraphId: cgId,
      subGraphName,
      limit: pagination.limit,
      offset: pagination.offset,
    });
  } catch (err) {
    return jsonResponse(ctx.res, 500, {
      error: 'PluginMisconfigured',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const queryOptions = discoveryQueryOptions(ctx, cgId, subGraphName);
  let countBindings: Array<Record<string, unknown>>;
  let pageBindings: Array<Record<string, unknown>>;
  let contentBindings: Array<Record<string, unknown>> = [];
  try {
    const fetchBindings = async (sparql: string): Promise<Array<Record<string, unknown>>> =>
      (await ctx.agent.query(sparql, queryOptions)).bindings;
    [countBindings, pageBindings] = await Promise.all([
      fetchBindings(countQuery),
      fetchBindings(listQuery),
    ]);
    const targets = pageBindings.flatMap((row) => {
      const ual = unwrapBindingValue(row.ual);
      const root = unwrapBindingValue(row.root);
      const contentGraph = unwrapBindingValue(row.contentGraph);
      return ual && root && contentGraph ? [{ ual, root, contentGraph }] : [];
    });
    if (targets.length > 0) {
      contentBindings = await fetchBindings(buildPageContentQuery(targets));
    }
  } catch (err) {
    return queryFailedResponse(ctx.res, err);
  }
  const total = extractCount(countBindings);

  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of contentBindings) {
    const subject = unwrapBindingValue(row.ual);
    if (!subject) continue;
    const arr = grouped.get(subject) ?? [];
    arr.push(row);
    grouped.set(subject, arr);
  }
  const items: Array<Record<string, unknown>> = [];
  const orderedUals = [...new Set(
    pageBindings.map((row) => unwrapBindingValue(row.ual)).filter((ual): ual is string => Boolean(ual)),
  )];
  for (const ual of orderedUals) {
    const subjectBindings = grouped.get(ual) ?? [];
    const ka = bindingsToKa(subjectBindings);
    if (ka) items.push(ka as Record<string, unknown>);
  }

  return jsonResponse(ctx.res, 200, {
    items,
    limit: pagination.limit,
    offset: pagination.offset,
    total,
  });
}

async function handleGetSingle(
  ctx: KafkaPluginCtx,
  opts: CreateHandlerOptions,
  ual: string,
): Promise<void> {
  const cgId = opts.contextGraphId ?? ctx.config.kafka?.contextGraphId;
  if (!cgId) {
    return jsonResponse(ctx.res, 503, {
      error: 'PluginMisconfigured',
      message: 'kafka-plugin has no configured contextGraphId',
    });
  }
  if (!ual) {
    return jsonResponse(ctx.res, 404, { error: 'StreamNotFound', message: 'UAL not found in configured context graph' });
  }

  let sparql: string;
  const subGraphName = resolvePublishSubGraphName(opts);
  try {
    sparql = buildSingleByUalQuery({ contextGraphId: cgId, subGraphName, ual });
  } catch (err) {
    return jsonResponse(ctx.res, 400, {
      error: 'InvalidContent',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  let result: { bindings: Array<Record<string, unknown>> };
  try {
    result = await ctx.agent.query(sparql, discoveryQueryOptions(ctx, cgId, subGraphName));
  } catch (err) {
    return queryFailedResponse(ctx.res, err);
  }
  const triples = result.bindings.map((row) => ({ ...row, ual }));
  const ka = bindingsToKa(triples);
  if (!ka) {
    return jsonResponse(ctx.res, 404, {
      error: 'StreamNotFound',
      message: `UAL ${ual} not found in context graph ${cgId}`,
    });
  }
  return jsonResponse(ctx.res, 200, ka);
}

function parseSearchParams(ctx: KafkaPluginCtx): URLSearchParams {
  if (ctx.url) return ctx.url.searchParams;
  const rawUrl = ctx.req.url ?? '/';
  try {
    return new URL(rawUrl, `http://${ctx.req.headers.host ?? 'localhost'}`).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function discoveryQueryOptions(
  ctx: KafkaPluginCtx,
  contextGraphId: string,
  subGraphName?: string,
): { contextGraphId: string; subGraphName?: string; callerAgentAddress: string; includePrivate: true } {
  return {
    contextGraphId,
    subGraphName,
    callerAgentAddress: ctx.requestAgentAddress,
    includePrivate: true,
  };
}

function extractCount(bindings: Array<Record<string, unknown>>): number {
  if (bindings.length === 0) return 0;
  const raw = unwrapBindingValue(bindings[0]?.count as unknown);
  if (!raw) return 0;
  const match = String(raw).match(/^"?(-?\d+)/);
  return match ? Number(match[1]) : 0;
}

function queryFailedResponse(res: ServerResponse, err: unknown): void {
  return jsonResponse(res, 503, {
    error: 'QueryFailed',
    message: err instanceof Error ? err.message : String(err),
  });
}

function unwrapBindingValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === 'string' ? inner : String(inner);
  }
  return undefined;
}

function resolvePublishSubGraphName(opts: CreateHandlerOptions): string | undefined {
  const subGraphName = opts.publishOptions?.subGraphName;
  return typeof subGraphName === 'string' ? subGraphName : undefined;
}

function resolveJobRequestScope(request: unknown): KafkaJobScope {
  if (!isRecord(request)) return {};

  const direct = scopeFromRecord(request);
  if (direct.contextGraphId) return direct;

  if (isRecord(request.lift)) {
    const lift = scopeFromRecord(request.lift);
    if (lift.contextGraphId) return lift;
  }

  if (isRecord(request.knowledgeAssetVmPublish)) {
    const kaVmPublish = scopeFromRecord(request.knowledgeAssetVmPublish);
    if (kaVmPublish.contextGraphId) return kaVmPublish;
  }

  return {};
}

function scopeFromRecord(record: Record<string, unknown>): KafkaJobScope {
  return {
    contextGraphId: typeof record.contextGraphId === 'string' ? record.contextGraphId : undefined,
    subGraphName: typeof record.subGraphName === 'string' ? record.subGraphName : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function decodePathSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

function flattenIssues(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

const CORE_FIELD_SET = new Set<string>(CORE_FIELDS as readonly string[]);

function pickCoreFields(parsed: Record<string, unknown>): CoreFields {
  const out: Record<string, unknown> = {};
  for (const k of CORE_FIELDS) {
    if (k in parsed) out[k as string] = parsed[k as string];
  }
  return out as CoreFields;
}

function pickExtensionFields(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!CORE_FIELD_SET.has(k)) out[k] = v;
  }
  return out;
}
