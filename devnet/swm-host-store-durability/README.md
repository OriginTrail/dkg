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
| N x kill -9 | The core is SIGKILLed the moment a new frame lands in its log (so the kill falls in the append -> cursor write -> directory fsync window, or right after it) and restarted. No `<key>.<log\|meta>.tmp-*` file that existed at the kill survives the restart; host mode is re-engaged from the persisted flag; after new frames arrive the log has no torn tail, seqnos are strictly increasing with no duplicate or reused value across the crash (every new seqno is above the pre-kill high-water mark), and the `.meta` cursor is never below the log tail. The suite prints which crash window each kill hit. |
| Catch-up | The curator edge pages the core with `POST /api/shared-memory/host-catchup`, one round per call, resuming from the returned `nextSeqno` until the core has nothing more, from several starting cursors. Across the pages the core serves exactly the frames with seqno greater than the starting cursor and the final cursor is the true last seqno. |

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
