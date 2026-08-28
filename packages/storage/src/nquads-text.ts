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
  return {
    subject: stripAngle(match[1]),
    predicate: stripAngle(match[2]),
    object: match[3].startsWith('<') ? stripAngle(match[3]) : match[3],
    graph: match[4] ? stripAngle(match[4]) : '',
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

function stripAngle(term: string): string {
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}
