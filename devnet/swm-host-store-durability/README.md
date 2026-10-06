# swm-host-store-durability - devnet validation

`kill -9` of a core that hosts a curated context graph's Shared Working Memory
(the `SwmHostModeStore` files in `<home>/swm-host/`) must not corrupt the store
or recycle a seqno, and host catch-up must still page to the end.

## Setup this release needs

Three things have to line up before a devnet core keeps any private SWM
ciphertext at all, so the suite arranges them and undoes them on exit:

- **RFC-64 kill switch on node4 (core) and node5 (curator edge).** In catalog
  mode the legacy SWM transport, and with it host-mode custody, is inert.
- **`swmHostMode.stripCiphertext=false` on node4.** By default a core keeps no
  private ciphertext for a curated graph (OT-RFC-49 WS-A).
- **A curated graph that allowlists only the curator.** A private graph whose
  roster has a reachable peer besides the author is delivered point-to-point and
  never gossiped, which a non-member host cannot receive. With the author as the
  only agent the roster is empty, so the gossip leg that the host store consumes
  stays on. The curator is an allowlisted agent, so it is also a legitimate
  `host-catchup` requester.

## What it proves

| Step | Assertion |
|------|-----------|
| Baseline | The core's `<key>.log` holds the curator's shares as frames, seqnos start at 1 and are strictly increasing, the API stats agree, and the `.meta` cursor equals the last seqno. Without this the rest would be vacuous. |
| N x kill -9 | The core is SIGKILLed the moment a new frame lands in its log (so the kill falls in the append -> cursor write -> directory fsync window, or right after it) and restarted. No `<key>.<log\|meta>.tmp-*` file that existed at the kill survives the restart; host mode is re-engaged from the persisted flag; after new frames arrive the log has no torn tail, seqnos are strictly increasing with no duplicate, and the `.meta` cursor covers the log, trailing it at most by the one append that can be in flight while the writer runs (`checkCursorCoversLog` with `appendInFlight`, counted in frames). The suite snapshots the complete frames on disk at the kill (seqno plus a digest of each whole frame) once the killed processes are gone, and requires the recovered log to start with exactly that prefix (none dropped, replaced or reordered) and every frame appended after the restart to sit after it with a seqno above the high-water mark, `max(.meta cursor, last complete frame)` at the kill. The suite prints which crash window each kill hit. |
| Catch-up | With ingestion stopped, the `.meta` cursor covers the whole log (`checkCursorCoversLog`: the one-frame allowance of the kill cycles no longer applies). The curator edge then pages the core with `POST /api/shared-memory/host-catchup`, one round per call and a page smaller than the log, resuming from the returned `nextSeqno` until the core has nothing more, from several starting cursors. Each call must resume where the last stopped, hold at most a page and advance the cursor over exactly the frames it served, and paging from 0 takes at least three non-empty pages (`checkCatchupWalk`). The envelopes served across the pages are, in order, exactly the frames with seqno greater than the starting cursor, each byte-identical to its stored ciphertext (`checkServedFrames`), and the final cursor is the true last seqno. |

The comparison itself is a pure function (`log-frames.ts`, `checkNoSeqnoReuse`)
with no-devnet tests (`log-frames.test.ts`, included by this suite's vitest
config so `pnpm test:devnet:swm-host-store-durability` runs them too, and
runnable alone with `pnpm vitest run --config
devnet/swm-host-store-durability/vitest.config.ts log-frames`). They pin the case
a weaker check would miss: before the kill the log holds seqnos 1-4 and the meta
says 3; a recovery that drops frame 4 and appends different frames 4 and 5
fails, and the honest recovery (keeps 4, appends 5) passes. A frame replaced in
place, a dropped or reordered prefix frame, a seqno at or below the high-water
mark (including a cursor that was ahead of the log), a duplicate or out-of-order
new seqno, and no new frame at all are each rejected.

The unit tests (`packages/agent/test/swm/host-mode-store-{durable-writes,tail-recovery,cold-init,dirsync-retries}.test.ts`,
over the durable file operations in `packages/agent/src/swm/host-store-durable-fs.ts`)
and the real-file SIGKILL e2e
(`packages/agent/test/swm/host-mode-store-crash.e2e.test.ts`) pin each crash
window deterministically; this suite shows the same invariants hold inside a
real daemon under live gossip.

This suite is a regression and soak check, not a base-versus-fix discriminator:
a process-level `kill -9` leaves the page cache intact (only a power cut loses
un-fsynced writes) and lands between two of the base build's near-instant
writes, so it also passes against the pre-fix store. What it does show on the
fixed build is that every kill lands in the append -> cursor-write window
(`meta lags the log` in the output), because the append now fsyncs, and that
recovery from that window keeps the seqnos strictly monotonic.

## Node lifecycle

Killing and restarting node4 uses the shared helpers in
`devnet/_bootstrap/node-lifecycle.ts` (also used by `core-peers-features`): PID
files, liveness, dead-PID cleanup, the port environment for `devnet.sh
restart-node`, restart plus readiness. They only ever signal PIDs listed in
this devnet's own `node<N>/{daemon,devnet}.pid` files (`daemon.pid` is the
worker, `devnet.pid` the detached supervisor that would respawn it), and never
delete the file of a live process. A PID is also signalled only if it is alive
and its command line (`ps -ww -o command=`: argv, not the environment) is a DKG
daemon started from this checkout: the checkout's CLI entry point
(`<repoRoot>/packages/cli/dist/cli.js`) directly followed by `daemon-supervisor`,
`daemon-worker` or `daemon-foreground-worker`, as the last argument (a process that
only runs from the checkout, such as the test runner, does not qualify). A live PID
that is not one (a stale file whose number an unrelated process has taken) makes the
helper throw without signalling anything, instead of killing it or silently skipping
it, which would leave the node running and turn the kill -9 into a graceful stop. The
check runs before the wait for the next frame (`verifiedNodePids`), so the `SIGKILL`
itself (`sigkillPids`) stays immediate. Restarts go through the same check: the
suite's setup verifies both nodes before it edits a config, and `restartNodeAndWait`
stops the node itself (verify, SIGTERM, SIGKILL after the grace period, remove the
dead PID files) before it calls `devnet.sh restart-node`, whose own stop phase signals
whatever the PID files list without a check and so finds nothing live. (That script
also sweeps the process table for processes that mention the node's home directory,
as it always has; the helpers do not change that.) The node's home is not used
for it: `DKG_HOME` is only in the process environment, while the checkout path is
in every daemon's argv (`devnet.sh` runs nodes with `DKG_NO_BLUE_GREEN=1`). What it
cannot tell apart is a recycled PID that became another daemon of this same
checkout. This suite keeps its own choices as explicit arguments: an
immediate `SIGKILL` of every live daemon process the node's PID files list, the Hardhat
port for `restart-node` taken from node1's config (not `DEVNET_RPC`), an
unparseable PID file removed with the dead ones, and readiness probed without a
token, with a 3 s request timeout, every second. The helpers' no-devnet tests run
with `pnpm test:devnet:manifest`.

## Run

```bash
pnpm run build && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:swm-host-store-durability
```

Runtime is about 3-5 minutes on a warm devnet (`SWM_HOST_KILL_CYCLES`, default 5,
sets the number of kill/restart cycles). The suite restarts node4 several times,
restores the `config.json` of node4 and node5 and restarts them once more on
exit, and creates only its own curated context graph.
