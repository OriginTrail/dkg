# swm-host-store-durability - devnet validation

`kill -9` of a core that hosts a curated context graph's Shared Working Memory
(the `SwmHostModeStore` files in `<home>/swm-host/`) must not corrupt the store
or recycle a seqno, and a member's host catch-up must still page to the end.

## What it proves

The hosting core (node4) runs with `swmHostMode.stripCiphertext=false` (the
default strips private ciphertext, so a core normally keeps nothing for a
curated graph). The curator edge (node5) creates a fresh curated graph with the
member edge (node6) allowlisted, the core is designated to host it through
`POST /api/shared-memory/host-mode/subscribe`, and a writer keeps sharing
Knowledge Assets.

| Step | Assertion |
|------|-----------|
| Baseline | The core's `<key>.log` holds the curator's shares as frames, seqnos start at 1 and are strictly increasing, the API stats agree, and the `.meta` cursor equals the last seqno. Without this the rest would be vacuous. |
| N x kill -9 | The core is SIGKILLed the moment a new frame lands in its log (so the kill falls in the append -> cursor write -> directory fsync window, or right after it) and restarted. No `<key>.<log\|meta>.tmp-*` file that existed at the kill survives the restart; host mode is re-engaged from the persisted flag; after new frames arrive the log has no torn tail, seqnos are strictly increasing with no duplicate or reused value across the crash (every new seqno is above the pre-kill high-water mark), and the `.meta` cursor is never below the log tail. The suite prints which crash window each kill hit. |
| Member catch-up | The member calls `POST /api/shared-memory/host-catchup` against the core from several `sinceSeqno` cursors. The core serves exactly the frames with seqno greater than the cursor and reports the true last seqno as `nextSeqno`. |

The unit tests (`packages/agent/test/swm/host-mode-store-durability.test.ts`)
and the real-file SIGKILL e2e
(`packages/agent/test/swm/host-mode-store-crash.e2e.test.ts`) pin each crash
window deterministically; this suite shows the same invariants hold inside a
real daemon under live gossip.

## Run

```bash
pnpm run build && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:swm-host-store-durability
```

Runtime is about 8-15 minutes (`SWM_HOST_KILL_CYCLES`, default 5, sets the
number of kill/restart cycles). The suite restarts node4 several times,
restores node4's `config.json` and restarts it once more on exit, and creates
only its own curated context graph.
