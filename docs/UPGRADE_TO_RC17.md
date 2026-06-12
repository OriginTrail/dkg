# Upgrading to `v10.0.0-rc.17` — land it clean

**Audience:** DKG **node operators** (edge + core) on V10 Testnet (Base
Sepolia) upgrading from any pre-rc.17 build (rc.12 → rc.16), plus anyone
spinning up a node for the first time on rc.17.

**Compatibility posture:** rc.17 ships the **per-KA memory model** — a new,
uniform per-Knowledge-Asset named-graph layout in the local RDF store. This
is an **off-chain breaking change**. It is **not** a contract redeploy, so it
does **not** bump `chainResetMarker`, which means the daemon's automatic
chain-reset wipe **does not fire** on this upgrade, and **there is no
boot-time layout migration**. A node that simply auto-updates rc.16 → rc.17
keeps its old data in the *old* layout while writing all new data in the
*new* layout — a split-brain store with only partial read-both coverage.

**Bottom line:** to land rc.17 cleanly you do a **one-time local store wipe**
when you take the upgrade. The chain is untouched; your wallet/identity and
on-chain assets are preserved, and Verifiable Memory re-syncs. **One exception:**
local Working/Shared Memory you authored but never published is *not*
re-derivable — if you have any, export it first (**§5**) before you wipe.

> **New operators:** there is nothing to migrate — just install rc.17 fresh
> (see §4.1) and skip the rest.

---

## 0. Did this already happen to you? (for most operators — yes)

If your node **auto-updated** from rc.16 (or any pre-rc.17 build) to rc.17, it
is now running rc.17 code over old-layout data — the split-brain state above.
This hit essentially every node that had auto-update enabled.

> **Most visible symptom — node sluggish, queries hang.** Beyond the stale-data
> visibility bugs in §1, the oversized old-layout store makes the daemon
> unresponsive: `/api/query` and `/dkg/10.0.2/sync` take seconds or time out, and
> **publishing fails on validation timeouts** before it ever reaches the network.
> On the **`oxigraph-server`** backend this shows up starkly as the separate
> `oxigraph-server` process pegging CPU (200–360%+ even when idle, on the rc.17
> nodes we observed on that backend); on the **default `oxigraph-worker`**
> (in-process worker thread, no separate process) the same bloat instead surfaces
> as daemon-process CPU and worker-thread query hangs — `/api/status` can look
> green while `/api/query` stalls. The one-time wipe in §4.2 fixes it — on one
> oxigraph-server node, CPU dropped ~360% → ~3% and `/api/status` latency 5.6s →
> 5ms the instant it restarted on a fresh store (magnitude depends on backend +
> store size). This hits **every** rc.17 node that auto-updated, **including
> core/host nodes** — if your fleet's cores auto-updated, wipe them too.
>
> Note: a clean/fresh node can *also* fail to publish for an unrelated reason — a
> slow chain RPC. If publishing still fails after the wipe, see **§4.3**.

**Confirm in 30 seconds:**

```bash
# A) Backend + size. NOTE: storeQuads is non-null ONLY on oxigraph-server /
#    blazegraph / sparql-http. On the DEFAULT oxigraph-worker it is always null —
#    use the store.nq file size instead.
curl -s :9200/api/status | jq '{version, storeBackend, storeQuads}'
ls -lh "${DKG_HOME:-$HOME/.dkg}/store.nq" 2>/dev/null   # oxigraph-worker: a multi-MB/GB file = bloated old-layout store
#    rc.17 + a large store.nq (or, on oxigraph-server, storeQuads in the 100k+) = strong signal

# B) Definitive — do OLD /assertion/ graphs still exist? Route through the daemon
#    so it works on EVERY backend (incl. the default oxigraph-worker):
curl -s -X POST :9200/api/query \
  -H "Authorization: Bearer $(cat "${DKG_HOME:-$HOME/.dkg}/auth.token")" \
  -H 'Content-Type: application/json' \
  -d '{"sparql":"SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g),\"/assertion/\")) }"}'
#    (oxigraph-server only, optional: hit http://127.0.0.1:7878/query directly.)

# C) Symptom check — sluggish node? (only oxigraph-server runs a SEPARATE process)
ps aux | grep '[o]xigraph' | awk '{print $3"% CPU"}'   # oxigraph-server: 200%+ when idle = affected
curl -s -o /dev/null -w 'api/query latency: %{time_total}s\n' -X POST :9200/api/query \
  -H "Authorization: Bearer $(cat "${DKG_HOME:-$HOME/.dkg}/auth.token")" \
  -H 'Content-Type: application/json' -d '{"sparql":"ASK {}"}'   # >1s = degraded (works on all backends)
```

- **If you auto-updated in place (didn't fresh-install rc.17), you are affected** —
  do the one-time wipe in **§4.2**, regardless of what the counts say. Wallet,
  identity, and on-chain assets are safe. (A non-zero `/assertion/` count from B
  confirms it; a connection-refused on `:7878` just means you're on the embedded
  worker backend — **not** that you're clean.)
- **Only if you fresh-installed rc.17** (and the B count is 0): already clean —
  nothing to do.

> **Why your node didn't self-heal:** rc.17 is an *off-chain* breaking change,
> so it does **not** bump `chainResetMarker` — the daemon's automatic
> chain-reset wipe never fired, and there is no boot-time migration. The wipe
> is manual, once. (See §8 for the durable fleet-wide fix.)
>
> **It can recur.** The in-place update happened because auto-update has
> prereleases enabled. To opt out of automatic RC updates, set
> `autoUpdate.allowPrerelease: false` in your node config (`~/.dkg/config.json`,
> or `config.yaml` on YAML installs) — your node then
> stays on its current build until you update manually and run this guide
> deliberately (stable releases still auto-update). Watch **#builders** for a
> heads-up on each off-chain-breaking RC.

---

## 1. TL;DR

| # | Area | Change | What it means for you |
|---|------|--------|------------------------|
| 1 | Local RDF layout | New uniform per-KA graphs: `…/_working_memory/{addr}/{n}`, `…/_shared_memory/…`, `…/_verifiable_memory/{addr}/{n}` | Old graphs (`…/assertion/{addr}/{name}`, SWM buckets, `…/_verifiable_memory/{vmId}`) are **not** rewritten |
| 2 | Migration | **None.** The planned boot-time layout migration is not implemented in rc.17 | In-place upgrade ⇒ mixed/old+new layout coexisting |
| 3 | Auto-wipe | `chainResetMarker` is **unchanged** (no chain redeploy) | The daemon will **not** wipe for you — you must wipe manually once |
| 4 | Failure mode | Node boots fine; no crash | Pre-rc.17 KAs may be **invisible / not served / not synced** under the new layout |
| 5 | HTTP API | `/api/assertion/*` → `/api/knowledge-assets/*` | Update any monitoring / scripts that hit the old route |
| 6 | Chain / wire | No contract redeploy; sync protocol unchanged (`/dkg/10.0.2/sync`) | No on-chain action; no fund/identity loss |
| 7 | RPC endpoint | A slow / public RPC (e.g. `sepolia.base.org`) rate-limits chain reads & writes | `unconfirmed context graph` warnings, publish access-policy **"unknown"**, `register`/publish tx timeouts — use a dedicated RPC (**§4.3**) |
| 8 | Known bug #1124 | Publishing to a **public** CG (access-policy 0) fails at ACK quorum with `NO_DATA_IN_SWM` | NOT the upgrade and NOT the RPC — use **private** CGs (access-policy 1) until fixed; **don't re-wipe** chasing it (see §7) |

If you upgrade in place **without** the wipe, the node will run, but expect
stale-data visibility bugs. The clean path below avoids all of that.

---

## 2. Use this guide as an agent prompt

Point an AI agent at this doc and your node host:

```
You are upgrading a DKG node to @origintrail-official/dkg v10.0.0-rc.17.
Read docs/UPGRADE_TO_RC17.md end to end first. rc.17 is an OFF-CHAIN
breaking change (per-KA memory-model layout) with no automatic store wipe
and no layout migration, so the upgrade requires a one-time local store
wipe to land clean.

Do this, in order:
1. Confirm the node is affected and record state:
   `curl -s :9200/api/status | jq '{version, storeBackend}'` (`dkg status`
   shows the store but not the version). A node that auto-updated in place to
   rc.17 over pre-rc.17 data is affected (see §0); a fresh rc.17 install is not.
2. `dkg stop`.
3. Update to rc.17, pinned: `dkg update 10.0.0-rc.17` (or
   `npm install -g @origintrail-official/dkg@10.0.0-rc.17`). A bare `dkg update`
   is not deterministic — `autoUpdate.allowPrerelease: false` nodes may skip it.
4. Before wiping: if any un-published local WM exists, run the §5 export first —
   the wipe is irreversible. Then wipe the LOCAL store for the detected backend
   (see §4.2). Do NOT touch the keystore (wallets.json/agent-key*), auth.token,
   or your config (config.json/config.yaml).
5. `dkg start`.
6. Verify: `dkg doctor`, `/api/status` shows version 10.0.0-rc.17 **and answers
   in <100ms** (not seconds — slow = the store wipe didn't take), and a
   spot-check query returns post-upgrade data. Confirm logs show no
   leftover pre-rc.17 graph URIs being gossiped/dropped.
7. Check the RPC: if logs repeat `unauthorized or unconfirmed context graph`
   or publishes fail with access-policy "unknown", the chain RPC is too slow —
   set a dedicated `chain.rpcUrl` (see §4.3) and restart. This is independent of
   the wipe.

Report the backend you wiped, the RPC you use, and the verification output.
```

---

## 3. Why a wipe is needed (and why it's safe)

The pre-rc.17 quads reference the **old** graph URIs. rc.17 reads/writes the
**new** per-KA URIs. There is no migration that re-homes the old graphs, and
the fallback read-both paths only cover some query/sync routes — so leaving
the old data in place produces inconsistent visibility rather than a clean
cutover.

Wiping is safe because **everything dropped is re-derivable**:

- **Verifiable Memory** re-syncs from chain + peers after restart.
- Your **on-chain identity, stake, and KAs are on Base Sepolia** — untouched.
- The wipe preserves your **wallet keystore, `auth.token`, and config
(`config.json` / `config.yaml`)**.

The only thing genuinely lost is **local Working/Shared Memory you authored
but never published to Verifiable Memory.** If you have un-published local WM
you care about, export it first (see §5).

---

## 4. The clean upgrade

### 4.1 Fresh install (new operators, or "I don't care about local data")

```bash
npm install -g @origintrail-official/dkg@10.0.0-rc.17
dkg init        # if not yet configured
dkg start
```

That's it — a fresh node is already on the new layout.

### 4.2 Existing node — upgrade + one-time wipe

**Step 0 — detect your store backend** (the wipe differs per backend):

```bash
curl -s :9200/api/status | jq '{version, storeBackend}'   # `dkg status` shows the store but not the version
```

**Step 1 — stop + update:**

```bash
dkg stop
dkg update 10.0.0-rc.17     # or: npm install -g @origintrail-official/dkg@10.0.0-rc.17
```

**Step 2 — wipe the local store for your backend.** In all cases also remove
the file-side state so journals/WAL/marker can't reference stale data:

> **STOP — irreversible.** If you authored local Working/Shared Memory you never
> published to Verifiable Memory, export it **now** (**§5**). This step destroys
> it, and §5 cannot be run afterward. Everything else (VM, identity, on-chain
> assets) is safe.

```bash
NODE_DATA_DIR="${DKG_HOME:-$HOME/.dkg}"
# fixed-name file-side state
rm -f \
  "$NODE_DATA_DIR/store.nq" \
  "$NODE_DATA_DIR/store.nq.tmp" \
  "$NODE_DATA_DIR/random-sampling.wal" \
  "$NODE_DATA_DIR/.network-state.json"
# if you set `randomSampling.walPath` in your config, the WAL can live OUTSIDE
# ~/.dkg — delete that file too.
# publish journals via `find` so it's glob-safe — a bare `publish-journal.*`
# aborts the whole command under zsh's nomatch when no journals exist:
find "$NODE_DATA_DIR" -maxdepth 1 -name 'publish-journal.*' -delete 2>/dev/null
```

Then clear the RDF store itself:

- **`oxigraph-worker` (the default — what `/api/status` reports when there's no
  `store` block in your config):** persists to `store.options.path`, **default
  `$NODE_DATA_DIR/store.nq`** — already removed above. If you set a custom
  `store.options.path`, remove *that* file (and its `.tmp`) instead.

- **`oxigraph-persistent`:** persists to the `store.options.path` you configured,
  which **may not be `store.nq`**. Remove (or, for §5, copy) **that** file and its
  `.tmp` — don't assume `store.nq`.

- **`oxigraph` (in-memory):** ephemeral — nothing on disk to wipe or back up,
  unless you set a `store.options.path` (then treat it like `oxigraph-persistent`).

- **`oxigraph-server` (DKG-managed local server):** the data is a local
  RocksDB at `$NODE_DATA_DIR/oxigraph-data` — **or wherever `store.options.location`
  points, if you set it in config** — **not** `store.nq`. With the daemon
  stopped, drop that RocksDB directory:

  ```bash
  rm -rf "$NODE_DATA_DIR/oxigraph-data"   # or your configured store.options.location
  ```

  (If you run oxigraph-server *independently* of the daemon and want to keep it
  up, issue a SPARQL `DROP ALL` against its update endpoint instead —
  `curl -s -X POST http://127.0.0.1:7878/update --data-urlencode 'update=DROP ALL'`.
  Port `7878` is the default — substitute your `store.options.port` if you moved
  it (same for the `:7878` `/store` backup in §5; or read it from `/api/status`).
  After `dkg stop` the DKG-managed server is down, so just use the `rm -rf` path
  above. `DROP ALL` is safe only because this namespace is DKG-owned — **never**
  run it against a shared `sparql-http`/`blazegraph` endpoint; use the scoped
  `DELETE` shown below.)

- **`sparql-http` / `blazegraph` (operator-provided endpoint):** the daemon
  shares this instance, so clear only the V10 graphs (don't nuke unrelated
  data):

  ```sparql
  # against your update endpoint
  DELETE { GRAPH ?g { ?s ?p ?o } }
  WHERE  { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:")) }
  ```

  If the namespace is dedicated to this node, `DROP ALL` is simpler.

**Step 3 — start + verify:**

```bash
dkg start
dkg doctor
curl -s :9200/api/status | jq '{version, storeBackend, storeQuads}'
```

Expect `version: "10.0.0-rc.17"`. On **oxigraph-server / external** backends
`storeQuads` starts low and climbs as VM re-syncs; on the **default
oxigraph-worker** `storeQuads` is always `null` — instead confirm the §0-B
`/assertion/` count has dropped to 0.

### 4.3 Use a reliable RPC endpoint (or sync + publish silently stall)

Separate from the store wipe, the **most common reason a *clean* rc.17 node
"works but can't publish"** is a slow chain RPC. rc.17 will only host or sync a
CG's Shared Memory once it has **confirmed that CG from chain state** — the
on-chain `ContextGraphCreated` event seeds the node's local meta/policy cache —
and it reads the **live on-chain access policy** before choosing an encrypted vs
plaintext payload. A slow RPC leaves CGs unconfirmed and the access policy
unreadable, so hosting stops and publishes fail — with no obvious error pointing
at the RPC.

**Tell-tale signs your RPC is too slow:**

- Logs repeat `Skipping SWM sync for unauthorized or unconfirmed context graph "…"`.
- Publishing (UI/agent) fails with access-policy **"unknown"** — the on-chain
  access policy couldn't be read in time.
- `dkg context-graph register` or a publish tx fails with
  `… transaction signing via RPC #1 timed out after 10000ms`.

The **public** Base Sepolia endpoints (`https://sepolia.base.org` and free
community RPCs) rate-limit aggressively and routinely trip all three. Use a
**dedicated** Base Sepolia RPC (Alchemy / Infura / QuickNode, or your own node).
Set it in your node config — `~/.dkg/config.json`, **or `config.yaml` if that's
what your node already uses** (don't create `config.json` on a YAML node — it
shadows the YAML) — under `chain`; `rpcUrl` is the primary, `rpcUrls` an ordered
fallback list:

```jsonc
"chain": {
  "chainId": "base:84532",
  "rpcUrl":  "https://<your-dedicated-base-sepolia-rpc>",
  "rpcUrls": ["https://<backup-1>"]
}
```

Restart after changing it (`dkg stop && dkg start`), then confirm reads are fast
and the warnings stop:

```bash
time curl -s :9200/api/status >/dev/null                            # well under 1s
tail -300 "${DKG_HOME:-$HOME/.dkg}/daemon.log" | grep -c 'unconfirmed context graph'   # should trend to 0
```

> Edge nodes need a reliable RPC to publish; **core/host nodes need it too** — a
> core on a slow RPC marks CGs unconfirmed and won't host their Shared Memory,
> which silently starves every publisher that depends on it for ACK quorum.

---

## 5. (Optional) preserve un-published local data first

If you have local Working/Shared Memory you authored and have **not**
published to Verifiable Memory, export it before wiping:

```bash
# IMPORTANT: a SPARQL `CONSTRUCT { ?s ?p ?o }` FLATTENS every named graph into
# the default graph — it loses the WM/SWM/VM graph URIs and is NOT a usable
# backup. Use a dataset-level N-Quads export per backend:

# oxigraph-worker / oxigraph-persistent (embedded): the store IS already an
# N-Quads file at store.options.path (default store.nq) — just copy it:
cp "${DKG_HOME:-$HOME/.dkg}/store.nq" ~/dkg-prewipe-backup.nq   # or your store.options.path
# (in-memory `oxigraph` with no store.options.path keeps nothing on disk — no backup needed.)

# oxigraph-server (managed): dump the whole dataset via the /store endpoint —
# this preserves graph names (note `/store`, NOT `/query`). Port 7878 is the
# default — substitute your store.options.port if you changed it:
curl -s 'http://127.0.0.1:7878/store' -H 'Accept: application/n-quads' \
  > ~/dkg-prewipe-backup.nq

# sparql-http / blazegraph: use the backend's native dataset export — the SPARQL
# Graph Store Protocol (GET each graph) or the server's dump endpoint. A
# CONSTRUCT will drop the graph names.
```

Anything already in Verifiable Memory does **not** need backing up — it
re-syncs from chain/peers.

---

## 6. What's preserved vs reset

| Preserved | Reset |
|---|---|
| Wallet keystore (`wallets.json` / `agent-key*` / `agent-keystore.json`) — same key, same identity | Local RDF store (all pre-rc.17 quads) |
| `auth.token` (local API token) | `publish-journal.*`, `random-sampling.wal` |
| `config.json` / `config.yaml` (your preferences, incl. `store.backend`) | `.network-state.json` (re-derived on boot) |
| On-chain identity, stake, published KAs (Base Sepolia) | Un-published local WM/SWM (back up first if needed) |

---

## 7. Verification checklist

- [ ] `/api/status` reports `version: 10.0.0-rc.17`.
- [ ] `dkg doctor` is green.
- [ ] `storeQuads` started near zero post-wipe and is climbing (VM re-sync).
- [ ] A spot-check SPARQL query returns assertions created **after** the
      upgrade in the new per-KA layout.
- [ ] No old `…/assertion/{addr}/{name}` or bare-bucket SWM graphs linger
      (`SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g),"/assertion/")) }` returns 0).
- [ ] Daemon logs show no repeated "validation failed / dropping" churn from
      stale gossiped entries.
- [ ] **`oxigraph-server` CPU is back to idle** (single digits, not 200%+) and
      `/api/status` answers in <100ms — i.e. the wipe actually relieved the store:
      `ps aux | grep '[o]xigraph'` · `curl -s -o /dev/null -w '%{time_total}s\n' :9200/api/status`.
- [ ] No `unauthorized or unconfirmed context graph` warnings in recent logs
      (if present → RPC too slow, see **§4.3**).
- [ ] *(Optional, costs a little gas + TRAC)* **publish smoke test** — prove you
      can actually write to Verifiable Memory end-to-end:

      ```bash
      dkg context-graph create upgrade-smoke --access-policy 1   # private/curated; prints the full <cgId>
      dkg context-graph register <cgId>                          # on-chain confirm — do NOT re-pass --access-policy
      dkg shared-memory write   <cgId> --name t1 -s https://example.org/e/1 -p https://schema.org/name -o '"ok"'
      dkg shared-memory publish <cgId> --name t1                 # expect: Status: confirmed
      ```
      Use the **full `<cgId>`** that `create` prints (it prefixes the slug with
      your agent address) in all four commands; re-passing `--access-policy` to
      `register` trips a deliberate mismatch guard — it inherits the create policy.

> **Smoke-test with a _private_ CG (`--access-policy 1`).** Publishing to a
> **public** CG (`--access-policy 0`) currently fails at ACK quorum with
> `NO_DATA_IN_SWM` — a known rc.17 bug
> ([OriginTrail/dkg#1124](https://github.com/OriginTrail/dkg/issues/1124)),
> **not** an upgrade problem. Don't re-wipe chasing it — use private CGs until
> the fix lands.

---

## 8. Maintainer note (the durable fix)

This manual wipe is the **interim** operator path. The clean, fleet-wide
options are either of:

1. **Bump `chainResetMarker`** in `network/testnet.json` on the rc.17
   release. Phase C of [`TESTNET_RESET.md`](archive/internal/TESTNET_RESET.md) then fires the
   existing auto-wipe on every node at upgrade (including `DROP ALL` on
   managed `oxigraph-server`), and operators do nothing. Caveat: the marker
   semantically tracks *chain* resets; reusing it for an off-chain layout
   break is a slight abuse but mechanically correct.
2. **Ship the planned per-KA layout migration** (the "D3d / chorusLayout"
   step described in `docs/archive/internal/rc17-chorus-implementation.md`) so existing
   stores are re-homed in place with no wipe.

Until one of those lands and is documented in `CHANGELOG.md` under an
`[10.0.0-rc.17]` section, operators should follow §4 above.

---

## 9. Where to get help

- **Per-KA memory-model design:** [`docs/archive/internal/rc17-chorus-implementation.md`](archive/internal/rc17-chorus-implementation.md).
- **Reset mechanics (auto-wipe / chainResetMarker):** [`docs/archive/internal/TESTNET_RESET.md`](archive/internal/TESTNET_RESET.md).
- **API route rename:** [`docs/archive/internal/migrations/assertion-to-knowledge-assets.md`](archive/internal/migrations/assertion-to-knowledge-assets.md).
- **Prior breaking upgrade (for format reference):** [`docs/archive/internal/UPGRADE_RC11_TO_RC12.md`](archive/internal/UPGRADE_RC11_TO_RC12.md).
- **Discord** #builders / open an issue on [`OriginTrail/dkg`](https://github.com/OriginTrail/dkg/issues) tagged `rc.17-upgrade`.
