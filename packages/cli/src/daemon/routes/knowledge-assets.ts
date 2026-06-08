// Route handlers for the GitHub-shaped Knowledge Asset HTTP surface.
//
// OT-RFC-43 §10.5 — one coherent resource model for a Knowledge Asset (KA):
// the working tree is WM, SWM and VM are remote branches, assertions are
// immutable commits, layer is EXPLICIT in every write path:
//
//   POST /api/knowledge-assets                       create KA + open WM draft
//                                                    (atomic: quads + also* flags)
//   GET  /api/knowledge-assets/:name                 KA metadata / lifecycle state
//   GET  /api/knowledge-assets/:name/{wm,swm,vm}     per-layer status
//   POST /api/knowledge-assets/:name/wm/write        append quads to the draft
//   POST /api/knowledge-assets/:name/wm/finalize     seal the draft (git commit)
//   POST /api/knowledge-assets/:name/wm/discard      throw the draft away
//   POST /api/knowledge-assets/:name/wm/pull-from    seed draft from SWM/VM  [TODO]
//   POST /api/knowledge-assets/:name/swm/share       advance the SWM pointer
//   POST /api/knowledge-assets/:name/vm/publish      mint/update on chain
//
// These delegate to the SAME agent lifecycle methods the legacy
// `/api/assertion/*` + `/api/shared-memory/*` routes use, so behavior is
// identical; only the URL shape changes. This module is purely ADDITIVE — the
// legacy routes are untouched (308 redirects from them land in a follow-up).
//
// Identifier note (OT-RFC-43 §10.5.7): for the v10.0 floor the KA is addressed
// by its lifecycle NAME (the file handle) + `contextGraphId`. Minter-namespaced
// `(agent, number)` addressing is layered on by Option 1 later, on these same
// routes, as an additional accepted identifier form.
import type { RequestContext } from "./context.js";
import {
  isPayloadTooLargeError,
  jsonResponse,
  payloadTooLargeResponseBody,
  readBody,
  safeParseJson,
  validateEntities,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  parsePublishRequestBody,
  normalizeContextGraphIdOrUri,
  resolveRequiredWriteContextGraphId,
} from "../http-utils.js";
import { validatePreSignedAuthorAttestation } from "./memory.js";
import { recordAssertionActivity } from "../activity-notification.js";
import {
  handleKaImportArtifactResolve,
  handleKaImportArtifactRead,
  handleKaImportArtifactReadMarkdown,
  handleKaSemanticEnrichmentWrite,
  handleKaImportFile,
  handleKaExtractionStatus,
} from "./knowledge-assets-import.js";
import {
  handleKaShareJobsList,
  handleKaShareJobStatus,
  handleKaShareJobCancel,
  handleKaShareJobRecover,
} from "./knowledge-assets-async-share.js";
import {
  decodePromoteJobId,
  asyncPromoteUnavailable,
} from "./shared-assertion-helpers.js";
import { PromoteJobConflictError } from "@origintrail-official/dkg-publisher";
import { deriveStatus } from "@origintrail-official/dkg-publisher";
import { validateAssertionName, contextGraphAssertionUri } from "@origintrail-official/dkg-core";

const PREFIX = "/api/knowledge-assets";

// Decode + validate a `:name` path segment (parity with the legacy routes,
// which `safeDecodeURIComponent` then `validateAssertionName` every name). A
// B3 read identifier is exempt — it's validated by `classifyKaIdentifier`.
// Returns the name, or null after writing a 400/error.
function decodeAndValidateName(seg: string, res: RequestContext["res"]): string | null {
  if (classifyKaIdentifier(seg).kind === "kaId") return seg;
  const nameVal = validateAssertionName(seg);
  if (!nameVal.valid) {
    jsonResponse(res, 400, { error: `Invalid "name": ${nameVal.reason}` });
    return null;
  }
  return seg;
}

// Best-effort assertion-activity row + notification SSE for a lifecycle event.
// Never throws — activity tracking must not break a write/publish path.
function recordActivityAndNotify(
  ctx: RequestContext,
  input: {
    contextGraphId: string;
    kind: "created" | "promoted" | "published";
    actorAgentAddress: string;
    subGraphName?: string;
    tripleCount?: number;
  },
): void {
  try {
    recordAssertionActivity(ctx.dashDb, {
      contextGraphId: input.contextGraphId,
      kind: input.kind,
      actorAgentAddress: input.actorAgentAddress,
      subGraphName: input.subGraphName,
      ...(typeof input.tripleCount === "number" ? { tripleCount: input.tripleCount } : {}),
    });
    ctx.emitNotification?.({ contextGraphId: input.contextGraphId, type: "assertion_activity" });
  } catch {
    /* activity/notification is advisory — never block the lifecycle op */
  }
}
const FINALIZE_ONLY_CREATE_FIELDS = [
  "authorAgentAddress",
  "preSignedAuthorAttestation",
  "schemeVersion",
] as const;

/**
 * Translate engine/publisher errors on the WM/SWM mutation verbs into the same
 * HTTP status mapping the legacy `/api/assertion/*` routes use, so callers see
 * 400 for their own mistakes (missing assertion, unsafe/reserved IRI) and 409
 * for the "_meta says completed but the data graph is empty" case — instead of
 * a blanket 500. NOT applied to vm/publish: on-chain/storage failures there can
 * carry "Invalid"/"Unsafe" text and must stay 500 (parity with the legacy
 * publish path, which never down-classified them).
 */
function respondAssertionError(res: RequestContext["res"], e: any): void {
  if (isPayloadTooLargeError(e)) {
    jsonResponse(res, 413, payloadTooLargeResponseBody(e));
    return;
  }
  if (e?.name === "AssertionNotPersistedError" || e?.code === "ASSERTION_NOT_PERSISTED") {
    jsonResponse(res, 409, {
      error: e.message,
      code: "ASSERTION_NOT_PERSISTED",
      contextGraphId: e.contextGraphId,
      assertionGraph: e.assertionGraph,
      expectedTripleCount: e.expectedTripleCount,
    });
    return;
  }
  const msg = e?.message ?? String(e);
  if (
    e?.name === "ReservedNamespaceError" ||
    msg.includes("not found") ||
    msg.includes("Invalid") ||
    msg.includes("Unsafe") ||
    msg.includes("reserved namespace")
  ) {
    jsonResponse(res, 400, { error: msg });
    return;
  }
  jsonResponse(res, 500, { error: msg });
}

function hex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/**
 * OT-RFC-43 B3 — classify the leading path segment as a KA identifier:
 *   (a) `did:dkg:.../<id>`        → the trailing `/<id>` is the packed kaId
 *   (b) `0x<agent>:<number>`      → (agent, number), but only on read paths
 *   (c) anything else             → a plain assertion NAME (current behavior)
 * The compact form stays enabled for GET/read compatibility. Create/mutation
 * call sites pass `includeCompact: false` so historically-valid literal names
 * like `0xabc...:7` remain creatable and mutable.
 */
const AGENT_NUMBER_RE = /^0x[0-9a-fA-F]{40}:[0-9]+$/;

function classifyKaIdentifier(
  seg: string,
  opts: { includeCompact?: boolean } = {},
): { kind: "kaId"; kaId: bigint } | { kind: "name" } {
  const includeCompact = opts.includeCompact ?? true;
  if (seg.startsWith("did:dkg:")) {
    // The kaId is the last `/`-delimited segment of the UAL.
    const idPart = seg.slice(seg.lastIndexOf("/") + 1);
    if (/^[0-9]+$/.test(idPart)) {
      try {
        return { kind: "kaId", kaId: BigInt(idPart) };
      } catch {
        /* fall through to name */
      }
    }
    return { kind: "name" };
  }
  if (includeCompact && AGENT_NUMBER_RE.test(seg)) {
    const [agentHex, numberStr] = seg.split(":");
    try {
      const kaId = (BigInt(agentHex) << 96n) | BigInt(numberStr);
      return { kind: "kaId", kaId };
    } catch {
      return { kind: "name" };
    }
  }
  return { kind: "name" };
}

function rejectKaIdMutationIdentifier(seg: string, res: RequestContext["res"]): boolean {
  if (classifyKaIdentifier(seg, { includeCompact: false }).kind !== "kaId") return false;
  jsonResponse(res, 400, {
    code: "KA_ID_MUTATION_UNSUPPORTED",
    error:
      "B3 did:dkg KA identifiers are only supported on GET /api/knowledge-assets routes. " +
      "Mutation routes must use the lifecycle assertion name.",
  });
  return true;
}

function rejectReservedKaIdentifierName(name: string, res: RequestContext["res"]): boolean {
  if (classifyKaIdentifier(name, { includeCompact: false }).kind !== "kaId") return false;
  jsonResponse(res, 400, {
    code: "KA_IDENTIFIER_RESERVED",
    error:
      "B3 did:dkg KA identifiers are reserved for KA addressing and cannot be used as lifecycle assertion names.",
  });
  return true;
}

/**
 * OT-RFC-43 §10.5.4 — derive a per-layer status from a history descriptor's
 * pointers. Reuses the canonical `deriveStatus` helper.
 */
function layerStatus(hist: Record<string, unknown>, layer: "wm" | "swm" | "vm"): string {
  return deriveStatus(
    {
      state: hist["state"] as string | undefined,
      wmCurrentAssertion: hist["wmCurrentAssertion"] as string | undefined,
      swmCurrentAssertion: hist["swmCurrentAssertion"] as string | undefined,
      vmCurrentAssertion: hist["vmCurrentAssertion"] as string | undefined,
    },
    layer,
  );
}

function resolveFinalizeOptions(
  raw: Record<string, any>,
  res: RequestContext["res"],
): Record<string, unknown> | null {
  const {
    subGraphName,
    authorAgentAddress,
    preSignedAuthorAttestation,
    schemeVersion,
  } = raw;
  if (authorAgentAddress != null && preSignedAuthorAttestation != null) {
    jsonResponse(res, 400, {
      error: '"authorAgentAddress" and "preSignedAuthorAttestation" are mutually exclusive',
    });
    return null;
  }
  if (
    authorAgentAddress != null &&
    (typeof authorAgentAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(authorAgentAddress))
  ) {
    jsonResponse(res, 400, {
      error: '"authorAgentAddress" must be a 0x-prefixed 20-byte EVM address',
    });
    return null;
  }
  let resolvedPreSignedAttestation:
    | { address: string; reservedKaId: bigint; signature: { r: Uint8Array; vs: Uint8Array } }
    | undefined;
  if (preSignedAuthorAttestation != null) {
    const validated = validatePreSignedAuthorAttestation(preSignedAuthorAttestation, res);
    if (validated === undefined) return null;
    resolvedPreSignedAttestation = validated;
  }
  if (
    schemeVersion != null &&
    (typeof schemeVersion !== "number" || !Number.isInteger(schemeVersion) || schemeVersion < 1)
  ) {
    jsonResponse(res, 400, { error: '"schemeVersion" must be a positive integer when supplied' });
    return null;
  }
  return {
    ...(subGraphName ? { subGraphName } : {}),
    ...(typeof authorAgentAddress === "string" ? { authorAgentAddress } : {}),
    ...(resolvedPreSignedAttestation ? { preSignedAuthorAttestation: resolvedPreSignedAttestation } : {}),
    ...(schemeVersion != null ? { schemeVersion } : {}),
  };
}

function hasFinalizeOnlyCreateFields(raw: Record<string, unknown>): boolean {
  return FINALIZE_ONLY_CREATE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(raw, field));
}

// uint32 epoch ceiling (matches sibling routes memory.ts / publisher.ts). Not an
// id encoder — the on-chain endEpoch is a uint40 but the publish API caps at uint32.
const MAX_PUBLISH_EPOCHS = 0xffffffff;

// PR #972 — classify a finalized-publish result into an HTTP status. On this
// SYNCHRONOUS route a non-confirmed publish is a failure, not a normal in-flight
// state ("no silent tentative downgrade"):
//   confirmed, no contextGraphError → 200 (fully done)
//   confirmed + contextGraphError   → 207 (partial: KA minted on-chain, context-graph binding failed)
//   tentative | failed              → 502 (publish did not confirm)
function classifyVmPublish(pub: unknown): { httpStatus: 200 | 207 | 502; reason?: string } {
  const p = (pub ?? {}) as { status?: unknown; contextGraphError?: unknown };
  const cgError = typeof p.contextGraphError === "string" && p.contextGraphError.length > 0 ? p.contextGraphError : undefined;
  if (p.status === "confirmed" && !cgError) return { httpStatus: 200 };
  if (p.status === "confirmed") return { httpStatus: 207, reason: cgError };
  return {
    httpStatus: 502,
    reason: cgError ?? `VM publish did not confirm (status: ${typeof p.status === "string" ? p.status : "unknown"})`,
  };
}

// Reject finalized-publish request shapes that don't make sense once the URL
// name + seal already select the assertion and encode the author (PR #971).
// The seal commits to the whole assertion content + author, so assertionName /
// author overrides / partial selection on vm/publish are user errors, not
// silently-ignored fields.
function validateFinalizedAssertionPublishRequest(
  parsed: Record<string, unknown>,
  res: RequestContext["res"],
): boolean {
  const nested = parsed.options && typeof parsed.options === "object" && !Array.isArray(parsed.options)
    ? parsed.options as Record<string, unknown>
    : undefined;
  const assertionName = parsed.assertionName ?? nested?.assertionName;
  if (assertionName !== undefined) {
    jsonResponse(res, 400, {
      error:
        '"assertionName" is not accepted on /api/knowledge-assets/:name/vm/publish — the URL name selects the assertion.',
    });
    return false;
  }
  const hasAuthorOverride =
    parsed.authorAgentAddress != null ||
    parsed.preSignedAuthorAttestation != null ||
    nested?.authorAgentAddress != null ||
    nested?.preSignedAuthorAttestation != null;
  if (hasAuthorOverride) {
    jsonResponse(res, 400, {
      error:
        '"authorAgentAddress" and "preSignedAuthorAttestation" cannot be supplied on vm/publish — the seal already encodes the author. Re-finalize the assertion if you need to change authorship.',
    });
    return false;
  }
  const selection = parsed.selection ?? nested?.selection;
  if (selection !== undefined && selection !== "all") {
    jsonResponse(res, 400, {
      error:
        '"selection" must be omitted or "all" on vm/publish — the seal commits to the entire assertion content.',
    });
    return false;
  }
  return true;
}

// Validate + normalize the finalized-publish options BEFORE they reach
// `publishFromFinalizedAssertion` (PR #971). Without this, malformed epochs /
// identity overrides / flags flowed straight through and surfaced as opaque
// 500s deep in the publisher. Returns the normalized options, or null after
// having already written a 400 response (caller must return).
function resolveFinalizedPublishOptions(
  ctx: RequestContext,
  raw: unknown,
): Record<string, unknown> | null {
  const { res } = ctx;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const { clearAfter, clearSharedMemoryAfter, publisherNodeIdentityIdOverride } = source;
  const rawPublishEpochs = source.publishEpochs ?? source.epochs;
  const publishEpochsField = source.publishEpochs !== undefined ? "publishEpochs" : "epochs";

  let resolvedPublisherIdentityOverride: bigint | undefined;
  if (publisherNodeIdentityIdOverride !== undefined && publisherNodeIdentityIdOverride !== null) {
    const v = String(publisherNodeIdentityIdOverride);
    if (!/^\d+$/.test(v)) {
      jsonResponse(res, 400, {
        error: '"publisherNodeIdentityIdOverride" must be a non-negative integer (string or number)',
      });
      return null;
    }
    resolvedPublisherIdentityOverride = BigInt(v);
  }

  let resolvedPublishEpochs: number | undefined;
  if (rawPublishEpochs !== undefined && rawPublishEpochs !== null) {
    const v = String(rawPublishEpochs).trim();
    if (!/^[1-9]\d*$/.test(v)) {
      jsonResponse(res, 400, { error: `"${publishEpochsField}" must be a positive integer (string or number)` });
      return null;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      jsonResponse(res, 400, { error: `"${publishEpochsField}" is too large to safely represent as a JavaScript integer` });
      return null;
    }
    if (n > MAX_PUBLISH_EPOCHS) {
      jsonResponse(res, 400, { error: `"${publishEpochsField}" must be less than or equal to ${MAX_PUBLISH_EPOCHS}` });
      return null;
    }
    resolvedPublishEpochs = n;
  }

  if (clearAfter !== undefined && typeof clearAfter !== "boolean") {
    jsonResponse(res, 400, { error: '"clearAfter" must be a boolean when supplied' });
    return null;
  }
  if (clearSharedMemoryAfter !== undefined && typeof clearSharedMemoryAfter !== "boolean") {
    jsonResponse(res, 400, { error: '"clearSharedMemoryAfter" must be a boolean when supplied' });
    return null;
  }
  const clearValue = clearAfter !== undefined ? clearAfter : clearSharedMemoryAfter;
  return {
    ...(clearValue !== undefined ? { clearSharedMemoryAfter: clearValue } : {}),
    ...(resolvedPublishEpochs !== undefined ? { publishEpochs: resolvedPublishEpochs } : {}),
    ...(resolvedPublisherIdentityOverride !== undefined
      ? { publisherNodeIdentityIdOverride: resolvedPublisherIdentityOverride }
      : {}),
  };
}

async function verifyDirectPublishOnChainContextGraphId(
  agent: RequestContext["agent"],
  contextGraphId: string,
  onChainContextGraphId: string | undefined,
  res: RequestContext["res"],
): Promise<string | undefined | null> {
  if (onChainContextGraphId === undefined) return undefined;
  let resolvedOnChainContextGraphId: string | null | undefined;
  try {
    resolvedOnChainContextGraphId = await agent.getContextGraphOnChainId(contextGraphId);
  } catch (err) {
    jsonResponse(res, 400, {
      error:
        `Unable to verify "onChainContextGraphId" for context graph "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
  const normalizedResolved = String(resolvedOnChainContextGraphId ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalizedResolved)) {
    jsonResponse(res, 400, {
      error:
        `"onChainContextGraphId" cannot be supplied for context graph "${contextGraphId}" because no trusted positive on-chain mapping is available`,
    });
    return null;
  }
  if (BigInt(normalizedResolved) !== BigInt(onChainContextGraphId)) {
    jsonResponse(res, 400, {
      error:
        `"onChainContextGraphId" (${onChainContextGraphId}) does not match the trusted mapping for context graph "${contextGraphId}" (${normalizedResolved})`,
    });
    return null;
  }
  return normalizedResolved;
}

export async function handleKnowledgeAssetsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, url, requestToken, requestAgentAddress, emitMemoryGraphChanged } = ctx;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
  const method = req.method ?? "GET";

  // ── Collection-level import-artifact + semantic-enrichment routes ──
  // Keyed by `assertionUri` in the body (no `:name` segment). Ported from
  // the legacy `/api/assertion/*` routes. Matched here, BEFORE the generic
  // `segs` parsing below, so `import-artifact/resolve` isn't mis-split into
  // name="import-artifact". The exact-match `POST /api/knowledge-assets`
  // create handler (`path === PREFIX`) is unaffected — these paths all carry
  // a trailing segment.
  if (method === "POST" && path === `${PREFIX}/import-artifact/resolve`) return handleKaImportArtifactResolve(ctx);
  if (method === "POST" && path === `${PREFIX}/import-artifact/read`) return handleKaImportArtifactRead(ctx);
  if (method === "POST" && path === `${PREFIX}/import-artifact/read-markdown`) return handleKaImportArtifactReadMarkdown(ctx);
  if (method === "POST" && path === `${PREFIX}/semantic-enrichment/write`) return handleKaSemanticEnrichmentWrite(ctx);

  // ── Async SWM-share jobs COLLECTION routes (faithful ports of the legacy
  // `/api/assertion/promote-async*` queue routes) ──
  //
  // These start with `swm/share-jobs`, so `segs[0]` would be "swm" — the
  // generic `:name` parsing below would mis-read it as an assertion name.
  // Match them EARLY on the raw `path`, before any name logic. The per-name
  // enqueue route (`:name/swm/share-async`) is NOT here — it has a real name
  // segment and is handled in the SWM section alongside `swm/share`.
  //
  // The `/recover` suffix (#5) must be matched BEFORE the bare-`:jobId`
  // patterns (#3/#4). jobIds are decoded via `decodePromoteJobId` on the
  // url-encoded segment, exactly as the legacy routes did inline.
  const SHARE_JOBS_PREFIX = `${PREFIX}/swm/share-jobs`;
  if (path === SHARE_JOBS_PREFIX || path.startsWith(`${SHARE_JOBS_PREFIX}/`)) {
    // GET /api/knowledge-assets/swm/share-jobs — list
    if (method === "GET" && path === SHARE_JOBS_PREFIX) {
      return handleKaShareJobsList(ctx);
    }
    // POST /api/knowledge-assets/swm/share-jobs/:jobId/recover — recover (#5)
    if (
      method === "POST" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      path.endsWith("/recover")
    ) {
      const jobId = decodePromoteJobId(
        path.slice(`${SHARE_JOBS_PREFIX}/`.length, -"/recover".length),
        res,
      );
      if (jobId === null) return;
      return handleKaShareJobRecover(ctx, jobId);
    }
    // GET /api/knowledge-assets/swm/share-jobs/:jobId — status (#3)
    if (
      method === "GET" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      !path.endsWith("/recover")
    ) {
      const jobId = decodePromoteJobId(path.slice(`${SHARE_JOBS_PREFIX}/`.length), res);
      if (jobId === null) return;
      return handleKaShareJobStatus(ctx, jobId);
    }
    // DELETE /api/knowledge-assets/swm/share-jobs/:jobId — cancel (#4)
    if (method === "DELETE" && path.startsWith(`${SHARE_JOBS_PREFIX}/`)) {
      const jobId = decodePromoteJobId(path.slice(`${SHARE_JOBS_PREFIX}/`.length), res);
      if (jobId === null) return;
      return handleKaShareJobCancel(ctx, jobId);
    }
  }

  // Parity with the legacy assertion routes: resolve/validate the write
  // contextGraphId against the caller's known graphs before any mutation, so a
  // bad/foreign id is a 400 here rather than an opaque 500 from the engine.
  const writePreflightCallerAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };

  // ── POST /api/knowledge-assets/publish — explicit-quads one-shot publish ──
  //
  // This is intentionally separate from the assertion/SWM lifecycle routes. If
  // the caller already has the exact quads to publish, use agent.publish()
  // directly so the publisher's ACK/direct-payload path owns availability. The
  // SWM/finalized-assertion methods below remain only for callers that have
  // explicitly staged or finalized the target content first.
  if (method === "POST" && path === `${PREFIX}/publish`) {
    const rawBody = await readBody(req);
    const parsed = parsePublishRequestBody(rawBody);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const raw = JSON.parse(rawBody) as Record<string, unknown>;
    const {
      contextGraphId,
      quads,
      privateQuads,
      accessPolicy,
      allowedPeers,
      subGraphName,
      onChainContextGraphId,
    } = parsed.value;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    const publishControls = resolveFinalizedPublishOptions(ctx, raw);
    if (publishControls === null) return;
    const {
      clearSharedMemoryAfter: _ignoredClearSharedMemoryAfter,
      ...directPublishControls
    } = publishControls;
    const verifiedOnChainContextGraphId = await verifyDirectPublishOnChainContextGraphId(
      agent,
      resolvedContextGraphId,
      onChainContextGraphId,
      res,
    );
    if (verifiedOnChainContextGraphId === null) return;
    try {
      const pub: any = await agent.publish(resolvedContextGraphId, quads, privateQuads, {
        accessPolicy,
        allowedPeers,
        subGraphName,
        ...(verifiedOnChainContextGraphId !== undefined
          ? { onChainContextGraphId: verifiedOnChainContextGraphId }
          : {}),
        ...directPublishControls,
      });
      const { httpStatus, reason } = classifyVmPublish(pub);
      if (httpStatus === 200) {
        recordActivityAndNotify(ctx, {
          contextGraphId: resolvedContextGraphId,
          kind: "published",
          actorAgentAddress: requestAgentAddress,
          subGraphName,
        });
      }
      const chain = pub?.onChainResult;
      const kaManifest = Array.isArray(pub?.kaManifest) ? pub.kaManifest : [];
      return jsonResponse(res, httpStatus, {
        ...pub,
        mode: "direct",
        kaId: pub?.kaId != null ? String(pub.kaId) : pub?.kaId,
        status: pub?.status,
        kas: kaManifest.map((ka: any) => ({
          tokenId: String(ka.tokenId),
          rootEntity: ka.rootEntity,
        })),
        ...(chain?.txHash ? { txHash: chain.txHash } : {}),
        ...(chain?.blockNumber !== undefined ? { blockNumber: chain.blockNumber } : {}),
        ...(chain?.batchId !== undefined ? { batchId: String(chain.batchId) } : {}),
        ...(chain?.publisherAddress ? { publisherAddress: chain.publisherAddress } : {}),
        ...(typeof pub?.contextGraphError === "string" ? { contextGraphError: pub.contextGraphError } : {}),
        ...(reason ? { error: reason } : {}),
      });
    } catch (e: any) {
      if (isPayloadTooLargeError(e)) {
        return jsonResponse(res, 413, payloadTooLargeResponseBody(e));
      }
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  // ── POST /api/knowledge-assets — create KA + open WM draft (atomic shortcut) ──
  if (method === "POST" && path === PREFIX) {
    const parsed = safeParseJson(await readBody(req), res);
    if (!parsed) return;
    const {
      contextGraphId,
      name,
      subGraphName,
      quads,
      finalize,
      authorAgentAddress,
      preSignedAuthorAttestation,
      schemeVersion,
      alsoPublishVm,
    } = parsed;
    // OT-RFC-43 migration alias: the legacy one-shot publish shape posts
    // `promote: true` (ApiClient.publishAssertion, MCP publishQuads, OpenClaw
    // publish, and network-sim still send { quads, finalize: true, promote: true }).
    // Honor it as `alsoShareSwm` so those calls still promote WM→SWM — otherwise
    // they seal WM but never promote, and a follow-up VM publish runs against an
    // empty SWM and fails. An explicit `alsoShareSwm` wins when both are supplied.
    const alsoShareSwm = parsed.alsoShareSwm ?? parsed.promote;
    if (!name) {
      return jsonResponse(res, 400, { error: 'Missing "name"' });
    }
    if (typeof name !== "string") {
      return jsonResponse(res, 400, { error: '"name" must be a string' });
    }
    if (rejectReservedKaIdentifierName(name, res)) return;
    const nameVal = validateAssertionName(name);
    if (!nameVal.valid) {
      return jsonResponse(res, 400, { error: `Invalid "name": ${nameVal.reason}` });
    }
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    // Parity: resolve/validate the contextGraphId before any mutation.
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    // Strict boolean validation for the opt-in tail flags (PR #971): a stray
    // `"false"` string must NOT silently promote/publish.
    if (alsoShareSwm !== undefined && typeof alsoShareSwm !== "boolean") {
      return jsonResponse(res, 400, { error: '"alsoShareSwm" must be a boolean when supplied' });
    }
    if (alsoPublishVm !== undefined && typeof alsoPublishVm !== "boolean" && (typeof alsoPublishVm !== "object" || alsoPublishVm === null || Array.isArray(alsoPublishVm))) {
      return jsonResponse(res, 400, { error: '"alsoPublishVm" must be a boolean or an options object when supplied' });
    }
    // Strict boolean for `finalize` (parity with the also* flags above): a
    // stray `"false"` string must not silently flip sealing behavior.
    if (finalize !== undefined && typeof finalize !== "boolean") {
      return jsonResponse(res, 400, { error: '"finalize" must be a boolean when supplied' });
    }
    // Quads are WRITTEN whenever supplied; the draft is also SEALED only when
    // `finalize` is not explicitly false. Default-true preserves the one-shot
    // `{ quads, finalize:true }` shape. An explicit `finalize:false` keeps an
    // editable WM draft that never touches the chain — the only lifecycle
    // available to local-only / on-chain-unregistered CGs (finalize binds the
    // author attestation and reserves the on-chain identity, so it requires the
    // CG to be registered). OT-RFC-43 §10.5.5.
    const hasQuads = Array.isArray(quads) && quads.length > 0;
    const shouldFinalize = hasQuads && finalize !== false;
    // alsoShareSwm/alsoPublishVm advance a SEALED assertion to SWM/VM, so they
    // require this request to finalize. Reject upfront — before any create/write
    // mutation — whenever it won't (no quads, or finalize:false); otherwise the
    // create lands a durable draft the tail can't share/publish, turning a
    // request-shape error into orphaned state.
    const alsoPublishVmRequested =
      alsoPublishVm === true || (typeof alsoPublishVm === "object" && alsoPublishVm !== null);
    if (!shouldFinalize && (alsoShareSwm === true || alsoPublishVmRequested)) {
      return jsonResponse(res, 400, {
        error: '"alsoShareSwm"/"alsoPublishVm" require a finalized assertion (non-empty "quads" and "finalize" !== false)',
      });
    }
    if (!shouldFinalize && hasFinalizeOnlyCreateFields(parsed)) {
      return jsonResponse(res, 400, {
        error: '"authorAgentAddress", "preSignedAuthorAttestation", and "schemeVersion" require non-empty "quads" with finalize !== false',
      });
    }
    const finalizeOptions = shouldFinalize
      ? resolveFinalizeOptions({ subGraphName, authorAgentAddress, preSignedAuthorAttestation, schemeVersion }, res)
      : {};
    if (finalizeOptions === null) return;
    const resolvedAuthorAgentAddress =
      typeof (finalizeOptions as Record<string, unknown>).authorAgentAddress === "string"
        ? ((finalizeOptions as Record<string, unknown>).authorAgentAddress as string)
        : undefined;
    try {
      // `alreadyExists` parity (#988): the engine create is a non-destructive
      // get-or-create, so detect prior existence up front (cheap descriptor
      // read) and surface it for idempotent callers.
      let alreadyExists = false;
      try {
        const prior = await agent.assertion.history(resolvedContextGraphId, name, { subGraphName });
        alreadyExists = prior != null;
      } catch {
        /* treat a failed lookup as "does not exist yet" */
      }
      const assertionUri = await agent.assertion.create(resolvedContextGraphId, name, { subGraphName });
      const result: Record<string, unknown> = { name, assertionUri, alreadyExists, status: "draft-open" };
      emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_created", source: "api", counts: { triples: 0 } });
      recordActivityAndNotify(ctx, { contextGraphId: resolvedContextGraphId, kind: "created", actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress, subGraphName });

      // Write quads whenever supplied; SEAL only when finalize !== false. An
      // explicit finalize:false leaves an editable WM draft and never touches
      // the chain (OT-RFC-43 §10.5.5). `also*` are opt-in transitions on top.
      if (hasQuads) {
        await agent.assertion.write(resolvedContextGraphId, name, quads, { subGraphName });
        result.written = quads.length;
        emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_written", source: "api", counts: { triples: quads.length } });
      }
      if (shouldFinalize) {
        const seal = await agent.assertion.finalize(resolvedContextGraphId, name, finalizeOptions);
        result.merkleRoot = hex(seal.merkleRoot);
        result.status = "wm-sealed";
        emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_finalized", source: "api" });
      }

      const errors: Array<{ phase: string; error: string }> = [];
      if (alsoShareSwm === true) {
        try {
          const share = await agent.assertion.promote(resolvedContextGraphId, name, { subGraphName });
          result.swmShared = true;
          result.promotedCount = share.promotedCount;
          result.status = "swm-shared";
          if (share.promotedCount !== 0) {
            emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm", "swm"], subGraphName, operation: "assertion_promoted", source: "api", counts: { triples: share.promotedCount } });
            recordActivityAndNotify(ctx, { contextGraphId: resolvedContextGraphId, kind: "promoted", actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress, subGraphName, tripleCount: share.promotedCount });
          }
        } catch (e: any) {
          errors.push({ phase: "swm-share", error: e?.message ?? String(e) });
        }
      }
      if (alsoPublishVm === true || (typeof alsoPublishVm === "object" && alsoPublishVm !== null)) {
        try {
          const opts = typeof alsoPublishVm === "object" && alsoPublishVm ? alsoPublishVm : {};
          const pub: any = await agent.publishFromFinalizedAssertion(resolvedContextGraphId, name, { subGraphName, ...opts });
          result.kaId = pub?.kaId;
          result.ual = pub?.ual;
          result.txHash = pub?.onChainResult?.txHash;
          // PR #972: only a fully-confirmed publish is "vm-confirmed"; a partial
          // (207) or non-confirmed (502) outcome is flagged as a tail error so
          // the atomic response is a 207 rather than a misleading success.
          const { httpStatus, reason } = classifyVmPublish(pub);
          if (httpStatus === 200) {
            result.status = "vm-confirmed";
          } else {
            result.status = httpStatus === 207 ? "vm-partial" : "vm-failed";
            errors.push({ phase: "vm-publish", error: reason ?? "VM publish did not confirm" });
          }
        } catch (e: any) {
          errors.push({ phase: "vm-publish", error: e?.message ?? String(e) });
        }
      }

      // 207 when a create+finalize succeeded but an opt-in tail failed; the
      // sealed assertion is a real artifact the caller can retry against.
      if (errors.length > 0) return jsonResponse(res, 207, { created: true, ...result, errors });
      return jsonResponse(res, 201, result);
    } catch (e: any) {
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  // ── /api/knowledge-assets/:name[/{wm,swm,vm}[/verb]] ──
  const segs = path.slice(`${PREFIX}/`.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (segs.length === 0) return;
  const name = segs[0];
  const layer = segs[1]; // wm | swm | vm | undefined
  const verb = segs[2];

  // OT-RFC-43 B3 — classify the identifier once for the GET surface. For a
  // kaId form (did:dkg UAL or `0x<addr>:<number>`) we resolve to the lifecycle
  // descriptor via the agent resolver; for a plain name we use it directly.
  // Returns the descriptor (or null) so both GET handlers share one read.
  async function resolveDescriptor(cg: string, subGraphName?: string, agentAddress?: string): Promise<Record<string, unknown> | null> {
    const ident = classifyKaIdentifier(name);
    if (ident.kind === "kaId") {
      // Compact `0x<agent>:<number>` is both a B3 read alias and a historically
      // valid literal assertion name. Preserve literal-name semantics first:
      // if such a lifecycle exists, return it; otherwise fall back to B3.
      if (AGENT_NUMBER_RE.test(name)) {
        const literalHist = await agent.assertion.history(cg, name, { agentAddress, subGraphName });
        if (literalHist) return literalHist as unknown as Record<string, unknown>;
      }
      const hist = await (agent as any).assertion.resolveByKaId?.(cg, ident.kaId, { subGraphName });
      return (hist as unknown as Record<string, unknown>) ?? null;
    }
    // `agentAddress` parity (#988): author-scoped read so a caller can inspect
    // another agent's lifecycle record (the engine keys the lifecycle URI by
    // author and defaults to the local agent when omitted).
    const hist = await agent.assertion.history(cg, name, { subGraphName, ...(agentAddress ? { agentAddress } : {}) });
    return (hist as unknown as Record<string, unknown>) ?? null;
  }

  // Shared GET preflight: decode/validate the :identifier, require + normalize
  // contextGraphId, validate subGraphName, extract optional agentAddress.
  function readGetParams(): { cg: string; subGraphName?: string; agentAddress?: string } | null {
    if (decodeAndValidateName(name, res) === null) return null;
    const rawCg = url.searchParams.get("contextGraphId");
    if (!validateRequiredContextGraphId(rawCg, res)) return null;
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return null;
    const agentAddress = url.searchParams.get("agentAddress") ?? undefined;
    if (agentAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
      jsonResponse(res, 400, { error: '"agentAddress" must be a 0x-prefixed 20-byte EVM address' });
      return null;
    }
    return { cg: normalizeContextGraphIdOrUri(rawCg as string), subGraphName, agentAddress };
  }

  // GET /api/knowledge-assets/:identifier — KA metadata / lifecycle state.
  // `:identifier` is a plain name OR a B3 kaId (did:dkg UAL / `0x<addr>:<n>`).
  if (method === "GET" && segs.length === 1) {
    const p = readGetParams();
    if (!p) return;
    const hist = await resolveDescriptor(p.cg, p.subGraphName, p.agentAddress);
    if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}" in context graph "${p.cg}"` });
    return jsonResponse(res, 200, hist);
  }

  // GET /api/knowledge-assets/:identifier/wm/quads — dump the WM draft's quads.
  // Parity with the legacy POST /api/assertion/:name/query (read, not SPARQL).
  if (method === "GET" && layer === "wm" && verb === "quads") {
    const p = readGetParams();
    if (!p) return;
    // B3: ONLY a did:dkg / 0x<agent>:<number> kaId alias needs resolving to the
    // lifecycle name before querying — otherwise the raw alias is passed as the
    // assertion name and misses the real WM graph (parity with the sibling GETs).
    // A plain name is queried directly (unchanged), so reads of a name-keyed WM
    // draft still work even when no lifecycle descriptor exists yet.
    let resolvedName = name;
    if (classifyKaIdentifier(name).kind === "kaId") {
      const hist = await resolveDescriptor(p.cg, p.subGraphName, p.agentAddress);
      if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}" in context graph "${p.cg}"` });
      if (typeof hist.name === "string") resolvedName = hist.name;
    }
    try {
      const quads = await agent.assertion.query(p.cg, resolvedName, p.subGraphName ? { subGraphName: p.subGraphName } : undefined);
      const sorted = [...quads].sort((l, r) => JSON.stringify(l).localeCompare(JSON.stringify(r)));
      return jsonResponse(res, 200, { quads: sorted, count: sorted.length });
    } catch (e: any) {
      return respondAssertionError(res, e);
    }
  }

  // GET /api/knowledge-assets/:name/wm/extraction-status?contextGraphId=...&subGraphName=...
  // Faithful port of the legacy GET /api/assertion/:name/extraction-status. The
  // handler reads + validates the query params itself (parity with legacy), so
  // here we only decode/validate the :name segment before delegating.
  if (method === "GET" && layer === "wm" && verb === "extraction-status") {
    if (decodeAndValidateName(name, res) === null) return;
    return handleKaExtractionStatus(ctx, name);
  }

  // GET /api/knowledge-assets/:identifier/{wm,swm,vm} — per-layer status.
  // Returns that layer's pointer + that layer's derived status so per-layer
  // divergence (e.g. WM ahead of VM after wm/pull-from) is observable.
  if (method === "GET" && (layer === "wm" || layer === "swm" || layer === "vm") && !verb) {
    const p = readGetParams();
    if (!p) return;
    const hist = await resolveDescriptor(p.cg, p.subGraphName, p.agentAddress);
    if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}"` });
    const pointerKey = `${layer}CurrentAssertion`;
    return jsonResponse(res, 200, {
      layer,
      ...hist,
      // This layer's own pointer + status (overrides the overall `status`).
      currentAssertion: hist[pointerKey] ?? undefined,
      status: layerStatus(hist, layer),
    });
  }

  if (method !== "POST") return;
  if (rejectKaIdMutationIdentifier(name, res)) return;

  // POST /api/knowledge-assets/:name/wm/import-file — MULTIPART, not JSON.
  // Faithful port of the legacy POST /api/assertion/:name/import-file. This MUST
  // be matched BEFORE the `safeParseJson(await readBody(req))` JSON preflight
  // below: the body is multipart/form-data and the handler reads it raw via
  // `readBodyBuffer` + `parseMultipart`. Routing it through the JSON preflight
  // would consume the request stream and 400 every upload. Only the :name
  // segment is decoded/validated here (parity with the JSON verbs); the handler
  // re-validates the name and resolves the contextGraphId from the multipart
  // fields itself.
  if (method === "POST" && layer === "wm" && verb === "import-file") {
    if (decodeAndValidateName(name, res) === null) return;
    return handleKaImportFile(ctx, name);
  }

  const parsed = safeParseJson(await readBody(req), res);
  if (!parsed) return;
  if (decodeAndValidateName(name, res) === null) return;
  const subGraphName = parsed.subGraphName;
  if (!validateOptionalSubGraphName(subGraphName, res)) return;
  // Parity: resolve/validate the contextGraphId before any mutation verb.
  const contextGraphId = await resolveRequiredWriteContextGraphId(
    agent,
    parsed.contextGraphId,
    res,
    writePreflightContextGraphOpts,
  );
  if (!contextGraphId) return;

  try {
    // ── WM verbs (the only writable layer) ──
    if (layer === "wm") {
      if (verb === "write") {
        if (!Array.isArray(parsed.quads)) return jsonResponse(res, 400, { error: 'Missing "quads"' });
        // A bare write to a name that was never created used to fall through to
        // the legacy `/assertion/{addr}/{name}` graph and produce a KA that is
        // permanently 404 in the descriptor API (no `_meta` lifecycle record,
        // no per-KA `_working_memory` layout). Ensure the KA exists first so the
        // proper per-KA layout is in place before the first append.
        //
        // create() is NOT a no-op get-or-create: assertionCreate() clears and
        // rebuilds the lifecycle record (resetting state/memoryLayer, dropping
        // the prov event history and any seal/finalize metadata, preserving only
        // the KA identity + layer pointers). Calling it on every write would
        // corrupt an in-progress draft and — if the following write() throws —
        // leave that wipe behind. So gate it on an active-draft existence check:
        // brand-new or discarded names get created; existing drafts stay append-only.
        const existing = await agent.assertion.history(contextGraphId, name, { subGraphName });
        if (!existing || existing.state === "discarded") {
          await agent.assertion.create(contextGraphId, name, { subGraphName });
        }
        await agent.assertion.write(contextGraphId, name, parsed.quads, { subGraphName });
        emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm"], subGraphName, operation: "assertion_written", source: "api", counts: { triples: parsed.quads.length } });
        return jsonResponse(res, 200, { written: parsed.quads.length });
      }
      if (verb === "finalize") {
        const finalizeOptions = resolveFinalizeOptions(parsed, res);
        if (finalizeOptions === null) return;
        const seal = await agent.assertion.finalize(contextGraphId, name, finalizeOptions);
        emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm"], subGraphName, operation: "assertion_finalized", source: "api" });
        // Full seal payload (PR #971) — clients inspect the attestation.
        return jsonResponse(res, 200, {
          assertionUri: seal.assertionUri,
          merkleRoot: hex(seal.merkleRoot),
          authorAddress: seal.authorAddress,
          schemeVersion: seal.schemeVersion,
          chainId: seal.chainId?.toString?.(),
          kav10Address: seal.kav10Address,
          eip712Digest: seal.eip712Digest,
        });
      }
      if (verb === "discard") {
        await agent.assertion.discard(contextGraphId, name, { subGraphName });
        // Parity with legacy discard: evict any cached extraction-status record
        // for this assertion so a re-import doesn't see a stale "completed".
        ctx.extractionStatus.delete(contextGraphAssertionUri(contextGraphId, requestAgentAddress, name, subGraphName));
        emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm"], subGraphName, operation: "assertion_discarded", source: "api" });
        return jsonResponse(res, 200, { discarded: true });
      }
      if (verb === "pull-from") {
        // Net-new primitive (the git-checkout equivalent): seed a fresh WM
        // draft from the current SWM or VM state (OT-RFC-43 §10.5.3).
        const sourceLayer = parsed.layer;
        if (sourceLayer !== "swm" && sourceLayer !== "vm") {
          return jsonResponse(res, 400, { error: 'pull-from requires "layer": "swm" | "vm"' });
        }
        const onConflict = parsed.onConflict === "replace" ? "replace" : "reject";
        try {
          const result = await agent.assertion.pullFrom(contextGraphId, name, sourceLayer, { subGraphName, onConflict });
          return jsonResponse(res, 200, { wmDraft: "open", seededFrom: { layer: sourceLayer }, ...result });
        } catch (e: any) {
          if (e?.code === "WM_DRAFT_CONFLICT") {
            return jsonResponse(res, 409, { code: "WM_DRAFT_CONFLICT", error: e.message });
          }
          throw e; // -> outer catch -> 500
        }
      }
    }

    // ── SWM verb: share (WM → SWM; OT-RFC-43 §10.6 renames promote → share) ──
    if (layer === "swm" && verb === "share") {
      const share = await agent.assertion.promote(contextGraphId, name, { entities: parsed.entities, subGraphName });
      if (share.promotedCount !== 0) {
        emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm", "swm"], subGraphName, operation: "assertion_promoted", source: "api", counts: { triples: share.promotedCount } });
        recordActivityAndNotify(ctx, { contextGraphId, kind: "promoted", actorAgentAddress: requestAgentAddress, subGraphName, tripleCount: share.promotedCount });
      }
      return jsonResponse(res, 200, { swmShared: true, promotedCount: share.promotedCount });
    }

    // ── SWM verb: share-async (WM → SWM, enqueued) ──
    // Faithful port of POST /api/assertion/:name/promote-async. The shared
    // preflight above already decoded/validated `name`, parsed the JSON body,
    // validated `subGraphName`, and resolved `contextGraphId` — so we reuse
    // those here (parity with how `swm/share` reuses them). The worker-
    // availability 503 guard, `validateEntities` 400, and the conflict/error
    // mapping match the legacy handler exactly. Self-contained try/catch (like
    // `vm/publish`) so the legacy enqueue error mapping is preserved verbatim
    // and unmatched errors rethrow rather than falling through to the outer
    // `respondAssertionError` catch.
    if (layer === "swm" && verb === "share-async") {
      if (asyncPromoteUnavailable(res)) return;
      const entities = parsed.entities;
      if (!validateEntities(entities, res)) return;
      try {
        const result = await agent.assertion.promoteAsync(contextGraphId, name, {
          entities: entities ?? "all",
          subGraphName,
        });
        return jsonResponse(res, 200, { jobId: result.jobId, state: "queued" });
      } catch (err: any) {
        if (err instanceof PromoteJobConflictError) {
          return jsonResponse(res, 409, {
            error: err.message,
            existingJobId: err.existingJobId,
          });
        }
        if (
          err.message?.includes("required") ||
          err.message?.includes("Invalid") ||
          err.message?.includes("must be")
        ) {
          return jsonResponse(res, 400, { error: err.message });
        }
        throw err;
      }
    }

    // ── VM verb: publish (SWM/WM → VM; mint or update on chain) ──
    // Publish keeps its own generic-500 catch: on-chain/storage/publisher
    // failures can carry "Invalid"/"Unsafe" text and must NOT be down-classified
    // to 400 (parity with the legacy publish path).
    if (layer === "vm" && verb === "publish") {
      // #988: publish keeps its OWN generic-500 catch (NOT the outer
      // respondAssertionError) so on-chain/storage "Invalid"/"Unsafe" text isn't
      // down-classified to 400. Inside it, run the #971 input validation +
      // #972 outcome-status mapping (200/207/502).
      try {
        // Validate the request shape + normalize options BEFORE the publish (PR
        // #971): this is a standalone request, so a 400 here mutates nothing.
        if (!validateFinalizedAssertionPublishRequest(parsed, res)) return;
        const opts = resolveFinalizedPublishOptions(ctx, parsed.options);
        if (opts === null) return;
        const pub: any = await agent.publishFromFinalizedAssertion(contextGraphId, name, { subGraphName, ...opts });
        const { httpStatus, reason } = classifyVmPublish(pub);
        if (httpStatus === 200) {
          // Activity attributed to the SEAL author (PR #971), not the requester.
          recordActivityAndNotify(ctx, { contextGraphId, kind: "published", actorAgentAddress: pub?.seal?.authorAddress ?? pub?.authorAddress ?? requestAgentAddress, subGraphName });
        }
        // Full publish payload (PR #971) so clients can reconcile sealed↔minted.
        return jsonResponse(res, httpStatus, {
          kaId: pub?.kaId,
          status: pub?.status,
          ual: pub?.ual,
          txHash: pub?.onChainResult?.txHash,
          ...(pub?.assertionUri !== undefined ? { assertionUri: pub.assertionUri } : {}),
          ...(pub?.seal?.authorAddress ?? pub?.authorAddress ? { authorAddress: pub?.seal?.authorAddress ?? pub?.authorAddress } : {}),
          ...(pub?.merkleRoot !== undefined
            ? { merkleRoot: typeof pub.merkleRoot === "string" ? pub.merkleRoot : hex(pub.merkleRoot) }
            : {}),
          ...(Array.isArray(pub?.kas) ? { kas: pub.kas } : {}),
          ...(pub?.onChainResult?.blockNumber !== undefined ? { blockNumber: pub.onChainResult.blockNumber } : {}),
          ...(typeof pub?.contextGraphError === "string" ? { contextGraphError: pub.contextGraphError } : {}),
          ...(reason ? { error: reason } : {}),
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        // A vm/publish on a KA that hasn't been finalized, or hasn't been
        // shared to SWM, is a caller precondition error (4xx), not a
        // server/on-chain failure (5xx). Both messages below are thrown by the
        // engine BEFORE any chain interaction, so down-classifying them to 409
        // is safe. Everything else (on-chain reverts, storage, "Invalid"/
        // "Unsafe" publisher text) keeps the generic 500 — the #988 parity
        // contract that publish must NOT down-classify on-chain errors.
        if (/is not finalized/.test(msg) || /No quads in shared memory/.test(msg)) {
          return jsonResponse(res, 409, { code: "VM_PUBLISH_PRECONDITION", error: msg });
        }
        return jsonResponse(res, 500, { error: msg });
      }
    }
  } catch (e: any) {
    // WM/SWM mutation verbs (write/finalize/discard/pull-from/share) only.
    return respondAssertionError(res, e);
  }

  // Unmatched under the prefix — fall through to the daemon's 404.
}
