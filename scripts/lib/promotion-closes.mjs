/**
 * Closing-keyword collection for a `testnet-canary` -> `main` promotion PR.
 *
 * WHY THIS EXISTS: GitHub only honours closing keywords when a pull request
 * merges into the repository's DEFAULT branch (`main`). Day-to-day PRs here
 * target `testnet-canary`, so their `Closes #N` lines never fire and the issues
 * stay open forever even though the fix shipped — nothing closes them
 * retroactively when canary is promoted. Restating the keywords in the
 * promotion PR body is what actually closes them.
 *
 * Pure functions only. All git / gh I/O lives in `scripts/promotion-closes.mjs`
 * so the parsing and filtering rules below are fixture-testable.
 */

/**
 * GitHub's same-repository closing keywords.
 *
 * The separator is `\s*:?\s*` because GitHub also accepts a colon
 * (`Fixes: #123`), a form that appears in this repo's own history (PRs #933,
 * #940, #943). Missing one of those recreates exactly the stale-backlog problem
 * this workflow exists to prevent, whereas emitting one extra line is harmless
 * — so the parser errs toward inclusion.
 */
export const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;

/** Extract PR numbers from `git log --format=%s` merge subjects. */
export function parseMergedPrNumbers(subjects) {
  const out = new Set();
  for (const line of String(subjects ?? '').split('\n')) {
    const m = /^Merge pull request #(\d+)\b/.exec(line.trim());
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Extract every issue number a PR body claims to close.
 * Deduplicated, ascending. Tolerates null/undefined/multiline bodies.
 */
export function extractClosingRefs(body) {
  const out = new Set();
  const text = String(body ?? '');
  // The regex is module-level and /g, so reset before each use.
  CLOSING_KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = CLOSING_KEYWORD_RE.exec(text)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * Render the block for the promotion PR body.
 * `entries` is [{ issue, pr }]; only issues the caller has POSITIVELY
 * established are open should be passed in.
 */
export function formatClosesBlock(entries) {
  const seen = new Map();
  for (const { issue, pr } of entries) {
    if (!seen.has(issue)) seen.set(issue, pr);
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([issue, pr]) => `Closes #${issue}  <!-- shipped in PR #${pr} -->`)
    .join('\n');
}
