import { WRITE_PREFLIGHT_SITES as AGENT_WRITE_PREFLIGHT_SITES, WRITE_PREFLIGHT_FAILURE_KINDS,
  type WritePreflightFailureKind } from '@origintrail-official/dkg-agent/write-preflight-attribution';

const WRITE_PREFLIGHT_DIAGNOSTIC_SITES = [...AGENT_WRITE_PREFLIGHT_SITES,
  'exact-probe', 'metadata', 'list', 'decision'] as const;
// The daemon owns the final payload budget independently of probe API changes.
const MAX_DIAGNOSTIC_FAILURES = 9;
export interface WritePreflightDiagnosticFailure {
  readonly site: typeof WRITE_PREFLIGHT_DIAGNOSTIC_SITES[number];
  readonly kind: WritePreflightFailureKind;
}

/** A bounded set of closed sites; its order is not a causal ordering. */
export function sanitizeWritePreflightFailures(input: unknown): WritePreflightDiagnosticFailure[] {
  const result: WritePreflightDiagnosticFailure[] = [];
  try {
    if (!Array.isArray(input)) return result;
    for (let i = 0; i < Math.min(input.length, MAX_DIAGNOSTIC_FAILURES); i++) {
      const row = input[i];
      const rawSite = row?.site; const rawKind = row?.kind;
      const site = WRITE_PREFLIGHT_DIAGNOSTIC_SITES.includes(rawSite) ? rawSite : 'decision';
      const kind = WRITE_PREFLIGHT_FAILURE_KINDS.includes(rawKind) ? rawKind : 'unknown';
      if (!result.some(value => value.site === site && value.kind === kind)) result.push({ site, kind });
    }
  } catch { result.push({ site: 'decision', kind: 'unknown' }); }
  return result.slice(0, MAX_DIAGNOSTIC_FAILURES);
}
