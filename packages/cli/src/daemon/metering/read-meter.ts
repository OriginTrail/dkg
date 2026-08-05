// V2-B2 — node-integrated read metering (read-schedule/1.0-provisional).
//
// Ratified design points this file implements:
//  D8  enforcement lives on the query route, not in a sidecar;
//  D7  U = F_base + w_out·KiB + M·S/S0, marker vocabulary frozen,
//      coefficients provisional; billable failure = base fee;
//  D12 protocol-internal reads are PROVABLY exempt (zero ledger mutation);
//  C.3 shadow mode: meter + receipt everything, debit nothing, until the
//      operator flips enforcement per principal.
//
// The unit implementation is intentionally duplicated from the standalone
// `read-schedule` package rather than imported: the node must not depend on
// a workspace-external module, and TWO independent implementations agreeing
// is itself the D6/D7 cross-implementation gate. Any divergence is a bug in
// one of them and the golden vectors will show it.

export const SCHEDULE_VERSION = "read-schedule/1.0-provisional";

export type MeterMode = "off" | "shadow" | "enforce";

export interface MeterConfig {
  mode: MeterMode;
  /** TRAC micro-units per 1000 U. Advertised in /api/status. */
  readAskMicroPer1k: number;
  /** Principals (agent addresses / token subjects) exempt from billing. */
  exemptPrincipals: Set<string>;
  /** Enforcement allowlist; empty ⇒ nobody is enforced (shadow for all). */
  enforcedPrincipals: Set<string>;
}

export const COEFFICIENTS = Object.freeze({
  F_base: 1,
  w_out: 0.25,
  S0: 10000,
  markers: Object.freeze({ scan: 1, aggregate: 1.5, text: 1.5, path: 2, cartesian: 200 }),
  roundTo: 0.1,
});

const KEYWORDS =
  /\b(SELECT|WHERE|FILTER|OPTIONAL|UNION|GRAPH|BIND|VALUES|GROUP|ORDER|HAVING|LIMIT|OFFSET|DISTINCT|REDUCED|MINUS|SERVICE|CONSTRUCT|ASK|DESCRIBE|FROM|AS|BY)\b/gi;
const AGG_FUNCS = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|SAMPLE)\s*\(/i;
const TEXT_FUNCS = /\b(CONTAINS|REGEX|STRSTARTS|STRENDS|LCASE|UCASE)\s*\(/i;

function stripLiterals(sparql: string): string {
  let out = "";
  let i = 0;
  const s = String(sparql);
  while (i < s.length) {
    const c = s[i];
    if (c === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "<") {
      const j = s.indexOf(">", i);
      if (j > -1 && !/\s/.test(s.slice(i, j))) {
        const mod = /^[*+?]/.test(s.slice(j + 1)) ? s[j + 1] : "";
        out += ` IRI${mod} `;
        i = j + 1 + mod.length;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const triple = s.slice(i, i + 3) === c.repeat(3);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < s.length) {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s.slice(j, j + q.length) === q) break;
        j++;
      }
      out += " LIT ";
      i = j + q.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** See read-schedule/src/schedule.mjs for the normative description. */
function extractPatterns(sparql: string): string[][] {
  const first = sparql.indexOf("{");
  const body = first === -1 ? sparql : sparql.slice(first + 1);
  const toks = body
    .replace(/([{}(),;.])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const patterns: string[][] = [];
  let terms: string[] = [];
  let lastSubject: string | null = null;
  let lastPredicate: string | null = null;
  const flush = () => {
    if (terms.length >= 3) {
      patterns.push([terms[0], terms[1], terms[2]]);
      lastSubject = terms[0];
      lastPredicate = terms[1];
    }
    terms = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^(FILTER|BIND|VALUES|HAVING|SERVICE)$/i.test(t)) {
      flush();
      let depth = 0;
      let started = false;
      for (i++; i < toks.length; i++) {
        if (toks[i] === "(") { depth++; started = true; continue; }
        if (toks[i] === ")") { depth--; if (started && depth <= 0) break; continue; }
        if (!started && (toks[i] === "." || toks[i] === "}")) { i--; break; }
      }
      continue;
    }
    if (t === ".") { flush(); lastSubject = null; lastPredicate = null; continue; }
    if (t === ";") { flush(); terms = lastSubject ? [lastSubject] : []; continue; }
    if (t === ",") { flush(); terms = lastSubject && lastPredicate ? [lastSubject, lastPredicate] : []; continue; }
    if (t === "{" || t === "}" || /^(UNION|OPTIONAL|MINUS|GRAPH)$/i.test(t)) {
      flush(); lastSubject = null; lastPredicate = null; continue;
    }
    if (t === "(" || t === ")") continue;
    KEYWORDS.lastIndex = 0;
    if (KEYWORDS.test(t)) { KEYWORDS.lastIndex = 0; flush(); lastSubject = null; lastPredicate = null; continue; }
    KEYWORDS.lastIndex = 0;
    terms.push(t);
    if (terms.length === 3) flush();
  }
  flush();
  return patterns;
}

const isVar = (t: string) => typeof t === "string" && (t.startsWith("?") || t.startsWith("$"));

export function detectMarkers(sparql: string): { markers: Record<string, number>; M: number } {
  const s = stripLiterals(sparql);
  const patterns = extractPatterns(s);
  const found: Record<string, number> = {};
  const bump = (k: string) => { found[k] = (found[k] ?? 0) + 1; };

  const boundByBind = new Set<string>();
  for (const m of s.matchAll(/\bBIND\s*\([^)]*\bAS\s+(\?\w+|\$\w+)/gi)) boundByBind.add(m[1]);
  for (const m of s.matchAll(/\bVALUES\s+(\?\w+|\$\w+)/gi)) boundByBind.add(m[1]);
  for (const m of s.matchAll(/\bVALUES\s*\(([^)]*)\)/gi))
    for (const v of m[1].split(/\s+/).filter(isVar)) boundByBind.add(v);

  const reachable = new Set<string>(boundByBind);
  const scanVars = new Set<string>();
  for (const [sub, , obj] of patterns) {
    const subBound = !isVar(sub) || reachable.has(sub);
    if (subBound) {
      if (isVar(sub)) reachable.add(sub);
      if (isVar(obj)) reachable.add(obj);
    } else {
      bump("scan");
      scanVars.add(sub);
      reachable.add(sub);
      if (isVar(obj)) reachable.add(obj);
    }
  }

  const hasOrderBy = /\bORDER\s+BY\b/i.test(s);
  if (/\bGROUP\s+BY\b/i.test(s) || AGG_FUNCS.test(s) || (hasOrderBy && found.scan)) bump("aggregate");
  if (TEXT_FUNCS.test(s)) bump("text");
  for (const [sub, pred] of patterns) {
    if (typeof pred === "string" && /[*+]/.test(pred) && !/^[?$]/.test(pred)) {
      if (isVar(sub) && !boundByBind.has(sub)) { bump("path"); break; }
    }
  }
  if (!found.path && /\)\s*[*+]/.test(s) && found.scan) bump("path");

  if (scanVars.size >= 2) {
    const parent = new Map<string, string>();
    const seen = (v: string) => { if (!parent.has(v)) parent.set(v, v); };
    const find = (x: string): string => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
      return x;
    };
    const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const p of patterns) {
      const vars = p.filter(isVar);
      vars.forEach(seen);
      for (let k = 1; k < vars.length; k++) union(vars[0], vars[k]);
    }
    const comps = new Set([...scanVars].filter((v) => parent.has(v)).map(find));
    if (comps.size >= 2) bump("cartesian");
  }

  const M = Object.entries(found).reduce(
    (acc, [k, n]) => acc + ((COEFFICIENTS.markers as Record<string, number>)[k] ?? 0) * n,
    0,
  );
  return { markers: found, M };
}

const ceilTo = (x: number, step: number) => Math.round(Math.ceil(x / step - 1e-9) * step * 1e6) / 1e6;

export interface UnitResult {
  units: number;
  scheduleVersion: string;
  error: boolean;
  breakdown: { base: number; egress: number; scope: number; markers: Record<string, number>; M: number; kib: number };
}

export function computeUnits(args: {
  sparql: string;
  scopeQuads: number;
  responseBytes: number;
  error?: boolean;
}): UnitResult {
  const { F_base, w_out, S0, roundTo } = COEFFICIENTS;
  if (args.error) {
    return {
      units: ceilTo(F_base, roundTo),
      scheduleVersion: SCHEDULE_VERSION,
      error: true,
      breakdown: { base: F_base, egress: 0, scope: 0, markers: {}, M: 0, kib: 0 },
    };
  }
  const kib = Math.ceil(Math.max(0, Number(args.responseBytes) || 0) / 1024);
  const { markers, M } = detectMarkers(args.sparql);
  const egress = w_out * kib;
  const scope = M * (Math.max(0, Number(args.scopeQuads) || 0) / S0);
  return {
    units: ceilTo(F_base + egress + scope, roundTo),
    scheduleVersion: SCHEDULE_VERSION,
    error: false,
    breakdown: {
      base: F_base,
      egress: Math.round(egress * 1e6) / 1e6,
      scope: Math.round(scope * 1e6) / 1e6,
      markers,
      M,
      kib,
    },
  };
}

export const costMicroTrac = (units: number, askMicroPer1k: number) =>
  Math.ceil((units * askMicroPer1k) / 1000);

/**
 * D12: protocol-internal reads must be provably exempt with ZERO ledger
 * mutation. Exemption is decided BEFORE any ledger call — the meter returns a
 * receipt-shaped record marked `billable:false` and never touches the tab.
 */
export function isExempt(principal: string | undefined, cfg: MeterConfig): boolean {
  if (!principal) return true;                       // node-internal / unauthenticated local
  if (cfg.exemptPrincipals.has(principal)) return true;
  if (cfg.mode !== "enforce") return true;           // shadow/off never bills
  return !cfg.enforcedPrincipals.has(principal);     // per-principal enforcement (Stage 3)
}
