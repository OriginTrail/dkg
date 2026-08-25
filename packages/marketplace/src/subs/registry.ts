// Marketplace Registry CG publishers (G18) — the OPEN graph holding Model
// KAs, offer KAs with committed asks, tokenizer bundle KAs, and the Query
// Cost Schedule KA. Publishes through the node's own HTTP API
// (wm/write → wm/finalize → swm/share), same as the offering publisher.
// SWM is the immediate registry; VM publication stays operator-gated money.

import { NSM, type Quad } from "../seller/offering.js";
import { SCHEDULE_V1, scheduleDigest, type QueryCostSchedule } from "./query-cost.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export function buildScheduleKaQuads(s: QueryCostSchedule = SCHEDULE_V1): { ka: string; urn: string; quads: Quad[] } {
  const digest = scheduleDigest(s);
  const urn = `urn:nsm:query-schedule:${digest}`;
  const ka = `nsm-query-schedule-${digest.slice(7, 19)}`;
  const q: Quad[] = [];
  const lit = (p: string, v: unknown) => q.push({ subject: urn, predicate: `${NSM}${p}`, object: JSON.stringify(String(v)) });
  q.push({ subject: urn, predicate: `${RDF}type`, object: `${NSM}QueryCostSchedule` });
  lit("scheduleVersion", s.version);
  lit("scheduleDigest", digest);
  lit("base", s.base);
  lit("perTriplePattern", s.perTriplePattern);
  lit("perJoinVar", s.perJoinVar);
  lit("perPropertyPath", s.perPropertyPath);
  lit("perOptionalOrUnion", s.perOptionalOrUnion);
  lit("perFilter", s.perFilter);
  lit("perAggregation", s.perAggregation);
  lit("missingLimitSurcharge", s.missingLimitSurcharge);
  lit("perReturnedResult", s.perReturnedResult);
  return { ka, urn, quads: q };
}

async function apiCall(nodeBase: string, token: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(nodeBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/** Publish the frozen schedule into the registry CG. Idempotent by name:
 *  the KA is content-addressed, so a re-publish of the same schedule hits
 *  the same KA and the daemon's own idempotency applies. */
export async function publishScheduleKa(nodeBase: string, token: string, a: {
  contextGraphId: string; subGraphName?: string; schedule?: QueryCostSchedule;
}): Promise<{ ka: string; urn: string; ual: string }> {
  const { ka, urn, quads } = buildScheduleKaQuads(a.schedule);
  const sg = a.subGraphName ?? "registry";
  await apiCall(nodeBase, token, "/api/sub-graph/create", { contextGraphId: a.contextGraphId, subGraphName: sg }).catch(() => null);
  await apiCall(nodeBase, token, `/api/knowledge-assets/${ka}/wm/write`, { quads, contextGraphId: a.contextGraphId, subGraphName: sg });
  await apiCall(nodeBase, token, `/api/knowledge-assets/${ka}/wm/finalize`, { contextGraphId: a.contextGraphId, subGraphName: sg });
  await apiCall(nodeBase, token, `/api/knowledge-assets/${ka}/swm/share`, { contextGraphId: a.contextGraphId, subGraphName: sg });
  return { ka, urn, ual: `did:dkg:context-graph:${a.contextGraphId}/${ka}` };
}
