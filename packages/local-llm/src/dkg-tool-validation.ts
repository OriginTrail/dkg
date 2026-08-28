export interface DkgToolValidationResult {
  ok: boolean;
  errors: string[];
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

/**
 * Cheap, deterministic checks for mistakes small local models commonly make.
 * This is deliberately a preflight rather than a SPARQL parser: the DKG query
 * engine remains authoritative, while obvious malformed calls get the
 * runtime's single bounded repair attempt instead of a daemon round trip.
 */
export function validateSparqlForDkg(value: unknown): DkgToolValidationResult {
  const sparql = typeof value === 'string' ? value.trim() : '';
  const errors: string[] = [];
  if (!sparql) return { ok: false, errors: ['sparql must not be empty'] };
  if (/```/.test(sparql)) errors.push('remove Markdown fences and send raw SPARQL only');

  const declaredPrefixes = new Set(
    [...sparql.matchAll(/\bPREFIX\s+([A-Za-z][A-Za-z0-9_-]*):\s*<[^>]+>/gi)]
      .map((match) => match[1].toLowerCase()),
  );
  const withoutPrefixes = sparql.replace(/^(?:\s*PREFIX\s+[^\s:]*:\s*<[^>]+>\s*)+/i, '');
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
  if (/(?:^|\s)(?:COUNT|SUM|AVG|MIN|MAX)\s*\([^)]*\)\s+AS\s+\?[A-Za-z_]/i.test(masked)) {
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
