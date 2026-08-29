import type { Quad as DKGQuad } from './triple-store.js';

export type NQuadLineScan =
  | { readonly line: string; readonly parsed: true; readonly quad: DKGQuad }
  | { readonly line: string; readonly parsed: false; readonly quad?: undefined };

/**
 * Parse one normalized N-Quads statement into the storage wire model.
 *
 * Returning undefined preserves the historical tolerant behavior of the HTTP
 * adapters: callers may ignore unsupported or malformed interior lines, while
 * stricter boundaries such as Blazegraph can treat an unparseable final line
 * as evidence of a truncated response.
 */
export function parseNQuadLine(line: string): DKGQuad | undefined {
  const match = line.match(
    /^(<[^>]+>|_:\S+)\s+(<[^>]+>)\s+(<[^>]+>|_:\S+|"(?:[^"\\]|\\.)*"(?:@\S+|\^\^<[^>]+>)?)\s*(?:(<[^>]+>)\s*)?\.$/,
  );
  if (!match) return undefined;
  const subject = decodeIriTerm(match[1]);
  const predicate = decodeIriTerm(match[2]);
  const object = match[3].startsWith('<') ? decodeIriTerm(match[3]) : match[3];
  const graph = match[4] ? decodeIriTerm(match[4]) : '';
  if (subject === null || predicate === null || object === null || graph === null) {
    return undefined;
  }
  return {
    subject,
    predicate,
    object,
    graph,
  };
}

/**
 * Scan normalized content lines without choosing whether parse failures are fatal.
 *
 * Blank and comment lines are not content and are omitted. Every other line is
 * returned with either its parsed quad or explicit parse-failure metadata so
 * callers can apply their own integrity policy without duplicating scanning.
 */
export function scanNQuadLines(text: string): NQuadLineScan[] {
  const lines: NQuadLineScan[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const quad = parseNQuadLine(line);
    lines.push(quad
      ? { line, parsed: true, quad }
      : { line, parsed: false });
  }
  return lines;
}

/**
 * Parse newline-delimited N-Quads using the HTTP adapters' legacy tolerant policy.
 *
 * Blank, comment, and invalid lines are ignored. Integrity-sensitive callers
 * should consume {@link scanNQuadLines} and handle parse failures explicitly.
 */
export function parseNQuadsTextTolerant(text: string): DKGQuad[] {
  const quads: DKGQuad[] = [];
  for (const scanned of scanNQuadLines(text)) {
    if (scanned.parsed) quads.push(scanned.quad);
  }
  return quads;
}

function decodeIriTerm(term: string): string | null {
  if (!term.startsWith('<') || !term.endsWith('>')) return term;
  return decodeNTriplesIriEscapes(term.slice(1, -1));
}

/** Decode N-Triples UCHAR escapes in IRIREF positions, including UTF-16 pairs. */
function decodeNTriplesIriEscapes(iri: string): string | null {
  if (!iri.includes('\\')) return iri;
  let decoded = '';
  for (let index = 0; index < iri.length; index += 1) {
    if (iri[index] !== '\\') {
      decoded += iri[index];
      continue;
    }
    const marker = iri[index + 1];
    const digits = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
    const hex = digits === 0 ? '' : iri.slice(index + 2, index + 2 + digits);
    if (digits === 0 || hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
      return null;
    }
    let codePoint = Number.parseInt(hex, 16);
    index += digits + 1;
    if (marker === 'u' && codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const lowPrefix = iri.slice(index + 1, index + 3);
      const lowHex = iri.slice(index + 3, index + 7);
      if (lowPrefix !== '\\u' || !/^[dD][c-fC-F][0-9A-Fa-f]{2}$/.test(lowHex)) {
        return null;
      }
      const low = Number.parseInt(lowHex, 16);
      codePoint = 0x10000 + ((codePoint - 0xd800) * 0x400) + (low - 0xdc00);
      index += 6;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return null;
    }
    if (codePoint > 0x10ffff) return null;
    decoded += String.fromCodePoint(codePoint);
  }
  return decoded;
}
