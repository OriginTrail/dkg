// Pair CG lifecycle (G17) — curated, exactly the two members, auto-created
// at first subscription. Carries reconciliation only: checkpoints ride SWM
// gossip inside it (never VM); the period statement KA is its one clean-path
// VM-bound artifact (I6). Names are derived, so both seats agree without
// coordination: nsm-pair-<sha256(buyer~seller)[:12]>.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PairCg } from "./objects.js";
import { subsHome } from "./journal.js";

export const pairId = (buyer: string, seller: string): string =>
  `${buyer.toLowerCase()}~${seller.toLowerCase()}`;

export function pairCgId(pair: string): string {
  return "nsm-pair-" + createHash("sha256").update(pair).digest("hex").slice(0, 12);
}

function recordsPath(home: string): string { return join(subsHome(home), "pair-cgs.jsonl"); }

export function readPairCgs(home: string): PairCg[] {
  const p = recordsPath(home);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairCg);
}

async function api(nodeBase: string, token: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(nodeBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(out).slice(0, 120)}`);
  return out;
}

/** Ensure the pair CG exists with exactly the two members. Idempotent:
 *  a local record short-circuits; an existing remote CG is adopted. The
 *  counterpart's node joins via the daemon's own invite/subscribe flow. */
export async function ensurePairCg(nodeBase: string, token: string, a: {
  home: string; buyer: string; seller: string; peerIdToInvite?: string; now: Date;
}): Promise<PairCg> {
  const pair = pairId(a.buyer, a.seller);
  const existing = readPairCgs(a.home).find((r) => r.pair === pair);
  if (existing) return existing;

  const contextGraphId = pairCgId(pair);
  const exists = await api(nodeBase, token, "/api/context-graph/exists", { id: contextGraphId })
    .catch(() => ({ exists: false }));
  if (!(exists as { exists?: boolean }).exists) {
    await api(nodeBase, token, "/api/context-graph/create", {
      id: contextGraphId,
      name: contextGraphId,
      description: `NSM v5 reconciliation pair ${pair} — membership is exactly the two seats`,
      accessPolicy: "curated",
      private: true,
    });
  }
  if (a.peerIdToInvite) {
    await api(nodeBase, token, "/api/context-graph/invite", { contextGraphId, peerId: a.peerIdToInvite })
      .catch(() => null);   // re-invite of a member is a no-op
  }
  const rec: PairCg = { pair, contextGraphId, createdAt: a.now.toISOString() };
  appendFileSync(recordsPath(a.home), JSON.stringify(rec) + "\n");
  return rec;
}
