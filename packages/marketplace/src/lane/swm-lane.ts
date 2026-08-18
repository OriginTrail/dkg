// The SWM lane — DKG-native transport for the NSM wire contract.
//
// Operator requirement (2026-08-17): cross-device marketplace messaging must
// ride the DKG network (SWM gossip), not a VPN. This lane tunnels the
// UNCHANGED wire contract over shared-memory knowledge assets:
//
//   buyer  → publishes an immutable request KA  (op, body-b64, EIP-191 headers)
//   gossip → SWM replicates CG shared memory node-to-node (~seconds)
//   seller → its executor polls ITS OWN node, replays the request against its
//            own loopback front (100% reuse of the reviewed surface), and
//            publishes the response KA (status, body-b64, the signed leg inside)
//   buyer  → polls ITS OWN node for the correlated response
//
// Each seat talks ONLY to its own node; every cross-device byte is DKG
// replication. The transaction transcript is itself knowledge assets on the
// DKG — transport and evidence are the same layer.
//
// Security: unchanged. Requests carry the same EIP-191 signature over
// method+path+body-digest+tab+nonce (body transported base64 so digests match
// byte-for-byte); the front verifies exactly as over HTTP. Lane visibility is
// CG-membership — the curated-graph admission the marketplace already assumes.
import { randomBytes } from "node:crypto";

export const LANE_NS = "https://w3id.org/neurosymbolic-marketplace/nsm#";

export interface LaneRequest {
  id: string;                        // correlation id (hex)
  method: string;                    // POST / GET
  path: string;                      // contract path relative to apiBase, e.g. /v1/chat/completions
  bodyB64: string;                   // exact request bytes, base64
  headers: Record<string, string>;   // x-nsm-* auth headers (public by design)
  from: string;                      // sender address (informational; auth is the signature)
  /** v3.5: the provider address this request is FOR. v3 lanes were
   *  single-seller-per-CG and had no addressing; with two executors on one CG
   *  an unaddressed request is answered (and raced) by BOTH sellers — the
   *  wrong one publishing E_TAB_UNKNOWN 401s against the right one's 200. */
  to?: string;
  at: string;
}

/** Is this lane request addressed to me? Unaddressed requests keep the v3
 *  single-seller behavior (served); addressed requests are served only by the
 *  named provider. Case-insensitive on the address. */
export function laneRequestIsForMe(req: { to?: string }, providerAddress: string): boolean {
  if (!req.to) return true;
  return req.to.toLowerCase() === providerAddress.toLowerCase();
}

export interface LaneResponse {
  correlation: string;
  status: number;
  bodyB64: string;                   // exact response bytes, base64
  at: string;
}

export const newLaneId = (): string => randomBytes(12).toString("hex");

type NodeCall = (path: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>;

/** node-API caller bound to one node + token (always the caller's OWN node). */
export function nodeCaller(nodeBase: string, token: string): NodeCall {
  return async (path, body) => {
    const res = await fetch(nodeBase + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    let json: Record<string, unknown> | null = null;
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
    return { status: res.status, json };
  };
}

const lit = (s: string, p: string, v: string) => ({ subject: s, predicate: p, object: JSON.stringify(v) });

/** Publish one immutable lane message KA via the caller's own node. */
export async function publishLaneMessage(
  call: NodeCall, cg: string,
  msg: { kind: "request"; req: LaneRequest } | { kind: "response"; res: LaneResponse },
): Promise<string> {
  const id = msg.kind === "request" ? msg.req.id : msg.res.correlation;
  const ka = `nsm-lane-${msg.kind === "request" ? "req" : "res"}-${id}`;
  const S = `urn:nsm:lane:${msg.kind}:${id}`;
  const quads = msg.kind === "request" ? [
    lit(S, `${LANE_NS}laneKind`, "request"),
    lit(S, `${LANE_NS}laneId`, msg.req.id),
    lit(S, `${LANE_NS}laneMethod`, msg.req.method),
    lit(S, `${LANE_NS}lanePath`, msg.req.path),
    lit(S, `${LANE_NS}laneBodyB64`, msg.req.bodyB64),
    lit(S, `${LANE_NS}laneHeaders`, Buffer.from(JSON.stringify(msg.req.headers), "utf8").toString("base64")),
    lit(S, `${LANE_NS}laneFrom`, msg.req.from),
    lit(S, `${LANE_NS}laneAt`, msg.req.at),
  ] : [
    lit(S, `${LANE_NS}laneKind`, "response"),
    lit(S, `${LANE_NS}laneCorrelation`, msg.res.correlation),
    lit(S, `${LANE_NS}laneStatus`, String(msg.res.status)),
    lit(S, `${LANE_NS}laneBodyB64`, msg.res.bodyB64),
    lit(S, `${LANE_NS}laneAt`, msg.res.at),
  ];
  const w = await call(`/api/knowledge-assets/${ka}/wm/write`, { contextGraphId: cg, quads });
  if (w.status !== 200) throw new Error(`lane wm/write → ${w.status}`);
  const f = await call(`/api/knowledge-assets/${ka}/wm/finalize`, { contextGraphId: cg });
  if (f.status !== 200) throw new Error(`lane wm/finalize → ${f.status}`);
  const s = await call(`/api/knowledge-assets/${ka}/swm/share`, { contextGraphId: cg });
  if (s.status !== 200) throw new Error(`lane swm/share → ${s.status}`);
  return ka;
}

function unq(v: unknown): string {
  const s = String(v ?? "");
  const m = s.match(/^"(.*)"(\^\^.*)?$/s);
  return m ? m[1] : s;
}

/** Query the caller's OWN node for lane requests (seller side). */
export async function pollLaneRequests(call: NodeCall, cg: string): Promise<LaneRequest[]> {
  const q = await call("/api/query", {
    sparql: `PREFIX nsm: <${LANE_NS}> SELECT ?id ?m ?p ?b ?h ?f ?at WHERE { GRAPH ?g {
      ?s nsm:laneKind ?k ; nsm:laneId ?id ; nsm:laneMethod ?m ; nsm:lanePath ?p ;
         nsm:laneBodyB64 ?b ; nsm:laneHeaders ?h ; nsm:laneFrom ?f ; nsm:laneAt ?at .
      FILTER(STR(?k) = "request" || STR(?k) = "\\"request\\"") } } LIMIT 200`,
    contextGraphId: cg, includeSharedMemory: true, includeContextGraphPartitions: true,
  });
  const rows = ((q.json?.result as { bindings?: Array<Record<string, string>> })?.bindings) ?? [];
  return rows.map((r) => ({
    id: unq(r.id), method: unq(r.m), path: unq(r.p), bodyB64: unq(r.b),
    headers: (() => { try { return JSON.parse(Buffer.from(unq(r.h), "base64").toString("utf8")) as Record<string, string>; } catch { return {}; } })(),
    from: unq(r.f), at: unq(r.at),
  }));
}

/** Query the caller's OWN node for one correlated response (buyer side). */
export async function pollLaneResponse(call: NodeCall, cg: string, correlation: string): Promise<LaneResponse | null> {
  const q = await call("/api/query", {
    sparql: `PREFIX nsm: <${LANE_NS}> SELECT ?st ?b ?at WHERE { GRAPH ?g {
      <urn:nsm:lane:response:${correlation}> nsm:laneStatus ?st ; nsm:laneBodyB64 ?b ; nsm:laneAt ?at } } LIMIT 1`,
    contextGraphId: cg, includeSharedMemory: true, includeContextGraphPartitions: true,
  });
  const rows = ((q.json?.result as { bindings?: Array<Record<string, string>> })?.bindings) ?? [];
  if (!rows.length) return null;
  return { correlation, status: Number(unq(rows[0].st)), bodyB64: unq(rows[0].b), at: unq(rows[0].at) };
}
