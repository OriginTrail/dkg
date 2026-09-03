import type { McpToolDefinition } from './schema.js';
import { scanSparqlPreflight } from './sparql-preflight-scanner.js';

export interface DkgToolValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_SPARQL_PREFLIGHT_CHARS = 65_536;

export interface SanitizedContextGraphArguments {
  args: Record<string, unknown>;
  removed: Array<'projectId' | 'contextGraphId'>;
  reasons: Array<{
    key: 'projectId' | 'contextGraphId';
    reason: 'config-path' | 'default-placeholder';
    value: unknown;
  }>;
}

export function isDkgConfigPath(value: unknown): boolean {
  return typeof value === 'string'
    && /(?:^|[/\\])(?:\.dkg[/\\])?config\.(?:ya?ml|json)$/i.test(value.trim());
}

export function isDefaultContextGraphPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return /^(?:the[-_ ]?)?default(?:[-_ ]?(?:context[-_ ]?graph)(?:[-_ ]?id)?)?$/.test(normalized)
    || /^(?:context[-_ ]?graph|project)[-_ ]?id$/.test(normalized);
}

export function referencesUnresolvedContextGraphAlias(value: string): boolean {
  return /\b(?:default|current)\s+(?:dkg\s+)?(?:context\s+graphs?|cgs?)\b/i.test(value)
    || /\b(?:context\s+graphs?|cgs?)\s+(?:called\s+)?(?:the\s+)?(?:default|current)\b/i.test(value);
}

/**
 * Ported from the qwen-dkg harness. Local models sometimes copy prose from a
 * schema description and send `.dkg/config.yaml` (or a placeholder such as
 * `default-context-graph-id`) as if it were a real graph id. Remove those
 * synthetic values before scope materialization so they can never reach MCP.
 */
export function sanitizeContextGraphArguments(
  args: Record<string, unknown>,
): SanitizedContextGraphArguments {
  const cleaned = { ...args };
  const removed: SanitizedContextGraphArguments['removed'] = [];
  const reasons: SanitizedContextGraphArguments['reasons'] = [];
  for (const key of ['projectId', 'contextGraphId'] as const) {
    const reason = isDkgConfigPath(cleaned[key])
      ? 'config-path' as const
      : isDefaultContextGraphPlaceholder(cleaned[key])
        ? 'default-placeholder' as const
        : undefined;
    if (!reason) continue;
    reasons.push({ key, reason, value: cleaned[key] });
    delete cleaned[key];
    removed.push(key);
  }
  return { args: cleaned, removed, reasons };
}

function rewriteLocalLlmScopeDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteLocalLlmScopeDescriptions);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = key === 'description' && typeof child === 'string'
      ? child.replace(
        /Defaults to \.dkg\/config\.yaml\.?/gi,
        'Omit only when an explicit Session Context Graph is selected. Never pass a config filename or generic placeholder as a graph id.',
      )
      : rewriteLocalLlmScopeDescriptions(child);
  }
  return output;
}

/** Remove MCP-default wording that local models can mistake for a literal id. */
export function sanitizeDkgToolForLocalLlm(tool: McpToolDefinition): McpToolDefinition {
  return {
    ...tool,
    inputSchema: rewriteLocalLlmScopeDescriptions(tool.inputSchema) as Record<string, unknown>,
  };
}

/**
 * Cheap, deterministic checks for mistakes small local models commonly make.
 * This is deliberately a preflight rather than a SPARQL parser: the DKG query
 * engine remains authoritative, while obvious malformed calls get the
 * runtime's single bounded repair attempt instead of a daemon round trip.
 */
export function validateSparqlForDkg(value: unknown): DkgToolValidationResult {
  const rawSparql = typeof value === 'string' ? value : '';
  if (rawSparql.length > MAX_SPARQL_PREFLIGHT_CHARS) {
    return {
      ok: false,
      errors: [`sparql must not exceed ${MAX_SPARQL_PREFLIGHT_CHARS} characters`],
    };
  }
  const sparql = rawSparql.trim();
  const errors: string[] = [];
  if (!sparql) return { ok: false, errors: ['sparql must not be empty'] };
  if (/```/.test(sparql)) errors.push('remove Markdown fences and send raw SPARQL only');

  const scan = scanSparqlPreflight(sparql);
  if (scan.unterminated) errors.push('close the unterminated string literal or IRI');
  if (!scan.operation) {
    errors.push('query must start with SELECT, ASK, or CONSTRUCT');
  }
  if (!scan.bracesBalanced) errors.push('balance SPARQL braces');
  if (!scan.parenthesesBalanced) errors.push('balance SPARQL parentheses');
  if (scan.hasFrom) {
    errors.push('remove FROM because projectId, subGraphName, and view already scope the query');
  }
  if (scan.hasFilterNotExistsParentheses) {
    errors.push('use braces for FILTER NOT EXISTS');
  }
  if (scan.hasStrcontains) {
    errors.push('use SPARQL CONTAINS instead of STRCONTAINS');
  }
  if (scan.hasUnwrappedAggregateAlias) {
    errors.push('wrap aggregate aliases as (COUNT(...) AS ?count)');
  }

  // Prefixed names (schema:name) are valid. Absolute identifiers copied from
  // DKG evidence (urn:..., did:..., http://...) are not prefixed names and
  // must be enclosed in <...> when used as SPARQL terms.
  if (scan.bareAbsoluteIri) {
    errors.push(`wrap absolute IRI ${scan.bareAbsoluteIri} in angle brackets`);
  }

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique };
}

export function validateDkgToolCall(
  name: string,
  args: Record<string, unknown>,
): DkgToolValidationResult {
  if (name === 'dkg_query' || name === 'dkg_query_catalog_save') {
    return validateSparqlForDkg(args.sparql);
  }
  return { ok: true, errors: [] };
}

/**
 * Produce one conservative alternate for data written through the DKG quad
 * API, which preserves compact predicate strings such as `rdf:type`. This is
 * used only after the original, syntactically-valid read returned no evidence.
 */
export function rewriteCompactPredicatesForDkg(sparql: string): string {
  const subject = String.raw`(?:\?[A-Za-z_][A-Za-z0-9_]*|<[^>]+>|_:[A-Za-z][A-Za-z0-9_-]*)`;
  const predicateAnchor = String.raw`(?:${subject}\s+|;\s*)`;
  const scan = scanSparqlPreflight(sparql);
  if (scan.unterminated) return sparql;
  const { masked } = scan;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const shorthand = new RegExp(`(${predicateAnchor})a(\\s+)`, 'gi');
  for (const match of masked.matchAll(shorthand)) {
    const start = (match.index ?? 0) + match[1].length;
    edits.push({ start, end: start + 1, value: '<rdf:type>' });
  }
  const compact = new RegExp(
    `(${predicateAnchor})((?:rdf|rdfs|schema):[A-Za-z_][A-Za-z0-9_.-]*)(\\s+)`,
    'gi',
  );
  for (const match of masked.matchAll(compact)) {
    const start = (match.index ?? 0) + match[1].length;
    edits.push({ start, end: start + match[2].length, value: `<${match[2]}>` });
  }
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (rewritten, edit) => rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end),
      sparql,
    );
}
