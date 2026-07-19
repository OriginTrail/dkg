# OT-RFC-64 Gate 0: production persistence lifecycle

This bounded runtime gate starts the built, production `DKGAgent` in a real
child process. It stages one deterministic, signature-verified control object
through the agent-owned RFC-64 persistence boundary, proves that another
process cannot acquire the inventory lease, then exercises both shutdown paths:

1. graceful `SIGTERM` -> `DKGAgent.stop()` -> successful restart;
2. `SIGKILL` (no JavaScript cleanup) -> operating-system lease recovery.

Each restarted agent re-reads and cryptographically verifies the exact durable
object before the harness compares byte hashes, object/signature counts, and
owner-only file modes. Before any child is spawned, the runner requires a clean
tracked worktree and reads the tested commit from `git rev-parse HEAD`; it repeats
that check before publishing evidence. Untracked and ignored build/artifact files
do not affect this tracked-source check.

The result is encoded as stable, sorted JSON without timestamps, PIDs, durations,
or temporary absolute paths. The encoder accepts only lossless plain JSON data:
finite non-negative-zero numbers, strings, booleans, null, dense plain arrays, and
plain enumerable data-property objects without cycles, aliases, accessors, symbols,
or hidden fields.

Run from the repository root:

```sh
pnpm test:gate0:rfc64-persistence-lifecycle
```

Focused evidence-encoder, repository-state, and artifact-publication tests run with:

```sh
pnpm test:gate0:rfc64-persistence-lifecycle:unit
```

The default artifact is:

```text
devnet/rfc64-persistence-lifecycle/artifacts/gate0-result.json
```

Set `DKG_RFC64_GATE0_ARTIFACT` to override that path. The gate deliberately
does not add an HTTP/API route. Its only control channel is the parent/child
stdio and process-signal boundary. A shared `scripts/devnet.sh` cluster is not
required: RFC-64 persistence is acquired before networking, and isolating this
gate avoids mutating a developer's existing devnet.

Artifact publication uses an exclusive `0600` sibling temporary file, file
`fsync`, atomic rename, parent-directory topology revalidation, and a parent
directory `fsync` on POSIX. Windows performs the same file flush, rename, and
topology validation while reporting that directory `fsync` is unavailable. A
symlink target or symlink parent is rejected. The runner logs the SHA-256 of the
final bytes, allowing two runs at the same clean commit to prove byte identity.

This harness can prove that its bounded lifecycle checks completed. It does not
declare OT-RFC-64 Gate 0 passed: final Gate 0 evaluation remains unavailable until
the final RFC-64 integration has been assembled and tested at its own exact HEAD.
