export type TriplePattern = { s: string; p: string; o: string };

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

type PrefixMap = Map<string, string>;

export function stripSparqlComments(sparql: string): string {
  let out = '';
  let inIri = false;
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < sparql.length; i++) {
    const ch = sparql[i];

    if (escape) {
      out += ch;
      escape = false;
      continue;
    }

    if ((inSingle || inDouble) && ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === '<') {
        const prev = i > 0 ? sparql[i - 1] : ' ';
        const next = sparql[i + 1] ?? '';
        const tokenBoundaryBefore = /\s|[({[;,=]/.test(prev);
        const tokenStartAfter = next !== '' && !/\s/.test(next) && next !== '=' && next !== '>';
        const hasClosingAngle = sparql.indexOf('>', i + 1) !== -1;
        const looksLikeIriStart = tokenBoundaryBefore && tokenStartAfter && hasClosingAngle;
        if (!looksLikeIriStart) {
          out += ch;
          continue;
        }
        inIri = true;
        out += ch;
        continue;
      }
      if (ch === '>' && inIri) {
        inIri = false;
        out += ch;
        continue;
      }
    }

    if (!inIri && !inDouble && ch === '\'') {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (!inIri && !inSingle && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (!inIri && !inSingle && !inDouble && ch === '#') {
      while (i < sparql.length && sparql[i] !== '\n' && sparql[i] !== '\r') i++;
      if (i < sparql.length) out += sparql[i];
      continue;
    }

    out += ch;
  }

  return out;
}

function parseTriplePatternFromQuery(sparql: string): TriplePattern | null {
  const withoutComments = stripSparqlComments(sparql);
  const whereMatch = withoutComments.match(/where\s*\{([\s\S]+)\}/i);
  const source = whereMatch ? whereMatch[1] : withoutComments;
  const term = String.raw`(?:<[^>]+>|_:[A-Za-z][\w-]*|\?[A-Za-z_][\w-]*|(?:[A-Za-z][\w+.-]*|):[^\s{};,.]+|a|"(?:[^"\\]|\\.)*"(?:@[A-Za-z-]+|\^\^(?:<[^>]+>|(?:[A-Za-z][\w+.-]*|):[^\s{};,.]+))?)`;
  const tripleRegex = new RegExp(`(${term})\\s+(${term})\\s+(${term})\\s*\\.?`, 'ig');
  const match = tripleRegex.exec(source);
  if (!match) return null;
  return { s: match[1], p: match[2], o: match[3] };
}

function parseSparqlPrefixes(sparql: string): PrefixMap {
  const prefixes: PrefixMap = new Map();
  const withoutComments = stripSparqlComments(sparql);
  const prefixRegex = /(?:^|\s)PREFIX\s+([A-Za-z][\w-]*)?\s*:\s*<([^>]+)>/gim;
  let match: RegExpExecArray | null;
  while ((match = prefixRegex.exec(withoutComments)) !== null) {
    prefixes.set(match[1] ?? '', match[2]);
  }
  return prefixes;
}

function normalizeSparqlToken(token: string, prefixes: PrefixMap): string {
  const trimmed = token.trim().replace(/[.;]$/, '');
  if (trimmed === 'a') return RDF_TYPE;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }

  const literalMatch = trimmed.match(/^"((?:[^"\\]|\\.)*)"(?:(@[A-Za-z-]+)|\^\^(<[^>]+>|(?:[A-Za-z][\w+.-]*|):[^\s]+))?$/);
  if (literalMatch) {
    const lexical = literalMatch[1];
    const langTag = literalMatch[2] ?? '';
    const datatype = literalMatch[3] ?? '';
    if (langTag) return `"${lexical}"${langTag}`;
    if (!datatype) return `"${lexical}"`;
    if (datatype.startsWith('<') && datatype.endsWith('>')) return `"${lexical}"^^${datatype}`;
    const curieMatch = datatype.match(/^([A-Za-z][\w-]*|):(.+)$/);
    if (curieMatch) {
      const iriBase = prefixes.get(curieMatch[1]);
      if (iriBase) return `"${lexical}"^^<${iriBase}${curieMatch[2]}>`;
    }
    return `"${lexical}"^^${datatype}`;
  }

  const curieMatch = trimmed.match(/^([A-Za-z][\w-]*|):(.+)$/);
  if (curieMatch) {
    const iriBase = prefixes.get(curieMatch[1]);
    if (iriBase) return `${iriBase}${curieMatch[2]}`;
  }

  return trimmed;
}

function coerceBindingValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return coerceBindingValue((value as Record<string, unknown>).value);
  }
  return String(value);
}

function resolveTermValue(row: Record<string, unknown>, token: string, prefixes: PrefixMap): string | null {
  if (token.startsWith('?')) {
    return coerceBindingValue(row[token.slice(1)]);
  }
  return normalizeSparqlToken(token, prefixes);
}

export function deriveGraphTriples(result: any, sparql: string): Array<{ s: string; p: string; o: string }> {
  if (!Array.isArray(result) || result.length === 0) return [];

  if ('s' in result[0] && 'p' in result[0] && 'o' in result[0]) {
    return result
      .map((row: any) => ({
        s: coerceBindingValue(row.s),
        p: coerceBindingValue(row.p),
        o: coerceBindingValue(row.o),
      }))
      .filter((row: any) => row.s && row.p && row.o);
  }
  if ('subject' in result[0] && 'predicate' in result[0] && 'object' in result[0]) {
    return result
      .map((row: any) => ({
        s: coerceBindingValue(row.subject),
        p: coerceBindingValue(row.predicate),
        o: coerceBindingValue(row.object),
      }))
      .filter((row: any) => row.s && row.p && row.o);
  }

  const triplePattern = parseTriplePatternFromQuery(sparql);
  if (!triplePattern) return [];
  const prefixes = parseSparqlPrefixes(sparql);

  return result
    .map((row: any) => ({
      s: resolveTermValue(row, triplePattern.s, prefixes),
      p: resolveTermValue(row, triplePattern.p, prefixes),
      o: resolveTermValue(row, triplePattern.o, prefixes),
    }))
    .filter((row: any) => row.s && row.p && row.o);
}

type ProvenanceRow = {
  s: string;
  p: string;
  o: string;
  g: string;
  graphType: string;
  contextGraph: string;
  source: string;
  ual: string;
  txHash: string;
  timestamp: string;
};

export function buildTripleRowsWithProvenance(
  triples: Array<{ s: string; p: string; o: string }>,
  rows: ProvenanceRow[],
): ProvenanceRow[] {
  const dedupedTriples = new Map<string, { s: string; p: string; o: string }>();
  for (const triple of triples) {
    const key = `${triple.s}\u0000${triple.p}\u0000${triple.o}`;
    if (!dedupedTriples.has(key)) dedupedTriples.set(key, triple);
  }

  const rowsByTriple = new Map<string, Map<string, ProvenanceRow>>();
  for (const row of rows) {
    const tripleKey = `${row.s}\u0000${row.p}\u0000${row.o}`;
    const graphKey = row.g || '__no_graph__';
    if (!rowsByTriple.has(tripleKey)) rowsByTriple.set(tripleKey, new Map());
    const current = rowsByTriple.get(tripleKey)!;
    if (!current.has(graphKey)) current.set(graphKey, row);
  }

  const out: ProvenanceRow[] = [];
  for (const [tripleKey, triple] of dedupedTriples.entries()) {
    const matches = Array.from(rowsByTriple.get(tripleKey)?.values() ?? []);
    if (matches.length === 0) {
      out.push({
        s: triple.s,
        p: triple.p,
        o: triple.o,
        g: '',
        graphType: '',
        contextGraph: '',
        source: '',
        ual: '',
        txHash: '',
        timestamp: '',
      });
      continue;
    }
    for (const match of matches) {
      out.push({
        s: triple.s,
        p: triple.p,
        o: triple.o,
        g: match.g || '',
        graphType: match.graphType || '',
        contextGraph: match.contextGraph || '',
        source: match.source || '',
        ual: match.ual || '',
        txHash: match.txHash || '',
        timestamp: match.timestamp || '',
      });
    }
  }
  return out;
}
