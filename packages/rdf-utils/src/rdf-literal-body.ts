const QUOTE = 0x22;
const AT = 0x40;
const CARET = 0x5e;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

export interface RdfLiteralBodyOptions {
  /** Accept any text after the closing quote, as `/^"(.*)".*$/` did. */
  readonly anySuffix?: boolean;
  /**
   * Take any term that starts and ends with a quote as a plain literal,
   * whatever it contains, line terminators included, before the other rules.
   */
  readonly plainQuoted?: boolean;
}

/**
 * The body of an N-Triples-style literal term, as written (not unescaped): the
 * text between the opening quote and the closing quote of `"body"`,
 * `"body"^^…` or `"body"@…`. Returns `undefined` when the term is not one.
 *
 * One linear scan, with the results of the backtracking pattern
 * `/^"(.*)"(?:\^\^.*|@.*)?$/` it replaces: the body runs to the last quote that
 * is followed by nothing, `^^` or `@`, and a term with a line terminator is not
 * a literal.
 */
export function rdfLiteralBody(
  term: string,
  options: RdfLiteralBodyOptions = {},
): string | undefined {
  if (options.plainQuoted && term.startsWith('"') && term.endsWith('"')) return term.slice(1, -1);
  if (term.charCodeAt(0) !== QUOTE || LINE_TERMINATOR.test(term)) return undefined;
  for (let close = term.lastIndexOf('"'); close > 0; close = term.lastIndexOf('"', close - 1)) {
    if (options.anySuffix || closesLiteral(term, close)) return term.slice(1, close);
  }
  return undefined;
}

function closesLiteral(term: string, close: number): boolean {
  if (close === term.length - 1) return true;
  const next = term.charCodeAt(close + 1);
  return next === AT || (next === CARET && term.charCodeAt(close + 2) === CARET);
}
