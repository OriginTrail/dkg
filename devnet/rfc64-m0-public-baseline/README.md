# RFC-64 M0 current public baseline

M0 is a composed release gate for the public RFC-64 slice already present in
the repository. It turns the previously separate lifecycle, SWM, finalized-VM,
cold-start, failover, and bounded-work proofs into one reproducible command.
It does not enable RFC-64 features, change node defaults, or claim private
Context Graph support.

Run from a clean repository root:

```sh
pnpm test:m0:rfc64-public-baseline
```

The workspace-owned runner fails closed unless every row below passes on the
exact checked-out commit. The root command is only an alias for this suite.

| M0 acceptance row | Product boundary exercised |
| --- | --- |
| Persistence lifecycle | Production `DKGAgent` child process; graceful stop, `SIGKILL`, lease recovery, exact durable object readback |
| Public SWM policy parity | Distinct author and receiver OS processes; public-open and public-curated; exact N-Quads, content digest, bundle digest, and durable applied head |
| Finalized public VM | Distinct author and receiver OS processes; finalized chain policy and numeric CG id; exact VM projection and metadata before applied-head commit |
| Automatic cold start and restart | Production catalog bootstrap starts after publication, reaches the exact durable head, and reuses it after receiver restart |
| Source recovery | An initial provider miss is retried and the later viable provider is selected automatically |
| Public-curated cold/warm parity | Warm and cold receivers converge to one exact finalized head and retain it across restart |
| Bounded work | Catalog receiver queue/concurrency bounds, unified backpressure invariants, and reconnect-churn behavior |

The runtime sub-gates write their existing commit-bound artifacts under:

- `devnet/rfc64-persistence-lifecycle/artifacts/`
- `devnet/rfc64-cp1-public-swm-parity/artifacts/`
- `devnet/rfc64-gate2-multi-asset-completeness/artifacts/`

The agent-owned `rfc64-m0-recovery-manifest.mjs` is the canonical source for
the three recovery ids, row labels, and test titles. The M0 runner, dispatcher,
and focused recovery describe all derive from it. The M0 runner passes each
manifest id directly to one stable dispatcher, and each row runs as an
independent child command without title filters or reporter parsing.
The ordinary native-wiring suite is skipped as one unit in focused mode, and
discovery fails if any required scenario is missing or duplicated. The
bounded-work row selects stable test files rather than English test titles.
Every child process exit status is part of the composed gate; focused tests do
not substitute fixture data for runtime observations.

## What M0 does not prove

M0 is a one-machine reproducible foundation. It does not prove internet/NAT
reachability, testnet fleet behavior, long-duration soak stability, private
content confidentiality, membership revocation, or private-curated publishing.
Those remain later milestones and must not be inferred from an M0 pass.

For release comparison, run the same command in clean worktrees at the exact
`main` and `testnet-canary` commits and record both SHAs. A green run on one ref
does not imply that the other ref was tested.
