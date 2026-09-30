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
| N x kill -9 | The core is SIGKILLed the moment a new frame lands in its log (so the kill falls in the append -> cursor write -> directory fsync window, or right after it) and restarted. No `<key>.<log\|meta>.tmp-*` file that existed at the kill survives the restart; host mode is re-engaged from the persisted flag; after new frames arrive the log has no torn tail, seqnos are strictly increasing with no duplicate, and the `.meta` cursor is never below the log tail. The suite snapshots the complete frames on disk at the kill (seqno plus a digest of each whole frame) once the killed processes are gone, and requires the recovered log to start with exactly that prefix (none dropped, replaced or reordered) and every frame appended after the restart to sit after it with a seqno above the high-water mark, `max(.meta cursor, last complete frame)` at the kill. The suite prints which crash window each kill hit. |
| Catch-up | The curator edge pages the core with `POST /api/shared-memory/host-catchup`, one round per call, resuming from the returned `nextSeqno` until the core has nothing more, from several starting cursors. Across the pages the core serves exactly the frames with seqno greater than the starting cursor and the final cursor is the true last seqno. |

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

The unit tests (`packages/agent/test/swm/host-mode-store-durability.test.ts`)
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
daemon started from this checkout, `<repoRoot>/.../cli.js daemon-supervisor` or
`daemon-worker`. A live PID that is not one (a stale file whose number an
unrelated process has taken) makes the helper throw without signalling anything,
instead of killing it or silently skipping it, which would leave the node running
and turn the kill -9 into a graceful stop. The check runs before the wait for the
next frame, so the `SIGKILL` itself stays immediate. The node's home is not used
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
