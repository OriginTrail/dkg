// V2 Stage-3 — POST /api/metering/read : the capability-authenticated read.
//
// Deliberately a SEPARATE route from /api/query rather than a flag on it.
// /api/query authenticates by bearer token and bills the token holder; this
// route authenticates by delegation and bills the delegation's tabPrincipal.
// Those are different trust models, and merging them behind one path is how a
// caller ends up billed for someone else's read — or, as the provider front
// would have done, how the provider bills itself.
//
// The route never trusts:
//   * the transport token for identity (it is the front's, not the buyer's);
//   * a caller-supplied wallet key (anchored from proof/registry instead);
//   * its own leg as settled (the buyer countersigns, D14).
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { createHash } from "node:crypto";
import { loadMeterConfig, canonicalize } from "../metering/ledger.js";
import { COEFFICIENTS_CANONICAL } from "../metering/read-meter.js";
import { authoriseMeteredRead, settleMeteredRead, countersignLeg, withholdLeg } from "../metering/metered-read.js";
import type { CapabilityState } from "../metering/capability.js";
import { chainIdOf } from "./metering.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

// Home-keyed, like the ledger: a Stage-1 home and production must never share
// capability state. (Learned the hard way when module-global balances leaked
// across DKG_HOMEs.)
const capStates = new Map<string, Map<string, CapabilityState>>();
function capState(home: string, id: string): CapabilityState {
  if (!capStates.has(home)) capStates.set(home, new Map());
  const m = capStates.get(home)!;
  if (!m.has(id)) m.set(id, { spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
  return m.get(id)!;
}



export async function handleMeteredQueryRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, agent } = ctx;
  if (path !== "/api/metering/read" && path !== "/api/metering/countersign" && path !== "/api/metering/withhold") return;
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "E_METHOD" });

  const home = meterHome();
  const cfg = loadMeterConfig(home);
  const scheduleDigest = sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>));

  let body: Record<string, any>;
  try { body = JSON.parse((await readBody(req, SMALL_BODY_BYTES)) || "{}"); }
  catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }

  // ── POST /api/metering/countersign ─────────────────────────────────────
  if (path === "/api/metering/countersign") {
    if (!body.leg || !body.countersignature || !body.sessionPublicKeyPem) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["leg", "countersignature", "sessionPublicKeyPem"] });
    }
    const r = countersignLeg({
      home, leg: body.leg, countersignature: body.countersignature, sessionPublicKeyPem: body.sessionPublicKeyPem,
    });
    return jsonResponse(res, r.ok ? 200 : 403, {
      settleable: r.ok, code: r.code,
      note: r.ok ? "Leg is now admissible for settlement." : "Leg remains a provider claim, not a settled payment.",
    });
  }

  // ── POST /api/metering/withhold ────────────────────────────────────────
  // The buyer's authenticated ONE-per-epoch dispute (billed-run block fix):
  // adjudicates a served leg as withheld — void from the provider claim,
  // excluded from the envelope aggregate, and RELEASING gradual release so the
  // run continues. Verified against the session key bound to the leg, under a
  // domain distinct from countersign.
  if (path === "/api/metering/withhold") {
    if (!body.leg || !body.withholdSignature || !body.sessionPublicKeyPem) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["leg", "withholdSignature", "sessionPublicKeyPem"] });
    }
    const r = withholdLeg({
      home, leg: body.leg, withholdSignature: body.withholdSignature, sessionPublicKeyPem: body.sessionPublicKeyPem,
    });
    return jsonResponse(res, r.ok ? 200 : 403, {
      withheld: r.ok, code: r.code,
      note: r.ok ? "Leg adjudicated as withheld: void from the provider claim; the run may continue." : "Withhold refused; the leg's status is unchanged.",
    });
  }

  // ── POST /api/metering/read ────────────────────────────────────────────
  const chainId = chainIdOf(ctx);
  if (chainId === null || !Number.isFinite(chainId)) {
    return jsonResponse(res, 503, { error: "E_CHAIN_UNRESOLVED" });
  }
  if (typeof body.sparql !== "string" || !body.sparql.trim()) {
    return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["sparql"] });
  }
  if (!body.delegation?.capabilityId) {
    return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["delegation"] });
  }

  const state = capState(home, body.delegation.capabilityId);
  const auth = authoriseMeteredRead({
    home, chainId, cfg,
    request: {
      delegation: body.delegation,
      bindingProof: body.bindingProof,
      sparql: body.sparql,
      contextGraphId: body.contextGraphId,
      view: body.view,
      maxMicroTrac: body.maxMicroTrac,
      revocationCheckpoint: body.revocationCheckpoint,
    },
    state,
    route: "POST /api/metering/read",
    nodeClass: body.nodeClass ?? "dkg-edge-mainnet",
    settlementId: body.settlementId ?? "settle-main",
    scheduleDigest,
    priceVectorDigest: body.priceVectorDigest ?? scheduleDigest,
  });
  if (!auth.ok) return jsonResponse(res, auth.status, { error: auth.code, detail: auth.detail });

  // Authorised. Execute the read as the DELEGATION's principal, never as the
  // transport identity — the caller cannot widen its own scope by holding a
  // more privileged token.
  const t0 = Date.now();
  let result: unknown;
  try {
    result = await (agent as unknown as { query: (q: string, o: unknown) => Promise<unknown> }).query(body.sparql, {
      contextGraphId: body.contextGraphId,
      view: body.view,
      callerAgentAddress: auth.principal,
      source: "metered-read",
    });
  } catch (e: unknown) {
    return jsonResponse(res, 400, { error: "E_QUERY_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }
  const responseBody = JSON.stringify(result ?? {});

  const outcome = settleMeteredRead({
    home, cfg,
    principal: auth.principal,
    requesterKeyRef: body.delegation.sessionPublicKeyPem ? "sha256:" + sha256(body.delegation.sessionPublicKeyPem) : undefined,
    sparql: body.sparql,
    responseBody,
    scopeQuads: Number(body.scopeQuads ?? 0),
    contextGraphId: body.contextGraphId,
    view: body.view,
    maxMicroTrac: body.maxMicroTrac,
    wallMs: Date.now() - t0,
  });
  if (!outcome.ok) return jsonResponse(res, outcome.status, { error: outcome.code, detail: outcome.detail });

  // The result is returned even when billing is in shadow, but the response
  // states plainly whether anything was billed. A buyer must never have to
  // infer that from the presence of a field.
  state.sequence += 1;
  return jsonResponse(res, 200, {
    result,
    metering: {
      principal: outcome.principal,
      bindingMode: auth.bindingMode,
      billed: outcome.billed,
      costMicroTrac: outcome.costMicroTrac,
      tab: outcome.tab,
      settlement: outcome.settlement,
      leg: outcome.leg,
    },
  });
}
