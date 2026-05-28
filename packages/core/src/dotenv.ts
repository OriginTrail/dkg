/**
 * Minimal `.env` value parser matching python-dotenv semantics, shared by the
 * Hermes adapter (which provisions `API_SERVER_KEY` into the Hermes profile
 * `.env`) and the daemon (which reads it back to forward as a bearer). Keeping
 * a single implementation here prevents the two sides from drifting and
 * silently breaking auth.
 *
 * Rules (python-dotenv):
 *  - A quoted value keeps everything between the matching quotes, including an
 *    inner `#` (`"se#cret"` → `se#cret`).
 *  - An unquoted value is truncated at the first whitespace-preceded `#` (an
 *    inline comment) and trimmed (`secret # dev` → `secret`); a `#` with no
 *    preceding whitespace is literal (`a#b` → `a#b`).
 */
export function parseDotenvValue(raw: string): string {
  const value = raw.replace(/^\s+/, '');
  if (value[0] === '"' || value[0] === "'") {
    const end = value.indexOf(value[0], 1);
    if (end > 0) return value.slice(1, end);
  }
  const comment = value.match(/\s#/);
  return (comment?.index !== undefined ? value.slice(0, comment.index) : value).trim();
}
