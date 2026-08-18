// Offering-KA publisher (journey A3): the DKG is the model registry. The
// offering becomes a first-class KA in the seller's context graph, carrying
// the v3 minimum shape — provenanceClass, model identity, pricing, tokenizer
// bundle ref, deterministic serving settings, provider address, apiBase.
//
// Publishes through the node's OWN HTTP API (wm/write → wm/finalize →
// swm/share) — the same lane every Iteration-2 registry artifact used. SWM is
// the safe, immediate registry; on-chain (VM) publication is a separate,
// operator-gated money step and is NOT performed here.
import type { OfferingBinding } from "./front.js";
import { buildModelKaQuads, modelKaFromBinding } from "./model-ka.js";

export const NSM = "https://w3id.org/neurosymbolic-marketplace/nsm#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export interface Quad { subject: string; predicate: string; object: string }

export function buildOfferingQuads(ob: OfferingBinding, a: {
  providerAddress: string; apiBase: string; chainId: number;
}): { ka: string; quads: Quad[] } {
  const o = ob.offering;
  const modelId = ob.binding.kind === "llamacpp" ? ob.binding.modelId : ob.binding.model;
  const ka = `nsm-offering-${o.id}`;
  const OFFER = `urn:nsm:model-offering:${o.id}`;
  const q: Quad[] = [];
  const iri = (s: string, p: string, obj: string) => q.push({ subject: s, predicate: p, object: obj });
  const lit = (s: string, p: string, v: unknown) => q.push({ subject: s, predicate: p, object: JSON.stringify(String(v)) });

  iri(OFFER, `${RDF}type`, `${NSM}ModelOffering`);
  lit(OFFER, `${NSM}modelId`, modelId);
  // v3.5: offerings REFERENCE the canonical Model KA instead of each carrying
  // loose model metadata; the catalog groups by this urn.
  {
    const mk = buildModelKaQuads(modelKaFromBinding(ob));
    iri(OFFER, `${NSM}modelRef`, mk.urn);
  }
  lit(OFFER, `${NSM}provenanceClass`, o.provenanceClass);
  lit(OFFER, `${NSM}perInputTokenMicroTrac`, o.perInputTokenMicroTrac);
  lit(OFFER, `${NSM}perOutputTokenMicroTrac`, o.perOutputTokenMicroTrac);
  lit(OFFER, `${NSM}queryFlatMicroTrac`, o.queryFlatMicroTrac);
  lit(OFFER, `${NSM}perReturnedQuadMicroTrac`, o.perReturnedQuadMicroTrac);
  lit(OFFER, `${NSM}tokenizerBundleRef`, ob.tokenizerBundleRef);
  lit(OFFER, `${NSM}providerAddress`, a.providerAddress);
  lit(OFFER, `${NSM}chain`, `eip155:${a.chainId}`);
  lit(OFFER, `${NSM}apiBase`, a.apiBase);
  lit(OFFER, `${NSM}quoteEndpoint`, "GET /terms");
  lit(OFFER, `${NSM}tabOpenEndpoint`, "POST /tab/open");
  lit(OFFER, `${NSM}inferEndpoint`, "POST /v1/chat/completions");
  lit(OFFER, `${NSM}queryEndpoint`, "POST /v1/query");
  if (ob.binding.kind === "llamacpp") {
    lit(OFFER, `${NSM}weightsDigest`, ob.binding.ggufSha256);
    lit(OFFER, `${NSM}servingSeed`, ob.binding.settings.seed);
    lit(OFFER, `${NSM}servingTemperature`, ob.binding.settings.temperature);
    lit(OFFER, `${NSM}servingCtx`, ob.binding.settings.ctx);
  } else {
    lit(OFFER, `${NSM}upstreamModelClaim`, ob.binding.model);
    if (ob.binding.kind === "openai") {
      lit(OFFER, `${NSM}chatTemplateConstantsDigest`, ob.binding.templateConstantsDigest);
    } else {
      lit(OFFER, `${NSM}countingBasis`, "local-verifiable");
      lit(OFFER, `${NSM}countingBundleSha256`, ob.binding.tokenizerFileSha256);
    }
  }
  lit(OFFER, `${NSM}nodeRequirement`,
    "Both seats operate DKG nodes: the provider serves, meters, and settles through its node; the buyer resolves this offering node-to-node and recounts every charge locally.");
  return { ka, quads: q };
}

/** Drive the node's own API to land the offering in SWM. Returns the KA name. */
export async function publishOffering(nodeBase: string, token: string, ob: OfferingBinding, a: {
  providerAddress: string; apiBase: string; chainId: number; contextGraphId: string; subGraphName?: string;
}): Promise<{ ka: string; ual: string }> {
  const { ka, quads } = buildOfferingQuads(ob, a);
  const mk = buildModelKaQuads(modelKaFromBinding(ob));
  const sg = a.subGraphName ?? "registry";
  const call = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(nodeBase + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 140)}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  // sub-graph may already exist — create is idempotent-by-refusal
  await call("/api/sub-graph/create", { contextGraphId: a.contextGraphId, subGraphName: sg }).catch(() => null);
  // v3.5: publish the canonical Model KA first (shared by all offerings of the
  // same model; a re-publish of an existing finalized KA fails harmlessly)
  await call(`/api/knowledge-assets/${mk.ka}/wm/write`, { quads: mk.quads, contextGraphId: a.contextGraphId, subGraphName: sg })
    .then(() => call(`/api/knowledge-assets/${mk.ka}/wm/finalize`, { contextGraphId: a.contextGraphId, subGraphName: sg }))
    .then(() => call(`/api/knowledge-assets/${mk.ka}/swm/share`, { contextGraphId: a.contextGraphId, subGraphName: sg }))
    .catch(() => null);
  try {
    await call(`/api/knowledge-assets/${ka}/wm/write`, { quads, contextGraphId: a.contextGraphId, subGraphName: sg });
  } catch (e) {
    // Idempotent republish (found by Hermes, event 16c1a650): a FINALIZED KA
    // refuses wm/write with "not an active Working Memory draft". Verify the
    // existing KA carries the SAME content we would publish (SPARQL over the
    // key fields) — identical ⇒ the publish is already done, return its UAL;
    // different ⇒ refuse loudly (a stale listing needs a KA edit flow, which
    // this rail deliberately does not improvise).
    if (!/not an active Working Memory draft/i.test(String((e as Error).message))) throw e;
    const want = new Map(quads.filter((x) => x.subject === `urn:nsm:model-offering:${ob.offering.id}`)
      .map((x) => [x.predicate, x.object]));
    const sparql = `SELECT ?p ?o WHERE { GRAPH ?g { <urn:nsm:model-offering:${ob.offering.id}> ?p ?o } }`;
    const res = await call("/api/query", { sparql, contextGraphId: a.contextGraphId, includeSharedMemory: true, includeContextGraphPartitions: true });
    const rows = ((res as { result?: { bindings?: Array<{ p: string; o: string }> } }).result?.bindings ?? []);
    const have = new Map(rows.map((r) => [r.p, r.o]));
    const diffs: string[] = [];
    for (const [pred, val] of want) {
      const got = have.get(pred);
      if (got === undefined) { diffs.push(`missing ${pred}`); continue; }
      // literals come back quoted; IRIs raw — compare on normalized forms
      const norm = (v: string) => { const m = v.match(/^"(.*)"(\^\^.*)?$/s); return m ? JSON.stringify(m[1]) : v; };
      if (norm(got) !== norm(String(val))) diffs.push(`${pred}: have ${String(got).slice(0, 60)} want ${String(val).slice(0, 60)}`);
    }
    if (have.size === 0) throw e;   // KA not resolvable — the original error stands
    if (diffs.length > 0) throw new Error(`E_PUBLISH_STALE_KA: existing ${ka} differs from current config — ${diffs.slice(0, 3).join("; ")} (KA edit flow required; not improvised)`);
    // Content matches — but the earlier publication may have died BETWEEN
    // finalize and share (found live: Hermes's KA was finalized on his node
    // and invisible to every other node). finalize+share are idempotent-or-
    // harmless; re-run BOTH so alreadyPublished always implies SHARED.
    await call(`/api/knowledge-assets/${ka}/wm/finalize`, { contextGraphId: a.contextGraphId, subGraphName: sg }).catch(() => null);
    let shared = true;
    let shareDetail: string | undefined;
    try {
      await call(`/api/knowledge-assets/${ka}/swm/share`, { contextGraphId: a.contextGraphId, subGraphName: sg });
    } catch (se) {
      // an "already shared" refusal is success; anything else is surfaced —
      // an unshared listing is invisible, never silently OK
      shareDetail = String((se as Error).message).slice(0, 140);
      shared = /already|exists|duplicate/i.test(shareDetail);
    }
    if (!shared) throw new Error(`E_PUBLISH_UNSHARED: ${ka} is finalized but swm/share failed — ${shareDetail}`);
    return { ka, ual: `did:dkg:context-graph:${a.contextGraphId}/${ka}`, alreadyPublished: true } as { ka: string; ual: string };
  }
  await call(`/api/knowledge-assets/${ka}/wm/finalize`, { contextGraphId: a.contextGraphId, subGraphName: sg });
  await call(`/api/knowledge-assets/${ka}/swm/share`, { contextGraphId: a.contextGraphId, subGraphName: sg });
  return { ka, ual: `did:dkg:context-graph:${a.contextGraphId}/${ka}` };
}
