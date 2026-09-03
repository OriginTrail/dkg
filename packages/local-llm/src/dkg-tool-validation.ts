import type { McpToolDefinition } from './schema.js';

export interface DkgToolValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_SPARQL_PREFLIGHT_CHARS = 65_536;
const AGGREGATE_KEYWORDS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;

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

function maskStringsIrisAndComments(value: string): { masked: string; unterminated: boolean } {
  let masked = '';
  let quote: '"' | "'" | undefined;
  let tripleQuoted = false;
  let inIri = false;
  let inComment = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (inComment) {
      if (character === '\n' || character === '\r') {
        inComment = false;
        masked += character;
      } else {
        masked += ' ';
      }
      continue;
    }
    if (quote) {
      if (tripleQuoted && value.slice(index, index + 3) === quote.repeat(3)) {
        masked += quote.repeat(3);
        index += 2;
        quote = undefined;
        tripleQuoted = false;
        escaped = false;
        continue;
      }
      masked += character === quote && !tripleQuoted && !escaped ? character : ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote && !tripleQuoted) quote = undefined;
      continue;
    }
    if (inIri) {
      masked += character === '>' ? '>' : ' ';
      if (character === '>') inIri = false;
      continue;
    }
    if (character === '#') {
      inComment = true;
      masked += ' ';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tripleQuoted = value.slice(index, index + 3) === character.repeat(3);
      masked += tripleQuoted ? character.repeat(3) : character;
      if (tripleQuoted) index += 2;
      continue;
    }
    if (character === '<') {
      const closing = value.indexOf('>', index + 1);
      const candidate = closing >= 0 ? value.slice(index + 1, closing) : '';
      if (candidate && !/\s/.test(candidate)) {
        inIri = true;
        masked += '<';
        continue;
      }
    }
    masked += character;
  }
  return { masked, unterminated: Boolean(quote || inIri) };
}

function balanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === open) depth++;
    if (character === close) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function skipWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && isWhitespace(value[cursor])) cursor++;
  return cursor;
}

function keywordAt(value: string, start: number, keyword: string): boolean {
  return value.slice(start, start + keyword.length).toUpperCase() === keyword;
}

function prefixDeclarationEnd(value: string, start: number): number | undefined {
  if (!keywordAt(value, start, 'PREFIX')) return undefined;
  let cursor = start + 'PREFIX'.length;
  if (!isWhitespace(value[cursor])) return undefined;
  cursor = skipWhitespace(value, cursor);

  while (
    cursor < value.length
    && !isWhitespace(value[cursor])
    && value[cursor] !== ':'
  ) cursor++;
  if (value[cursor] !== ':') return undefined;
  cursor = skipWhitespace(value, cursor + 1);
  if (value[cursor] !== '<') return undefined;

  const iriEnd = value.indexOf('>', cursor + 1);
  if (iriEnd <= cursor + 1) return undefined;
  return iriEnd + 1;
}

function stripLeadingPrefixDeclarations(value: string): string {
  let cursor = skipWhitespace(value, 0);
  let found = false;
  while (cursor < value.length) {
    const declarationEnd = prefixDeclarationEnd(value, cursor);
    if (declarationEnd === undefined) break;
    found = true;
    cursor = skipWhitespace(value, declarationEnd);
  }
  return found ? value.slice(cursor) : value;
}

function isVariableStart(character: string | undefined): boolean {
  if (character === '_') return true;
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function unwrappedAggregateAlias(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (index > 0 && !isWhitespace(value[index - 1])) {
      index++;
      continue;
    }
    const aggregate = AGGREGATE_KEYWORDS.find((keyword) => keywordAt(value, index, keyword));
    if (!aggregate) {
      index++;
      continue;
    }

    let cursor = skipWhitespace(value, index + aggregate.length);
    if (value[cursor] !== '(') {
      index += aggregate.length;
      continue;
    }
    const closing = value.indexOf(')', cursor + 1);
    if (closing < 0) return false;

    cursor = closing + 1;
    if (!isWhitespace(value[cursor])) {
      index = cursor;
      continue;
    }
    cursor = skipWhitespace(value, cursor);
    if (!keywordAt(value, cursor, 'AS')) {
      index = cursor;
      continue;
    }
    cursor += 'AS'.length;
    if (!isWhitespace(value[cursor])) {
      index = cursor;
      continue;
    }
    cursor = skipWhitespace(value, cursor);
    if (value[cursor] === '?' && isVariableStart(value[cursor + 1])) return true;
    index = cursor + 1;
  }
  return false;
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

  const declaredPrefixes = new Set(
    [...sparql.matchAll(/\bPREFIX\s+([A-Za-z][A-Za-z0-9_-]*):\s*<[^>]+>/gi)]
      .map((match) => match[1].toLowerCase()),
  );
  const withoutPrefixes = stripLeadingPrefixDeclarations(sparql);
  const { masked, unterminated } = maskStringsIrisAndComments(withoutPrefixes);
  if (unterminated) errors.push('close the unterminated string literal or IRI');
  if (!/^(?:\s*)(?:SELECT|ASK|CONSTRUCT)\b/i.test(masked)) {
    errors.push('query must start with SELECT, ASK, or CONSTRUCT');
  }
  if (!balanced(masked, '{', '}')) errors.push('balance SPARQL braces');
  if (!balanced(masked, '(', ')')) errors.push('balance SPARQL parentheses');
  if (/\bFROM\b/i.test(masked)) {
    errors.push('remove FROM because projectId, subGraphName, and view already scope the query');
  }
  if (/\bFILTER\s+NOT\s+EXISTS\s*\(/i.test(masked)) {
    errors.push('use braces for FILTER NOT EXISTS');
  }
  if (/\bSTRCONTAINS\s*\(/i.test(masked)) {
    errors.push('use SPARQL CONTAINS instead of STRCONTAINS');
  }
  if (unwrappedAggregateAlias(masked)) {
    errors.push('wrap aggregate aliases as (COUNT(...) AS ?count)');
  }

  // Prefixed names (schema:name) are valid. Absolute identifiers copied from
  // DKG evidence (urn:..., did:..., http://...) are not prefixed names and
  // must be enclosed in <...> when used as SPARQL terms.
  const bareAbsolute = masked.match(/\b(urn|https?|did|ipfs|ipns|tag|mailto):[^\s;,.(){}[\]<>]+/i);
  if (bareAbsolute && !declaredPrefixes.has(bareAbsolute[1].toLowerCase())) {
    errors.push(`wrap absolute IRI ${bareAbsolute[0]} in angle brackets`);
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
  const { masked, unterminated } = maskStringsIrisAndComments(sparql);
  if (unterminated) return sparql;
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
