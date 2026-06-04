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
import { validateAssertionName } from "@origintrail-official/dkg-core";
import { validatePreSignedAuthorAttestation } from "./memory.js";
import { recordAssertionActivity } from "../activity-notification.js";
import {
  jsonResponse,
  normalizeContextGraphIdOrUri,
  readBody,
  resolveRequiredWriteContextGraphId,
  safeDecodeURIComponent,
  safeParseJson,
  validateEntities,
  validateOptionalSubGraphName,
  validateRequiredContextGraphId,
} from "../http-utils.js";

const PREFIX = "/api/knowledge-assets";

function hex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
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
    message.includes("not registered") ||
    message.includes("mutually exclusive") ||
    message.includes("not a registered local agent") ||
    message.includes("signer mismatch") ||
    message.includes("has no quads") ||
    message.includes("different merkleRoot") ||
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

function normalizeFinalizedPublishOptions(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { clearAfter, clearSharedMemoryAfter, ...rest } = raw as Record<string, unknown>;
  return {
    ...rest,
    ...(clearAfter !== undefined
      ? { clearSharedMemoryAfter: clearAfter }
      : clearSharedMemoryAfter !== undefined
        ? { clearSharedMemoryAfter }
        : {}),
  };
}

function clearSharedMemoryAfterForNamedPublish(opts: Record<string, unknown>): boolean {
  return typeof opts.clearSharedMemoryAfter === "boolean" ? opts.clearSharedMemoryAfter : false;
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
  recordActivity(ctx, contextGraphId, "published", {
    subGraphName,
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
    const finalizeOptions = resolveFinalizeOptions(ctx, parsed);
    if (finalizeOptions === null) return;
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
      recordActivity(ctx, resolvedContextGraphId, "created", {
        subGraphName,
        actorAgentAddress:
          typeof finalizeOptions.authorAgentAddress === "string"
            ? finalizeOptions.authorAgentAddress
            : requestAgentAddress,
      });
      const result: Record<string, unknown> = { name, assertionUri, status: "draft-open" };

      // autoFinalize: when quads are supplied, write + seal in the same call
      // (OT-RFC-43 §10.5.5). `also*` are opt-in layer transitions on top.
      if (Array.isArray(quads) && quads.length > 0) {
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
        result.merkleRoot = hex(seal.merkleRoot);
        result.status = "wm-sealed";
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
              tripleCount: share.promotedCount,
            });
          }
        } catch (e: any) {
          errors.push({ phase: "swm-share", error: e?.message ?? String(e) });
        }
      }
      if (alsoPublishVm) {
        try {
          const opts = normalizeFinalizedPublishOptions(alsoPublishVm);
          const pub: any = await agent.publishFromFinalizedAssertion(resolvedContextGraphId, name, {
            ...(subGraphName ? { subGraphName } : {}),
            ...opts,
          });
          result.kaId = pub?.kaId;
          result.ual = pub?.ual;
          result.txHash = pub?.onChainResult?.txHash;
          result.status = "vm-confirmed";
          emitPublished(ctx, resolvedContextGraphId, pub, subGraphName, clearSharedMemoryAfterForNamedPublish(opts));
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
  const rawSegs = path.slice(`${PREFIX}/`.length).split("/").filter(Boolean);
  const segs: string[] = [];
  for (const rawSeg of rawSegs) {
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
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const hist = await agent.assertion.history(
        normalizedContextGraphId,
        name,
        subGraphName ? { subGraphName } : undefined,
      );
      if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}" in context graph "${normalizedContextGraphId}"` });
      return jsonResponse(res, 200, hist);
    } catch (e: any) {
      if (routeError(res, e)) return;
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  // GET /api/knowledge-assets/:name/{wm,swm,vm} — per-layer status
  if (method === "GET" && (layer === "wm" || layer === "swm" || layer === "vm") && !verb) {
    const cg = url.searchParams.get("contextGraphId");
    if (!validateRequiredContextGraphId(cg, res)) return;
    const normalizedContextGraphId = normalizeContextGraphIdOrUri(cg!);
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    if (!validateOptionalSubGraphName(subGraphName, res)) return;
    try {
      const hist = await agent.assertion.history(
        normalizedContextGraphId,
        name,
        subGraphName ? { subGraphName } : undefined,
      );
      if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}"` });
      return jsonResponse(res, 200, { layer, ...hist });
    } catch (e: any) {
      if (routeError(res, e)) return;
      return jsonResponse(res, 500, { error: e?.message ?? String(e) });
    }
  }

  if (method !== "POST") return;

  const parsed = safeParseJson(await readBody(req), res);
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
        return jsonResponse(res, 200, { merkleRoot: hex(seal.merkleRoot), eip712Digest: seal.eip712Digest });
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
        // Net-new primitive (the git-checkout equivalent): seed a fresh WM
        // draft from the current SWM or VM state (OT-RFC-43 §10.5.3).
        const sourceLayer = parsed.layer;
        if (sourceLayer !== "swm" && sourceLayer !== "vm") {
          return jsonResponse(res, 400, { error: 'pull-from requires "layer": "swm" | "vm"' });
        }
        const onConflict = parsed.onConflict === "replace" ? "replace" : "reject";
        try {
          const result = await agent.assertion.pullFrom(resolvedContextGraphId, name, sourceLayer, { subGraphName, onConflict });
          emitMemoryGraphChanged?.({
            contextGraphId: resolvedContextGraphId,
            layers: ["wm"],
            subGraphName,
            operation: "assertion_pull_from",
            source: "api",
            counts: { triples: result.seeded, roots: result.entities },
          });
          return jsonResponse(res, 200, { wmDraft: "open", seededFrom: { layer: sourceLayer }, ...result });
        } catch (e: any) {
          if (e?.code === "WM_DRAFT_CONFLICT") {
            return jsonResponse(res, 409, { code: "WM_DRAFT_CONFLICT", error: e.message });
          }
          if (e?.code === "PULL_FROM_EMPTY_SOURCE") {
            return jsonResponse(res, 409, { code: "PULL_FROM_EMPTY_SOURCE", error: e.message });
          }
          if (e?.code === "PULL_FROM_UNFINALIZED_ASSERTION") {
            return jsonResponse(res, 409, { code: "PULL_FROM_UNFINALIZED_ASSERTION", error: e.message });
          }
          if (e?.code === "PULL_FROM_INVALID_SEAL") {
            return jsonResponse(res, 409, { code: "PULL_FROM_INVALID_SEAL", error: e.message });
          }
          throw e; // -> outer catch -> 500
        }
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
          tripleCount: share.promotedCount,
        });
      }
      return jsonResponse(res, 200, { swmShared: true, promotedCount: share.promotedCount });
    }

    // ── VM verb: publish (SWM/WM → VM; mint or update on chain) ──
    if (layer === "vm" && verb === "publish") {
      const opts = normalizeFinalizedPublishOptions(parsed.options);
      const pub: any = await agent.publishFromFinalizedAssertion(resolvedContextGraphId, name, {
        ...(subGraphName ? { subGraphName } : {}),
        ...opts,
      });
      emitPublished(ctx, resolvedContextGraphId, pub, subGraphName, clearSharedMemoryAfterForNamedPublish(opts));
      return jsonResponse(res, 200, {
        kaId: pub?.kaId,
        status: pub?.status,
        ual: pub?.ual,
        txHash: pub?.onChainResult?.txHash,
      });
    }
  } catch (e: any) {
    if (routeError(res, e)) return;
    return jsonResponse(res, 500, { error: e?.message ?? String(e) });
  }

  // Unmatched under the prefix — fall through to the daemon's 404.
}
