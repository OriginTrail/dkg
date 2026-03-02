# Simulation errors — summary and fixes

When the sim reports errors (e.g. 100 failed out of 500), check the following.

## Where to see errors

1. **Terminal (Vite)**  
   The sim engine logs the first 20 failed ops and a final summary, e.g.:
   ```text
   [sim] error #1: chat node3 — No peers with known peerId
   [sim] error #2: publish node5 — timeout (60s)
   [sim] done: 500 ok, 100 errors (chat: 80 fail, publish: 20 fail)
   ```

2. **Activity feed (UI)**  
   Each failed op appears in the feed with a red icon and the `detail` message (e.g. `Unauthorized (0 KAs)`, `timeout (60s)`).

3. **Node daemon logs**  
   For publish/workspace/query failures, check:
   ```bash
   ./scripts/devnet.sh logs 1   # or 2..6
   ```
   Or inspect `.devnet/nodeN/daemon.log` for stack traces and API errors.

## Common causes and fixes

### 1. **Publish: "Paranet X does not exist. Create it first with createParanet()"**

- **Cause:** The sim only created the paranet on node 1. Each node checks for the paranet in its **local** store before publish; nodes 2–6 never had the definition.
- **Fix:** The sim now ensures the paranet exists on **all** nodes (create on each if missing). Restart the sim and run again; the first run after a devnet restart will create the paranet on every node.

### 2. **Chat: "No peers with known peerId"**

- **Cause:** Chat runs before peer discovery has finished, or the target node is offline.
- **Fix:** Reduce ops/sec or concurrency so discovery can complete; or disable the **Chat** op in the sim.

### 3. **Publish / workspace: "Unauthorized" or "HTTP 401"**

- **Cause:** Sim engine is not sending the devnet auth token (wrong token path or not loaded).
- **Fix:** Ensure devnet has written auth tokens to `.devnet/node1/auth.token`, …, `.devnet/node6/auth.token`. Restart the sim so it reloads tokens from `node1` … `node6` (not `node-1`).

### 4. **Publish / workspace: "timeout (60s)" or "timeout (30s)"**

- **Cause:** Node or chain is slow; with high concurrency many requests pile up.
- **Fix:** Lower **Concurrency** (e.g. 5) or **Ops/sec** (e.g. 5). For publish with many KAs (e.g. 100), 60s may be tight under load.

### 5. **Publish: "HTTP 502" or "Node offline"**

- **Cause:** Request was proxied to a node that is down or not responding.
- **Fix:** Run `./scripts/devnet.sh status` and restart devnet so all 6 nodes are up. If a node repeatedly dies, check its `daemon.log` for OOM or crash.

### 6. **Identity not set (0) — skipping on-chain publish**

- **Cause:** Devnet nodes are not registered on-chain, so `publisherNodeIdentityId` is 0. Publish is stored as **tentative** only (no on-chain tx).
- **Effect:** Publish still **succeeds** from the sim’s point of view (200 + kcId 0). No fix needed for the sim; for confirmed on-chain publish you’d need to register nodes with the Hub contract (devnet flow).

### 7. **600/500 or "completed" > target**

- **Cause:** The UI used to show (succeeded + errors) / target, so 500 succeeded + 100 failed appeared as 600/500.
- **Fix:** The UI now shows **succeeded/target** (e.g. 500/500) and **errors** separately. The sim engine also caps dispatched ops at `opCount` and does not schedule extra work after the cap.

## Reducing errors in a run

- Lower **Concurrency** (e.g. 5) and **Ops/sec** (e.g. 5–10).
- Disable **Chat** if you don’t need it (avoids "No peers" and delivery failures).
- Ensure devnet is healthy: `./scripts/devnet.sh status` and all nodes ready.
- After changing devnet or tokens, restart the sim (`pnpm sim`) so it picks up the new config and tokens.
