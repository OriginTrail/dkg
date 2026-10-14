/**
 * Which frontmatter key owns a value, shared by both directions: the base
 * fields the importer maps itself (SPEC §4.1, §13.1), the v0.2 families,
 * producer keys (every other key, SPEC §4.1/§11), and the one precedence rule
 * between `generated.at` and the legacy `timestamp` (§13.1). The importer
 * (`mapping.ts`), the `generated` / `timestamp` codec (`families/generated.ts`)
 * and the exporter (`export.ts`) all read this policy. It depends on the family
 * definitions (data), the timestamp primitives and the shared value helpers,
 * and on no mapping, Markdown or term-encoding code.
 */

import { FAMILY_BY_KEY } from './families/specs.js';
import { dateTimeLexical } from './timestamps.js';
import { isBlank, isMapping } from './utils.js';

/**
 * The frontmatter keys the importer maps itself (SPEC §4.1, §13.1). The v0.2
 * families come next (`families/`), and every other key is a producer key.
 */
export const BASE_KEYS: ReadonlySet<string> = new Set(['type', 'title', 'description', 'tags', 'timestamp', 'resource']);

/**
 * `generated.at` when it gives a last-modified time, which then supersedes the
 * v0.1 `timestamp` (§13.1); a blank one is missing (§11) and does not.
 */
export function generatedAtOf(frontmatter: Record<string, unknown>): string | null {
  const at = isMapping(frontmatter.generated) ? frontmatter.generated.at : undefined;
  return isBlank(at) ? null : dateTimeLexical(at);
}

/** Whether the importer reads `timestamp` as a producer key: when a `generated.at` supersedes it. */
export function timestampIsProducerKey(frontmatter: Record<string, unknown>): boolean {
  return generatedAtOf(frontmatter) !== null;
}

/** The last-modified time a concept reports: `generated.at`, else the legacy `timestamp`. */
export function lastModifiedOf(frontmatter: Record<string, unknown>): string | null {
  return generatedAtOf(frontmatter) ?? dateTimeLexical(frontmatter.timestamp);
}

/**
 * Whether the importer reads `key` in `frontmatter` as a producer key, kept
 * as `schema:<camelKey>` (SPEC §4.1/§11): a key that is neither a base field
 * nor a v0.2 family, and the legacy `timestamp` when a `generated.at`
 * supersedes it (§13.1). Export writes a producer value back only under such
 * a key.
 */
export function readsAsProducerKey(key: string, frontmatter: Record<string, unknown>): boolean {
  if (key === 'timestamp') return timestampIsProducerKey(frontmatter);
  return !BASE_KEYS.has(key) && !FAMILY_BY_KEY.has(key);
}
