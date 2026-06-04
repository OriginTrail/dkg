// Route handlers for the GitHub-shaped Knowledge Asset HTTP surface.
//
// OT-RFC-43 §10.5 — one coherent resource model for a Knowledge Asset (KA):
// the working tree is WM, SWM and VM are remote branches, assertions are
// immutable commits, layer is EXPLICIT in every write path:
//
//   POST /api/knowledge-assets                       create KA + open WM draft
//                                                    (atomic: quads + also* flags)
//   GET  /api/knowledge-assets/:name                 KA metadata / lifecycle state
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
  contextGraphMetaUri,
  createOperationContext,
  validateAssertionName,
  type OperationContext,
} from "@origintrail-official/dkg-core";
import { resolveChainConfig } from "../../config.js";
import { validatePreSignedAuthorAttestation } from "./memory.js";
import { recordAssertionActivity } from "../activity-notification.js";
import {
  jsonResponse,
  normalizeContextGraphIdOrUri,
  readBody,
  resolveRequiredWriteContextGraphId,
  safeDecodeURIComponent,
  safeParseJson,
  SMALL_BODY_BYTES,
  validateEntities,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
} from "../http-utils.js";

const PREFIX = "/api/knowledge-assets";
const DKG_NS = "http://dkg.io/ontology/";
const PROV_NS = "http://www.w3.org/ns/prov#";

function sparqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripSparqlValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/^<|>$/g, "")
    .replace(/"\^\^<.*>$/, "")
    .replace(/^"|"$/g, "");
}

function agentAddressFromDid(value: string | undefined): string | undefined {
  const raw = stripSparqlValue(value);
  if (!raw) return undefined;
  const prefix = "did:dkg:agent:";
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

async function resolveAssertionOwnerAgentAddress(
  agent: RequestContext["agent"],
  contextGraphId: string,
  name: string,
  subGraphName?: string,
): Promise<string | undefined> {
  const store = (agent as unknown as { store?: { query?: (sparql: string) => Promise<any> } }).store;
  if (!store?.query) return undefined;

  const metaGraph = contextGraphMetaUri(contextGraphId);
  const assertionGraphPrefix = subGraphName
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`
    : `did:dkg:context-graph:${contextGraphId}/assertion/`;

  try {
    const result = await store.query(
      `SELECT ?agent WHERE {
        GRAPH <${metaGraph}> {
          ?assertion <${DKG_NS}contextGraph> <did:dkg:context-graph:${contextGraphId}> ;
                     <${DKG_NS}assertionName> ${sparqlLiteral(name)} ;
                     <${PROV_NS}wasAttributedTo> ?agent .
          OPTIONAL { ?assertion <${DKG_NS}assertionGraph> ?assertionGraph }
          FILTER(!BOUND(?assertionGraph) || STRSTARTS(STR(?assertionGraph), ${sparqlLiteral(assertionGraphPrefix)}))
        }
      } LIMIT 1`,
    );
    if (result?.type !== "bindings" || !Array.isArray(result.bindings) || result.bindings.length === 0) {
      return undefined;
    }
    return agentAddressFromDid(result.bindings[0]?.agent);
  } catch {
    return undefined;
  }
}

/**
 * Body-size cap by `(layer, verb)` (codex PR #971 F21). The control verbs
 * (`finalize`, `discard`, `pull-from`, `share`, `publish`) carry a handful
 * of scalar fields — there is no legitimate reason for any of them to be
 * larger than the legacy `SMALL_BODY_BYTES` cap their `/api/assertion/*` +
 * `/api/shared-memory/*` ancestors used. `wm/write` is the only quad-bearing
 * sub-route, so it keeps the default `MAX_BODY_BYTES`. The atomic create at
 * `POST /api/knowledge-assets` also keeps the large cap because its body
 * may include the same `quads` payload as `wm/write`.
 */
function postShapeMaxBytes(layer: string | undefined, verb: string | undefined): number | undefined {
  if (layer === "wm" && verb === "write") return undefined; // default MAX_BODY_BYTES
  if (
    (layer === "wm" && (verb === "finalize" || verb === "discard" || verb === "pull-from")) ||
    (layer === "swm" && verb === "share") ||
    (layer === "vm" && verb === "publish")
  ) {
    return SMALL_BODY_BYTES;
  }
  return undefined;
}

function hex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function serializeSeal(seal: any): Record<string, unknown> {
  return {
    assertionUri: seal?.assertionUri,
    merkleRoot: seal?.merkleRoot instanceof Uint8Array ? hex(seal.merkleRoot) : seal?.merkleRoot,
    authorAddress: seal?.authorAddress,
    schemeVersion: seal?.schemeVersion,
    chainId: seal?.chainId != null ? String(seal.chainId) : undefined,
    kav10Address: seal?.kav10Address,
    eip712Digest: seal?.eip712Digest,
  };
}

function publishResponsePayload(result: any): Record<string, unknown> {
  const chain = result?.onChainResult;
  const seal = serializeSeal(result?.seal);
  return {
    kaId: result?.kaId != null ? String(result.kaId) : undefined,
    status: result?.status,
    assertionUri: result?.assertionUri ?? seal.assertionUri,
    authorAddress: seal.authorAddress,
    merkleRoot: seal.merkleRoot,
    ual: result?.ual,
    kas: Array.isArray(result?.kaManifest)
      ? result.kaManifest.map((ka: any) => ({
        tokenId: ka?.tokenId != null ? String(ka.tokenId) : undefined,
        rootEntity: ka?.rootEntity,
      }))
      : undefined,
    ...(chain ? { txHash: chain.txHash, blockNumber: chain.blockNumber } : {}),
    ...(result?.contextGraphError ? { contextGraphError: result.contextGraphError } : {}),
  };
}

function finalizedPublishOptionsInput(
  parsed: Record<string, unknown>,
  res: RequestContext["res"],
): unknown | null {
  if (
    parsed.options !== undefined &&
    (parsed.options === null || typeof parsed.options !== "object" || Array.isArray(parsed.options))
  ) {
    jsonResponse(res, 400, { error: '"options" must be an object when supplied' });
    return null;
  }
  const nested = parsed.options as Record<string, unknown> | undefined;
  return {
    ...(nested ?? {}),
    ...(parsed.clearAfter !== undefined ? { clearAfter: parsed.clearAfter } : {}),
    ...(parsed.clearSharedMemoryAfter !== undefined ? { clearSharedMemoryAfter: parsed.clearSharedMemoryAfter } : {}),
    ...(parsed.publishEpochs !== undefined ? { publishEpochs: parsed.publishEpochs } : {}),
    ...(parsed.epochs !== undefined ? { epochs: parsed.epochs } : {}),
    ...(parsed.publisherNodeIdentityIdOverride !== undefined
      ? { publisherNodeIdentityIdOverride: parsed.publisherNodeIdentityIdOverride }
      : {}),
  };
}

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
        '"authorAgentAddress" and "preSignedAuthorAttestation" cannot be combined with "assertionName" — the seal already encodes the author. Re-finalize the assertion if you need to change authorship.',
    });
    return false;
  }

  const selection = parsed.selection ?? nested?.selection;
  if (selection !== undefined && selection !== "all") {
    jsonResponse(res, 400, {
      error:
        '"selection" must be omitted or "all" when "assertionName" is supplied — the seal commits to the entire assertion content.',
    });
    return false;
  }

  return true;
}

function routeError(res: RequestContext["res"], err: unknown): boolean {
  const anyErr = err as any;
  if (anyErr?.name === "AssertionNotPersistedError" || anyErr?.code === "ASSERTION_NOT_PERSISTED") {
    jsonResponse(res, 409, {
      error: anyErr.message,
      code: "ASSERTION_NOT_PERSISTED",
      contextGraphId: anyErr.contextGraphId,
      assertionGraph: anyErr.assertionGraph,
      expectedTripleCount: anyErr.expectedTripleCount,
    });
    return true;
  }
  const message = anyErr?.message ?? String(err);
  if (
    message.includes("already exists") ||
    message.includes("not found") ||
    message.includes("Invalid") ||
    message.includes("Unsafe") ||
    message.includes("not registered on-chain") ||
    message.includes("not registered") ||
    message.includes("not finalized") ||
    message.includes("seal binds chainId") ||
    message.includes("seal binds KAv10") ||
    message.includes("expectedMerkleRoot mismatch") ||
    message.includes("precomputedAttestation signer mismatch") ||
    message.includes("mutually exclusive") ||
    message.includes("not a registered local agent") ||
    message.includes("signer mismatch") ||
    message.includes("has no quads") ||
    message.includes("has no pending shared-memory writes") ||
    message.includes("different merkleRoot") ||
    message.includes("could not be auto-registered on-chain before publish") ||
    message.includes("reserved namespace") ||
    anyErr?.name === "ReservedNamespaceError"
  ) {
    jsonResponse(res, 400, { error: message });
    return true;
  }
  return false;
}

function resolveFinalizeOptions(
  ctx: RequestContext,
  parsed: Record<string, any>,
): Record<string, unknown> | null {
  const { res, agent, requestToken } = ctx;
  const {
    authorAgentAddress: bodyAuthorAgentAddress,
    preSignedAuthorAttestation: bodyPreSignedAttestation,
    schemeVersion,
  } = parsed;
  if (bodyAuthorAgentAddress != null && bodyPreSignedAttestation != null) {
    jsonResponse(res, 400, {
      error: '"authorAgentAddress" and "preSignedAuthorAttestation" are mutually exclusive',
    });
    return null;
  }
  let resolvedPreSignedAttestation:
    | { address: string; signature: { r: Uint8Array; vs: Uint8Array } }
    | undefined;
  if (bodyPreSignedAttestation != null) {
    const validated = validatePreSignedAuthorAttestation(bodyPreSignedAttestation, res);
    if (validated === undefined) return null;
    resolvedPreSignedAttestation = validated;
  }
  let resolvedAuthorAgentAddress: string | undefined;
  if (resolvedPreSignedAttestation == null) {
    if (typeof bodyAuthorAgentAddress === "string" && bodyAuthorAgentAddress.length > 0) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(bodyAuthorAgentAddress)) {
        jsonResponse(res, 400, {
          error: '"authorAgentAddress" must be a 0x-prefixed 20-byte EVM address',
        });
        return null;
      }
      resolvedAuthorAgentAddress = bodyAuthorAgentAddress;
    } else {
      const tokenAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
      if (tokenAgentAddress != null) resolvedAuthorAgentAddress = tokenAgentAddress;
    }
  }
  if (
    schemeVersion != null &&
    (typeof schemeVersion !== "number" || !Number.isInteger(schemeVersion) || schemeVersion < 1)
  ) {
    jsonResponse(res, 400, {
      error: '"schemeVersion" must be a positive integer when supplied',
    });
    return null;
  }
  return {
    ...(resolvedAuthorAgentAddress ? { authorAgentAddress: resolvedAuthorAgentAddress } : {}),
    ...(resolvedPreSignedAttestation ? { preSignedAuthorAttestation: resolvedPreSignedAttestation } : {}),
    ...(schemeVersion != null ? { schemeVersion } : {}),
  };
}

function actorFromFinalizeOptions(finalizeOptions: Record<string, unknown>): string | undefined {
  if (typeof finalizeOptions.authorAgentAddress === "string") return finalizeOptions.authorAgentAddress;
  const preSigned = finalizeOptions.preSignedAuthorAttestation as { address?: unknown } | undefined;
  return typeof preSigned?.address === "string" ? preSigned.address : undefined;
}

async function sealedAuthorFromAssertionHistory(
  ctx: RequestContext,
  contextGraphId: string,
  name: string,
  subGraphName?: string,
): Promise<string | undefined> {
  try {
    const history = await ctx.agent.assertion.history(
      contextGraphId,
      name,
      subGraphName ? { subGraphName } : undefined,
    );
    const seal = (history as { seal?: { authorAddress?: unknown } } | null)?.seal;
    return typeof seal?.authorAddress === "string" && seal.authorAddress.length > 0
      ? seal.authorAddress
      : undefined;
  } catch {
    return undefined;
  }
}

function recordActivity(
  ctx: RequestContext,
  contextGraphId: string,
  kind: "created" | "promoted" | "published",
  opts: { subGraphName?: string; actorAgentAddress?: string; tripleCount?: number; entityCount?: number } = {},
): void {
  try {
    recordAssertionActivity(ctx.dashDb, {
      contextGraphId,
      kind,
      actorAgentAddress: opts.actorAgentAddress ?? ctx.requestAgentAddress,
      subGraphName: opts.subGraphName,
      tripleCount: opts.tripleCount,
      entityCount: opts.entityCount,
    });
    ctx.emitNotification?.({ contextGraphId, type: "assertion_activity" });
  } catch {
    // Dashboard side effects must never break the write path.
  }
}

// Mirror the legacy `/api/shared-memory/publish` ceiling (`memory.ts`).
const MAX_PUBLISH_EPOCHS = 0xffffffff;

// Strict parser for the finalized-assertion publish options. Mirrors the
// validation/coercion the legacy `/api/shared-memory/publish` path applies in
// `memory.ts` so this surface never forwards raw JSON strings/invalid values
// straight into `publishFromFinalizedAssertion()` (which would become 500s or
// mis-typed publishes). `clearAfter` is the SDK spelling for the publisher's
// `clearSharedMemoryAfter`. Returns `null` after writing a 400 on bad input;
// returns `{}` when `raw` carries no recognised options (e.g. `alsoPublishVm:
// true`). Only the recognised keys are forwarded — unknown fields are dropped.
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
      jsonResponse(res, 400, {
        error: `"${publishEpochsField}" must be a positive integer (string or number)`,
      });
      return null;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n)) {
      jsonResponse(res, 400, {
        error: `"${publishEpochsField}" is too large to safely represent as a JavaScript integer`,
      });
      return null;
    }
    if (n > MAX_PUBLISH_EPOCHS) {
      jsonResponse(res, 400, {
        error: `"${publishEpochsField}" must be less than or equal to ${MAX_PUBLISH_EPOCHS}`,
      });
      return null;
    }
    resolvedPublishEpochs = n;
  }

  const clearValue = clearAfter !== undefined ? clearAfter : clearSharedMemoryAfter;
  if (clearAfter !== undefined && typeof clearAfter !== "boolean") {
    jsonResponse(res, 400, { error: '"clearAfter" must be a boolean when supplied' });
    return null;
  }
  if (clearSharedMemoryAfter !== undefined && typeof clearSharedMemoryAfter !== "boolean") {
    jsonResponse(res, 400, { error: '"clearSharedMemoryAfter" must be a boolean when supplied' });
    return null;
  }
  return {
    ...(clearValue !== undefined ? { clearSharedMemoryAfter: clearValue } : {}),
    ...(resolvedPublishEpochs !== undefined ? { publishEpochs: resolvedPublishEpochs } : {}),
    ...(resolvedPublisherIdentityOverride !== undefined
      ? { publisherNodeIdentityIdOverride: resolvedPublisherIdentityOverride }
      : {}),
  };
}

function clearSharedMemoryAfterForNamedPublish(opts: Record<string, unknown>): boolean {
  return typeof opts.clearSharedMemoryAfter === "boolean" ? opts.clearSharedMemoryAfter : false;
}

/**
 * Mirror the legacy `/api/shared-memory/publish` operation-tracker dance
 * (codex PR #971 F22). Without this the new surface would publish without
 * recording progress, tx hash, or gas/cost metadata in the daemon's
 * operation history — a silent regression versus the route it replaces.
 *
 * `publishFromFinalizedAssertion` accepts `operationCtx` and threads it
 * through the publisher's own phase markers, so the dashboard sees the
 * same fine-grained timeline regardless of which HTTP surface initiated
 * the publish. On exit:
 *   - throws → `tracker.fail(opCtx, err)` then re-throw (caller's catch
 *     maps to 400/500 as before);
 *   - returns → `tracker.complete(opCtx, { tripleCount: kaManifest.length })`
 *     unconditionally. Partial-success states (`tentative`/`failed` /
 *     `contextGraphError`) are reflected in the HTTP status code (207)
 *     by the caller — the operation row records a non-error completion
 *     because the publish call itself completed, exactly mirroring the
 *     legacy code path in `memory.ts` (`tracker.complete` runs even when
 *     `result.contextGraphError` is set).
 */
async function publishWithTracker(
  ctx: RequestContext,
  contextGraphId: string,
  name: string,
  options: {
    subGraphName?: string;
    publishOptions: Record<string, unknown>;
  },
): Promise<any> {
  const { tracker, agent, config, network } = ctx;
  const opCtx = createOperationContext("publishFromSWM");
  tracker.start(opCtx, {
    contextGraphId,
    details: {
      source: "api",
      assertionName: name,
      ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
    },
  });
  try {
    await ensureRegisteredForNamedPublish(ctx, contextGraphId, opCtx);
    const result: any = await tracker.trackPhase(opCtx, "read-shared-memory", () =>
      agent.publishFromFinalizedAssertion(contextGraphId, name, {
        ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
        operationCtx: opCtx,
        ...options.publishOptions,
      }),
    );
    const chain = result?.onChainResult;
    if (chain) {
      tracker.setCost(opCtx, {
        gasUsed: chain.gasUsed,
        gasPrice: chain.effectiveGasPrice,
      });
      const chainId = resolveChainConfig(config, network)?.chainId;
      tracker.setTxHash(opCtx, chain.txHash, chainId ? Number(chainId) : undefined);
    }
    tracker.complete(opCtx, { tripleCount: result?.kaManifest?.length ?? 0 });
    return result;
  } catch (err) {
    tracker.fail(opCtx, err);
    throw err;
  }
}

async function ensureRegisteredForNamedPublish(
  ctx: RequestContext,
  contextGraphId: string,
  opCtx: OperationContext,
): Promise<void> {
  const { agent, tracker, requestToken } = ctx;
  const existingOnChainId = await agent.getContextGraphOnChainId(contextGraphId);
  if (existingOnChainId) return;

  if (
    typeof agent.hasPendingSharedMemoryWrites === "function" &&
    !agent.hasPendingSharedMemoryWrites(contextGraphId)
  ) {
    throw new Error(
      `Context graph "${contextGraphId}" has no pending shared-memory writes — ` +
      "nothing to publish to Verified Memory. Stage entities into SWM first, then retry publish.",
    );
  }

  const storedOpts = await agent.getStoredContextGraphRegistrationOptions(contextGraphId);
  const tokenAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
  try {
    await tracker.trackPhase(opCtx, "register-on-chain", () =>
      agent.registerContextGraph(contextGraphId, {
        ...(tokenAgentAddress ? { callerAgentAddress: tokenAgentAddress } : {}),
        ...(storedOpts.publishPolicy !== undefined ? { publishPolicy: storedOpts.publishPolicy } : {}),
        ...(storedOpts.publishAuthorityAccountId !== undefined
          ? { publishAuthorityAccountId: storedOpts.publishAuthorityAccountId }
          : {}),
      }),
    );
  } catch (regErr: any) {
    throw new Error(
      `Context graph "${contextGraphId}" could not be auto-registered on-chain before publish: ` +
      `${regErr?.message ?? String(regErr)}`,
    );
  }
}

function emitPublished(
  ctx: RequestContext,
  contextGraphId: string,
  result: any,
  subGraphName?: string,
  clearSharedMemoryAfter = false,
): void {
  const publicTripleCount = Array.isArray(result?.publicQuads) ? result.publicQuads.length : 0;
  const rootCount = Array.isArray(result?.kaManifest) ? result.kaManifest.length : 0;
  const publishedSwmCleaned = result?.status === "confirmed";
  ctx.emitMemoryGraphChanged?.({
    contextGraphId,
    layers: publishedSwmCleaned ? ["swm", "vm"] : ["vm"],
    subGraphName,
    operation: "shared_memory_published",
    source: "api",
    clearSharedMemoryAfter,
    status: typeof result?.status === "string" ? result.status : undefined,
    counts: { roots: rootCount, triples: publicTripleCount },
  });
  // Attribute the activity to the actual seal author the publisher signed for
  // (pre-signed / delegated / admin-as-agent flows), not the request token.
  // Falls back to the request agent when the result carries no seal author.
  const sealAuthorAddress =
    typeof result?.seal?.authorAddress === "string" ? result.seal.authorAddress : undefined;
  recordActivity(ctx, contextGraphId, "published", {
    subGraphName,
    actorAgentAddress: sealAuthorAddress,
    tripleCount: publicTripleCount,
    entityCount: rootCount,
  });
}

export async function handleKnowledgeAssetsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, url, requestToken, requestAgentAddress, emitMemoryGraphChanged } = ctx;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
  const method = req.method ?? "GET";
  const writePreflightCallerAgentAddress = requestToken
    ? agent.resolveAgentByToken(requestToken)
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };

  // ── POST /api/knowledge-assets — create KA + open WM draft (atomic shortcut) ──
  if (method === "POST" && path === PREFIX) {
    const parsed = safeParseJson(await readBody(req), res);
    if (!parsed) return;
    const { contextGraphId, name, subGraphName, quads, alsoShareSwm, alsoPublishVm } = parsed;
    if (!name) return jsonResponse(res, 400, { error: 'Missing "contextGraphId" or "name"' });
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      contextGraphId,
      res,
      writePreflightContextGraphOpts,
    );
    if (!resolvedContextGraphId) return;
    if (typeof name !== "string") return jsonResponse(res, 400, { error: '"name" must be a string' });
    const nameVal = validateAssertionName(name);
    if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid "name": ${nameVal.reason}` });
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    if (quads !== undefined && (!Array.isArray(quads) || quads.length === 0)) {
      return jsonResponse(res, 400, { error: '"quads" must be a non-empty array when supplied' });
    }
    // Type-check the opt-in flags before they are consumed by truthiness —
    // otherwise `{"alsoShareSwm":"false"}` would leak into SWM and
    // `{"alsoPublishVm":"x"}` would spend TRAC. `alsoPublishVm` also accepts an
    // inline publish-options OBJECT (its supported control surface); a boolean
    // is the "publish with defaults" form.
    if (alsoShareSwm !== undefined && typeof alsoShareSwm !== "boolean") {
      return jsonResponse(res, 400, { error: '"alsoShareSwm" must be a boolean' });
    }
    const alsoPublishVmIsObject =
      typeof alsoPublishVm === "object" && alsoPublishVm !== null && !Array.isArray(alsoPublishVm);
    if (alsoPublishVm !== undefined && typeof alsoPublishVm !== "boolean" && !alsoPublishVmIsObject) {
      return jsonResponse(res, 400, {
        error: '"alsoPublishVm" must be a boolean or an inline publish-options object',
      });
    }
    // Validate the opt-in layer-transition combinations BEFORE create, so a
    // deterministically-invalid request never leaves durable partial state.
    // A tail needs something to finalize (quads), and publish reads from SWM
    // only — so it must be preceded by a share.
    const hasQuads = Array.isArray(quads) && quads.length > 0;
    if ((alsoShareSwm || alsoPublishVm) && !hasQuads) {
      return jsonResponse(res, 400, {
        error:
          '"alsoShareSwm"/"alsoPublishVm" require "quads" — there is nothing to finalize, share, or publish otherwise',
      });
    }
    if (alsoPublishVm && !alsoShareSwm) {
      return jsonResponse(res, 400, {
        error:
          '"alsoPublishVm" requires "alsoShareSwm" — publishFromFinalizedAssertion reads from Shared Memory, so the assertion must be shared first',
      });
    }
    if (alsoPublishVmIsObject && !validateFinalizedAssertionPublishRequest(alsoPublishVm as Record<string, unknown>, res)) {
      return;
    }
    const finalizeOptions = resolveFinalizeOptions(ctx, parsed);
    if (finalizeOptions === null) return;
    // Coerce/validate publish controls up front too — bad option values 400
    // before any assertion is created rather than after a durable seal.
    let atomicPublishOptions: Record<string, unknown> = {};
    if (alsoPublishVm) {
      const publishOptionsInput = alsoPublishVmIsObject
        ? finalizedPublishOptionsInput(alsoPublishVm as Record<string, unknown>, res)
        : alsoPublishVm;
      if (publishOptionsInput === null) return;
      const resolvedAtomicPublishOptions = resolveFinalizedPublishOptions(ctx, publishOptionsInput);
      if (resolvedAtomicPublishOptions === null) return;
      atomicPublishOptions = resolvedAtomicPublishOptions;
    }
    try {
      const assertionUri = await agent.assertion.create(
        resolvedContextGraphId,
        name,
        subGraphName ? { subGraphName } : undefined,
      );
      emitMemoryGraphChanged?.({
        contextGraphId: resolvedContextGraphId,
        layers: ["wm"],
        subGraphName,
        operation: "assertion_created",
        source: "api",
        counts: { triples: 0 },
      });
      const finalizeActorAddress = actorFromFinalizeOptions(finalizeOptions);
      recordActivity(ctx, resolvedContextGraphId, "created", {
        subGraphName,
        actorAgentAddress: finalizeActorAddress ?? requestAgentAddress,
      });
      const result: Record<string, unknown> = { name, assertionUri, status: "draft-open" };

      // autoFinalize: when quads are supplied, write + seal in the same call
      // (OT-RFC-43 §10.5.5). `also*` are opt-in layer transitions on top.
      if (Array.isArray(quads) && quads.length > 0) {
        try {
          await agent.assertion.write(
            resolvedContextGraphId,
            name,
            quads,
            subGraphName ? { subGraphName } : undefined,
          );
          emitMemoryGraphChanged?.({
            contextGraphId: resolvedContextGraphId,
            layers: ["wm"],
            subGraphName,
            operation: "assertion_written",
            source: "api",
            counts: { triples: quads.length },
          });
          result.written = quads.length;
          result.status = "wm-written";
          const seal = await agent.assertion.finalize(resolvedContextGraphId, name, {
            ...(subGraphName ? { subGraphName } : {}),
            ...finalizeOptions,
          });
          emitMemoryGraphChanged?.({
            contextGraphId: resolvedContextGraphId,
            layers: ["wm"],
            subGraphName,
            operation: "assertion_finalized",
            source: "api",
          });
          Object.assign(result, serializeSeal(seal));
          result.status = "wm-sealed";
        } catch (e: any) {
          const phase = result.written === quads.length ? "wm-finalize" : "wm-write";
          return jsonResponse(res, 207, {
            created: true,
            ...result,
            errors: [{ phase, error: e?.message ?? String(e) }],
          });
        }
      }

      const errors: Array<{ phase: string; error: string }> = [];
      if (alsoShareSwm) {
        try {
          const share = await agent.assertion.promote(
            resolvedContextGraphId,
            name,
            subGraphName ? { subGraphName } : undefined,
          );
          result.swmShared = true;
          result.promotedCount = share.promotedCount;
          result.status = "swm-shared";
          if (share.promotedCount !== 0) {
            emitMemoryGraphChanged?.({
              contextGraphId: resolvedContextGraphId,
              layers: ["wm", "swm"],
              subGraphName,
              operation: "assertion_promoted",
              source: "api",
              counts: { triples: share.promotedCount },
            });
            recordActivity(ctx, resolvedContextGraphId, "promoted", {
              subGraphName,
              actorAgentAddress: finalizeActorAddress ?? requestAgentAddress,
              tripleCount: share.promotedCount,
            });
          }
        } catch (e: any) {
          errors.push({ phase: "swm-share", error: e?.message ?? String(e) });
        }
      }
      if (alsoPublishVm && result.swmShared === true) {
        try {
          // codex PR #971 F22: the atomic-create publish tail records into
          // the same operation-tracker timeline as `/api/shared-memory/publish`
          // and `/vm/publish`, so dashboards never lose visibility on a
          // publish just because the caller chose the atomic surface.
          const pub: any = await publishWithTracker(ctx, resolvedContextGraphId, name, {
            subGraphName,
            publishOptions: atomicPublishOptions,
          });
          result.kaId = pub?.kaId;
          result.ual = pub?.ual;
          result.txHash = pub?.onChainResult?.txHash;
          result.vmStatus = pub?.status;
          if (pub?.contextGraphError) result.contextGraphError = pub.contextGraphError;
          emitPublished(
            ctx,
            resolvedContextGraphId,
            pub,
            subGraphName,
            clearSharedMemoryAfterForNamedPublish(atomicPublishOptions),
          );
          // `publishFromFinalizedAssertion` can return `tentative`/`failed` or a
          // `contextGraphError` WITHOUT throwing. Only claim a confirmed VM
          // publish when the publisher actually confirms; otherwise reflect the
          // real status and record it as a partial failure so the response is a
          // 207 over the (real, retryable) sealed+shared artifact, not a false 201.
          if (pub?.status === "confirmed" && !pub?.contextGraphError) {
            result.status = "vm-confirmed";
          } else {
            result.status = `vm-${typeof pub?.status === "string" ? pub.status : "unconfirmed"}`;
            errors.push({
              phase: "vm-publish",
              error: pub?.contextGraphError
                ? `contextGraphError: ${typeof pub.contextGraphError === "string" ? pub.contextGraphError : JSON.stringify(pub.contextGraphError)}`
                : `publish not confirmed (status: ${pub?.status ?? "unknown"})`,
            });
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
      if (routeError(res, e)) return;
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  // ── /api/knowledge-assets/:name[/{wm,swm,vm}[/verb]] ──
  const rawSegs = path.slice(`${PREFIX}/`.length).split("/");
  const segs: string[] = [];
  for (const rawSeg of rawSegs) {
    if (rawSeg === "") return;
    const decoded = safeDecodeURIComponent(rawSeg, res);
    if (decoded === null) return;
    segs.push(decoded);
  }
  if (segs.length === 0) return;
  const name = segs[0];
  const nameVal = validateAssertionName(name);
  if (!nameVal.valid) return jsonResponse(res, 400, { error: `Invalid "name": ${nameVal.reason}` });
  const layer = segs[1]; // wm | swm | vm | undefined
  const verb = segs[2];

  // GET /api/knowledge-assets/:name — KA metadata / lifecycle state
  if (method === "GET" && segs.length === 1) {
    const cg = url.searchParams.get("contextGraphId");
    if (!validateRequiredContextGraphId(cg, res)) return;
    const normalizedContextGraphId = normalizeContextGraphIdOrUri(cg!);
    const rawAgentAddress = url.searchParams.get("agentAddress") ?? undefined;
    if (rawAgentAddress && !/^[\w:.\-]+$/.test(rawAgentAddress)) {
      return jsonResponse(res, 400, { error: "Invalid agentAddress format" });
    }
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const resolvedAgentAddress = rawAgentAddress
        ?? await resolveAssertionOwnerAgentAddress(agent, normalizedContextGraphId, name, subGraphName);
      const hist = await agent.assertion.history(
        normalizedContextGraphId,
        name,
        resolvedAgentAddress || subGraphName
          ? {
              ...(resolvedAgentAddress ? { agentAddress: resolvedAgentAddress } : {}),
              ...(subGraphName ? { subGraphName } : {}),
            }
          : undefined,
      );
      if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}" in context graph "${normalizedContextGraphId}"` });
      return jsonResponse(res, 200, hist);
    } catch (e: any) {
      if (routeError(res, e)) return;
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  if (method !== "POST") return;

  // Guard the supported (layer, verb) POST shapes BEFORE reading/validating the
  // body, so an unknown shape (e.g. `/:name/foo/bar`) falls through to the
  // daemon's 404 instead of returning a body-dependent 400/500. `pull-from` is
  // a known shape (returns 501 below), so it stays in the supported set.
  //
  // codex PR #971 F20: require the EXACT segment count for each known POST
  // shape. Without the `segs.length === 3` guard, a path like
  // `/api/knowledge-assets/foo/vm/publish/extra` still matched
  // `(layer="vm", verb="publish")` and ran the publish side effect instead
  // of falling through to the daemon's 404. Every currently-supported POST
  // shape is `<name>/<layer>/<verb>` (3 segments after the prefix); when
  // future shapes add their own depth they will need their own segment
  // count too.
  const isSupportedPostShape =
    segs.length === 3 &&
    ((layer === "wm" && (verb === "write" || verb === "finalize" || verb === "discard" || verb === "pull-from")) ||
      (layer === "swm" && verb === "share") ||
      (layer === "vm" && verb === "publish"));
  if (!isSupportedPostShape) return;

  if (layer === "wm" && verb === "pull-from") {
    // Net-new primitive (the git-checkout equivalent): seed a fresh WM
    // draft from the current SWM or VM state, with onConflict semantics
    // for a dirty draft. Implemented in a focused follow-up — it needs the
    // per-layer entity-scoped gather + conflict handling (OT-RFC-43 §10.5.3).
    //
    // Short-circuit before body/context validation so feature probes always
    // receive the advertised 501, even with malformed JSON or a stale CG id.
    return jsonResponse(res, 501, {
      error: "wm/pull-from is not implemented yet (OT-RFC-43 §10.5.3 — follow-up)",
      layer,
    });
  }

  // codex PR #971 F21: pick the body-size cap up front from the matched
  // shape so control verbs do not silently inherit the 10 MB default.
  const verbMaxBytes = postShapeMaxBytes(layer, verb);
  const parsed = safeParseJson(await readBody(req, verbMaxBytes), res);
  if (!parsed) return;
  const contextGraphId = parsed.contextGraphId;
  const subGraphName = parsed.subGraphName;
  const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
    agent,
    contextGraphId,
    res,
    writePreflightContextGraphOpts,
  );
  if (!resolvedContextGraphId) return;
  if (!validateOptionalSubGraphName(subGraphName, res)) return;

  try {
    // ── WM verbs (the only writable layer) ──
    if (layer === "wm") {
      if (verb === "write") {
        if (!Array.isArray(parsed.quads) || parsed.quads.length === 0) {
          return jsonResponse(res, 400, { error: 'Missing "quads"' });
        }
        await agent.assertion.write(
          resolvedContextGraphId,
          name,
          parsed.quads,
          subGraphName ? { subGraphName } : undefined,
        );
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm"],
          subGraphName,
          operation: "assertion_written",
          source: "api",
          counts: { triples: parsed.quads.length },
        });
        return jsonResponse(res, 200, { written: parsed.quads.length });
      }
      if (verb === "finalize") {
        const finalizeOptions = resolveFinalizeOptions(ctx, parsed);
        if (finalizeOptions === null) return;
        const seal = await agent.assertion.finalize(resolvedContextGraphId, name, {
          ...(subGraphName ? { subGraphName } : {}),
          ...finalizeOptions,
        });
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm"],
          subGraphName,
          operation: "assertion_finalized",
          source: "api",
        });
        return jsonResponse(res, 200, serializeSeal(seal));
      }
      if (verb === "discard") {
        await agent.assertion.discard(
          resolvedContextGraphId,
          name,
          subGraphName ? { subGraphName } : undefined,
        );
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm"],
          subGraphName,
          operation: "assertion_discarded",
          source: "api",
        });
        return jsonResponse(res, 200, { discarded: true });
      }
      if (verb === "pull-from") {
        return jsonResponse(res, 501, {
          error: "wm/pull-from is not implemented yet (OT-RFC-43 §10.5.3 — follow-up)",
          layer,
        });
      }
    }

    // ── SWM verb: share (WM → SWM; OT-RFC-43 §10.6 renames promote → share) ──
    if (layer === "swm" && verb === "share") {
      if (!validateEntities(parsed.entities, res)) return;
      const share = await agent.assertion.promote(resolvedContextGraphId, name, {
        entities: parsed.entities ?? "all",
        subGraphName,
      });
      if (share.promotedCount !== 0) {
        const sealAuthorAddress = await sealedAuthorFromAssertionHistory(
          ctx,
          resolvedContextGraphId,
          name,
          subGraphName,
        );
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ["wm", "swm"],
          subGraphName,
          operation: "assertion_promoted",
          source: "api",
          counts: { triples: share.promotedCount },
        });
        recordActivity(ctx, resolvedContextGraphId, "promoted", {
          subGraphName,
          actorAgentAddress: sealAuthorAddress,
          tripleCount: share.promotedCount,
        });
      }
      return jsonResponse(res, 200, { swmShared: true, promotedCount: share.promotedCount });
    }

    // ── VM verb: publish (SWM/WM → VM; mint or update on chain) ──
    if (layer === "vm" && verb === "publish") {
      if (!validateFinalizedAssertionPublishRequest(parsed, res)) return;
      const optionsInput = finalizedPublishOptionsInput(parsed, res);
      if (optionsInput === null) return;
      const opts = resolveFinalizedPublishOptions(ctx, optionsInput);
      if (opts === null) return;
      // codex PR #971 F22: mirror the legacy operation-tracker dance from
      // `/api/shared-memory/publish` so the daemon's operation history
      // records progress / tx-hash / cost for KA publishes too.
      const pub: any = await publishWithTracker(ctx, resolvedContextGraphId, name, {
        subGraphName,
        publishOptions: opts,
      });
      emitPublished(ctx, resolvedContextGraphId, pub, subGraphName, clearSharedMemoryAfterForNamedPublish(opts));
      // Mirror the atomic path: non-throwing tentative/failed/contextGraphError
      // results are partial successes, not confirmed publishes.
      const httpStatus = pub?.status === "confirmed" && !pub?.contextGraphError ? 200 : 207;
      return jsonResponse(res, httpStatus, publishResponsePayload(pub));
    }
  } catch (e: any) {
    if (routeError(res, e)) return;
    return jsonResponse(res, 500, { error: e?.message ?? String(e) });
  }

  // Unmatched under the prefix — fall through to the daemon's 404.
}
