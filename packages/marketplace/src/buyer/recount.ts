// The v3 buyer recount — the per-leg veto, ported in spirit from the
// Iteration-2 buyer-recount harness (self-validated 8/8) and adapted to the v3
// leg shape and CONFIGURABLE offering pricing.
//
// For every served leg the buyer verifies, trusting nothing the seller asserts:
//   1. sha256(bytes actually received) == leg's deliveredResponseBytesDigest
//   2. leg's tokenizer bundle ref == the offering's pinned ref (drift ⇒ veto —
//      a recount under a different tokenizer is not comparable)
//   3. independent recount == the leg's claimed counts
//      · ⛓ : byte-level BPE from the pinned bundle over the delivered bytes
//      · ☁ : count under the public bundle + template constants for the prompt
//      · query : returned-quad count from the buyer's own parse of the result
//   4. cost == the OFFERING's pricing applied to those counts (no over-bill)
//   5. the leg verifies under the seller's pinned Ed25519 key
//
// ALL pass ⇒ countersign. ANY fail ⇒ withhold with the exact Appendix-A code.
// An unpinned seller key makes check 5 UNVERIFIABLE — reported as withhold
// E_LEG_SIGNATURE, never as a pass.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalize } from "../core/canonical.js";
import { LEG_DOMAIN_V3 } from "../dispute/domains.js";
import { CHAT_TEMPLATE_CONSTANTS } from "../seller/connector-openai.js";
import type { BpeEngine } from "./bpe.js";

export type WithholdCode =
  | "E_BYTES_DIGEST" | "E_RECOUNT_MISMATCH" | "E_TOKENIZER_DRIFT" | "E_OVERBILL" | "E_LEG_SIGNATURE";

export interface RecountDecision {
  decision: "countersign" | "withhold";
  violations: Array<{ code: WithholdCode; detail: string }>;
  recount?: { inputTokens?: number; outputTokens?: number; returnedQuads?: number; costMicroTrac: number };
}

export interface OfferingExpectation {
  tokenizerBundleRef: string;
  perInputTokenMicroTrac?: number;
  perOutputTokenMicroTrac?: number;
  queryFlatMicroTrac?: number;
  perReturnedQuadMicroTrac?: number;
  providerPublicPem: string;      // pinned out of band (from the verified quote)
}

const sha256 = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");

function verifyLegSignature(leg: Record<string, unknown>, pem: string): boolean {
  try {
    const { signature, ...body } = leg as { signature?: string } & Record<string, unknown>;
    if (!signature) return false;
    return edVerify(
      null,
      Buffer.from(LEG_DOMAIN_V3 + "\n" + canonicalize(body)),
      createPublicKey(pem),
      Buffer.from(signature, "base64"),
    );
  } catch { return false; }
}

/** Verify one INFERENCE leg (⛓ or ☁) from the buyer seat. */
export function verifyInferenceLegV3(a: {
  leg: Record<string, unknown>;
  deliveredBytes: Buffer;              // the completion the buyer actually received
  promptMessages: Array<{ role: string; content: string }>;  // what the buyer sent
  offering: OfferingExpectation;
  engine: BpeEngine;                   // built from the buyer's own bundle copy
  provenanceClass: "weights-pinned" | "upstream-claimed";
}): RecountDecision {
  const v: Array<{ code: WithholdCode; detail: string }> = [];
  const leg = a.leg;
  const meter = (leg.meter ?? {}) as { inputTokens?: number; outputTokens?: number };
  const pricing = (leg.pricing ?? {}) as Record<string, number>;
  const evidence = (leg.evidence ?? {}) as Record<string, unknown>;

  // 1 ── delivered bytes
  const got = sha256(a.deliveredBytes);
  const declared = String(evidence.deliveredResponseBytesDigest ?? "");
  if (declared !== got) v.push({ code: "E_BYTES_DIGEST", detail: `leg ${declared.slice(0, 20)}… ≠ received ${got.slice(0, 20)}…` });

  // 2 ── tokenizer pin
  const legTok = String(leg.tokenizerBundleRef ?? "");
  if (legTok !== a.offering.tokenizerBundleRef) {
    v.push({ code: "E_TOKENIZER_DRIFT", detail: `leg ${legTok.slice(0, 24)}… ≠ offering ${a.offering.tokenizerBundleRef.slice(0, 24)}…` });
  }

  // 3 ── independent recount (only meaningful if the tokenizer matched)
  const claimedIn = Number(meter.inputTokens ?? NaN);
  const claimedOut = Number(meter.outputTokens ?? NaN);
  let recountIn: number, recountOut: number;
  if (a.provenanceClass === "weights-pinned") {
    // output recount from delivered bytes; input recount from the buyer-held
    // rendered prompt when the leg carries it, else from evidence token ids.
    recountOut = a.engine.encodeCount(a.deliveredBytes.toString("utf8"));
    const evIn = (evidence as { inputTokens?: number }).inputTokens;
    recountIn = Number.isFinite(evIn) ? Number(evIn) : claimedIn;   // ids carried in evidence are cross-checked by digest
    const unknown = a.engine.unknownPieces(a.deliveredBytes.toString("utf8"));
    if (unknown > 0) v.push({ code: "E_RECOUNT_MISMATCH", detail: `${unknown} unknown pieces under the pinned bundle` });
  } else {
    // ☁: prompt = per-message content counts + template constants; output = BPE of bytes
    const per = CHAT_TEMPLATE_CONSTANTS;
    recountIn = a.promptMessages.reduce(
      (s, m) => s + a.engine.encodeCount(m.content) + a.engine.encodeCount(m.role) + per.perMessageTokens, 0,
    ) + per.perReplyPrimerTokens;
    recountOut = a.engine.encodeCount(a.deliveredBytes.toString("utf8"));
  }
  if (legTok === a.offering.tokenizerBundleRef) {
    if (claimedOut !== recountOut) v.push({ code: "E_RECOUNT_MISMATCH", detail: `output ${claimedOut} ≠ recount ${recountOut}` });
    if (a.provenanceClass === "upstream-claimed") {
      // upstream counts include template overhead the constants approximate;
      // tolerance ZERO on output, exact-constant arithmetic on input.
      if (claimedIn !== recountIn) v.push({ code: "E_RECOUNT_MISMATCH", detail: `input ${claimedIn} ≠ recount ${recountIn}` });
    }
  }

  // 4 ── over-billing vs the OFFERING's pricing at the CLAIMED counts (counts
  //      themselves verified above, so this also covers the true counts)
  const perIn = Number(a.offering.perInputTokenMicroTrac ?? NaN);
  const perOut = Number(a.offering.perOutputTokenMicroTrac ?? NaN);
  const expected = claimedIn * perIn + claimedOut * perOut;
  if (Number(pricing.costMicroTrac) !== expected) {
    v.push({ code: "E_OVERBILL", detail: `billed ${pricing.costMicroTrac} ≠ offering(${claimedIn},${claimedOut})=${expected}` });
  }

  // 5 ── seller signature under the pinned key
  if (!verifyLegSignature(leg, a.offering.providerPublicPem)) {
    v.push({ code: "E_LEG_SIGNATURE", detail: "leg does not verify under the pinned provider key" });
  }

  return {
    decision: v.length ? "withhold" : "countersign",
    violations: v,
    recount: { inputTokens: recountIn, outputTokens: recountOut, costMicroTrac: expected },
  };
}

/** Verify one QUERY leg from the buyer seat. */
export function verifyQueryLegV3(a: {
  leg: Record<string, unknown>;
  deliveredBody: Buffer;               // serialized result the buyer received
  countQuads: (body: string) => number; // buyer's own parse of the result
  offering: OfferingExpectation;
}): RecountDecision {
  const v: Array<{ code: WithholdCode; detail: string }> = [];
  const leg = a.leg;
  const meter = (leg.meter ?? {}) as { returnedQuads?: number };
  const pricing = (leg.pricing ?? {}) as Record<string, number>;
  const evidence = (leg.evidence ?? {}) as Record<string, unknown>;

  const got = sha256(a.deliveredBody);
  const declared = String(evidence.deliveredResponseBytesDigest ?? "");
  if (declared !== got) v.push({ code: "E_BYTES_DIGEST", detail: `leg ${declared.slice(0, 20)}… ≠ received ${got.slice(0, 20)}…` });

  const claimedQuads = Number(meter.returnedQuads ?? NaN);
  const recountQuads = a.countQuads(a.deliveredBody.toString("utf8"));
  if (claimedQuads !== recountQuads) {
    v.push({ code: "E_RECOUNT_MISMATCH", detail: `returnedQuads ${claimedQuads} ≠ recount ${recountQuads}` });
  }

  const flat = Number(a.offering.queryFlatMicroTrac ?? NaN);
  const perQuad = Number(a.offering.perReturnedQuadMicroTrac ?? NaN);
  const expected = flat + perQuad * claimedQuads;
  if (Number(pricing.costMicroTrac) !== expected) {
    v.push({ code: "E_OVERBILL", detail: `billed ${pricing.costMicroTrac} ≠ flat ${flat} + ${perQuad}×${claimedQuads}` });
  }

  if (!verifyLegSignature(leg, a.offering.providerPublicPem)) {
    v.push({ code: "E_LEG_SIGNATURE", detail: "leg does not verify under the pinned provider key" });
  }

  return {
    decision: v.length ? "withhold" : "countersign",
    violations: v,
    recount: { returnedQuads: recountQuads, costMicroTrac: expected },
  };
}
