/**
 * Producer-defined keys *inside* an OKF v0.2 family (SPEC §4.1 "consumers
 * SHOULD preserve unknown keys") — e.g. `executor.timeout_s`,
 * `usage_window.population`, `verified[].note` — are carried under a
 * family-scoped extension predicate:
 *
 *     okf:<familyKey>.<percent-encoded key>
 *     e.g. http://dkg.io/ontology/okf/executor.timeout_s
 *
 * on the same subject as the family's own fields (the concept for
 * `generated` / `executor` / `attester` / `usage_window`, the entry's node for
 * `verified` / `sources` / `parameters`). The key is percent-encoded with
 * `encodeURIComponent`, so the predicate is always IRI-safe (a space becomes
 * `%20`, `é` becomes `%C3%A9`) and the original key is recovered exactly on
 * export — unlike the camelCase convention used for top-level producer keys,
 * which folds `timeout_s` to `timeoutS` and drops non-ASCII characters.
 */

import { OKF_NS } from './constants.js';

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `okf:<familyKey>.` — the prefix every extension predicate of a family shares. */
export function okfExtensionPrefix(familyKey: string): string {
  return `${OKF_NS}${familyKey}.`;
}

/** The extension predicate for producer key `key` inside family `familyKey`. */
export function okfExtensionPredicate(familyKey: string, key: string): string {
  // encodeURIComponent throws on an ill-formed UTF-16 string; replace lone
  // surrogates (which YAML never produces from a valid UTF-8 file) first.
  return okfExtensionPrefix(familyKey) + encodeURIComponent(key.replace(LONE_SURROGATE_RE, '�'));
}

/**
 * Inverse of `okfExtensionPredicate`: the producer key an extension predicate
 * carries, or `null` when `predicate` is not an extension of `familyKey`.
 * A malformed percent sequence (only possible in a hand-edited graph) is
 * returned undecoded rather than throwing.
 */
export function okfExtensionKey(familyKey: string, predicate: string): string | null {
  const prefix = okfExtensionPrefix(familyKey);
  if (!predicate.startsWith(prefix)) return null;
  const encoded = predicate.slice(prefix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
