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
import { COEFFICIENTS_CANONICAL, SCHEDULE_VERSION, costMicroTrac, type MeterConfig, type MeterMode } from "./read-meter.js";

export const LEG_DOMAIN = "odysseus-dkg:read-leg:v0.3";

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** RFC 8785 subset canonicalization (integers only), shared with the proxy. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    // D12 v1.1 (buyer-found, Hermes/Bo 2026-08-06): NO floats in signed
    // material — not even "one decimal place". `Math.round(u*10)/10` followed
    // by JSON serialization does not preserve a trailing ".0" (U=3.0 emits
    // `3`), so two conforming implementations could produce DIFFERENT
    // canonical bytes for the same charge. U is therefore signed as
    // `unitsTenths`, an integer number of tenths. Any non-integer here is a
    // bug in the caller, and throwing is the only safe response.
    if (!Number.isInteger(value)) throw new Error(`E_CANON_NON_INTEGER: ${value} (use integer tenths for U)`);
    if (!Number.isSafeInteger(value)) throw new Error("E_CANON_UNSAFE_INTEGER");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    // D12 v1.1 (found by the canonicalization fixture): only PLAIN objects may
    // be canonicalized. A Date/Map/Set/class instance has no own enumerable
    // keys, so it would silently serialize as `{}` — data loss inside signed
    // material. Reject rather than coerce.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`E_CANON_NON_PLAIN_OBJECT: ${value?.constructor?.name ?? "unknown"} (serialize it explicitly first)`);
    }
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
type Settlement = { withdrawalId: string; txHash: string; netPaidMicroTrac: number; at: string };
type Refunded = { amountMicroTrac: number; refundAddress: string; termsDigest: string; at: string };
interface TabState {
  balance: number; sequence: number; lastHash: string; seen: Set<string>;
  settled?: Settlement;            // terminal for the CURRENT epoch
  refunded?: Refunded;             // terminal for the CURRENT epoch (Bo #3)
  epoch: number;                   // current tab lifecycle
  settlementHistory: Settlement[]; // prior epochs' settlements (immutable)
  creditedDeposits: Set<string>;   // canonical deposit ids already applied (Bo #2)
}

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
  if (!m.has(principal)) m.set(principal, { balance: 0, sequence: 0, lastHash: "genesis", seen: new Set(), epoch: 0, settlementHistory: [], creditedDeposits: new Set() });
  return m.get(principal)!;
}

// A credit arriving on a SETTLED tab is, by construction, a new deposit: a
// settled tab is terminal and cannot be topped up. Roll to a fresh EPOCH so the
// new tab gets its own settlement/refund lifecycle and its own leg chain
// starting at sequence 1 (which the close statement's 1..closeSequence
// completeness check requires). The prior settlement is archived, never lost.
//
// Buyer-found by attempting a SECOND real deposit (Hermes/Bo, 2026-08-09): the
// sticky per-principal `settled` flag from the read run poisoned any second
// tab — it funded but could be neither settled (settleTab short-circuits
// alreadySettled) nor refunded (refundOnExpiry refuses settled), stranding the
// principal's balance. Applied identically here in credit() and in replay() so
// the in-memory and journal-derived state can never diverge.
/** Canonical, replay-stable identity of an on-chain deposit: chain:token:tx:log.
 *  A duplicate credit for the same deposit is a no-op, so a replayed or
 *  double-submitted credit cannot inflate a balance (Bo #2). */
export function canonicalDepositId(ev: Record<string, unknown> | undefined): string | null {
  if (!ev) return null;
  const tx = ev.txHash ?? ev.tx;
  if (!tx) return null;                 // non-deposit credits (mock top-ups) opt out
  const chain = ev.chainId ?? ev.chain ?? "";
  const token = ev.token ?? "";
  const log = ev.logIndex ?? ev.log ?? "0";
  return `${chain}:${token}:${String(tx).toLowerCase()}:${log}`;
}

/** Returns true if the credit was APPLIED, false if it was a duplicate no-op. */
function applyCredit(t: TabState, amount: number, depositId: string | null): boolean {
  if (depositId !== null && t.creditedDeposits.has(depositId)) return false;   // idempotent
  // A credit on a TERMINAL epoch (settled OR refunded) opens a fresh epoch.
  // Both are terminal now (Bo #3): a refunded tab must not let a later credit
  // inherit its refund marker.
  if (t.settled || t.refunded) {
    if (t.settled) t.settlementHistory.push(t.settled);
    t.settled = undefined;
    t.refunded = undefined;
    t.epoch += 1;
    t.balance = amount;        // a new tab, not a top-up
    t.sequence = 0;
    t.lastHash = "genesis";
  } else {
    t.balance += amount;
  }
  if (depositId !== null) t.creditedDeposits.add(depositId);
  return true;
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
    if (rec.kind === "credit") { applyCredit(t, rec.amountMicroTrac, canonicalDepositId(rec.evidence)); continue; }
    // Buyer-found (Hermes/Bo, 2026-08-06), by insisting the post-restart balance
    // be verified through the API rather than read from the journal: replay
    // handled credits and debits but IGNORED refunds, so a refunded balance
    // resurrected on the next restart. That is worse than never refunding — the
    // journal said the money was returned while the live ledger said the buyer
    // still had it to spend, and in enforce mode they could have spent it twice.
    // Subtraction rather than zeroing, so a future partial refund replays right.
    if (rec.kind === "refund") {
      t.balance = Math.max(0, t.balance - rec.amountMicroTrac);
      // A refund is TERMINAL for the current epoch (Bo #3): mark it so the next
      // credit rolls a fresh epoch and a repeated refund cannot resurrect it.
      if (rec.terminal !== false) t.refunded = { amountMicroTrac: Number(rec.amountMicroTrac), refundAddress: String(rec.refundAddress ?? ""), termsDigest: String(rec.termsDigest ?? ""), at: String(rec.at ?? "") };
      continue;
    }
    // Buyer-found (Hermes/Bo) at settlement close-out: a confirmed withdrawal
    // must reconcile the TAB, not just the withdrawal journal. Without this the
    // buyer-visible tab still shows a claimable balance after on-chain payout —
    // a phantom residual claim and a double-refund risk if expiry ever sweeps.
    if (rec.kind === "settled") {
      t.balance = 0;
      t.settled = { withdrawalId: String(rec.withdrawalId), txHash: String(rec.txHash), netPaidMicroTrac: Number(rec.netPaidMicroTrac), at: String(rec.at) };
      continue;
    }
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
  const depositId = canonicalDepositId(evidence);
  // Dedup BEFORE append: a duplicate deposit must not even reach the journal, so
  // it is idempotent across restarts (Bo #2).
  if (depositId !== null && entry(home, principal).creditedDeposits.has(depositId)) {
    return { ...balance(home, principal), duplicate: true, depositId };
  }
  durableAppend(home, { kind: "credit", principal, amountMicroTrac, evidence, at: new Date().toISOString() });
  applyCredit(entry(home, principal), amountMicroTrac, depositId);
  return balance(home, principal);
}

export function balance(home: string, principal: string) {
  replay(home);
  const t = entry(home, principal);
  return { balance: t.balance, sequence: t.sequence, lastHash: t.lastHash, epoch: t.epoch };
}

/**
 * Assemble + sign a read leg and atomically debit the tab.
 * Returns the signed leg. Throws E_INSUFFICIENT_FUNDS without mutating state.
 */
/**
 * Debit gate hook. Injected by the deposit rail so the ledger cannot bill a
 * tab whose opening has expired (Bo's amendment). Default: permissive, so
 * environments without a tab rail (Stage-1 mock tabs) keep working.
 */
let debitGate: ((home: string, principal: string, now: number) => { ok: boolean; code?: string }) | null = null;
export function setDebitGate(fn: typeof debitGate) { debitGate = fn; }

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
  // Bo's amendment: NO debit path after expiry.
  if (debitGate) {
    const g = debitGate(home, args.principal, Date.now());
    if (!g.ok) throw new Error(g.code ?? "E_TAB_EXPIRED");
  }
  const t = entry(home, args.principal);
  const cost = costMicroTrac(args.units, args.askMicroPer1k);
  const before = t.balance;
  const after = before - cost;
  if (after < 0) throw new Error("E_INSUFFICIENT_FUNDS");

  // D12 v1.1, applied consistently: EVERYTHING in the signed preimage is
  // integer. `units` was converted to tenths when Bo found the float-divergence
  // bug, but the breakdown was left carrying floats (egress/scope/marker
  // weights), so canonicalize() threw E_CANON_NON_INTEGER on every real leg —
  // which nothing noticed, because shadow mode never reached this line. The
  // rule has to cover the whole preimage or it covers nothing.
  const SCALE = 1000;
  const scaleInt = (n: unknown) => Math.round(Number(n ?? 0) * SCALE);
  const rawBreakdown = args.breakdown as Record<string, unknown>;
  const scaledMarkers: Record<string, number> = {};
  for (const [k, v] of Object.entries((rawBreakdown?.markers ?? {}) as Record<string, unknown>)) {
    scaledMarkers[k] = scaleInt(v);
  }
  const breakdownScaled = {
    scale: SCALE,
    base: scaleInt(rawBreakdown?.base),
    egress: scaleInt(rawBreakdown?.egress),
    scope: scaleInt(rawBreakdown?.scope),
    M: scaleInt(rawBreakdown?.M),
    kib: Math.round(Number(rawBreakdown?.kib ?? 0)),
    markers: scaledMarkers,
  };

  const leg = {
    legType: "read" as const,
    schemaVersion: "receipt-v0.3",
    domain: LEG_DOMAIN,
    tabEpoch: t.epoch,
    legId: sha256(`${args.principal}:${t.sequence + 1}:${sha256(args.sparql)}:${Date.now()}`).slice(0, 32),
    sequence: t.sequence + 1,
    previousLegHash: t.lastHash,
    counterparty: { providerKeyId: providerKeyId(home) },
    requester: { principal: args.principal, keyRef: args.requesterKeyRef ?? null },
    meter: {
      scheduleVersion: SCHEDULE_VERSION,
      // D12 v1.1: integer tenths is the SIGNED representation. A decimal
      // `units` may be shown to humans but never enters the preimage.
      unitsTenths: Math.round(args.units * 10),
      breakdownScaled,
      scopeQuads: args.scopeQuads,
      coefficientsDigest: sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>)),
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

  durableAppend(home, { kind: "debit", principal: args.principal, epoch: t.epoch, hash, leg: signed });
  t.balance = after; t.sequence = leg.sequence; t.lastHash = hash; t.seen.add(leg.legId);
  return signed;
}

/**
 * Record an INFERENCE leg. Same tab/hash-chain/signing/settlement path as
 * recordReadLeg — deliberately, so inference settles through the exact spine
 * proven on-chain for reads. The only differences are the meter (token counts,
 * not read-U) and the evidence (the buyer-ratified receipt binding). The cost is
 * already integer µTRAC from the inference policy, so it is passed directly.
 *
 * Everything in the signed preimage is integer (Bo's rule): inputTokens,
 * outputTokens, costMicroTrac are integers; the evidence carries digests
 * (strings) and the token COUNTS, never floats.
 */
export function recordInferenceLeg(home: string, args: {
  principal: string;
  inputTokens: number;
  outputTokens: number;
  costMicroTrac: number;      // integer µTRAC, from inferenceCostMicroTrac
  policyDigest: string;
  evidence: Record<string, unknown>;  // buildInferenceEvidence(...) output
  requesterKeyRef?: string;
}) {
  replay(home);
  if (debitGate) {
    const g = debitGate(home, args.principal, Date.now());
    if (!g.ok) throw new Error(g.code ?? "E_TAB_EXPIRED");
  }
  const t = entry(home, args.principal);
  const cost = Math.max(0, Math.round(args.costMicroTrac));
  const before = t.balance;
  const after = before - cost;
  if (after < 0) throw new Error("E_INSUFFICIENT_FUNDS");

  const evDigest = sha256(canonicalize(args.evidence));
  const leg = {
    legType: "inference" as const,
    // Derived from the evidence rather than restated, so the leg's schema stamp
    // can never drift from the contract the evidence was actually built under.
    schemaVersion: (args.evidence?.schemaVersion as string) ?? "receipt-v0.5",
    tabEpoch: t.epoch,
    domain: LEG_DOMAIN,
    legId: sha256(`${args.principal}:${t.sequence + 1}:${evDigest}:${Date.now()}`).slice(0, 32),
    sequence: t.sequence + 1,
    previousLegHash: t.lastHash,
    counterparty: { providerKeyId: providerKeyId(home) },
    requester: { principal: args.principal, keyRef: args.requesterKeyRef ?? null },
    meter: {
      policyVersion: "inference-policy/v1",
      inputTokens: Math.round(args.inputTokens),
      outputTokens: Math.round(args.outputTokens),
      policyDigest: args.policyDigest,
    },
    // The full buyer-ratified binding: request/prompt/response bytes digests,
    // input & billable-output token-ID-sequence digests+counts, model digests,
    // and the emitted-only/special-token rules.
    evidence: { ...args.evidence, snapshot: new Date().toISOString() },
    pricing: { costMicroTrac: cost, unit: "mockTRAC-u" },
    tab: { before, after },
    settlement: { status: "pending-countersignature" as const },
  };
  const preimage = Buffer.concat([Buffer.from(LEG_DOMAIN + "\n"), Buffer.from(canonicalize(leg))]);
  const providerSignature = edSign(null, preimage, createPrivateKey(providerKeys(home).privatePem)).toString("base64");
  const signed = { ...leg, providerSignature };
  const hash = sha256(canonicalize(signed));

  durableAppend(home, { kind: "debit", principal: args.principal, epoch: t.epoch, hash, leg: signed });
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
    units: COEFFICIENTS_CANONICAL.F_base / COEFFICIENTS_CANONICAL.scale,
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

/**
 * Idempotent, observable refund (Bo's amendment). Appending twice is a no-op:
 * the journal records exactly one refund per (principal, tabDigest), and the
 * balance goes to zero. Observability = the refund record itself, replayable
 * by the buyer's verifier.
 */
export function refundOnExpiry(home: string, principal: string, refundAddress: string, termsDigest: string) {
  replay(home);
  const t = entry(home, principal);
  // A tab settled on-chain must never be refunded — that would pay twice.
  if (t.settled) {
    return { alreadyRefunded: true, refundedMicroTrac: 0, at: t.settled.at, settled: true };
  }
  // Idempotency is scoped to the CURRENT EPOCH, not to (principal, termsDigest)
  // (Bo #3): reusing a terms digest on a later epoch must not inherit an old
  // refund marker. The current epoch already carries its terminal `refunded`
  // state if it was refunded, so this is a durable per-epoch check.
  if (t.refunded) {
    return { alreadyRefunded: true, refundedMicroTrac: t.refunded.amountMicroTrac, at: t.refunded.at, epoch: t.epoch };
  }
  const amount = Math.max(0, t.balance);
  const at = new Date().toISOString();
  durableAppend(home, {
    kind: "refund", principal, epoch: t.epoch, amountMicroTrac: amount, refundAddress, termsDigest,
    reason: "tab-expiry", terminal: true, at,
  });
  t.balance = 0;
  t.refunded = { amountMicroTrac: amount, refundAddress, termsDigest, at };   // terminal for this epoch
  return { alreadyRefunded: false, refundedMicroTrac: amount, epoch: t.epoch, at };
}

/**
 * Shadow observation journal (D11 calibration corpus).
 *
 * Operator-found, 2026-08-06: the 48-hour shadow window was reported as
 * "producing the calibration corpus" while `shadow` mode persisted NOTHING —
 * it computed a metering block, attached it to the HTTP response, and dropped
 * it. Only non-exempt principals ever reached `recordReadLeg`, and there were
 * none, so `~/.dkg-mainnet/metering/` held nothing but a config file. A window
 * that stores no observations is not a window.
 *
 * What is retained is deliberately narrow: the structural features calibration
 * actually needs, plus wall time to test the request-derived-units argument.
 * The query TEXT is never written — only its digest — so a long-running window
 * on a production node does not accumulate a log of what was asked.
 */
export function recordShadowObservation(home: string, obs: {
  units: number;
  breakdown: Record<string, unknown>;
  scopeQuads: number;
  responseBytes: number;
  sparql: string;
  askMicroPer1k: number;
  costMicroTrac: number;
  mode: string;
  billable: boolean;
  wallMs?: number;
  contextGraphId?: string;
  view?: string;
}): void {
  try {
    const dir = `${home}/metering`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const rec = {
      at: new Date().toISOString(),
      scheduleVersion: SCHEDULE_VERSION,
      // digest, never the text
      queryDigest: "sha256:" + createHash("sha256").update(obs.sparql).digest("hex"),
      queryChars: obs.sparql.length,
      units: obs.units,
      breakdown: obs.breakdown,
      scopeQuads: obs.scopeQuads,
      responseBytes: obs.responseBytes,
      askMicroPer1k: obs.askMicroPer1k,
      costMicroTrac: obs.costMicroTrac,
      mode: obs.mode,
      billable: obs.billable,
      wallMs: obs.wallMs ?? null,
      contextGraphId: obs.contextGraphId ?? null,
      view: obs.view ?? null,
    };
    appendFileSync(`${dir}/shadow-observations.jsonl`, JSON.stringify(rec) + "\n");
  } catch { /* observation must never break serving */ }
}

// ── settlement support ───────────────────────────────────────────────────────
// Exposed for the settlement module (V2-B5). Kept here because provider key
// custody and journal I/O live here and must not be duplicated: two code paths
// signing with two notions of "the provider key" is how a close statement ends
// up signed by a key the leg receipts were not.

/** The provider's public PEM — what a buyer verifies close statements against. */
export function providerPublicPem(home: string): string {
  return providerKeys(home).publicPem;
}

/** Sign `material` under a domain with the provider key. Same key as leg receipts. */
export function providerSign(home: string, domain: string, material: string): string {
  const preimage = Buffer.concat([Buffer.from(domain + "\n"), Buffer.from(material)]);
  return edSign(null, preimage, createPrivateKey(providerKeys(home).privatePem)).toString("base64");
}

/** Read the durable journal as parsed records, replaying nothing. For settlement
 *  replay, which must derive state from journal + chain, never from live balance. */
export function readJournal(home: string): Array<Record<string, unknown>> {
  const p = journalPath(home);
  if (!existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn tail line */ }
  }
  return out;
}

/** Append a settlement/withdrawal record durably (fsync before returning). */
export function appendJournal(home: string, record: Record<string, unknown>): void {
  durableAppend(home, record);
}


/**
 * Reconcile a tab against a CONFIRMED on-chain settlement (buyer-found, Bo).
 * Zeros the buyer-visible balance and records the settlement so the tab reads
 * as closed with no residual claim, and so expiry can never double-refund it.
 * Idempotent by withdrawalId: replaying or re-confirming appends nothing new.
 */
export function settleTab(home: string, principal: string, info: { withdrawalId: string; txHash: string; netPaidMicroTrac: number; expectedEpoch?: number }): { ok: boolean; alreadySettled: boolean; code?: string } {
  replay(home);
  const t = entry(home, principal);
  // Expected-epoch CAS (Bo #1): a withdrawal prepared against a PRIOR epoch must
  // never settle the CURRENT one. A stale/conflicting epoch fails closed with no
  // state change — it cannot zero or erase a fresh tab.
  if (info.expectedEpoch !== undefined && info.expectedEpoch !== t.epoch) {
    return { ok: false, alreadySettled: false, code: "E_SETTLE_EPOCH_MISMATCH" };
  }
  if (t.settled) return { ok: true, alreadySettled: true };
  // ONE timestamp: the journal record and the in-memory state must carry the
  // identical `at`, or the buyer-visible settlement receipt changes across a
  // restart (live used a second new Date()). Found by the tab-epoch replay gate.
  const at = new Date().toISOString();
  durableAppend(home, {
    kind: "settled", principal, withdrawalId: info.withdrawalId, txHash: info.txHash,
    netPaidMicroTrac: info.netPaidMicroTrac, at,
  });
  t.balance = 0;
  t.settled = { ...info, at };
  return { ok: true, alreadySettled: false };
}

/** The confirmed settlement for a principal, or null. Buyer-visible receipt. */
export function settlementOf(home: string, principal: string): { withdrawalId: string; txHash: string; netPaidMicroTrac: number; at: string } | null {
  replay(home);
  const st = entry(home, principal).settled;
  return st ? { ...st } : null;      // deep-enough copy: caller cannot mutate module state (Bo #4)
}

/** Which tab lifecycle this principal is on. 0 = first tab. Incremented each
 *  time a new deposit opens a fresh tab after a prior terminal (settled/refunded) tab. */
export function tabEpoch(home: string, principal: string): number {
  replay(home);
  return entry(home, principal).epoch;
}

/** The epoch a FRESH deposit would open right now: current epoch, or the next
 *  one if the current tab is terminal (settled or refunded). Used to bind a
 *  funded-run quote to the exact fresh epoch (Bo, deposit-stage). */
export function nextEpochFor(home: string, principal: string): number {
  replay(home);
  const t = entry(home, principal);
  return (t.settled || t.refunded) ? t.epoch + 1 : t.epoch;
}

/** Terminal state of the current epoch — exposed so a buyer sees a clean
 *  pre-credit read for a fresh run. */
export function tabTerminalState(home: string, principal: string): { settled: boolean; refunded: boolean } {
  replay(home);
  const t = entry(home, principal);
  return { settled: !!t.settled, refunded: !!t.refunded };
}

/** Every PRIOR settlement for a principal (the current epoch's, if any, is in
 *  settlementOf). A prior settlement is immutable audit history and is never
 *  overwritten by opening a new tab. */
export function settlementHistoryOf(home: string, principal: string): Settlement[] {
  replay(home);
  return entry(home, principal).settlementHistory.map((x) => ({ ...x }));   // immutable snapshots (Bo #4)
}
