/**
 * Minimal `.env` value parser matching python-dotenv semantics, shared by the
 * Hermes adapter (which provisions `API_SERVER_KEY` into the Hermes profile
 * `.env`) and the daemon (which reads it back to forward as a bearer). Keeping
 * a single implementation here prevents the two sides from drifting and
 * silently breaking auth.
 *
 * Rules (python-dotenv):
 *  - A quoted value keeps everything between the matching quotes, including an
 *    inner `#` (`"se#cret"` → `se#cret`). In double-quoted values escape
 *    sequences are decoded the way python-dotenv decodes them — `\n`/`\t`/`\r`
 *    become newline/tab/CR, `\"`/`\\`/`\'` become the literal char, and any
 *    other `\x` drops the backslash (`"abc\"def"` → `abc"def`, `"a\nb"` → a
 *    newline-separated value). Single-quoted values are literal.
 *  - An unquoted value is truncated at the first whitespace-preceded `#` (an
 *    inline comment) and trimmed (`secret # dev` → `secret`); a `#` with no
 *    preceding whitespace is literal (`a#b` → `a#b`).
 */
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

export function parseDotenvValue(raw: string): string {
  const value = raw.replace(/^\s+/, '');
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let result = '';
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      // In double-quoted values a backslash introduces an escape sequence
      // (python-dotenv decodes `\n`/`\t`/`\r`/`\\`/`\"`/`\'`; any other `\x`
      // becomes `x`). Single-quoted values treat backslash literally.
      if (ch === '\\' && quote === '"' && i + 1 < value.length) {
        const next = value[i + 1];
        result += DOUBLE_QUOTE_ESCAPES[next] ?? next;
        i += 1;
        continue;
      }
      if (ch === quote) return result; // matching close quote
      result += ch;
    }
    // Unterminated quote: fall through and treat the raw text as unquoted.
  }
  const comment = value.match(/\s#/);
  return (comment?.index !== undefined ? value.slice(0, comment.index) : value).trim();
}
