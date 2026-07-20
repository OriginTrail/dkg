# WAL-000 DKG semantic baseline and legacy-sync characterization

This directory defines the executable oracle for the production-authoritative
SWM/VM path before the WAL parallel protocol is integrated. It does not enable
WAL, register a protocol, change a configuration default, or write into an
existing node home.

The current sync implementation is not a correctness baseline. Equal-peer,
delta, reconnect, recovery, interrupted-sync, and sync-performance scenarios
are executed only to characterize what the old path currently does. Their
evidence is explicitly tagged `sync-characterization`, excluded from
`semantic-oracle.json`, and MUST NOT be used as a WAL correctness/parity target.
WAL correctness comes from the RFC invariants and new protocol acceptance tests.

## Outputs

- `scenario-matrix.json` fixes the semantic and performance workloads.
- `PATH-INVENTORY.md` maps each frozen fixture to the production-authority path
  it exercises and records the known pre-existing skips.
- `semantic-oracle.json` freezes only DKG semantics, crypto/authorization, VM
  lifecycle, and storage-safety assertions plus their exact source bytes.
- `evidence.schema.json` defines the machine-readable receipt envelope.
- Each execution writes raw stdout, stderr, Vitest JSON, and one evidence
  manifest outside the repository, under `/tmp/dkg-wal-000-*` by default.

The normative semantic digest is deliberately tied to both the full assertion names and
the exact source bytes of the selected legacy tests. Existing tests contain the
expected RDF, Merkle roots, lifecycle states, authorization decisions, chain
outcomes, retry behavior, and failure invariants. Freezing only test names
would allow those expected values to drift unnoticed.

The matrix records both the human-readable `origin/main` source ref and the
exact base commit used to create this baseline. Later movement of the remote
tracking ref is recorded in evidence but cannot silently reinterpret the
frozen corpus.

Before either profile runs, the harness builds the repository's runtime package
set and records that preparation command, timing, resource usage, and raw logs
in the receipt. This keeps the command reproducible from a clean checkout where
workspace package `dist` entries do not exist yet. It follows the repository's
Node-test build path by setting `DKG_SKIP_EVM_BUILD=1`, so committed EVM ABI
fixtures are reused and the build cannot rewrite deployment metadata.
The repository's existing Vitest Hardhat global setup rewrites the tracked
`localhost_contracts.json` development-deployment manifest. The runner protects
that exact file by snapshotting and restoring its original bytes after every
scenario, and records each restoration digest in the receipt. Git state is
checked at every scenario boundary; any change outside that one explicit
generated-file allowlist fails the run instead of producing an accepted receipt.

## Commands

```sh
pnpm wal:baseline:list
pnpm wal:baseline:semantic
pnpm wal:baseline:performance
pnpm wal:baseline
```

During harness development only, `--allow-dirty` permits execution before the
baseline branch is committed. Accepted receipts must come from a clean commit.
`--output=/absolute/path` may select another receipt directory, but the runner
rejects any output path inside the repository.

## Safety boundary

The runner creates a distinct `DKG_HOME` and temporary directory for every
scenario repetition. It strips wallet keys, mnemonics, auth tokens, and
configured remote RPC/API endpoints from child environments. If a DKG or chain
endpoint environment variable names a non-loopback host, execution fails before
starting a scenario.

This first command family is hermetic. A future live-devnet profile must retain
the same safety rules, use a task-owned devnet directory and ports, and require
an explicit opt-in; it must never infer permission to contact an existing
deployment.
