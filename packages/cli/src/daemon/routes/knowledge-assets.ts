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
import { jsonResponse, readBody, safeParseJson } from "../http-utils.js";
import { validatePreSignedAuthorAttestation } from "./memory.js";

const PREFIX = "/api/knowledge-assets";
const FINALIZE_ONLY_CREATE_FIELDS = [
  "authorAgentAddress",
  "preSignedAuthorAttestation",
  "schemeVersion",
] as const;

function hex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
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
    | { address: string; signature: { r: Uint8Array; vs: Uint8Array } }
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

export async function handleKnowledgeAssetsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, url } = ctx;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
  const method = req.method ?? "GET";

  // ── POST /api/knowledge-assets — create KA + open WM draft (atomic shortcut) ──
  if (method === "POST" && path === PREFIX) {
    const parsed = safeParseJson(await readBody(req), res);
    if (!parsed) return;
    const {
      contextGraphId,
      name,
      subGraphName,
      quads,
      authorAgentAddress,
      preSignedAuthorAttestation,
      schemeVersion,
      alsoShareSwm,
      alsoPublishVm,
    } = parsed;
    if (!contextGraphId || !name) {
      return jsonResponse(res, 400, { error: 'Missing "contextGraphId" or "name"' });
    }
    const shouldAutoFinalize = Array.isArray(quads) && quads.length > 0;
    if (!shouldAutoFinalize && hasFinalizeOnlyCreateFields(parsed)) {
      return jsonResponse(res, 400, {
        error: '"authorAgentAddress", "preSignedAuthorAttestation", and "schemeVersion" require non-empty "quads"',
      });
    }
    const finalizeOptions = shouldAutoFinalize
      ? resolveFinalizeOptions({ subGraphName, authorAgentAddress, preSignedAuthorAttestation, schemeVersion }, res)
      : {};
    if (finalizeOptions === null) return;
    try {
      const assertionUri = await agent.assertion.create(contextGraphId, name, { subGraphName });
      const result: Record<string, unknown> = { name, assertionUri, status: "draft-open" };

      // autoFinalize: when quads are supplied, write + seal in the same call
      // (OT-RFC-43 §10.5.5). `also*` are opt-in layer transitions on top.
      if (shouldAutoFinalize) {
        await agent.assertion.write(contextGraphId, name, quads, { subGraphName });
        result.written = quads.length;
        const seal = await agent.assertion.finalize(contextGraphId, name, finalizeOptions);
        result.merkleRoot = hex(seal.merkleRoot);
        result.status = "wm-sealed";
      }

      const errors: Array<{ phase: string; error: string }> = [];
      if (alsoShareSwm) {
        try {
          const share = await agent.assertion.promote(contextGraphId, name, { subGraphName });
          result.swmShared = true;
          result.promotedCount = share.promotedCount;
          result.status = "swm-shared";
        } catch (e: any) {
          errors.push({ phase: "swm-share", error: e?.message ?? String(e) });
        }
      }
      if (alsoPublishVm) {
        try {
          const opts = typeof alsoPublishVm === "object" && alsoPublishVm ? alsoPublishVm : {};
          const pub: any = await agent.publishFromFinalizedAssertion(contextGraphId, name, { subGraphName, ...opts });
          result.kaId = pub?.kaId;
          result.ual = pub?.ual;
          result.txHash = pub?.onChainResult?.txHash;
          result.status = "vm-confirmed";
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

  // GET /api/knowledge-assets/:name — KA metadata / lifecycle state
  if (method === "GET" && segs.length === 1) {
    const cg = url.searchParams.get("contextGraphId");
    if (!cg) return jsonResponse(res, 400, { error: 'Missing "contextGraphId" query param' });
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    const hist = await agent.assertion.history(cg, name, { subGraphName });
    if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}" in context graph "${cg}"` });
    return jsonResponse(res, 200, hist);
  }

  // GET /api/knowledge-assets/:name/{wm,swm,vm} — per-layer status
  if (method === "GET" && (layer === "wm" || layer === "swm" || layer === "vm") && !verb) {
    const cg = url.searchParams.get("contextGraphId");
    if (!cg) return jsonResponse(res, 400, { error: 'Missing "contextGraphId" query param' });
    const subGraphName = url.searchParams.get("subGraphName") ?? undefined;
    const hist = await agent.assertion.history(cg, name, { subGraphName });
    if (!hist) return jsonResponse(res, 404, { error: `No knowledge asset "${name}"` });
    return jsonResponse(res, 200, { layer, ...hist });
  }

  if (method !== "POST") return;

  const parsed = safeParseJson(await readBody(req), res);
  if (!parsed) return;
  const contextGraphId = parsed.contextGraphId;
  const subGraphName = parsed.subGraphName;
  if (!contextGraphId) return jsonResponse(res, 400, { error: 'Missing "contextGraphId"' });

  try {
    // ── WM verbs (the only writable layer) ──
    if (layer === "wm") {
      if (verb === "write") {
        if (!Array.isArray(parsed.quads)) return jsonResponse(res, 400, { error: 'Missing "quads"' });
        await agent.assertion.write(contextGraphId, name, parsed.quads, { subGraphName });
        return jsonResponse(res, 200, { written: parsed.quads.length });
      }
      if (verb === "finalize") {
        const finalizeOptions = resolveFinalizeOptions(parsed, res);
        if (finalizeOptions === null) return;
        const seal = await agent.assertion.finalize(contextGraphId, name, finalizeOptions);
        return jsonResponse(res, 200, { merkleRoot: hex(seal.merkleRoot), eip712Digest: seal.eip712Digest });
      }
      if (verb === "discard") {
        await agent.assertion.discard(contextGraphId, name, { subGraphName });
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
      return jsonResponse(res, 200, { swmShared: true, promotedCount: share.promotedCount });
    }

    // ── VM verb: publish (SWM/WM → VM; mint or update on chain) ──
    if (layer === "vm" && verb === "publish") {
      const opts = parsed.options && typeof parsed.options === "object" ? parsed.options : {};
      const pub: any = await agent.publishFromFinalizedAssertion(contextGraphId, name, { subGraphName, ...opts });
      return jsonResponse(res, 200, {
        kaId: pub?.kaId,
        status: pub?.status,
        ual: pub?.ual,
        txHash: pub?.onChainResult?.txHash,
      });
    }
  } catch (e: any) {
    return jsonResponse(res, 500, { error: e?.message ?? String(e) });
  }

  // Unmatched under the prefix — fall through to the daemon's 404.
}
