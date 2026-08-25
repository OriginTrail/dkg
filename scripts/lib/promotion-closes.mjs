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

/**
 * Merge-commit subject: `Merge pull request #123 from owner/branch`.
 * Squash subject: GitHub appends ` (#123)` to the PR title.
 *
 * Both are needed — this repository has `allow_merge_commit` AND
 * `allow_squash_merge` enabled, and both appear in `testnet-canary`'s history
 * (e.g. `refactor(2305): … (#2307)`). Parsing only the merge form silently
 * dropped every squash-merged PR, recreating the stale-backlog problem this
 * command exists to prevent (PR #2327 review).
 *
 * NOTE: a rebase-merge leaves no PR marker in the subject at all and is not
 * discoverable this way. The repo does not use it for PR merges today; if that
 * changes, discovery must move to GitHub's commit-to-PR association.
 */
const MERGE_SUBJECT_RE = /^Merge pull request #(\d+)\b/;
const SQUASH_SUBJECT_RE = /\(#(\d+)\)\s*$/;

/** Extract PR numbers from `git log --format=%s` subjects. */
export function parseMergedPrNumbers(subjects) {
  const out = new Set();
  for (const raw of String(subjects ?? '').split('\n')) {
    const line = raw.trim();
    const m = MERGE_SUBJECT_RE.exec(line) ?? SQUASH_SUBJECT_RE.exec(line);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Remove HTML comments before parsing.
 *
 * GitHub does not treat commented-out text as an active closing reference, and
 * neither must we: `.github/PULL_REQUEST_TEMPLATE.md` ships
 * `<!-- Link any related issues: Fixes #123, Relates to #456 -->`, and 15
 * merged PRs still carry it verbatim. Parsing it would emit `Closes #123` into
 * the promotion body and close a completely unrelated issue on merge — a
 * wrong-closure bug in the one tool whose job is closing issues correctly
 * (PR #2327 review).
 */
export function stripHtmlComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Extract every issue number a PR body ACTIVELY claims to close.
 * Deduplicated, ascending. Tolerates null/undefined/multiline bodies.
 */
export function extractClosingRefs(body) {
  const out = new Set();
  const text = stripHtmlComments(body);
  // The regex is module-level and /g, so reset before each use.
  CLOSING_KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = CLOSING_KEYWORD_RE.exec(text)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * Canonicalise references across PRs BEFORE any issue lookup: one entry per
 * issue, attributed to the first (lowest-numbered) PR that claimed it.
 *
 * Keeping dedup here rather than in the formatter means the caller performs
 * exactly one state lookup per unique issue instead of one per reference
 * (PR #2327 review).
 *
 * @param {Array<{pr: number, body: string}>} prBodies
 * @returns {Map<number, number>} issue -> first PR that claimed it
 */
export function canonicalIssueRefs(prBodies) {
  const out = new Map();
  for (const { pr, body } of [...prBodies].sort((a, b) => a.pr - b.pr)) {
    for (const issue of extractClosingRefs(body)) {
      if (!out.has(issue)) out.set(issue, pr);
    }
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Render the block for the promotion PR body.
 * `entries` is [{ issue, pr }], already canonical and already filtered to
 * issues the caller POSITIVELY established are open.
 */
export function formatClosesBlock(entries) {
  return [...entries]
    .sort((a, b) => a.issue - b.issue)
    .map(({ issue, pr }) => `Closes #${issue}  <!-- shipped in PR #${pr} -->`)
    .join('\n');
}
