import type { Quad } from '../triple-store.js';
import { scanNQuadLines, type NQuadLineScan } from '../nquads-text.js';

/**
 * Parse a Blazegraph CONSTRUCT body and reject one that the engine cut short.
 *
 * Blazegraph commits `200 OK` and starts streaming before it knows whether the
 * query will finish. If the query is then killed — by the server-side deadline,
 * or by an engine error mid-result — the error text is appended to the
 * already-committed body. The historical parser skips any line it cannot
 * match, so without an integrity check that body parses into a short,
 * structurally valid, silently-incomplete quad set: a sync page that looks
 * whole and is not.
 *
 * The check is deliberately narrow — it looks for *truncation*, not for any
 * unparseable line — so it cannot start rejecting the odd-but-harmless
 * serialisations the tolerant parser has always accepted:
 *
 *  - the final non-comment line must parse as a complete N-Quad statement
 *  - Blazegraph's appended failure text carries a Java exception marker
 *
 * Parsing and final-line validation consume {@link scanNQuadLines}, so line
 * normalization and parse-failure metadata have one shared definition.
 * Interior unparseable lines retain the adapter's historical tolerant
 * behaviour; an unparseable final statement is the truncation signal that
 * must fail closed.
 */
export function parseBlazegraphConstructNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  let finalStatement: NQuadLineScan | undefined;

  for (const scanned of scanNQuadLines(text)) {
    const { line } = scanned;

    // Both alternatives are line-start anchored on purpose. The engine
    // appends failure text as standalone lines, while the same words inside a
    // stored literal occur after the subject and predicate on a valid N-Quad.
    const javaError = /^(?:[\w.$]+\.)?(?:\w*Exception|\w*Error)\b|^\s*at com\.bigdata\./.exec(line);
    if (javaError) {
      throw new Error(
        'Blazegraph returned a truncated CONSTRUCT result: the response body carries an engine '
        + `error (${javaError[0].slice(0, 120)}). Treating this as a failure rather than as an `
        + 'empty/partial result — see parseBlazegraphConstructNQuads.',
      );
    }

    finalStatement = scanned;
    if (scanned.parsed) quads.push(scanned.quad);
  }

  if (finalStatement && !finalStatement.parsed) {
    throw new Error(
      'Blazegraph returned a truncated CONSTRUCT result: the final statement is incomplete '
      + `(${JSON.stringify(finalStatement.line.slice(-120))}). Treating this as a failure rather `
      + 'than as a partial result — see parseBlazegraphConstructNQuads.',
    );
  }

  return quads;
}

