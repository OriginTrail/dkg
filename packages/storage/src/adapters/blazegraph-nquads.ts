/**
 * Blazegraph N-Quads wire encoder.
 *
 * A focused boundary for the one structural quirk of Blazegraph's bulk-insert
 * endpoint: its N-Quads parser reads the request body BYTE-wise as ASCII (the
 * Content-Type charset is ignored), so any non-ASCII byte is replaced with
 * U+FFFD before parsing — silent stored-value corruption. Downstream, a
 * published KA carrying such a literal fails its storage-ACK merkle
 * recomputation (MERKLE_MISMATCH_IN_SWM) and the publish dies.
 *
 * Verified against the stock `lyrasis/blazegraph:2.1.5` image (image CI + the
 * devnet run). Kept here, separate from the adapter's transport/query/mutation
 * orchestration, so the wire-format invariant is a single testable unit.
 */

/**
 * Make an assembled N-Quads line ASCII-safe for Blazegraph's bulk-insert
 * endpoint:
 *
 *  - Raw non-ASCII UTF-8 (a 2-byte `é` as much as a 4-byte astral emoji) →
 *    `\uXXXX` per UTF-16 code unit (astral chars as their surrogate pair) — the
 *    exact Java-String form Blazegraph itself emits on CONSTRUCT read-back and
 *    the one encoding that round-trips every scalar, including the
 *    supplementary plane.
 *  - In-range `\UXXXXXXXX` escapes (which Blazegraph truncates to their low 16
 *    bits on parse, e.g. `\U0001F600` 😀 → U+F600) → equivalent `\uXXXX`
 *    escape(s). Out-of-range `\U` (> U+10FFFF, unrepresentable) passes through.
 *
 * `\uXXXX` is a valid UCHAR in both IRIREF and STRING_LITERAL_QUOTED, so the
 * transform is safe to apply to the whole line. Existing escape sequences are
 * consumed pairwise (backslash parity), so a literal backslash followed by
 * `U…` text (`\\U0001F600`) is never mis-rewritten. The transform is line-level
 * by design — the `\U` normalization and the backslash-parity guard are
 * properties of the rendered line, not of an individual term.
 */
export function toBlazegraphAsciiSafeNQuads(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x5c /* backslash */) {
      // In-range \UXXXXXXXX → equivalent \uXXXX escape(s) Blazegraph parses
      // correctly. Out-of-range \U (> U+10FFFF, unrepresentable) passes through.
      if (line[i + 1] === 'U') {
        const hex = line.slice(i + 2, i + 10);
        if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10ffff) {
            out += escapeUtf16CodeUnits(String.fromCodePoint(cp));
            i += 9;
            continue;
          }
        }
      }
      // Any other escape: copy the pair verbatim so the escaped char is never
      // re-inspected (preserves backslash parity for the \U check above).
      out += line[i];
      if (i + 1 < line.length) {
        const nextCode = line.charCodeAt(i + 1);
        out += nextCode >= 0x7f ? escapeUtf16CodeUnits(line[i + 1]) : line[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0x7f) {
      out += escapeUtf16CodeUnits(line[i]);
      continue;
    }
    out += line[i];
  }
  return out;
}

/** `\uXXXX` escape per UTF-16 code unit (surrogate halves stay split). */
function escapeUtf16CodeUnits(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += `\\u${s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}
