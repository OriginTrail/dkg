/**
 * Escape an RDF literal lexical value for a double-quoted N-Triples/N-Quads
 * term. Raw C0 controls and DEL are not legal in STRING_LITERAL_QUOTE; use the
 * standard short ECHAR forms where available and UCHAR everywhere else.
 */
export function escapeNQuadsLiteral(value: string): string {
  let out = '';
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    switch (codePoint) {
      case 0x5c: out += '\\\\'; break;
      case 0x22: out += '\\"'; break;
      case 0x08: out += '\\b'; break;
      case 0x09: out += '\\t'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0d: out += '\\r'; break;
      default:
        out += codePoint <= 0x1f || codePoint === 0x7f
          ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
          : char;
    }
  }
  return out;
}
