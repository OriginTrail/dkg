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

/**
 * Parse a `major.minor.patch` contract `_VERSION` string into a numeric triple.
 *
 * Missing or non-numeric components read as 0, so a pre-versioned, empty, or
 * oddly-formatted value sorts BELOW every real release rather than throwing —
 * "unparseable" and "too old" must reach callers as the same answer, since both
 * mean "do not enable the capability". Note this is deliberately NOT semver:
 * pre-release/build suffixes are truncated by `parseInt` (`10.0.6-rc.1` reads as
 * `10.0.6`), which is correct for contract `_VERSION` literals — they are plain
 * dotted integers by convention.
 */
export function parseContractVersionTriple(raw: string): [number, number, number] {
  const parts = String(raw).split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * True iff contract version `raw` is at least `minimum`, compared major → minor →
 * patch. Callers gate capabilities on this and MUST fail closed (treat an
 * unreadable version as unsupported) — see the consumers listed above.
 */
export function contractVersionAtLeast(raw: string, minimum: string): boolean {
  const [maj, min, pat] = parseContractVersionTriple(raw);
  const [minMaj, minMin, minPat] = parseContractVersionTriple(minimum);
  if (maj !== minMaj) return maj > minMaj;
  if (min !== minMin) return min > minMin;
  return pat >= minPat;
}
