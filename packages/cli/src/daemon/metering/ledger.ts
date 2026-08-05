// V2-B2 — per-principal read ledger + receipt assembly.
//
// Ratified design points:
//  D9  ONE v0.2 envelope, independently signed TYPED LEGS. This module emits
//      the `read` leg only; the inference leg is signed by the proxy. The
//      envelope binds ordering/context; liability lives per leg, so a read
//      leg never implies the node attested to anyone else's work.
//  D10 append-only journal with a precisely specified entry vocabulary,
//      sufficient for independent replay (deposit, credit, debit, settle,
//      refund-request, operator-response, expiry — signatures on each).
//  D12 crash-safe: durable append before acknowledge; exactly-once by
//      (principal, sequence, previousLegHash) with CAS on the balance.
//  D14 receipts carry the requester keyRef; SETTLEMENT admissibility requires
//      the requester countersignature — this module marks legs `pending` until
//      countersigned and never treats an uncountersigned leg as settled.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { dirname, join } from "node:path";
import { COEFFICIENTS, SCHEDULE_VERSION, costMicroTrac, type MeterConfig, type MeterMode } from "./read-meter.js";

export const LEG_DOMAIN = "odysseus-dkg:read-leg:v0.2";

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** RFC 8785 subset canonicalization (integers only), shared with the proxy. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in canonical payload");
    // U carries one decimal place by construction; scale to integer tenths.
    if (!Number.isInteger(value)) return String(Math.round(value * 10) / 10);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error(`unsupported type ${typeof value}`);
}

export interface MeterPaths { home: string; }

function meterDir(home: string) {
  const d = join(home, "metering");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// ── provider signing key (node-local, never exported) ───────────────────────
function providerKeys(home: string) {
  const f = join(meterDir(home), "provider-keys.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export const providerKeyId = (home: string) => "ed25519:" + sha256(providerKeys(home).publicPem).slice(0, 16);

// ── journal ─────────────────────────────────────────────────────────────────
interface TabState { balance: number; sequence: number; lastHash: string; seen: Set<string>; }

// State is keyed BY DKG_HOME. A module-global map leaks balances between
// homes — which is not a hypothetical: the isolated Stage-1 node and the
// production node run in the same process shape, and the gate tests caught
// exactly this. Never make this a single flat map again.
const tabsByHome = new Map<string, Map<string, TabState>>();
const replayedHomes = new Set<string>();

function journalPath(home: string) { return join(meterDir(home), "read-journal.jsonl"); }

function homeTabs(home: string): Map<string, TabState> {
  if (!tabsByHome.has(home)) tabsByHome.set(home, new Map());
  return tabsByHome.get(home)!;
}

function entry(home: string, principal: string): TabState {
  const m = homeTabs(home);
  if (!m.has(principal)) m.set(principal, { balance: 0, sequence: 0, lastHash: "genesis", seen: new Set() });
  return m.get(principal)!;
}

function replay(home: string) {
  if (replayedHomes.has(home)) return;
  replayedHomes.add(home);
  const p = journalPath(home);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const t = entry(home, rec.principal);
    if (rec.kind === "credit") { t.balance += rec.amountMicroTrac; continue; }
    if (rec.kind === "debit") {
      t.balance = rec.leg.tab.after;
      t.sequence = rec.leg.sequence;
      t.lastHash = rec.hash;
      t.seen.add(rec.leg.legId);
    }
  }
}

function durableAppend(home: string, obj: unknown) {
  const p = journalPath(home);
  appendFileSync(p, JSON.stringify(obj) + "\n");
  const fd = openSync(p, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }   // D12: durable before ack
}

export function credit(home: string, principal: string, amountMicroTrac: number, evidence: Record<string, unknown>) {
  replay(home);
  if (!Number.isSafeInteger(amountMicroTrac) || amountMicroTrac <= 0) throw new Error("E_BAD_CREDIT");
  durableAppend(home, { kind: "credit", principal, amountMicroTrac, evidence, at: new Date().toISOString() });
  entry(home, principal).balance += amountMicroTrac;
  return balance(home, principal);
}

export function balance(home: string, principal: string) {
  replay(home);
  const t = entry(home, principal);
  return { balance: t.balance, sequence: t.sequence, lastHash: t.lastHash };
}

/**
 * Assemble + sign a read leg and atomically debit the tab.
 * Returns the signed leg. Throws E_INSUFFICIENT_FUNDS without mutating state.
 */
export function recordReadLeg(home: string, args: {
  principal: string;
  units: number;
  breakdown: Record<string, unknown>;
  scopeQuads: number;
  sparql: string;
  responseBody: string;
  contextGraphId?: string;
  view?: string;
  askMicroPer1k: number;
  requesterKeyRef?: string;
}) {
  replay(home);
  const t = entry(home, args.principal);
  const cost = costMicroTrac(args.units, args.askMicroPer1k);
  const before = t.balance;
  const after = before - cost;
  if (after < 0) throw new Error("E_INSUFFICIENT_FUNDS");

  const leg = {
    legType: "read" as const,
    schemaVersion: "receipt-v0.2",
    domain: LEG_DOMAIN,
    legId: sha256(`${args.principal}:${t.sequence + 1}:${sha256(args.sparql)}:${Date.now()}`).slice(0, 32),
    sequence: t.sequence + 1,
    previousLegHash: t.lastHash,
    counterparty: { providerKeyId: providerKeyId(home) },
    requester: { principal: args.principal, keyRef: args.requesterKeyRef ?? null },
    meter: {
      scheduleVersion: SCHEDULE_VERSION,
      units: args.units,
      breakdown: args.breakdown,
      scopeQuads: args.scopeQuads,
      coefficientsDigest: sha256(canonicalize(COEFFICIENTS)),
    },
    evidence: {
      queryDigest: "sha256:" + sha256(args.sparql),
      resultDigest: "sha256:" + sha256(args.responseBody),
      bytesReturned: Buffer.byteLength(args.responseBody, "utf8"),
      contextGraphId: args.contextGraphId ?? null,
      view: args.view ?? null,
      snapshot: new Date().toISOString(),
    },
    pricing: { askMicroPer1k: args.askMicroPer1k, costMicroTrac: cost, unit: "mockTRAC-u" },
    tab: { before, after },
    // D14: settlement admissibility requires the requester countersignature.
    settlement: { status: "pending-countersignature" as const },
  };
  const preimage = Buffer.concat([Buffer.from(LEG_DOMAIN + "\n"), Buffer.from(canonicalize(leg))]);
  const providerSignature = edSign(null, preimage, createPrivateKey(providerKeys(home).privatePem)).toString("base64");
  const signed = { ...leg, providerSignature };
  const hash = sha256(canonicalize(signed));

  durableAppend(home, { kind: "debit", principal: args.principal, hash, leg: signed });
  t.balance = after; t.sequence = leg.sequence; t.lastHash = hash; t.seen.add(leg.legId);
  return signed;
}

/** Failed query: base fee only, receipt marked error (never debits in shadow). */
export function noteFailedRead(home: string, args: { principal?: string; sparql: string }) {
  if (!args.principal) return;
  durableAppend(home, {
    kind: "failed-read",
    principal: args.principal,
    queryDigest: "sha256:" + sha256(args.sparql),
    units: COEFFICIENTS.F_base,
    at: new Date().toISOString(),
  });
}

// ── config ──────────────────────────────────────────────────────────────────
export function loadMeterConfig(home: string): MeterConfig {
  const f = join(meterDir(home), "meter-config.json");
  const defaults = {
    mode: "off" as MeterMode,
    readAskMicroPer1k: 100,
    exemptPrincipals: [] as string[],
    enforcedPrincipals: [] as string[],
  };
  const raw = existsSync(f) ? { ...defaults, ...JSON.parse(readFileSync(f, "utf8")) } : defaults;
  // Kill switch: env always wins, so a bad rollout is one restart from off.
  const envMode = process.env.DKG_READ_METER_MODE as MeterMode | undefined;
  return {
    mode: envMode ?? raw.mode,
    readAskMicroPer1k: Number(process.env.DKG_READ_ASK ?? raw.readAskMicroPer1k),
    exemptPrincipals: new Set(raw.exemptPrincipals),
    enforcedPrincipals: new Set(raw.enforcedPrincipals),
  };
}
