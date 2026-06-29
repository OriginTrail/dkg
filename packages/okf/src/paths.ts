/**
 * Concept-ID ↔ path resolution and OKF cross-link resolution.
 *
 * The segment-validation regex is kept byte-for-byte in agreement with the
 * OKF reference agent's `okf/src/reference_agent/bundle/paths.py`:
 *
 *   _SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")
 *
 * matched with `fullmatch`. A path segment must start with an alphanumeric or
 * underscore, then may contain alphanumerics, underscore, dot or hyphen.
 */

import { DEFAULT_IRI_BASE } from './constants.js';

/** Reserved filenames that are NOT concepts (SPEC §3.1, §6, §7). */
export const RESERVED_FILENAMES = new Set(['index.md', 'log.md']);

/** Mirrors `paths.py` `_SEGMENT_RE` used with `fullmatch`. */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;

/** A scheme-prefixed URL (http:, https:, mailto:, urn:, …) — never a concept link. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isValidSegment(segment: string): boolean {
  return SEGMENT_RE.test(segment);
}

/** POSIX basename of a bundle-relative path. */
export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

/** True for reserved `index.md` / `log.md` at any depth (SPEC §3.1). */
export function isReservedFile(path: string): boolean {
  return RESERVED_FILENAMES.has(basename(path));
}

/** True for a non-reserved `.md` file (i.e. a concept document, SPEC §4). */
export function isConceptFile(path: string): boolean {
  return path.endsWith('.md') && !isReservedFile(path);
}

/**
 * Bundle-relative path → concept ID (path with `.md` removed, SPEC §2).
 * `tables/blocks.md` → `tables/blocks`.
 */
export function pathToConceptId(path: string): string {
  const noExt = path.endsWith('.md') ? path.slice(0, -3) : path;
  // Normalise any backslashes a Windows caller might pass; bundles are POSIX.
  return noExt.split(/[\\/]/).filter((s) => s.length > 0).join('/');
}

/** Concept ID → deterministic subject IRI. Same bundle ⇒ same IRI. */
export function conceptIdToIri(conceptId: string, iriBase: string = DEFAULT_IRI_BASE): string {
  return `${iriBase}${conceptId}`;
}

/**
 * Node-side Knowledge Asset / assertion name for a concept.
 *
 * DKG asset/assertion names cannot contain `/`, but OKF concept IDs are
 * path-based (`tables/blocks`). The encoding must be **injective** — a naive
 * `/`→`__` collapses `a/b` and the literal concept `a__b` onto the same name.
 * So escape the escape character first (`_`→`_5f`), then `/`→`_2f` (the chars'
 * hex codes). `a/b`→`a_2fb`, `a__b`→`a_5f_5fb` — distinct. The RDF subject IRI
 * is unaffected; it keeps the original `/`-bearing concept ID.
 */
export function conceptIdToKaName(conceptId: string): string {
  return conceptId.replace(/_/g, '_5f').replace(/\//g, '_2f');
}

/**
 * Resolve a Markdown link `href` written inside the concept `fromConceptId`
 * into a candidate target concept ID, per SPEC §5. Handles:
 *   - absolute (bundle-relative): `/tables/customers.md`
 *   - relative: `./other.md`, `../tables/x.md`
 *   - bare-sibling: `x.md`
 *   - extension-less variants: `x`, `../tables/x`
 *   - `#anchor` / `?query` suffixes are stripped first
 *
 * Returns `null` for: external URLs (scheme-prefixed), pure anchors, paths that
 * escape the bundle root, directory links, or any candidate whose segments fail
 * the `paths.py` validation regex (so it could not be a concept ID anyway).
 *
 * Note: this returns a *candidate* — whether the target actually exists in the
 * bundle is decided by the caller against the Pass-1 concept map. A candidate
 * that does not exist is a broken link, which is NOT an error (SPEC §5.3/§9).
 */
export function resolveLinkTarget(href: string, fromConceptId: string): string | null {
  // Strip anchor / query.
  let target = href.split('#')[0].split('?')[0].trim();
  if (target.length === 0) return null;
  // External URL (http:, mailto:, …) — not a concept link.
  if (SCHEME_RE.test(target)) return null;
  // A trailing slash denotes a directory, not a concept document.
  if (target.endsWith('/')) return null;

  let stack: string[];
  if (target.startsWith('/')) {
    // Absolute, bundle-relative.
    stack = [];
    target = target.slice(1);
  } else {
    // Relative to the linking concept's directory.
    stack = fromConceptId.split('/').slice(0, -1);
  }

  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null; // escapes the bundle root
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return null;

  // Drop a trailing `.md` extension (extension-less links are left as-is).
  const last = stack[stack.length - 1];
  if (last.endsWith('.md')) {
    stack[stack.length - 1] = last.slice(0, -3);
  }
  if (stack[stack.length - 1].length === 0) return null; // directory link

  // Every segment must be a valid concept-ID segment, else it can't be a concept.
  for (const seg of stack) {
    if (!isValidSegment(seg)) return null;
  }
  return stack.join('/');
}
