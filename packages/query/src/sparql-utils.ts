/**
 * Linear-time state-machine that replaces string literals, IRIs, and
 * line comments with spaces so keyword regexes only see "code" tokens.
 *
 * Handles: triple-quoted strings ("""/'''), regular strings ("/'),
 * IRIs (<...> only when preceded by whitespace/start — not comparison
 * operators like `< 1`), and line comments (# outside strings/IRIs).
 *
 * No regex backtracking — O(n) single pass, immune to ReDoS.
 */
export function stripLiteralsAndComments(sparql: string): string {
  const out = new Array<string>(sparql.length);
  let i = 0;
  const n = sparql.length;

  while (i < n) {
    const ch = sparql[i];

    if (
      (ch === '"' || ch === "'") &&
      sparql[i + 1] === ch &&
      sparql[i + 2] === ch
    ) {
      const start = i;
      i += 3;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch && sparql[i + 1] === ch && sparql[i + 2] === ch) {
          i += 3;
          break;
        }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch) { i++; break; }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '<') {
      const prev = i > 0 ? sparql[i - 1] : '';
      const isComparison = prev && (/[a-zA-Z0-9?$_]/.test(prev) || prev === ')' || prev === ']');
      if (!isComparison) {
        const next = sparql[i + 1];
        if (next && (/[a-zA-Z]/.test(next) || next === '#' || next === '/' || next === '.' || next === '_')) {
          const start = i;
          i++;
          while (i < n && sparql[i] !== '>' && sparql[i] !== '\n') i++;
          if (i < n && sparql[i] === '>') i++;
          for (let j = start; j < i; j++) out[j] = ' ';
          continue;
        }
      }
    }

    if (ch === '#') {
      const start = i;
      while (i < n && sparql[i] !== '\n') i++;
      for (let j = start; j < i; j++) out[j] = ' ';
      continue;
    }

    out[i] = ch;
    i++;
  }

  return out.join('');
}
