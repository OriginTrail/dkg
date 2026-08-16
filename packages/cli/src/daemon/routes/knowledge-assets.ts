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
//   POST /api/knowledge-assets/:name/vm/publish-async enqueue mint/update on chain
//
// These delegate to the agent lifecycle methods directly. Public content
// authoring and VM publish must enter through named KA lifecycle routes; retired
// loose/direct publish surfaces are guarded below with explicit 404s.
//
// Identifier note (OT-RFC-43 §10.5.7): for the v10.0 floor the KA is addressed
// by its lifecycle NAME (the file handle) + `contextGraphId`. Minter-namespaced
// `(agent, number)` addressing is layered on by Option 1 later, on these same
// routes, as an additional accepted identifier form.
import type { RequestContext } from "./context.js";
import { reportBatchRejectionWithLifecycle } from "@origintrail-official/dkg-agent";
import {
  isPayloadTooLargeError,
  jsonResponse,
  oversizedRdfLiteralResponseBody,
  payloadTooLargeResponseBody,
  readBody,
  safeParseJson,
  validateEntities,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
  isWritableQuad,
  validateQuadObjectTerms,
  respondIfReconcileUnavailable,
  respondIfChainRpcTransportError,
  sanitizeRpcMessage,
  validateWritableQuadLiteralSizes,
  normalizeContextGraphIdOrUri,
  resolveRequiredWriteContextGraphId,
  isNoFundedPublisherWalletLike,
  noFundedPublisherWalletBody,
  SMALL_BODY_BYTES,
} from "../http-utils.js";
import { validatePreSignedAuthorAttestation } from "./memory.js";
import { recordAssertionActivity, recordConvictionCostCovered } from "../activity-notification.js";
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
  handleKaShareJobClear,
  handleKaShareJobRecover,
} from "./knowledge-assets-async-share.js";
import {
  decodePromoteJobId,
  asyncPromoteUnavailable,
  authorizeAgentScopedAuthorClaim,
  buildAutoRegisterFailureBody,
  isSameAgentAddress,
  scopedTokenPromoteLane,
} from "./shared-assertion-helpers.js";
import { AsyncLiftJobConflictError, PromoteJobConflictError } from "@origintrail-official/dkg-publisher";
import { deriveStatus } from "@origintrail-official/dkg-publisher";
import {
  validateAssertionName,
  contextGraphAssertionUri,
  AMBIGUOUS_ASSERTION_AUTHOR_CODE,
  ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
} from "@origintrail-official/dkg-core";
import {
  formatFinalizedPublishOptionError,
  parseHttpFinalizedPublishOptions,
  type NormalizedFinalizedPublishOptions,
} from "../../finalized-publish-options.js";
import { storageAckPeerIdsFromPublishResult } from "./storage-ack-peers.js";

const PREFIX = "/api/knowledge-assets";
type FinalizedPublishResult = Awaited<
  ReturnType<RequestContext["agent"]["publishFromFinalizedAssertion"]>
> & {
  /** Backward-compatible response aliases still accepted by the HTTP route. */
  authorAddress?: string;
  kas?: unknown[];
};

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
function recordPcaDiscount(ctx: RequestContext, contextGraphId: string, onChain: any): void {
  const cc = onChain?.convictionCostCovered;
  const publisher = onChain?.publisherAddress;
  if (!cc || !publisher) return;
  try {
    recordConvictionCostCovered(ctx.dashDb, {
      contextGraphId,
      publisherAddress: publisher,
      accountId: cc.accountId,
      epoch: cc.epoch,
      baseCost: cc.baseCost,
      discountedCost: cc.discountedCost,
      drawnFromEpoch: cc.drawnFromEpoch,
      drawnFromTopUp: cc.drawnFromTopUp,
    });
    ctx.emitNotification?.({ contextGraphId, type: "pca_cost_covered" });
  } catch {
    /* confirmed-discount notification is advisory */
  }
}

const FINALIZE_ONLY_CREATE_FIELDS = [
  "authorAgentAddress",
  "preSignedAuthorAttestation",
  "schemeVersion",
] as const;

/**
 * GH#1778 — shared 409 mapping for the ambiguous-author VM-publish error, used
 * by both `vm/publish` and `vm/publish-async` so the `{ code, error, candidates }`
 * response shape cannot drift between the two routes. Returns `true` (and writes
 * the response) when it handled the error, `false` otherwise.
 */
function respondAmbiguousAssertionAuthor(res: RequestContext["res"], e: any): boolean {
  if (e?.code !== AMBIGUOUS_ASSERTION_AUTHOR_CODE) return false;
  jsonResponse(res, 409, {
    code: AMBIGUOUS_ASSERTION_AUTHOR_CODE,
    error: e.message ?? String(e),
    candidates: e.candidates ?? [],
  });
  return true;
}

/**
 * GH#1786 — author-selection outcomes that are permanent, caller-actionable
 * state rather than server faults. Unmapped they would fall through to a generic
 * 500 on both publish lanes; they are answered here, and are matched BEFORE the
 * precondition / message-keyed branches so a future reword of either message
 * cannot be captured by those looser predicates.
 *
 *  - `ASSERTION_AUTHOR_NOT_RESIDENT`: the selected author has no finalized
 *    assertion at this coordinate. Echoes the resident `candidates` so the client
 *    can retry without a second round-trip.
 *  - `PUBLISH_AUTHOR_NOT_CUSTODIAL`: the selected author's KA needs an UPDATE,
 *    which the node cannot re-sign without that author's custodial key.
 */
function respondAuthorSelectionError(res: RequestContext["res"], e: any): boolean {
  if (
    e?.code !== ASSERTION_AUTHOR_NOT_RESIDENT_CODE
    && e?.code !== PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE
  ) {
    return false;
  }
  jsonResponse(res, 409, {
    code: e.code,
    error: e.message ?? String(e),
    ...(e.candidates ? { candidates: e.candidates } : {}),
  });
  return true;
}

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
  if (e?.code === "OVERSIZED_RDF_LITERAL") {
    jsonResponse(res, 400, oversizedRdfLiteralResponseBody(e));
    return;
  }
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
  // Strict curator-ack gate (OT-RFC-49 curator-leader) on the WM→SWM promote
  // (swm/share). The curator (authoritative replica) did not confirm, so the
  // promote was aborted with WM left intact — surface a distinct, actionable
  // status instead of a 500. The client is TOLD, never silently led to success.
  if (e?.code === "CURATOR_UNCONFIRMED") {
    jsonResponse(res, 503, {
      error: e.message,
      code: "CURATOR_UNCONFIRMED",
      curatorDelivery: "unconfirmed",
      contextGraphId: e.contextGraphId,
    });
    return;
  }
  if (e?.code === "CURATOR_REJECTED") {
    jsonResponse(res, 409, {
      error: e.message,
      code: "CURATOR_REJECTED",
      curatorDelivery: "rejected",
      contextGraphId: e.contextGraphId,
    });
    return;
  }
  // GH#1759 — the draft has no sealable content (no quads at all, or only
  // reserved-namespace subjects that are filtered out before SWM). That is a
  // client precondition the caller can fix by writing a quad, not a server
  // fault, so it gets the same actionable 409 the rest of this route family
  // uses rather than an opaque 500. Code-keyed, so the mapping does not drift
  // when the engine's wording changes.
  if (e?.code === "ASSERTION_EMPTY") {
    jsonResponse(res, 409, {
      error: e.message,
      code: "ASSERTION_EMPTY",
    });
    return;
  }
  // KA-number-floor reconcile couldn't reach the chain (e.g. a rate-limited RPC
  // 429'd the one-time-per-author read) -> retryable 503, not 500.
  if (respondIfReconcileUnavailable(res, e)) return;
  // Transient chain-RPC transport failure (all endpoints exhausted / receipt
  // lookup failed / timeout) -> retryable 503/504, keyed on err.code so a
  // genuine on-chain revert (no transport code) still falls through to the
  // 4xx/500 mapping below. Code-keyed check precedes the message-keyed 400
  // branch so an exhaustion message that happens to contain "not found"
  // (e.g. "header not found") is not mis-mapped to a 400.
  if (respondIfChainRpcTransportError(res, e)) return;
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
    // Rootless V2 uses the author-scoped identity
    //   did:dkg:<chain>/<author>/<per-author-number>
    // while the legacy/canonical on-chain form carries an already-packed id
    // in the last segment. Reconstruct the packed id for the rootless form so
    // resolveByKaId can recover the lifecycle author after a cross-node sync.
    // A value larger than the 96-bit per-author range is already packed and
    // must remain byte-for-byte unchanged.
    const idPart = seg.slice(seg.lastIndexOf("/") + 1);
    if (/^[0-9]+$/.test(idPart)) {
      try {
        const numericId = BigInt(idPart);
        if (numericId <= ((1n << 96n) - 1n)) {
          const withoutId = seg.slice(0, seg.lastIndexOf("/"));
          const authorPart = withoutId.slice(withoutId.lastIndexOf("/") + 1);
          if (/^0x[0-9a-fA-F]{40}$/.test(authorPart)) {
            return { kind: "kaId", kaId: (BigInt(authorPart) << 96n) | numericId };
          }
        }
        return { kind: "kaId", kaId: numericId };
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

export function resolveFinalizeOptions(
  raw: Record<string, any>,
  res: RequestContext["res"],
  tokenAgentAddress?: string,
): Record<string, unknown> | null {
  const {
    subGraphName,
    authorAgentAddress,
    preSignedAuthorAttestation,
    schemeVersion,
    layer,
  } = raw;
  // Rootless KAs are sealed in WM and shared atomically. Retain a deliberate,
  // stable response for older clients that still send `layer:"swm"`, while
  // rejecting the request before any legacy SWM read or mutation.
  if (layer === "swm") {
    jsonResponse(res, 409, {
      code: "LEGACY_KA_READ_ONLY",
      error: "Legacy root-scoped Knowledge Assets are read-only",
    });
    return null;
  }
  if (layer != null && layer !== "wm") {
    jsonResponse(res, 400, { error: 'finalize "layer" must be "wm" when supplied' });
    return null;
  }
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
  if (!authorizeAgentScopedAuthorClaim(res, tokenAgentAddress, authorAgentAddress, "authorAgentAddress")) {
    return null;
  }
  if (!authorizeAgentScopedAuthorClaim(res, tokenAgentAddress, resolvedPreSignedAttestation?.address, "preSignedAuthorAttestation.address")) {
    return null;
  }
  // Token attribution — parity with lifecycle VM publish.
  // An agent-scoped bearer token attributes authorship to that agent when the
  // body specified neither an explicit `authorAgentAddress` nor a pre-signed
  // attestation. Callers pass `agent.resolveAgentByToken(requestToken)`, which
  // returns `undefined` for node-level / admin tokens — so those do NOT
  // auto-attribute, preserving the "publisher signs as itself" default.
  // Without this, the create + finalize routes ignored the token and a custodial
  // agent's publish was sealed under the node's own signer instead of the agent
  // (the on-chain author came out as the node's operational wallet).
  const explicitAuthorAgentAddress =
    typeof authorAgentAddress === "string"
      ? authorAgentAddress
      : undefined;
  const effectiveAuthorAgentAddress =
    (explicitAuthorAgentAddress && tokenAgentAddress && isSameAgentAddress(tokenAgentAddress, explicitAuthorAgentAddress)
      ? tokenAgentAddress
      : explicitAuthorAgentAddress) ??
    (resolvedPreSignedAttestation == null ? tokenAgentAddress : undefined);
  return {
    ...(subGraphName ? { subGraphName } : {}),
    ...(typeof effectiveAuthorAgentAddress === "string" ? { authorAgentAddress: effectiveAuthorAgentAddress } : {}),
    ...(resolvedPreSignedAttestation ? { preSignedAuthorAttestation: resolvedPreSignedAttestation } : {}),
    ...(schemeVersion != null ? { schemeVersion } : {}),
  };
}

function hasFinalizeOnlyCreateFields(raw: Record<string, unknown>): boolean {
  return FINALIZE_ONLY_CREATE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(raw, field));
}

function resolveAuthorAgentAddressFromFinalizeOptions(
  finalizeOptions: Record<string, unknown>,
  tokenAgentAddress?: string,
): string | undefined {
  const finalizedAuthor = finalizeOptions.authorAgentAddress;
  if (typeof finalizedAuthor === "string") {
    return tokenAgentAddress && isSameAgentAddress(tokenAgentAddress, finalizedAuthor)
      ? tokenAgentAddress
      : finalizedAuthor;
  }
  return tokenAgentAddress;
}

function scopedTokenStorageLane(agentAddress?: string): { agentAddress?: string } {
  return agentAddress ? { agentAddress } : {};
}

/**
 * GH#1778 — the VM-publish caller hint. The token holder is the CALLER, not
 * necessarily the KA author, so it is passed as `callerAgentAddress` (a
 * resolution hint), never as `agentAddress` (an authoritative author selector).
 * Centralised so both publish routes construct the same option.
 */
function publishCallerHintLane(agentAddress?: string): { callerAgentAddress?: string } {
  return agentAddress ? { callerAgentAddress: agentAddress } : {};
}

function resolveBatchRejectionReporterIdentity(
  ctx: Pick<RequestContext, "agent" | "requestAgentAddress">,
  tokenAgentAddress?: string,
): { agentAddress: string; peerId?: string } {
  const agentAddress = tokenAgentAddress || ctx.requestAgentAddress || "unknown";
  return ctx.agent.peerId ? { agentAddress, peerId: ctx.agent.peerId } : { agentAddress };
}

function parseExplicitBatchRejectionReporterIdentity(
  raw: unknown,
): { agentAddress: string; peerId?: string } | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("rejectedBy must be an object with agentAddress");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.agentAddress !== "string" || record.agentAddress.trim().length === 0) {
    throw new Error("rejectedBy.agentAddress must be a non-empty string");
  }
  return {
    agentAddress: record.agentAddress,
    ...(typeof record.peerId === "string" && record.peerId.trim().length > 0
      ? { peerId: record.peerId }
      : {}),
  };
}

async function resolveFinalizeStorageLane(
  agent: RequestContext["agent"],
  contextGraphId: string,
  name: string,
  finalizeOptions: Record<string, unknown>,
  tokenAgentAddress?: string,
): Promise<{ agentAddress?: string }> {
  const tokenLane = scopedTokenStorageLane(tokenAgentAddress);
  if (tokenLane.agentAddress) return tokenLane;

  const explicitAuthorLane = resolveAuthorAgentAddressFromFinalizeOptions(finalizeOptions, undefined);
  if (!explicitAuthorLane) return {};

  const history = agent.assertion?.history;
  if (typeof history !== "function") return {};

  const subGraphName =
    typeof finalizeOptions.subGraphName === "string"
      ? finalizeOptions.subGraphName
      : undefined;
  const baseOptions = subGraphName ? { subGraphName } : {};

  let defaultHistory: unknown;
  try {
    defaultHistory = await history.call(agent.assertion, contextGraphId, name, baseOptions);
  } catch {
    return {};
  }
  if (defaultHistory != null) return {};

  try {
    const authorHistory = await history.call(agent.assertion, contextGraphId, name, {
      ...baseOptions,
      agentAddress: explicitAuthorLane,
    });
    return authorHistory != null ? { agentAddress: explicitAuthorLane } : {};
  } catch {
    return {};
  }
}

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

// Reject finalized-publish fields that don't make sense once the URL name +
// seal already select the assertion and encode the author (PR #971). The seal
// commits to the whole assertion content + author, so assertionName / author
// overrides / partial selection are user errors, not silently-ignored fields.
function validateFinalizedAssertionPublishShape(
  source: Record<string, unknown>,
  res: RequestContext["res"],
): boolean {
  if (source.assertionName !== undefined) {
    jsonResponse(res, 400, {
      error:
        '"assertionName" is not accepted on /api/knowledge-assets/:name/vm/publish — the URL name selects the assertion.',
    });
    return false;
  }
  const hasAuthorOverride =
    source.authorAgentAddress != null ||
    source.preSignedAuthorAttestation != null;
  if (hasAuthorOverride) {
    jsonResponse(res, 400, {
      error:
        '"authorAgentAddress" and "preSignedAuthorAttestation" cannot be supplied on vm/publish — the seal already encodes the author. Re-finalize the assertion if you need to change authorship.',
    });
    return false;
  }
  if (source.selection !== undefined && source.selection !== "all") {
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
): NormalizedFinalizedPublishOptions | null {
  const { res } = ctx;
  const parsed = parseHttpFinalizedPublishOptions(raw);
  if (!parsed.ok) {
    jsonResponse(res, 400, { error: formatFinalizedPublishOptionError(parsed.error) });
    return null;
  }
  return parsed.options;
}

function resolveInlineVmPublishOptions(
  ctx: RequestContext,
  source: Record<string, unknown>,
): NormalizedFinalizedPublishOptions | null {
  if (!validateFinalizedAssertionPublishShape(source, ctx.res)) return null;
  if (!rejectSelectedAuthorOnCreate(ctx, source)) return null;
  return resolveFinalizedPublishOptions(ctx, source);
}

function resolveStandaloneVmPublishOptions(
  ctx: RequestContext,
  source: Record<string, unknown>,
): NormalizedFinalizedPublishOptions | null {
  if (!validateFinalizedAssertionPublishShape(source, ctx.res)) return null;
  const raw = source.options;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (!validateFinalizedAssertionPublishShape(raw as Record<string, unknown>, ctx.res)) return null;
    // GH#1786 — the author selector is a TOP-LEVEL field. `parseHttpFinalizedPublishOptions`
    // ignores unknown keys, so a nested one would be silently dropped and the publish would
    // resolve the author as if nothing was selected — spending real TRAC/gas on the wrong
    // author. Fail closed instead of no-op, matching this file's both-positions convention.
    if ((raw as Record<string, unknown>)[SELECTED_AUTHOR_FIELD] !== undefined) {
      jsonResponse(ctx.res, 400, {
        error:
          `"${SELECTED_AUTHOR_FIELD}" must be supplied at the top level of the request body, not inside "options".`,
      });
      return null;
    }
  }
  return resolveFinalizedPublishOptions(ctx, raw);
}

const SELECTED_AUTHOR_FIELD = "selectedAuthorAgentAddress";

/**
 * GH#1786 — read + validate the resident-author selector. Distinct from the
 * rejected `authorAgentAddress` (which would OVERRIDE authorship — the seal
 * already encodes the author): this only SELECTS among authors who already have
 * a finalized assertion at this coordinate, so a client can act on a
 * 409 `AMBIGUOUS_ASSERTION_AUTHOR`. Returns `{ ok: false }` after having written
 * a 400 (caller must return).
 */
function resolveSelectedAuthorAgentAddress(
  ctx: RequestContext,
  source: Record<string, unknown>,
): { ok: true; value?: string } | { ok: false } {
  const raw = source[SELECTED_AUTHOR_FIELD];
  // Only `undefined` counts as absent. A PRESENT `null` (a common client
  // serialization of "nothing selected") must fail closed like any other malformed
  // value — treating it as absent would fall back to normal author resolution and
  // could publish a different author with 200 instead of a request-shape error.
  if (raw === undefined) return { ok: true };
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    jsonResponse(ctx.res, 400, {
      error: `"${SELECTED_AUTHOR_FIELD}" must be a 0x-prefixed 20-byte EVM address`,
    });
    return { ok: false };
  }
  return { ok: true, value: raw };
}

/**
 * GH#1786 — the create route publishes the KA it just created, whose author is
 * fixed by the create itself, so selecting a foreign resident author there is
 * contradictory rather than merely a no-op. Rejected in BOTH positions because
 * the create handler reads only named top-level keys and would otherwise never
 * see it.
 */
function rejectSelectedAuthorOnCreate(
  ctx: RequestContext,
  source: Record<string, unknown>,
): boolean {
  if (source[SELECTED_AUTHOR_FIELD] === undefined) return true;
  jsonResponse(ctx.res, 400, {
    error:
      `"${SELECTED_AUTHOR_FIELD}" is not accepted when creating a knowledge asset — the created assertion's author is the publish author. Use POST /api/knowledge-assets/:name/vm/publish to select among resident authors.`,
  });
  return false;
}

export async function handleKnowledgeAssetsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, publisherControl, path, url, requestToken, requestAgentAddress, emitMemoryGraphChanged } = ctx;
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
    // POST /api/knowledge-assets/swm/share-jobs/:jobId/clear — #1837 atomic terminal
    // record removal (idempotent). DISTINCT from the DELETE cancellation below (which
    // rewrites a queued job to failed+cancelled and RETAINS the row).
    if (
      method === "POST" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      path.endsWith("/clear")
    ) {
      const jobId = decodePromoteJobId(
        path.slice(`${SHARE_JOBS_PREFIX}/`.length, -"/clear".length),
        res,
      );
      if (jobId === null) return;
      return handleKaShareJobClear(ctx, jobId);
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

  // ── POST /api/knowledge-assets/publish — retired direct publish surface ──
  if (method === "POST" && path === `${PREFIX}/publish`) {
    return jsonResponse(res, 404, {
      code: "DIRECT_PUBLISH_ROUTE_REMOVED",
      error:
        "POST /api/knowledge-assets/publish has been removed. Publish named knowledge assets via POST /api/knowledge-assets/:name/vm/publish after create, wm/write, wm/finalize, and swm/share.",
    });
  }

  // ── POST /api/knowledge-assets/batch-rejections/report ────────────────
  //
  // OT-RFC-38 LU-8 - when verifyBatch returns ok=false, the member creates
  // and shares a named BatchRejection KA so other members can sanity-check and
  // re-pull from a different host without using a loose shared-memory write.
  if (method === "POST" && path === `${PREFIX}/batch-rejections/report`) {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return;
    const contextGraphId = parsed.contextGraphId;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    const verifyResult = parsed.verifyResult;
    if (!verifyResult || verifyResult.ok !== false) {
      return jsonResponse(res, 400, {
        error: "verifyResult.ok must be false; nothing to report on an ok batch",
      });
    }

    const derivedRejectedBy = resolveBatchRejectionReporterIdentity(
      ctx,
      writePreflightCallerAgentAddress,
    );
    let explicitRejectedBy: { agentAddress: string; peerId?: string } | undefined;
    try {
      explicitRejectedBy = parseExplicitBatchRejectionReporterIdentity(parsed.rejectedBy);
    } catch (err: any) {
      return jsonResponse(res, 400, {
        error: err?.message ?? String(err),
      });
    }
    if (
      explicitRejectedBy &&
      !isSameAgentAddress(explicitRejectedBy.agentAddress, derivedRejectedBy.agentAddress)
    ) {
      return jsonResponse(res, 403, {
        error: "rejectedBy.agentAddress must match the authenticated rejecting agent",
        code: "REJECTED_BY_AGENT_MISMATCH",
      });
    }
    const rejectedBy = derivedRejectedBy;

    try {
      const result = await reportBatchRejectionWithLifecycle(agent, {
        contextGraphId: resolvedContextGraphId,
        batchId: parsed.batchId,
        verifyResult,
        rejectedBy,
        ...(writePreflightCallerAgentAddress ? { agentAddress: writePreflightCallerAgentAddress } : {}),
      });
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
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
      awaitCuratorAck,
    } = parsed;
    // No legacy alias: product callers must name the lifecycle transition.
    // `alsoShareSwm: true` is the only accepted create-route flag for advancing
    // a sealed WM assertion into SWM. The async/sync publish preflight relies on
    // this explicit share step.
    const alsoShareSwm = parsed.alsoShareSwm;
    if (parsed.promote !== undefined) {
      return jsonResponse(res, 400, { error: '"promote" is retired; use "alsoShareSwm" for the WM to SWM lifecycle transition' });
    }
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
    if (awaitCuratorAck !== undefined && typeof awaitCuratorAck !== "boolean") {
      return jsonResponse(res, 400, { error: '"awaitCuratorAck" must be a boolean when supplied' });
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
    if (hasQuads) {
      if (!quads.every(isWritableQuad)) {
        return jsonResponse(res, 400, { error: '"quads" must be an array of { subject, predicate, object } objects (graph optional); string-shaped quads are not accepted' });
      }
      const literalSize = validateWritableQuadLiteralSizes("quads", quads);
      if (!literalSize.ok) return jsonResponse(res, 400, literalSize.body);
    }
    const shouldFinalize = hasQuads && finalize !== false;
    // #1116 D5: the create ROUTE stays a primitive — create+write+seal, with
    // opt-in share (this preserves the "create stops at a sealed WM draft"
    // invariant the agent-tooling work relies on). The "default to seal AND
    // share to SWM" convenience is owned by the combined CLIENT function
    // `createKnowledgeAsset` (MCP/OpenClaw), which defaults `alsoShareSwm` when
    // it seals. So here `alsoShareSwm` is honored exactly as sent.
    // alsoShareSwm/alsoPublishVm advance a SEALED assertion to SWM/VM, so they
    // require this request to finalize. Reject upfront — before any create/write
    // mutation — whenever it won't (no quads, or finalize:false); otherwise the
    // create lands a durable draft the tail can't share/publish, turning a
    // request-shape error into orphaned state.
    const alsoPublishVmRequested =
      alsoPublishVm === true || (typeof alsoPublishVm === "object" && alsoPublishVm !== null);
    const alsoPublishVmOptions = alsoPublishVmRequested
      ? resolveInlineVmPublishOptions(
          ctx,
          typeof alsoPublishVm === "object" && alsoPublishVm !== null ? alsoPublishVm : {},
        )
      : {};
    if (alsoPublishVmOptions === null) return;
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
    // GH#1786 — the create body's top level is not otherwise inspected for this field
    // (only named keys are destructured), so without this a top-level selector here
    // would be silently ignored while the KA published under the created author.
    if (!rejectSelectedAuthorOnCreate(ctx, parsed)) return;
    const finalizeOptions = shouldFinalize
      ? resolveFinalizeOptions(
          { subGraphName, authorAgentAddress, preSignedAuthorAttestation, schemeVersion },
          res,
          writePreflightCallerAgentAddress,
        )
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
      // OT-RFC-43 §F2 — the kaId is stamped (in the author's namespace) at
      // create. It MUST match the author the seal is later finalized under, or
      // finalize throws KaIdNamespaceMismatch. So stamp under the same resolved
      // author the finalize uses: the body author, else the token's agent (else
      // undefined → the daemon's default agent for node/admin tokens).
      const createAuthorAgentAddress = resolveAuthorAgentAddressFromFinalizeOptions(
        finalizeOptions,
        writePreflightCallerAgentAddress,
      );
      const atomicAuthorLane = createAuthorAgentAddress
        ? { agentAddress: createAuthorAgentAddress }
        : {};
      const assertionUri = await agent.assertion.create(resolvedContextGraphId, name, {
        subGraphName,
        ...(createAuthorAgentAddress ? { agentAddress: createAuthorAgentAddress } : {}),
      });
      const result: Record<string, unknown> = { name, assertionUri, alreadyExists, status: "draft-open" };
      emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_created", source: "api", counts: { triples: 0 } });
      recordActivityAndNotify(ctx, { contextGraphId: resolvedContextGraphId, kind: "created", actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress, subGraphName });

      // Write quads whenever supplied; SEAL only when finalize !== false. An
      // explicit finalize:false leaves an editable WM draft and never touches
      // the chain (OT-RFC-43 §10.5.5). `also*` are opt-in transitions on top.
      if (hasQuads) {
        await agent.assertion.write(resolvedContextGraphId, name, quads, { subGraphName, ...atomicAuthorLane });
        result.written = quads.length;
        emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_written", source: "api", counts: { triples: quads.length } });
      }
      if (shouldFinalize) {
        const seal = await agent.assertion.finalize(resolvedContextGraphId, name, {
          ...finalizeOptions,
          ...atomicAuthorLane,
        });
        result.merkleRoot = hex(seal.merkleRoot);
        // Surface the sealed author so clients (and tests) can confirm custodial
        // attribution on the atomic create+finalize path, mirroring the dedicated
        // wm/finalize route's response.
        result.authorAddress = seal.authorAddress;
        result.status = "wm-sealed";
        emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm"], subGraphName, operation: "assertion_finalized", source: "api" });
      }

      const errors: Array<{ phase: string; error: string }> = [];
      if (alsoShareSwm === true) {
        try {
          // Carry the same resolved author into the share. The asset is already
          // sealed (finalize above), so promote shares the existing seal verbatim
          // and passing the author keeps the whole atomic flow in one namespace.
          const share = await agent.assertion.promote(resolvedContextGraphId, name, {
            subGraphName,
            ...atomicAuthorLane,
            awaitCuratorAck,
            ...(resolvedAuthorAgentAddress ? { authorAgentAddress: resolvedAuthorAgentAddress } : {}),
          });
          result.swmShared = true;
          result.promotedCount = share.promotedCount;
          result.sealed = share.sealed;
          result.publishReady = share.publishReady;
          if (share.shareOperationId) result.shareOperationId = share.shareOperationId;
          // #1116: the one-shot finalizes BEFORE sharing, so a shared asset is
          // normally sealed ("swm-shared"). The unsealed status is only reachable
          // if a future path shares without sealing.
          result.status = share.sealed ? "swm-shared" : "swm-shared-unsealed";
          if (share.promotedCount !== 0) {
            emitMemoryGraphChanged?.({ contextGraphId: resolvedContextGraphId, layers: ["wm", "swm"], subGraphName, operation: "assertion_promoted", source: "api", counts: { triples: share.promotedCount } });
            recordActivityAndNotify(ctx, { contextGraphId: resolvedContextGraphId, kind: "promoted", actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress, subGraphName, tripleCount: share.promotedCount });
          }
        } catch (e: any) {
          errors.push({ phase: "swm-share", error: sanitizeRpcMessage(e?.message ?? String(e)) });
        }
      }
      if (alsoPublishVm === true || (typeof alsoPublishVm === "object" && alsoPublishVm !== null)) {
        try {
          const pub: FinalizedPublishResult = await agent.publishFromFinalizedAssertion(resolvedContextGraphId, name, {
            subGraphName,
            ...alsoPublishVmOptions,
            ...atomicAuthorLane,
          });
          result.kaId = pub?.kaId;
          result.ual = pub?.ual;
          result.txHash = pub?.onChainResult?.txHash;
          const storageAckPeerIds = storageAckPeerIdsFromPublishResult(pub);
          if (storageAckPeerIds.length > 0) {
            result.storageAckPeerIds = storageAckPeerIds;
          }
          if (pub?.onChainResult?.convictionCostCovered) {
            result.convictionCostCovered = pub.onChainResult.convictionCostCovered;
          }
          // PR #972: only a fully-confirmed publish is "vm-confirmed"; a partial
          // (207) or non-confirmed (502) outcome is flagged as a tail error so
          // the atomic response is a 207 rather than a misleading success.
          const { httpStatus, reason } = classifyVmPublish(pub);
          if (httpStatus === 200) {
            result.status = "vm-confirmed";
          } else {
            result.status = httpStatus === 207 ? "vm-partial" : "vm-failed";
            errors.push({ phase: "vm-publish", error: sanitizeRpcMessage(reason ?? "VM publish did not confirm") });
          }
          recordPcaDiscount(ctx, resolvedContextGraphId, pub?.onChainResult);
        } catch (e: any) {
          errors.push({ phase: "vm-publish", error: sanitizeRpcMessage(e?.message ?? String(e)) });
        }
      }

      // 207 when a create+finalize succeeded but an opt-in tail failed; the
      // sealed assertion is a real artifact the caller can retry against.
      if (errors.length > 0) return jsonResponse(res, 207, { created: true, ...result, errors });
      return jsonResponse(res, 201, result);
    } catch (e: any) {
      if (e?.code === "OVERSIZED_RDF_LITERAL") {
        return jsonResponse(res, 400, oversizedRdfLiteralResponseBody(e));
      }
      // Transient KA-number-floor reconcile failure (rate-limited RPC) -> 503.
      if (respondIfReconcileUnavailable(res, e)) return;
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
  // contextGraphId, validate subGraphName, extract optional agentAddress. For
  // agent-scoped bearer tokens, omitted agentAddress defaults to the token's
  // storage lane so GETs see the same draft the write routes created.
  function readGetParams(): { cg: string; subGraphName?: string; agentAddress?: string } | null {
    if (decodeAndValidateName(name, res) === null) return null;
    const rawCg = url.searchParams.get("contextGraphId");
    if (!validateRequiredContextGraphId(rawCg, res)) return null;
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return null;
    const explicitAgentAddress = url.searchParams.get("agentAddress") ?? undefined;
    if (explicitAgentAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(explicitAgentAddress)) {
      jsonResponse(res, 400, { error: '"agentAddress" must be a 0x-prefixed 20-byte EVM address' });
      return null;
    }
    const agentAddress = explicitAgentAddress ?? writePreflightCallerAgentAddress;
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
      const quads = await agent.assertion.query(p.cg, resolvedName, {
        ...(p.subGraphName ? { subGraphName: p.subGraphName } : {}),
        ...(p.agentAddress ? { agentAddress: p.agentAddress } : {}),
      });
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
        // GH #306 — reject string-shaped / malformed quads here (4xx) instead of
        // letting them crash the agent write path with a TypeError (HTTP 500).
        if (!parsed.quads.every(isWritableQuad)) {
          return jsonResponse(res, 400, { error: '"quads" must be an array of { subject, predicate, object } objects (graph optional); string-shaped quads are not accepted' });
        }
        // GH #306/#787 (follow-up) — reject objects that are neither a quoted
        // literal nor an absolute IRI before they reach (and crash) the parser.
        const wmObjErr = validateQuadObjectTerms("quads", parsed.quads);
        if (wmObjErr) return jsonResponse(res, 400, { error: wmObjErr });
        const literalSize = validateWritableQuadLiteralSizes("quads", parsed.quads);
        if (!literalSize.ok) return jsonResponse(res, 400, literalSize.body);
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
        const writeAuthorLane = writePreflightCallerAgentAddress
          ? { agentAddress: writePreflightCallerAgentAddress }
          : {};
        const existing = await agent.assertion.history(contextGraphId, name, { subGraphName, ...writeAuthorLane });
        if (!existing || existing.state === "discarded") {
          // Stamp the kaId under the request token's agent (OT-RFC-43 §F2) so a
          // later finalize as that agent doesn't hit KaIdNamespaceMismatch.
          await agent.assertion.create(contextGraphId, name, {
            subGraphName,
            ...writeAuthorLane,
          });
        }
        await agent.assertion.write(contextGraphId, name, parsed.quads, { subGraphName, ...writeAuthorLane });
        emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm"], subGraphName, operation: "assertion_written", source: "api", counts: { triples: parsed.quads.length } });
        return jsonResponse(res, 200, { written: parsed.quads.length });
      }
      if (verb === "finalize") {
        const finalizeOptions = resolveFinalizeOptions(parsed, res, writePreflightCallerAgentAddress);
        if (finalizeOptions === null) return;
        const finalizeStorageLane = await resolveFinalizeStorageLane(
          agent,
          contextGraphId,
          name,
          finalizeOptions,
          writePreflightCallerAgentAddress,
        );
        const seal = await agent.assertion.finalize(contextGraphId, name, {
          ...finalizeOptions,
          ...finalizeStorageLane,
        });
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
        await agent.assertion.discard(contextGraphId, name, {
          subGraphName,
          ...(writePreflightCallerAgentAddress ? { agentAddress: writePreflightCallerAgentAddress } : {}),
        });
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
          const result = await agent.assertion.pullFrom(contextGraphId, name, sourceLayer, {
            subGraphName,
            onConflict,
            ...(writePreflightCallerAgentAddress ? { agentAddress: writePreflightCallerAgentAddress } : {}),
          });
          return jsonResponse(res, 200, { wmDraft: "open", seededFrom: { layer: sourceLayer }, ...result });
        } catch (e: any) {
          if (e?.code === "WM_DRAFT_CONFLICT") {
            return jsonResponse(res, 409, { code: "WM_DRAFT_CONFLICT", error: e.message });
          }
          if (
            e?.code === "UNSEALED_PULL_FROM_BLOCKED"
            || e?.code === "PULL_FROM_EMPTY_SOURCE"
            || e?.code === "LEGACY_KA_READ_ONLY"
          ) {
            return jsonResponse(res, 409, { code: e.code, error: e.message });
          }
          throw e; // -> outer catch -> 500
        }
      }
    }

    // ── SWM verb: share (WM → SWM; OT-RFC-43 §10.6 renames promote → share) ──
    if (layer === "swm" && verb === "share") {
      // Per-request opt-in to the strict curator-ack gate (OT-RFC-49). Omitted →
      // agent config default (`swmAwaitCuratorAck`). The promote aborts with 503
      // (mapped in respondAssertionError) if the curator doesn't confirm.
      const awaitCuratorAck = typeof parsed?.awaitCuratorAck === "boolean" ? parsed.awaitCuratorAck : undefined;
      if (!validateEntities(parsed.entities, res)) return;
      if (Array.isArray(parsed.entities)) {
        return jsonResponse(res, 400, {
          code: "KA_ATOMIC_SHARE_REQUIRED",
          error: '"entities" selection is not supported; graph-scoped Knowledge Assets are shared atomically',
        });
      }
      // Graph-scoped KAs are seal-before-share. Retain strict parsing and accept
      // an explicit false for older clients, but reject the removed true mode
      // before any lifecycle mutation.
      let skipSeal: boolean | undefined;
      if (parsed?.skipSeal !== undefined) {
        if (typeof parsed.skipSeal !== "boolean") {
          return jsonResponse(res, 400, { error: '"skipSeal" must be a boolean when supplied' });
        }
        if (parsed.skipSeal === true) {
          return jsonResponse(res, 400, {
            code: "UNSEALED_SHARE_UNSUPPORTED",
            error: "skipSeal:true is not supported for graph-scoped Knowledge Assets; finalize and share the complete KA atomically",
          });
        }
        skipSeal = parsed.skipSeal;
      }
      try {
        const share = await agent.assertion.promote(contextGraphId, name, {
          entities: parsed.entities,
          subGraphName,
          awaitCuratorAck,
          skipSeal,
          ...scopedTokenPromoteLane(writePreflightCallerAgentAddress),
        });
        if (share.promotedCount !== 0) {
          emitMemoryGraphChanged?.({ contextGraphId, layers: ["wm", "swm"], subGraphName, operation: "assertion_promoted", source: "api", counts: { triples: share.promotedCount } });
          recordActivityAndNotify(ctx, { contextGraphId, kind: "promoted", actorAgentAddress: requestAgentAddress, subGraphName, tripleCount: share.promotedCount });
        }
        // A durable idempotent replay returns zero newly-promoted rows together
        // with the original shareOperationId. That is an already-completed share,
        // not an ownership skip, so preserve its sealed/publish-ready status.
        const durableReplay = share.promotedCount === 0 && Boolean(share.shareOperationId);
        const swmShared = share.promotedCount > 0 || durableReplay;
        return jsonResponse(res, 200, {
          swmShared,
          promotedCount: share.promotedCount,
          ...(share.sealed !== undefined ? { sealed: swmShared && share.sealed } : {}),
          ...(share.publishReady !== undefined ? { publishReady: swmShared && share.publishReady } : {}),
          ...(share.shareOperationId ? { shareOperationId: share.shareOperationId } : {}),
        });
      } catch (e: any) {
        // A full share that cannot seal fails closed with WM preserved. Map to a 409 that
        // carries the recovery hint. Everything else (e.g. the curator-ack 503)
        // propagates to the outer handler unchanged.
        if (e?.code === "UNSEALED_SHARE_BLOCKED") {
          return jsonResponse(res, 409, { code: "UNSEALED_SHARE_BLOCKED", error: e.message, recovery: e.recovery });
        }
        if (e?.code === "KA_NAMED_GRAPH_SHARE_UNSUPPORTED") {
          return jsonResponse(res, 409, {
            code: "KA_NAMED_GRAPH_SHARE_UNSUPPORTED",
            error: e.message,
            namedGraphs: Array.isArray(e.namedGraphs) ? e.namedGraphs : undefined,
          });
        }
        throw e;
      }
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
      if (Array.isArray(entities)) {
        return jsonResponse(res, 400, {
          code: "KA_ATOMIC_SHARE_REQUIRED",
          error: '"entities" selection is not supported; graph-scoped Knowledge Assets are shared atomically',
        });
      }
      // #1116 (round 5): the sync swm/share validates `skipSeal` as a strict
      // boolean; the async queue ALWAYS seals (the safe default) and can't carry
      // skipSeal through the job, so it was silently dropped — a footgun where a
      // caller asking to skip sealing got a sealed share. Reject a non-boolean
      // (parity with the sync route) and reject a truthy boolean outright rather
      // than honoring it differently than requested.
      if (parsed?.skipSeal !== undefined) {
        if (typeof parsed.skipSeal !== "boolean") {
          return jsonResponse(res, 400, { error: '"skipSeal" must be a boolean when supplied' });
        }
        if (parsed.skipSeal === true) {
          return jsonResponse(res, 400, { error: "skipSeal is not supported; graph-scoped Knowledge Assets are always seal-before-share" });
        }
      }
      try {
        const result = await agent.assertion.promoteAsync(contextGraphId, name, {
          entities: entities ?? "all",
          subGraphName,
          ...scopedTokenPromoteLane(writePreflightCallerAgentAddress),
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
    if (layer === "vm" && verb === "publish-async") {
      try {
        const publisherAvailability = ctx.publisherState.availability;
        if (!publisherAvailability.available) {
          return jsonResponse(res, 503, {
            code: "async_publisher_unavailable",
            error: "The asynchronous publisher cannot accept jobs on this node.",
            reason: publisherAvailability.reason,
            retryable: publisherAvailability.retryable,
            operatorActionRequired: publisherAvailability.operatorActionRequired,
          });
        }
        const opts = resolveStandaloneVmPublishOptions(ctx, parsed);
        if (opts === null) return;
        const asyncSelectedAuthor = resolveSelectedAuthorAgentAddress(ctx, parsed);
        if (!asyncSelectedAuthor.ok) return;
        const publishOptions = opts;
        const intent = await agent.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name, {
          ...(subGraphName ? { subGraphName } : {}),
          ...publishCallerHintLane(writePreflightCallerAgentAddress),
          ...(asyncSelectedAuthor.value !== undefined
            ? { selectedAuthorAgentAddress: asyncSelectedAuthor.value }
            : {}),
          ...(publishOptions.publishEpochs !== undefined ? { publishEpochs: publishOptions.publishEpochs } : {}),
          ...(publishOptions.clearSharedMemoryAfter !== undefined
            ? { clearSharedMemoryAfter: publishOptions.clearSharedMemoryAfter }
            : {}),
          ...(publishOptions.publisherNodeIdentityIdOverride !== undefined
            ? { publisherNodeIdentityIdOverride: publishOptions.publisherNodeIdentityIdOverride }
            : {}),
        });
        await agent.preflightKnowledgeAssetVmPublishSnapshot(intent);
        const jobId = await publisherControl.enqueueKnowledgeAssetVmPublish(intent);
        return jsonResponse(res, 202, {
          jobId,
          status: "accepted",
          contextGraphId,
          name,
          shareOperationId: intent.shareOperationId,
          contentScopeVersion: intent.contentScopeVersion,
          kaUal: intent.kaUal,
          assertionVersion: intent.assertionVersion,
          publicTripleCount: intent.publicTripleCount,
          privateTripleCount: intent.privateTripleCount,
          sealMerkleRoot: intent.sealMerkleRoot,
          intentKey: intent.intentKey,
          // GH#1786 — echo the RESOLVED author so a client can verify which author
          // will be published before the job runs, and can detect a daemon that
          // ignored a supplied selector (the sync 200 body already echoes it).
          ...(intent.agentAddress ? { agentAddress: intent.agentAddress } : {}),
          ...(subGraphName ? { subGraphName } : {}),
        });
      } catch (err: any) {
        if (err instanceof AsyncLiftJobConflictError) {
          return jsonResponse(res, 409, {
            error: err.message,
            existingJobId: err.existingJobId,
          });
        }
        if (err?.code === "PUBLISH_NOT_FULL_SHARE" || err?.code === "PUBLISH_INTENT_STALE") {
          return jsonResponse(res, 409, { code: err.code, error: err.message ?? String(err) });
        }
        // GH#2273 — a multi-valued SWM head now fails closed in the resolver. That is
        // transient SERVER-side corruption the sync repair heals, not a stale client
        // intent, so it must not read as the 409 above (the client would re-share for
        // nothing) or fall through to a generic 500: 503 + retryable tells the caller to
        // retry the same enqueue after catch-up converges the head.
        if (err?.code === "KA_WORKSPACE_HEAD_CORRUPT") {
          return jsonResponse(res, 503, {
            code: err.code,
            error: err.message ?? String(err),
            retryable: true,
          });
        }
        // GH#1778 — several authors share this KA name; the caller must
        // disambiguate. Surface the candidate authors so the UI/CLI can pick.
        if (respondAmbiguousAssertionAuthor(res, err)) return;
        // GH#1786 — must precede the message-keyed 400 below, which would otherwise
        // capture any author-selection message containing "Invalid"/"must be".
        if (respondAuthorSelectionError(res, err)) return;
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

    if (layer === "vm" && verb === "publish") {
      // #988: publish keeps its OWN generic-500 catch (NOT the outer
      // respondAssertionError) so on-chain/storage "Invalid"/"Unsafe" text isn't
      // down-classified to 400. Inside it, run the #971 input validation +
      // #972 outcome-status mapping (200/207/502).
      try {
        // Validate the request shape + normalize options BEFORE the publish (PR
        // #971): this is a standalone request, so a 400 here mutates nothing.
        const opts = resolveStandaloneVmPublishOptions(ctx, parsed);
        if (opts === null) return;
        // #1116: registration moved from seal-time to publish-time, but it must
        // run AFTER the local preconditions, not before — otherwise a doomed
        // publish (not finalized / nothing in SWM) would burn registration gas
        // and only THEN surface the 409. publishFromFinalizedAssertion checks
        // those preconditions BEFORE any chain interaction (they throw
        // "is not finalized" / "No quads in shared memory"), and the
        // unregistered-CG guard fires only after them. So: try the publish
        // first; ONLY if the sole remaining blocker is an unregistered CG do we
        // transparently register and retry (idempotent). All other errors
        // propagate to the precondition/500 mapping below unchanged.
        let pub: FinalizedPublishResult;
        const selectedAuthor = resolveSelectedAuthorAgentAddress(ctx, parsed);
        if (!selectedAuthor.ok) return;
        // GH#1786 — the selector MUST live in this shared lane object, not at a call
        // site: it is spread into BOTH the first publish and the CG-registration
        // retry below, and the retry re-runs author resolution from scratch. A
        // per-call-site key would be dropped on the retry and publish the wrong
        // author with HTTP 200 and real spend (the unregistered-CG first publish is
        // exactly the curator's first publish of a member KA).
        const publishStorageLane = {
          ...publishCallerHintLane(writePreflightCallerAgentAddress),
          ...(selectedAuthor.value !== undefined ? { selectedAuthorAgentAddress: selectedAuthor.value } : {}),
        };
        try {
          pub = await agent.publishFromFinalizedAssertion(contextGraphId, name, { subGraphName, ...opts, ...publishStorageLane });
        } catch (firstErr: any) {
          // #1116 (review B): code-first, message fallback. The publisher now
          // stamps `code: 'CG_NOT_REGISTERED'` on this throw; match on it and
          // keep the message regex for back-compat (older publisher builds /
          // re-wrapped errors that lost the code).
          if (firstErr?.code !== "CG_NOT_REGISTERED" && !/not registered on-chain/i.test(firstErr?.message ?? String(firstErr))) throw firstErr;
          try {
            await agent.ensureRegisteredForPublish(contextGraphId, { callerAgentAddress: requestAgentAddress });
          } catch (regErr: any) {
            // A transient RPC outage during the pre-publish auto-registration
            // is retryable (503/504), NOT a permanent client error (400) — a
            // 400 would tell retry-aware clients to give up on a flaky RPC.
            if (respondIfChainRpcTransportError(res, regErr)) return;
            return jsonResponse(res, 400, buildAutoRegisterFailureBody(contextGraphId, regErr));
          }
          pub = await agent.publishFromFinalizedAssertion(contextGraphId, name, { subGraphName, ...opts, ...publishStorageLane });
        }
        const { httpStatus, reason } = classifyVmPublish(pub);
        if (httpStatus === 200) {
          // Activity attributed to the SEAL author (PR #971), not the requester.
          recordActivityAndNotify(ctx, { contextGraphId, kind: "published", actorAgentAddress: pub?.seal?.authorAddress ?? pub?.authorAddress ?? requestAgentAddress, subGraphName });
        }
        recordPcaDiscount(ctx, contextGraphId, pub?.onChainResult);
        const storageAckPeerIds = storageAckPeerIdsFromPublishResult(pub);
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
          ...(pub?.onChainResult?.convictionCostCovered ? { convictionCostCovered: pub.onChainResult.convictionCostCovered } : {}),
          ...(typeof pub?.contextGraphError === "string" ? { contextGraphError: pub.contextGraphError } : {}),
          ...(storageAckPeerIds.length > 0 ? { storageAckPeerIds } : {}),
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
        // `has no private payload` is the curated-CG analogue of `No quads in
        // shared memory`: a curated publish with nothing private shared (only
        // the public catalog entry) — a caller precondition, thrown before any
        // chain interaction, so 409 is safe + consistent with the public path.
        // #1116 (round 9): PUBLISH_NOT_FULL_SHARE — the marker gate (a publish
        // requires a complete full share resident in SWM) is also a pre-chain
        // caller precondition; map it to the same 409 (code-first).
        // GH#1786 — must precede the precondition branch below, which would otherwise
        // relabel an author-selection failure whose message happens to contain
        // "is not finalized" as a generic VM_PUBLISH_PRECONDITION.
        if (respondAuthorSelectionError(res, e)) return;
        if (e?.code === "PUBLISH_NOT_FULL_SHARE" || /is not finalized/.test(msg) || /No quads in shared memory/.test(msg) || /has no private payload/.test(msg)) {
          return jsonResponse(res, 409, { code: e?.code === "PUBLISH_NOT_FULL_SHARE" ? "PUBLISH_NOT_FULL_SHARE" : "VM_PUBLISH_PRECONDITION", error: msg });
        }
        // GH#1778 — several authors share this KA name; the caller must
        // disambiguate. Surface the candidate authors so the UI/CLI can pick.
        if (respondAmbiguousAssertionAuthor(res, e)) return;
        // Funded-wallet selection found no operational wallet holding the
        // gas + TRAC a publish needs. This is a user-actionable funding
        // condition (4xx), not a server/on-chain bug. Classification + body are
        // shared with the top-level daemon handler (lifecycle.ts) so the two
        // publish routes cannot drift on the code/marker contract.
        if (isNoFundedPublisherWalletLike(e)) {
          return jsonResponse(res, 400, noFundedPublisherWalletBody(msg));
        }
        // A transient chain-RPC transport failure (all endpoints exhausted /
        // receipt lookup failed / timeout) is retryable -> 503/504, matching
        // /api/context-graph/register. Keyed strictly on err.code, so an
        // on-chain revert (CALL_EXCEPTION, no transport code) still keeps the
        // generic 500 below (the #988 "publish never down-classifies on-chain
        // errors" parity contract).
        if (respondIfChainRpcTransportError(res, e)) return;
        return jsonResponse(res, 500, { error: msg });
      }
    }
  } catch (e: any) {
    // WM/SWM mutation verbs (write/finalize/discard/pull-from/share) only.
    return respondAssertionError(res, e);
  }

  // Unmatched under the prefix — fall through to the daemon's 404.
}
