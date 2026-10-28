/** N-Triples ECHAR short forms, keyed by the raw character. */
const RDF_LITERAL_SHORT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
});

/**
 * Escape a plain-text string for use as an RDF/N-Triples literal body.
 * Returns only the escaped body; callers add the surrounding quotes.
 */
export function escapeRdfLiteral(value: string): string {
  let escaped = '';
  let copyStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x1f && code !== 0x22 && code !== 0x5c && code !== 0x7f) continue;
    const character = value[index];
    const shortEscape = RDF_LITERAL_SHORT_ESCAPES[character];
    const replacement = shortEscape
      ?? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    escaped += value.slice(copyStart, index) + replacement;
    copyStart = index + 1;
  }
  // Most result literals need no escaping. Preserve the original string and
  // avoid both callback setup and allocation on that path.
  return copyStart === 0 ? value : escaped + value.slice(copyStart);
}
