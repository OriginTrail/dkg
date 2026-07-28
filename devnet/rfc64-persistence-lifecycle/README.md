# OT-RFC-64 Gate 0: production persistence lifecycle

This bounded runtime gate starts the built, production `DKGAgent` in a real
child process. It stages one deterministic, signature-verified control object
through the agent-owned RFC-64 persistence boundary, proves that another
process cannot acquire the inventory lease, then exercises both shutdown paths:

1. cross-platform stdin command -> `DKGAgent.stop()` -> closed persistence ->
   successful restart;
2. forced process termination (`SIGKILL` in the Node child-process API, with no
   JavaScript cleanup) -> operating-system lease recovery.

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

The root command has two distinct steps. `:generate` builds and exercises the
production lifecycle, writing raw evidence with `gateEvaluation.status` set to
`not-evaluated`. `:verify` then reads that artifact as a closed schema, pins its
source commit to the current clean tracked `HEAD`, evaluates every required
runtime/lifecycle/filesystem invariant, and prints `PASS` only after successful
verification. Either step can be invoked separately:

```sh
pnpm test:gate0:rfc64-persistence-lifecycle:generate
pnpm test:gate0:rfc64-persistence-lifecycle:verify
```

Focused evidence-encoder, child-process cleanup, repository-state, and
artifact-publication tests run with:

```sh
pnpm test:gate0:rfc64-persistence-lifecycle:unit
```

Strictly typecheck the producer, runner, verifier, and focused tests with:

```sh
pnpm typecheck:gate0:rfc64-persistence-lifecycle
```

The default artifact is:

```text
devnet/rfc64-persistence-lifecycle/artifacts/gate0-result.json
```

The verifier writes a separate deterministic verdict artifact:

```text
devnet/rfc64-persistence-lifecycle/artifacts/gate0-verdict.json
```

Set `DKG_RFC64_GATE0_ARTIFACT` or `DKG_RFC64_GATE0_VERDICT_ARTIFACT` to override
those paths. The gate deliberately does not add an HTTP/API route. Its only
control channel is the parent/child stdio graceful-stop command plus the forced
process-termination boundary used for crash recovery. Each graceful child must
emit an exact closed-state event after `DKGAgent.stop()` and before a clean exit.
A shared `scripts/devnet.sh` cluster is not required: RFC-64 persistence is
acquired before networking, and isolating this gate avoids mutating a developer's
existing devnet.

Artifact publication uses an exclusive `0600` sibling temporary file, file
`fsync`, atomic rename, parent-directory topology revalidation, and a parent
directory `fsync` on POSIX. Windows performs the same file flush, rename, and
topology validation while reporting that directory `fsync` is unavailable. A
symlink target or symlink parent is rejected. The runner logs the SHA-256 of the
final bytes, allowing two runs at the same clean commit to prove byte identity.

The verifier rejects missing or extra fields, non-canonical/lossy JSON, a dirty or
mismatched source commit, malformed lifecycle evidence, changed file lists or
digests, unsuccessful exits, non-busy lease probes, and incomplete POSIX mode or
Windows protected-owner ACL-policy evidence. Mutation tests delete, alter, and
extend every required schema location, including both graceful closed-state
events.

The `RFC-64 inventory Windows gate` hosted workflow runs the exact
generator-plus-verifier command on `windows-latest`. It is expected to reach the
same final `PASS` while proving that the stdin graceful-stop path closes
persistence and the forced-termination path still recovers the operating-system
lease on Windows.

A PASS on this standalone harness branch covers only the bounded evidence verifier.
It is not a formal OT-RFC-64 Gate 0 result. Formal evaluation requires running this
exact generator-plus-verifier command on the assembled integration commit.
