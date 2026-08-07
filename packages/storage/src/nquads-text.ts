import type { Quad as DKGQuad } from './triple-store.js';

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

/** Parse newline-delimited N-Quads while tolerating blank, comment, and invalid lines. */
export function parseNQuadsText(text: string): DKGQuad[] {
  const quads: DKGQuad[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const quad = parseNQuadLine(line);
    if (quad) quads.push(quad);
  }
  return quads;
}

function stripAngle(term: string): string {
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}
