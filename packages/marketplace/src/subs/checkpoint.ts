// Checkpoint service — the cadence that maps onto the DKG's memory layers.
// Meters are local Working Memory (continuous, free). Seats exchange small
// signed checkpoints — running totals per offering, hash-chained — over SWM
// gossip in the pair CG, NEVER published to Verifiable Memory (I6). A
// mismatch narrows any dispute to one checkpoint interval; only an
// UNRESOLVED divergence escalates to an interim VM publish.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Checkpoint } from "./objects.js";
import { callLogHead, subsHome, unitTotals } from "./journal.js";

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

export interface CadenceConfig {
  everyCalls: number;        // default 100 billable calls
  everyActiveMs: number;     // default 15 min of ACTIVITY (idle pairs send nothing)
  jitterPct: number;         // 0.2 → ±20%, seeded per pair (deterministic)
}
export const DEFAULT_CADENCE: CadenceConfig = { everyCalls: 100, everyActiveMs: 15 * 60_000, jitterPct: 0.2 };

/** Deterministic per-pair jitter so both seats agree on thresholds without
 *  coordination — seeded from the pair id, not from a clock. */
export function jitteredThresholds(pair: string, cfg: CadenceConfig): { calls: number; activeMs: number } {
  const seed = parseInt(sha256(pair).slice(7, 15), 16) / 0xffffffff; // [0,1)
  const f = 1 + (seed * 2 - 1) * cfg.jitterPct;
  return { calls: Math.max(1, Math.round(cfg.everyCalls * f)), activeMs: Math.max(1000, Math.round(cfg.everyActiveMs * f)) };
}

// ── emitter state (per pair, per seat) ─────────────────────────────────────

interface EmitState { callsSinceLast: number; lastEmitAt: string | null; lastActivityAt: string | null }

function statePath(home: string, pair: string): string {
  return join(subsHome(home), `ckpt-state-${pair}.json`);
}
function readState(home: string, pair: string): EmitState {
  const p = statePath(home, pair);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as EmitState
                       : { callsSinceLast: 0, lastEmitAt: null, lastActivityAt: null };
}
function writeState(home: string, pair: string, s: EmitState): void {
  writeFileSync(statePath(home, pair), JSON.stringify(s));
}

/** Record a billable call; returns true when the cadence says "emit now".
 *  Activity-driven by construction: with no calls there is no activity
 *  clock, so idle pairs send nothing. */
export function noteBillableCall(home: string, pair: string, now: Date, cfg: CadenceConfig = DEFAULT_CADENCE): boolean {
  const st = readState(home, pair);
  const th = jitteredThresholds(pair, cfg);
  st.callsSinceLast += 1;
  const activeSince = st.lastEmitAt ?? st.lastActivityAt ?? now.toISOString();
  st.lastActivityAt = now.toISOString();
  const due = st.callsSinceLast >= th.calls
    || (st.callsSinceLast > 0 && now.getTime() - new Date(activeSince).getTime() >= th.activeMs);
  writeState(home, pair, st);
  return due;
}

// ── checkpoint chain ───────────────────────────────────────────────────────

export function checkpointChain(home: string, pair: string): Checkpoint[] {
  const p = join(subsHome(home), `ckpt-${pair}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Checkpoint);
}

export function chainRoot(home: string, pair: string): string {
  const c = checkpointChain(home, pair);
  return c.length ? c[c.length - 1].digest : "sha256:genesis";
}

/** Emit this seat's checkpoint from its own call log — running totals per
 *  offering. Signing is a callback so the caller brings the node identity. */
export function emitCheckpoint(home: string, a: {
  pair: string; periodId: string; periodStartAt: string; now: Date;
  sign?: (digest: string) => string;
}): Checkpoint {
  const chain = checkpointChain(home, a.pair);
  const prev = chain.length ? chain[chain.length - 1].digest : "sha256:genesis";
  const totals = unitTotals(home, a.pair, a.periodStartAt);
  const body = {
    pair: a.pair, periodId: a.periodId, seq: chain.length + 1,
    at: a.now.toISOString(), totals, callLogHead: callLogHead(home, a.pair), prevDigest: prev,
  };
  const digest = sha256(prev + JSON.stringify(body));
  const cp: Checkpoint = { ...body, digest, signature: a.sign?.(digest) };
  appendFileSync(join(subsHome(home), `ckpt-${a.pair}.jsonl`), JSON.stringify(cp) + "\n");
  // reset the emitter window
  const st = readState(home, a.pair);
  writeState(home, a.pair, { ...st, callsSinceLast: 0, lastEmitAt: a.now.toISOString() });
  return cp;
}

// ── verifier: the peer's checkpoint against OUR totals ─────────────────────

export type CheckpointVerdict =
  | { kind: "agree"; seq: number }
  | { kind: "diverged"; seq: number; offerings: string[]; interval: { fromSeq: number; toSeq: number };
      ours: Record<string, number>; theirs: Record<string, number> };

/** Compare a received checkpoint with our own running totals. A mismatch
 *  names the offerings AND the interval — dispute scope is the interval
 *  since the last agreed checkpoint, never the whole period. */
export function verifyPeerCheckpoint(home: string, peer: Checkpoint, a: { periodStartAt: string }): CheckpointVerdict {
  // compare AS OF the peer's emit moment (+250ms cross-seat skew grace)
  const cutoff = new Date(new Date(peer.at).getTime() + 250).toISOString();
  const ours = unitTotals(home, peer.pair, a.periodStartAt, cutoff);
  const offerings = new Set([...Object.keys(ours), ...Object.keys(peer.totals)]);
  const diverged = [...offerings].filter((o) => (ours[o] ?? 0) !== (peer.totals[o] ?? 0));
  if (!diverged.length) {
    recordAgreement(home, peer.pair, peer.seq, peer.at);
    return { kind: "agree", seq: peer.seq };
  }
  const lastAgreed = lastAgreedSeq(home, peer.pair);
  return { kind: "diverged", seq: peer.seq, offerings: diverged,
           interval: { fromSeq: lastAgreed + 1, toSeq: peer.seq }, ours, theirs: peer.totals };
}

function agreementsPath(home: string, pair: string): string {
  return join(subsHome(home), `ckpt-agreed-${pair}.jsonl`);
}
function recordAgreement(home: string, pair: string, seq: number, at: string): void {
  appendFileSync(agreementsPath(home, pair), JSON.stringify({ seq, at }) + "\n");
}
export function lastAgreedSeq(home: string, pair: string): number {
  const p = agreementsPath(home, pair);
  if (!existsSync(p)) return 0;
  const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number });
  return rows.length ? rows[rows.length - 1].seq : 0;
}

/** The statement surface's freshness line ("Counts agree ✓ · checked 4 min
 *  ago") reads from here. */
export function freshness(home: string, pair: string, now: Date): { agree: boolean; checkedAgoMs: number | null } {
  const p = agreementsPath(home, pair);
  if (!existsSync(p)) return { agree: false, checkedAgoMs: null };
  const rows = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(rows[rows.length - 1]) as { seq: number; at: string };
  return { agree: true, checkedAgoMs: now.getTime() - new Date(last.at).getTime() };
}
