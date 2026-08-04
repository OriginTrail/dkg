# Issue #2052 system-record characterization

This directory is the design/characterization gate for
[`docs/adr/0002-system-record-sync-v1.md`](../../docs/adr/0002-system-record-sync-v1.md).
It changes no daemon behavior.

The committed r27 fixture combines the public issue's system-sync observations
with a later, redacted export of the stopped node's `agents` data projection.
Its provenance records that distinction and the exact diagnostics capture
window. It deliberately excludes `agents/_meta`: that graph is withheld by
current sync policy and is not the phonebook projection being characterized.

Profile records are grouped by the `dkg:peerId` predicate, never inferred from the
wallet-address root. Missing-peer, multi-peer-root, and peer-on-multiple-root cases
remain explicit ambiguous evidence instead of being projected into trusted
records. Wallet authority kind is `unknown` unless independently classified from
finalized chain code. V1 capability is `unsupported` for the baseline because the
protocol does not exist at the captured commit.

Run:

```bash
pnpm --filter @devnet/issue-2052-system-records typecheck
pnpm --filter @devnet/issue-2052-system-records test
pnpm --filter @devnet/issue-2052-system-records characterize
pnpm bench:w1-sync-telemetry:smoke
```

The package test runs the byte-for-byte fixture check before the Node test suite.
`pnpm --filter @devnet/issue-2052-system-records build-fixture` is also available as
the standalone reproducibility gate.

The committed sanitized inputs are sufficient to rebuild and byte-compare the
fixture without the original node home or diagnostics file:

```bash
node --import tsx devnet/issue-2052-system-records/build-fixture.ts --check
```

For an audit against the original stopped-store copy, the sanitized source and
fixture were generated with:

```bash
node --import tsx devnet/issue-2052-system-records/extract-rdf.ts \
  --endpoint http://127.0.0.1:17880 \
  --output devnet/issue-2052-system-records/fixtures/r27-v1.json \
  --source-output devnet/issue-2052-system-records/inputs/r27-redacted-source-v1.json \
  --observation-time 2026-08-04T20:24:21.000Z \
  --source-commit c297a7b6ffb6df82305c1f7eb76864a8b7a77c35 \
  --system-sync-input devnet/issue-2052-system-records/inputs/r27-system-sync-v1.json
```

The sanitized system-sync input records the exact min/max r27 capture bounds and
the original `diagnostics.jsonl` digest,
`sha256:30d3f690d2cc106f3ce97f872d89291d3d687831637ff19ca035b54779fb7f47`.
The source also commits separate raw population/detail input digests. The fixture
builder recomputes the profile digest and a manifest digest binding fixture
identity, every provenance field, and the complete evidence body.

The W1 smoke command measures telemetry record-site overhead only. It does not
measure system replay, B+tree convergence, profile authority, or activation load.
The CLI exposes this only as a load-envelope sub-gate, not a full activation
verdict. The baseline remains activation-ineligible until Stack C/D can produce
real service/arrival measurements, exact encoded bundle byte counts, signed
capability/authority coverage, and serve-lease evidence.
The reported `nquadsBytes` values characterize RDF size only; they are not a
substitute for the encoded transferable bundle size used by the activation gate.

The fixture was generated from an isolated copy of the stopped node's Oxigraph
v0.5.8 store. `extract-rdf.ts` accepts only an unauthenticated localhost endpoint,
retains only frozen allowlisted predicate/subject shapes and byte counts, and rejects
unknown nested subjects or predicates before serialization. It writes no literal,
wallet, peer-ID, peer-ID hash, name, multiaddr, token, or key values. Fixture-local
ordinal aliases retain only the duplicate-key relationships needed by the model.
