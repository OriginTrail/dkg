// SPDX-License-Identifier: Apache-2.0

/**
 * Deployed-contract `_VERSION` parsing and comparison — the ONE comparator behind
 * every capability gate in this package.
 *
 * Several features are gated on the version of the contract actually deployed at
 * the Hub-resolved address rather than on the node's own software version, so a
 * node self-heals the moment the Hub is repointed at an upgraded contract: no
 * restart, no config edit. That idiom needs exactly one parse/compare, because a
 * version gate is a capability boundary where drift is SILENT — a comparator that
 * disagrees with its neighbour by one patch level fails nothing, passes every
 * suite, and simply leaves a feature dormant (or enables it a release early
 * against a contract that will revert).
 *
 * Consumers:
 *   - `evm-adapter-base.ts` — attested-author publish authorization (GH#1689)
 *   - `evm-adapter-conviction.ts` — PCA `clearAgents` support
 */

/** A parsed contract version: exactly `[major, minor, patch]`. */
export type VersionTriple = readonly [number, number, number];

/**
 * Full-string dotted-integer match, or `null`.
 *
 * STRICT on purpose. The obvious implementation — `split('.')` plus `parseInt` —
 * accepts garbage in the direction that reads as a NEWER version: `'11.garbage'`
 * parses as `11.0.0` and `'10.1.7junk'` as `10.1.7`, so both would ENABLE a
 * capability gate. Unreachable today because every `_VERSION` is a hardcoded
 * literal, but this is the one canonical helper future gates will reuse, and a
 * parser that turns malformed input into a confident "yes" is the wrong thing for
 * a capability boundary to inherit.
 *
 * `null` means "not a version I can read", which callers MUST treat exactly like
 * "too old" — see {@link contractVersionAtLeast}. Deliberately NOT semver: no
 * pre-release or build suffixes, because contract `_VERSION` literals are plain
 * dotted integers by convention and reading `10.0.6-rc.1` as `10.0.6` would be
 * guessing at intent.
 */
export function parseContractVersion(raw: string): VersionTriple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(raw));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True iff contract version `raw` is at least `minimum`, compared major → minor →
 * patch.
 *
 * FAILS CLOSED: an unparseable `raw` (or `minimum`) yields `false`, so "I cannot
 * read this version" and "this version is too old" reach a capability gate as the
 * same answer — the only safe conflation, since both mean "do not enable".
 */
export function contractVersionAtLeast(raw: string, minimum: string): boolean {
  const version = parseContractVersion(raw);
  const floor = parseContractVersion(minimum);
  if (version === null || floor === null) return false;
  const [maj, min, pat] = version;
  const [minMaj, minMin, minPat] = floor;
  if (maj !== minMaj) return maj > minMaj;
  if (min !== minMin) return min > minMin;
  return pat >= minPat;
}
