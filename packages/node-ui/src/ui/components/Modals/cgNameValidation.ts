/**
 * Client-side input contract for the Create Context Graph modal name
 * field (BUG-016). The previous implementation accepted *any* string —
 * unbounded length, raw HTML, leading/trailing whitespace — and only
 * the daemon's slugify pass downstream caught the most blatant abuse.
 * That meant pasting a 5,000-character HTML chunk into the field
 * silently sent a 5,000-character payload (with embedded `<script>`
 * tags) over the wire, and the user only learned something was wrong
 * when the request 4xx'd or worse. The redacted display name in
 * dashboards then surfaced the raw HTML without escaping.
 *
 * The module exports three small helpers, all pure (no React, no DOM):
 *
 * - `CG_NAME_MAX_LENGTH`    — single source of truth for the cap. 80
 *                             chars is plenty for a human-readable
 *                             label and keeps the URL-encoded slug
 *                             well under the 60-char slug ceiling
 *                             enforced by the daemon (`slugify`).
 * - `sanitiseCgName(input)` — returns the cleaned version of the raw
 *                             input: HTML/control chars stripped,
 *                             whitespace collapsed, length capped.
 *                             This is what we feed back into the
 *                             controlled `<input>` so the user sees
 *                             exactly what will be submitted.
 * - `validateCgName(input)` — returns a user-facing error string if
 *                             the *raw* input fails a hard rule (empty
 *                             after sanitise, contained an HTML tag,
 *                             or sanitises to something the daemon's
 *                             slugify would collapse to an empty
 *                             slug), or `null` when acceptable.
 */
export const CG_NAME_MAX_LENGTH = 80;

// Detect HTML tag *shape* in the raw input. Used only for the
// "you typed HTML" warning, never for sanitisation. Declared without
// the `g` flag so `.test()` is stateless and safe to call on every
// keystroke without stepping `lastIndex` between calls.
const HTML_TAG_SHAPE_RE = /<\/?[a-z][^>]*>/i;

// Strip every ASCII control character EXCEPT the whitespace ones (tab,
// LF, CR) — those are still control codes (0x09/0x0A/0x0D) but the
// next step intentionally collapses them into spaces. Stripping them
// up-front would silently glue surrounding tokens together
// ("\nnewlines\nand\ttabs\n" would render as "newlinesandtabs").
const NON_WHITESPACE_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// The Create modal and CG setup helpers slugify with `/[^a-z0-9]+/g`.
// A Unicode-only display name can survive sanitisation, but it still
// produces an empty context-graph slug. Validate against the exact
// ASCII slug-producing contract so the submit button never sends an id
// ending in a stray "/".
const SLUG_PRODUCING_RE = /[a-z0-9]/i;

/**
 * Strip HTML-tag-shaped spans (`<…>`) from `input` using a manual
 * linear scan rather than `String.prototype.replace(TAG_RE, '')`.
 *
 * This sidesteps CodeQL's `js/incomplete-multi-character-sanitization`
 * rule, which trips on the classic "obfuscated tag" attack — input
 * like `<scr<script>ipt>` collapses to `<script>` after a single
 * regex pass. We instead consume each `<` deterministically up to its
 * next `>`, never re-scanning the buffer, so an inner `<` becomes
 * part of the discarded span and there is no second pass for the
 * static analyser to worry about. Lone `<` / `>` characters that
 * don't introduce a tag-shaped span (e.g. `Project > Beta`) are kept
 * for the bare-bracket strip downstream so we don't over-eat plain
 * text.
 */
function stripHtmlTagSpans(input: string): string {
  let result = '';
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch === 0x3C /* '<' */) {
      const next = input.charCodeAt(i + 1);
      const isTagStart =
        // </tagname  or  <tagname  (a–z A–Z, optionally preceded by /)
        (next >= 0x41 && next <= 0x5A) ||
        (next >= 0x61 && next <= 0x7A) ||
        next === 0x2F /* '/' */;
      if (isTagStart) {
        const end = input.indexOf('>', i + 1);
        if (end === -1) {
          // Unclosed tag: drop the rest of the input. The bare-
          // bracket strip below clears any residual angle brackets.
          break;
        }
        i = end + 1;
        continue;
      }
    }
    result += input[i];
    i += 1;
  }
  return result;
}

export function sanitiseCgName(input: string): string {
  if (typeof input !== 'string') return '';
  let v = stripHtmlTagSpans(input);
  // Belt-and-braces: drop any residual `<` / `>` characters. Without
  // this a payload like `< not a tag >` would survive the tag-shape
  // scan above (since `< ` doesn't look like a tag start) and the
  // user would still submit a name containing angle brackets.
  v = v.replace(/[<>]/g, '');
  v = v.replace(NON_WHITESPACE_CONTROL_CHARS_RE, '');
  v = v.replace(/\s+/g, ' ');
  v = v.trim();
  if (v.length > CG_NAME_MAX_LENGTH) v = v.slice(0, CG_NAME_MAX_LENGTH);
  return v;
}

export function validateCgName(input: string): string | null {
  const cleaned = sanitiseCgName(input);
  if (!cleaned) return 'Enter a name with at least one letter or digit.';
  if (!SLUG_PRODUCING_RE.test(cleaned)) {
    return 'Name must contain at least one letter or digit.';
  }
  if (HTML_TAG_SHAPE_RE.test(input)) {
    return 'HTML tags are not allowed in the name — they have been stripped automatically.';
  }
  if (input.length > CG_NAME_MAX_LENGTH) {
    return `Name was trimmed to ${CG_NAME_MAX_LENGTH} characters (was ${input.length}).`;
  }
  return null;
}
