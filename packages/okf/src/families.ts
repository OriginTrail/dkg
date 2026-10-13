/**
 * OKF v0.2 frontmatter families → RDF (SPEC §5 provenance / trust / lifecycle,
 * §7 actors, §10 attested computations), plus the context-free shape
 * diagnostics the validator and the mapper share.
 *
 * Design (CONTEXT.md "v0.2 families"):
 *   - single-valued fields sit flat on the concept (`okf:generatedBy`,
 *     `schema:dateModified`, `okf:status`, `okf:staleAfter`, `okf:runtime`,
 *     `okf:computation`, `okf:executor*`, `okf:attester*`);
 *   - list-valued families (`sources`, `verified`, `parameters`) become one
 *     skolemized node per entry, reached by `okf:source` / `okf:verification` /
 *     `okf:parameter`, with the entry index baked into the node IRI so export
 *     restores the original order;
 *   - every path-valued field is resolved against the bundle: a concept
 *     becomes a typed edge (and `sources[].resource` additionally a
 *     `prov:wasDerivedFrom` lineage edge), an absolute URL an IRI, anything
 *     else a literal;
 *   - the §5.3 trust tier is derived once and materialised as `okf:trustTier`
 *     when the concept carries at least one verifier. Absence ⇒ `unverified`.
 *
 * Nothing here is inferred from prose; every triple is a pure function of the
 * frontmatter. Unknown keys inside a family are preserved, never dropped.
 */

import {
  RDF_TYPE,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  PROV_WAS_DERIVED_FROM,
  OKF_GENERATED_BY,
  OKF_GENERATED_PREFIX,
  OKF_VERIFICATION,
  OKF_VERIFIED_BY,
  OKF_VERIFIED_AT,
  OKF_TRUST_TIER,
  OKF_STATUS,
  OKF_STALE_AFTER,
  OKF_SOURCE,
  OKF_RESOURCE,
  OKF_AUTHOR,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
  OKF_RUNTIME,
  OKF_PARAMETER,
  OKF_PARAMETER_TYPE,
  OKF_REQUIRED,
  OKF_COMPUTATION,
  OKF_EXECUTOR_PREFIX,
  OKF_EXECUTOR_RESOURCE,
  OKF_EXECUTOR_RECEIPT,
  OKF_ATTESTER_PREFIX,
  OKF_ATTESTER_RESOURCE,
  OKF_CLASS_VERIFICATION,
  OKF_CLASS_SOURCE,
  OKF_CLASS_PARAMETER,
  SECTION_GENID_INFIX,
  GENID_TAGS,
  XSD_BOOLEAN,
  XSD_INTEGER,
} from './constants.js';
import { literalTerm, typedLiteralTerm, pascalCase, sanitizeForBlank } from './utils.js';
import {
  dateTimeLexical,
  hasExplicitOffset,
  isKnownStatus,
  isXsdDateTime,
  normalizeVerified,
  deriveTrustTier,
} from './trust.js';
import {
  actorTerm,
  dateTerm,
  genericQuads,
  isAttestedComputationType,
  isMapping,
  pathFieldTerm,
  toArray,
  valueToTerms,
  type PathContext,
} from './terms.js';
import type { OkfWarning, Quad } from './types.js';

/** Frontmatter keys owned by the v0.2 families (SPEC §13.2). Everything else is a producer key. */
export const V02_FAMILY_KEYS: ReadonlySet<string> = new Set([
  'generated',
  'verified',
  'status',
  'stale_after',
  'sources',
  'usage_window',
  'runtime',
  'parameters',
  'computation',
  'executor',
  'attester',
]);

export interface FamilyResult {
  quads: Quad[];
  /** Bundle concepts named by `sources[].resource` (lineage edges). */
  derivedFromConcepts: string[];
  /** Context-dependent diagnostics only (unresolved bundle paths); shape issues come from `familyDiagnostics`. */
  warnings: OkfWarning[];
}

type Diagnostic = Pick<OkfWarning, 'code' | 'message'>;

function nodeIri(iri: string, tag: string, nodeKey: string, index: number): string {
  return `${iri}${SECTION_GENID_INFIX}${tag}${sanitizeForBlank(nodeKey)}_${index}`;
}

/** Producer-defined keys on a family node, preserved under the generic `schema:` convention. */
function extraQuads(subject: string, obj: Record<string, unknown>, known: ReadonlySet<string>): Quad[] {
  const out: Quad[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k) || v === null || v === undefined) continue;
    out.push(...genericQuads(subject, k, v));
  }
  return out;
}

/** Producer-defined keys nested in a single-valued family (`generated`, `executor`, `attester`): `<prefix><PascalKey>`. */
function prefixedExtraQuads(
  subject: string,
  prefix: string,
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
): Quad[] {
  const out: Quad[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k) || v === null || v === undefined) continue;
    const predicate = prefix + pascalCase(k);
    for (const object of valueToTerms(v)) out.push({ subject, predicate, object });
  }
  return out;
}

function pushDate(out: Quad[], subject: string, predicate: string, value: unknown): void {
  const t = dateTerm(value);
  if (t) out.push({ subject, predicate, object: t });
}

function usageWindowQuads(subject: string, value: unknown): Quad[] {
  if (!isMapping(value)) return genericQuads(subject, 'usage_window', value);
  const out: Quad[] = [];
  pushDate(out, subject, OKF_USAGE_WINDOW_FROM, value.from);
  pushDate(out, subject, OKF_USAGE_WINDOW_TO, value.to);
  return out;
}

const GENERATED_KNOWN = new Set(['by', 'at']);
const VERIFIED_KNOWN = new Set(['by', 'at']);
const SOURCE_KNOWN = new Set(['id', 'title', 'resource', 'author', 'usage_count', 'last_modified', 'usage_window']);
const PARAMETER_KNOWN = new Set(['name', 'type', 'required']);
const EXECUTOR_KNOWN = new Set(['resource', 'receipt']);
const ATTESTER_KNOWN = new Set(['resource']);

/**
 * Map one v0.2 family key. `frontmatter` is the whole block (the trust tier
 * needs `verified`; the Attested Computation check needs `type`).
 */
export function familyQuads(
  iri: string,
  key: string,
  value: unknown,
  frontmatter: Record<string, unknown>,
  ctx: PathContext,
): FamilyResult {
  const quads: Quad[] = [];
  const derivedFromConcepts: string[] = [];
  const warnings: OkfWarning[] = [];
  const nodeKey = ctx.conceptId;

  const resolvePath = (field: string, raw: unknown, subject: string, predicate: string): string | undefined => {
    const r = pathFieldTerm(raw, ctx);
    quads.push({ subject, predicate, object: r.term });
    if (r.unresolvedConceptPath) {
      warnings.push({
        conceptId: ctx.conceptId,
        code: 'broken-link',
        message: `${field} "${String(raw).trim()}" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)`,
      });
    }
    return r.conceptId;
  };

  switch (key) {
    case 'generated': {
      if (!isMapping(value)) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      if (value.by !== undefined && value.by !== null && String(value.by).trim() !== '') {
        quads.push({ subject: iri, predicate: OKF_GENERATED_BY, object: actorTerm(value.by) });
      }
      pushDate(quads, iri, SCHEMA_DATE_MODIFIED, value.at);
      quads.push(...prefixedExtraQuads(iri, OKF_GENERATED_PREFIX, value, GENERATED_KNOWN));
      break;
    }

    case 'verified': {
      const raw: unknown[] | null = Array.isArray(value) ? value : isMapping(value) ? [value] : null;
      if (raw === null) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      let events = 0;
      raw.forEach((entry, i) => {
        if (!isMapping(entry)) return;
        if (entry.by === undefined || entry.by === null || String(entry.by).trim() === '') return;
        events += 1;
        const node = nodeIri(iri, GENID_TAGS.verification, nodeKey, i);
        quads.push({ subject: iri, predicate: OKF_VERIFICATION, object: node });
        quads.push({ subject: node, predicate: RDF_TYPE, object: OKF_CLASS_VERIFICATION });
        quads.push({ subject: node, predicate: OKF_VERIFIED_BY, object: actorTerm(entry.by) });
        pushDate(quads, node, OKF_VERIFIED_AT, entry.at);
        quads.push(...extraQuads(node, entry, VERIFIED_KNOWN));
      });
      if (events > 0) {
        quads.push({ subject: iri, predicate: OKF_TRUST_TIER, object: literalTerm(deriveTrustTier(value)) });
      }
      break;
    }

    case 'status':
      quads.push({ subject: iri, predicate: OKF_STATUS, object: literalTerm(String(value).trim()) });
      break;

    case 'stale_after':
      pushDate(quads, iri, OKF_STALE_AFTER, value);
      break;

    case 'sources': {
      const raw: unknown[] | null = Array.isArray(value) ? value : isMapping(value) ? [value] : null;
      if (raw === null) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      raw.forEach((entry, i) => {
        if (!isMapping(entry)) return;
        const node = nodeIri(iri, GENID_TAGS.source, nodeKey, i);
        quads.push({ subject: iri, predicate: OKF_SOURCE, object: node });
        quads.push({ subject: node, predicate: RDF_TYPE, object: OKF_CLASS_SOURCE });
        if (entry.id !== undefined && entry.id !== null) {
          quads.push({ subject: node, predicate: SCHEMA_IDENTIFIER, object: literalTerm(String(entry.id)) });
        }
        if (entry.title !== undefined && entry.title !== null) {
          quads.push({ subject: node, predicate: SCHEMA_NAME, object: literalTerm(String(entry.title)) });
        }
        if (entry.resource !== undefined && entry.resource !== null) {
          const r = pathFieldTerm(entry.resource, ctx);
          quads.push({ subject: node, predicate: OKF_RESOURCE, object: r.term });
          if (r.conceptId) {
            derivedFromConcepts.push(r.conceptId);
            quads.push({ subject: iri, predicate: PROV_WAS_DERIVED_FROM, object: r.term });
          } else if (!r.term.startsWith('"')) {
            quads.push({ subject: iri, predicate: PROV_WAS_DERIVED_FROM, object: r.term });
          } else if (r.unresolvedConceptPath) {
            warnings.push({
              conceptId: ctx.conceptId,
              code: 'broken-link',
              message: `sources[${i}].resource "${String(entry.resource).trim()}" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)`,
            });
          }
        }
        if (entry.author !== undefined && entry.author !== null) {
          quads.push({ subject: node, predicate: OKF_AUTHOR, object: actorTerm(entry.author) });
        }
        if (entry.usage_count !== undefined && entry.usage_count !== null) {
          const n = entry.usage_count;
          const object =
            typeof n === 'number' && Number.isInteger(n)
              ? typedLiteralTerm(String(n), XSD_INTEGER)
              : valueToTerms(n)[0];
          if (object) quads.push({ subject: node, predicate: OKF_USAGE_COUNT, object });
        }
        pushDate(quads, node, SCHEMA_DATE_MODIFIED, entry.last_modified);
        if (entry.usage_window !== undefined && entry.usage_window !== null) {
          quads.push(...usageWindowQuads(node, entry.usage_window));
        }
        quads.push(...extraQuads(node, entry, SOURCE_KNOWN));
      });
      break;
    }

    case 'usage_window':
      quads.push(...usageWindowQuads(iri, value));
      break;

    case 'runtime':
      quads.push({ subject: iri, predicate: OKF_RUNTIME, object: literalTerm(String(value).trim()) });
      break;

    case 'parameters': {
      if (!Array.isArray(value)) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      value.forEach((entry, i) => {
        if (!isMapping(entry)) return;
        const node = nodeIri(iri, GENID_TAGS.parameter, nodeKey, i);
        quads.push({ subject: iri, predicate: OKF_PARAMETER, object: node });
        quads.push({ subject: node, predicate: RDF_TYPE, object: OKF_CLASS_PARAMETER });
        if (entry.name !== undefined && entry.name !== null) {
          quads.push({ subject: node, predicate: SCHEMA_NAME, object: literalTerm(String(entry.name)) });
        }
        if (entry.type !== undefined && entry.type !== null) {
          quads.push({ subject: node, predicate: OKF_PARAMETER_TYPE, object: literalTerm(String(entry.type)) });
        }
        if (entry.required !== undefined && entry.required !== null) {
          const object =
            typeof entry.required === 'boolean'
              ? typedLiteralTerm(String(entry.required), XSD_BOOLEAN)
              : valueToTerms(entry.required)[0];
          if (object) quads.push({ subject: node, predicate: OKF_REQUIRED, object });
        }
        quads.push(...extraQuads(node, entry, PARAMETER_KNOWN));
      });
      break;
    }

    case 'computation':
      resolvePath('computation', value, iri, OKF_COMPUTATION);
      break;

    case 'executor': {
      if (!isMapping(value)) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      if (value.resource !== undefined && value.resource !== null) {
        resolvePath('executor.resource', value.resource, iri, OKF_EXECUTOR_RESOURCE);
      }
      if (value.receipt !== undefined && value.receipt !== null) {
        for (const field of toArray(value.receipt)) {
          quads.push({ subject: iri, predicate: OKF_EXECUTOR_RECEIPT, object: literalTerm(String(field)) });
        }
      }
      quads.push(...prefixedExtraQuads(iri, OKF_EXECUTOR_PREFIX, value, EXECUTOR_KNOWN));
      break;
    }

    case 'attester': {
      if (!isMapping(value)) {
        quads.push(...genericQuads(iri, key, value));
        break;
      }
      if (value.resource !== undefined && value.resource !== null) {
        resolvePath('attester.resource', value.resource, iri, OKF_ATTESTER_RESOURCE);
      }
      quads.push(...prefixedExtraQuads(iri, OKF_ATTESTER_PREFIX, value, ATTESTER_KNOWN));
      break;
    }

    default:
      quads.push(...genericQuads(iri, key, value));
  }

  void frontmatter;
  return { quads, derivedFromConcepts, warnings };
}

function checkDateTime(field: string, value: unknown, out: Diagnostic[]): void {
  if (value === undefined || value === null) return;
  const lexical = dateTimeLexical(value);
  if (lexical === null || !isXsdDateTime(lexical)) {
    out.push({
      code: 'malformed-family',
      message: `${field} "${String(value)}" is not a valid ISO 8601 datetime (§5); kept as a plain literal`,
    });
    return;
  }
  if (!hasExplicitOffset(lexical)) {
    out.push({
      code: 'malformed-family',
      message: `${field} "${lexical}" has no explicit UTC offset (§5 requires one, e.g. 2026-06-30T14:00:00Z)`,
    });
  }
}

function checkUsageWindow(field: string, value: unknown, out: Diagnostic[]): void {
  if (value === undefined || value === null) return;
  if (!isMapping(value)) {
    out.push({ code: 'malformed-family', message: `${field} must be a \`{ from, to }\` mapping (§5.1); preserved verbatim` });
    return;
  }
  checkDateTime(`${field}.from`, value.from, out);
  checkDateTime(`${field}.to`, value.to, out);
}

/**
 * Context-free shape checks for the v0.2 families (SPEC §5, §10). These are
 * SHOULD-level producer rules; a consumer MUST NOT reject for any of them
 * (§11), so every finding is a warning. Shared by `validateBundle` and the
 * mapper so the two never disagree.
 */
export function familyDiagnostics(frontmatter: Record<string, unknown>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const fm = frontmatter;

  if (fm.generated !== undefined && fm.generated !== null) {
    if (!isMapping(fm.generated)) {
      out.push({ code: 'malformed-family', message: '`generated` must be a `{ by, at }` mapping (§5.2); preserved verbatim' });
    } else {
      if (fm.generated.by === undefined || fm.generated.by === null || String(fm.generated.by).trim() === '') {
        out.push({ code: 'malformed-family', message: '`generated.by` is required within `generated` (§5.2)' });
      }
      checkDateTime('`generated.at`', fm.generated.at, out);
    }
  }

  if (fm.verified !== undefined && fm.verified !== null) {
    const raw: unknown[] | null = Array.isArray(fm.verified) ? fm.verified : isMapping(fm.verified) ? [fm.verified] : null;
    if (raw === null) {
      out.push({ code: 'malformed-family', message: '`verified` must be a `{ by, at }` mapping or a list of them (§5.2); preserved verbatim' });
    } else {
      raw.forEach((entry, i) => {
        if (!isMapping(entry)) {
          out.push({ code: 'malformed-family', message: `\`verified[${i}]\` is not a \`{ by, at }\` mapping (§5.2); skipped` });
          return;
        }
        if (entry.by === undefined || entry.by === null || String(entry.by).trim() === '') {
          out.push({ code: 'malformed-family', message: `\`verified[${i}].by\` is missing (§5.2); the event cannot name a verifier and is skipped` });
        }
        checkDateTime(`\`verified[${i}].at\``, entry.at, out);
      });
    }
  }

  if (fm.status !== undefined && fm.status !== null) {
    const s = String(fm.status).trim();
    if (!isKnownStatus(s)) {
      out.push({ code: 'malformed-family', message: `\`status\` "${s}" is not one of draft | stable | deprecated (§5.4); kept verbatim` });
    }
  }

  checkDateTime('`stale_after`', fm.stale_after, out);

  if (fm.sources !== undefined && fm.sources !== null) {
    const raw: unknown[] | null = Array.isArray(fm.sources) ? fm.sources : isMapping(fm.sources) ? [fm.sources] : null;
    if (raw === null) {
      out.push({ code: 'malformed-family', message: '`sources` must be a list of entries (§5.1); preserved verbatim' });
    } else {
      raw.forEach((entry, i) => {
        if (!isMapping(entry)) {
          out.push({ code: 'malformed-family', message: `\`sources[${i}]\` is not a mapping (§5.1); skipped` });
          return;
        }
        if (entry.resource === undefined || entry.resource === null || String(entry.resource).trim() === '') {
          out.push({ code: 'malformed-family', message: `\`sources[${i}].resource\` is required within an entry (§5.1)` });
        }
        if (entry.usage_count !== undefined && entry.usage_count !== null) {
          if (typeof entry.usage_count !== 'number' || !Number.isInteger(entry.usage_count)) {
            out.push({ code: 'malformed-family', message: `\`sources[${i}].usage_count\` should be an integer (§5.1)` });
          }
        }
        checkDateTime(`\`sources[${i}].last_modified\``, entry.last_modified, out);
        checkUsageWindow(`\`sources[${i}].usage_window\``, entry.usage_window, out);
      });
    }
  }

  checkUsageWindow('`usage_window`', fm.usage_window, out);

  if (isAttestedComputationType(fm.type) && (fm.runtime === undefined || fm.runtime === null || String(fm.runtime).trim() === '')) {
    out.push({ code: 'malformed-family', message: '`runtime` is required for an `Attested Computation` concept (§10.2)' });
  }

  if (fm.parameters !== undefined && fm.parameters !== null) {
    if (!Array.isArray(fm.parameters)) {
      out.push({ code: 'malformed-family', message: '`parameters` must be a list of `{ name, type, required }` entries (§10.2); preserved verbatim' });
    } else {
      fm.parameters.forEach((entry, i) => {
        if (!isMapping(entry)) {
          out.push({ code: 'malformed-family', message: `\`parameters[${i}]\` is not a mapping (§10.2); skipped` });
        } else if (entry.name === undefined || entry.name === null || String(entry.name).trim() === '') {
          out.push({ code: 'malformed-family', message: `\`parameters[${i}].name\` is missing (§10.2)` });
        }
      });
    }
  }

  for (const key of ['executor', 'attester'] as const) {
    if (fm[key] !== undefined && fm[key] !== null && !isMapping(fm[key])) {
      out.push({ code: 'malformed-family', message: `\`${key}\` must be a mapping with a \`resource\` (§10.2); preserved verbatim` });
    }
  }

  return out;
}

/** The `sources[].id` labels a body footnote may join against (§5.1). */
export function sourceIds(frontmatter: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const raw: unknown[] = Array.isArray(frontmatter.sources)
    ? frontmatter.sources
    : isMapping(frontmatter.sources)
      ? [frontmatter.sources]
      : [];
  for (const entry of raw) {
    if (isMapping(entry) && entry.id !== undefined && entry.id !== null) ids.add(String(entry.id));
  }
  return ids;
}

/** True when the document declares a `sources` family at all (footnote checks apply only then). */
export function declaresSources(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.sources !== undefined && frontmatter.sources !== null;
}

export { normalizeVerified };
