# @origintrail-official/dkg

Command-line interface and daemon for DKG V10. This is the main entry point for running a DKG node — it manages the node lifecycle, exposes a local HTTP API, and provides commands for publishing, querying, and interacting with the network.

## Installation

```bash
npm install -g @origintrail-official/dkg
```

On supported platforms, the package performs a best-effort postinstall fetch of
the standalone MarkItDown converter into the package `bin/` directory so PDF,
DOCX, PPTX, XLSX, CSV, HTML, EPUB, and XML imports work without a separate
system-level install.

**From source** (monorepo development):

```bash
pnpm build
cd packages/cli && node ./scripts/bundle-markitdown-binaries.mjs --build-current-platform
pnpm link --global --filter @origintrail-official/dkg

# Binary is now available as `dkg`
dkg --help
```

## Quick Start

```bash
# Initialize a new node (generates keys, sets up config)
dkg init

# Start the node daemon
dkg start

# Check node status
dkg status

# Create a context graph (project), write RDF, promote to SWM, publish to VM
dkg context-graph create my-project
dkg assertion import-file notes -f data.md -c my-project
dkg assertion promote notes -c my-project
dkg shared-memory publish my-project

# Query the knowledge graph
dkg query my-project -q "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10"
```

## Running a Core Node (relay operator)

A Core Node is a publicly-reachable host that runs a libp2p circuit-relay v2
server, providing NAT traversal for the (much larger) population of edge
agents. Edge nodes don't need any of the configuration in this section — only
operators of relay-serving Core Nodes do.

### Capacity tuning

Default capacity is **1024 simultaneous reservations**. From that single knob
we derive all the other relay-related libp2p limits at a 1:2 ratio (HOP/STOP
stream caps, `connectionManager.maxConnections`) so capacity=1024 → 2048
streams + 2048 max conns. Override via the `relayServerCapacity` field in
`DKGNodeConfig` (config.json) when you want to scale up for big iron or down
for resource-constrained hosts (a Raspberry Pi runs comfortably at 256-512).

```jsonc
{
  "nodeRole": "core",            // enables the relay server
  "relayServerCapacity": 1024,   // default; bump or shrink as needed
  // ...
}
```

### Required `ulimit -n`

Each open libp2p connection costs one file descriptor. With the default
capacity and a 1:2 multiplier, the daemon needs **at least `max(4096,
maxConnections × 2)` file descriptors** (equivalently `max(4096, capacity × 4)`
since `maxConnections = capacity × 2`). The 4096 floor accounts for SQLite,
log files, the daemon HTTP server, and other non-libp2p fd consumers.

| `relayServerCapacity` | derived `maxConnections` | recommended `ulimit -n` |
|---|---|---|
| 256  (Pi-class)        | 512  | 4096 (floor wins) |
| 1024 (default)         | 2048 | 4096 (floor wins) |
| 2048                   | 4096 | 8192 |
| 4096 (big iron)        | 8192 | 16384 |

The daemon checks the host's `RLIMIT_NOFILE` at startup and emits an
operator-facing warning if the soft limit is below the recommended value.
**Without the bump, the kernel will reject new `socket()` calls with
`EMFILE` once the daemon hits the host limit, manifesting as silent peer
rejections rather than a crash** — fix it preemptively:

| Deployment shape | How to bump |
|---|---|
| Shell session | `ulimit -n 4096` before `dkg start` |
| systemd unit | `LimitNOFILE=4096` in the `[Service]` block |
| Docker | `--ulimit nofile=4096:4096` |
| Kubernetes | Configure at the **container runtime**, not in the pod spec — `nofile` is an rlimit, not a kernel sysctl, so `securityContext.sysctls` will NOT raise it. Set `LimitNOFILE` in the containerd / CRI-O runtime config (e.g. `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options].LimitNOFILE = 4096`), or use a `RuntimeClass` whose underlying runtime has the bump baked in. Confirm with `kubectl exec <pod> -- sh -c 'ulimit -n'`. |

To verify the live daemon's effective limit, look for the startup log line
`[dkg-core] relay server: ulimit -n soft=<N> >= recommended <M>, ok` (or the
WARN equivalent if the host needs tuning).

## Operator relays (rc.9 PR-7)

By default every daemon reserves on the public testnet relay set declared in
`network/<env>.json#relays`. The public set is enough for reliable chat /
skill / query traffic; operators who run their own relay infrastructure can
prioritise their own relays via `--relay-preferred` (CLI) or the
`preferredRelays` config field (persistent).

### Standing up your own relay

1. **Provision a small cloud VM.** 1 vCPU + 1 GiB RAM + 20 GiB disk is plenty
   for a relay-only node. Public IP + ports `4001/tcp` open. AWS t4g.small,
   Hetzner CPX11, GCP e2-micro all work.

2. **Install + init DKG** as you would for any other node (see "Quick Start"
   above).

3. **Switch the role to relay-server.** Edit `~/.dkg/config.json`:

   ```jsonc
   {
     "name": "my-relay-eu",
     "nodeRole": "core",            // enables circuit-relay-v2 server
     "relayServerCapacity": 1024,   // tune per the capacity table above
     "announceAddresses": [
       "/ip4/<your-public-ip>/tcp/4001"
     ]
   }
   ```

4. **Bump `ulimit -n`** per the table in "Required `ulimit -n`" above.

5. **Start the daemon and capture the relay's multiaddr** from the startup
   log. It will look like:

   ```
   /ip4/<public-ip>/tcp/4001/p2p/12D3KooWMyRelayPeerId...
   ```

   This is the string you share with your other nodes.

6. **Wire it up on every node that should prefer your relay:**

   ```bash
   dkg start --relay-preferred /ip4/<public-ip>/tcp/4001/p2p/12D3KooW...
   ```

   Or persistently in each node's `~/.dkg/config.json`:

   ```jsonc
   {
     "preferredRelays": [
       "/ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayEU...",
       "/dns4/relay-us.example.com/tcp/4001/p2p/12D3KooWMyRelayUS..."
     ]
   }
   ```

### Recommended infrastructure

- **2–3 relays in geographically distinct regions.** A two-relay topology
  (EU + US) gives 100% uptime tolerance to single-region outages; three
  (EU + US + APAC) lets you survive an entire cloud-provider failure.
- **Restart policy.** systemd `Restart=always` (or the equivalent for your
  init system). The local relay watchdog handles transient libp2p failures,
  but a daemon crash needs OS-level restart.
- **Monitoring.** Probe `/api/peer-info` (rc.9 #533) every 30s; alert on
  `currentReservations.length == 0` for more than 5 minutes (means the
  relay is technically running but holding no client reservations — usually
  a port-forward / NAT issue).
- **Backups.** A relay holds no application state — `~/.dkg` is reconstructible
  from `dkg init`. The only persistent artifact you care about is the libp2p
  peer key (`~/.dkg/key`); back it up if you want the same multiaddr after a
  VM rebuild.

See [`docs/messenger-operator.md`](../../docs/messenger-operator.md) for the
full operator-side guide (debugging stuck outbox entries, reading `/api/slo`
once it lands in rc.9 PR-12).

## Edge tuning

### Multi-reservation (NAT'd nodes)

By default an edge node behind NAT holds **3 simultaneous circuit-relay
reservations** instead of the single reservation it used to hold. Three
gives N-2 tolerance — two relays can blink concurrently and incoming
dialers still find a working circuit. Override with `relayReservationCount`
in `config.json` when you want to dial up tolerance (max 16) or strip back
down to 1 for the legacy behavior.

```jsonc
{
  "nodeRole": "edge",
  "relayPeers": [
    "/dns4/relay-a.example.com/tcp/4001/p2p/12D3Koo...",
    "/dns4/relay-b.example.com/tcp/4001/p2p/12D3Koo...",
    "/dns4/relay-c.example.com/tcp/4001/p2p/12D3Koo..."
  ],
  "relayReservationCount": 3   // default; cap is 16
}
```

The knob is:
- **Edge-only**. Core / relay-server nodes don't multi-reserve through
  other relays — they have public addresses for incoming traffic. The
  daemon's CLI fallback supplies `network.relays` to both core and edge
  by default, so without this gate every core node would also push 3
  `/p2p-circuit` listen addrs and consume relay slots network-wide.
  When set on a core node the value is ignored with a warning.
- **Clamped to `relayPeers.length`**. Requesting more reservations than
  there are configured relays can't deliver the documented tolerance
  and just queues an unattainable target. The clamp emits a warning so
  the misconfig is visible.
- **Ignored when no `relayPeers` are configured** (a node not behind NAT
  doesn't need reservations). Invalid values (0, negative, fractional,
  non-numeric, > 16) fall back to the default with a warning.

Reservation renewal is **automatic** — libp2p refreshes each reservation 5
minutes before its 2-hour TTL expires, so no application-level renewal
loop is required. The local relay watchdog handles the harder failure
modes auto-renewal can't recover from:

- a fully-dropped relay connection (TCP RST, NAT pinhole expiry, ISP
  routing flap), and
- per-relay reservation loss when multi-reservation is enabled (e.g. a
  refresh that returns an error and removes the slot without retrying
  on the same relay) — without this, N reservations would silently
  degrade to N-1 and stay there until restart.

## Commands

| Command | Description |
|---------|-------------|
| `dkg init` | Interactive setup — node name, role, relay |
| `dkg start [-f]` | Start the node daemon (HTTP API + P2P); `-f` runs in foreground |
| `dkg stop` | Graceful daemon shutdown |
| `dkg status` | Node health, peer count, identity |
| `dkg logs` | Tail the daemon log |
| `dkg peers` | List connected peers and transport info |
| `dkg peer info <peer-id>` | Inspect a peer's identity and addresses |
| `dkg send <name> <msg>` | Encrypted direct message to a peer |
| `dkg chat <name>` | Interactive chat with a peer |
| `dkg context-graph create <id>` | Create a local context graph (project) |
| `dkg context-graph register <id>` | Register an existing CG on-chain (unlocks Verified Memory) |
| `dkg context-graph list` | List subscribed context graphs |
| `dkg context-graph invite <id> <peer>` | Invite a peer to a curated CG |
| `dkg context-graph subscribe <id>` | Subscribe to a CG without creating it |
| `dkg assertion import-file <name> -f <file> -c <cg>` | Import a document into Working Memory |
| `dkg assertion promote <name> -c <cg>` | Promote a WM assertion to Shared Working Memory |
| `dkg assertion query <name> -c <cg>` | Read assertion quads from WM |
| `dkg shared-memory write <cg>` | Write triples directly to Shared Working Memory |
| `dkg shared-memory publish <cg>` | Publish from SWM to Verified Memory (costs TRAC) |
| `dkg publish <cg>` | One-shot RDF publish to a context graph |
| `dkg verify <batchId>` | Propose M-of-N verification for a published batch |
| `dkg endorse <ual>` | Endorse a published Knowledge Asset |
| `dkg query [cg] -q <sparql>` | SPARQL query against the local store |
| `dkg query-remote <peer>` | Query a remote peer's knowledge store |
| `dkg subscribe <cg>` | Subscribe to a context graph and sync its data |
| `dkg sync` | Catch up on data from peers |
| `dkg index [directory]` | Index a code repository into the dev-coordination CG |
| `dkg publisher ...` | Inspect and control the async publisher (jobs, wallets, stats) |
| `dkg auth show` | Display the current API auth token |
| `dkg auth rotate` | Generate a new API auth token |
| `dkg wallet` | Show operational wallet addresses and balances |
| `dkg set-ask <amount>` | Set the node's on-chain ask (TRAC per KB·epoch) |
| `dkg openclaw setup` | Install and configure the OpenClaw adapter |
| `dkg update` | Update the node software (blue-green slots) |
| `dkg rollback` | Roll back to the previous software slot |

Run `dkg <command> --help` for per-command options.

## Source Workers

`dkg source-worker run --config <path>` runs a generic polling worker from a
JSON config file. Treat that config as sensitive operator material, equivalent
to the daemon's `auth.token`: it contains `daemonToken` and names a
`handlerModule` that the CLI dynamically imports and executes in the worker
process. Store it with the same access controls as `auth.token`, and do not
commit it to a repository.

Handler modules export `createSourceWorkerDeps(context)`, returning
`getFingerprint` and `processSource`. `getFingerprint(source)` is the content
identity contract for the worker: source content changes that affect emitted
triples/assets must produce a different fingerprint, while unchanged source
content must keep the same fingerprint across runs. Do not include wall-clock
time, random values, transient job status, or other polling noise in the
fingerprint.

Minimal config shape:

```json
{
  "pollIntervalMs": 60000,
  "stateFile": "./state/source-worker.json",
  "daemonUrl": "http://127.0.0.1:9200",
  "daemonToken": "<contents of auth.token>",
  "handlerModule": "./handlers/source-worker.mjs",
  "handlerExport": "sourceWorker",
  "sources": [{ "id": "source-1" }]
}
```

The handler module is loaded from the config file's directory:

```js
export const sourceWorker = {
  createSourceWorkerDeps({ sharedMemory, asyncLift }) {
    return {
      async getFingerprint(source) {
        return source.contentHash;
      },
      async processSource(source, fingerprint) {
        const share = await sharedMemory.share(source.contextGraphId, source.quads);
        const jobId = await asyncLift.lift({
          ...source.liftRequest,
          shareOperationId: share.shareOperationId
        });
        return {
          sourceId: source.id,
          skipped: false,
          jobIds: [jobId],
          jobStatuses: { [jobId]: "queued" },
          status: "queued",
          nextState: {
            fingerprint,
            lastStatus: "queued",
            lastJobIds: [jobId],
            lastJobStatuses: { [jobId]: "queued" }
          }
        };
      },
    };
  },
};
```

The worker state file is updated with a same-directory temp-file write, file
fsync, atomic rename, and parent-directory fsync where supported so a crash does
not truncate the previous state file.

## HTTP API

When the daemon is running, it exposes a local HTTP API (default: `http://localhost:9200`). Key endpoint groups:

- `GET /api/status`, `GET /api/info` — node status and health
- `POST /api/agent/register`, `GET /api/agent/identity` — agent identity
- `POST /api/context-graph/create`, `/register`, `/invite`, `GET /api/context-graph/list` — context graph management
- `POST /api/assertion/create`, `/{name}/write`, `/{name}/promote`, `/{name}/discard`, `/{name}/import-file`, `GET /api/assertion/{name}/history` — Working Memory assertions
- `POST /api/shared-memory/write`, `/publish` — Shared Working Memory and publishing to Verified Memory
- `POST /api/query`, `POST /api/query-remote` — SPARQL querying
- `POST /api/endorse`, `POST /api/verify`, `POST /api/update` — Verified Memory trust operations
- `GET /api/peers`, `GET /api/connections`, `GET /api/agents` — network introspection
- `GET /api/wallets/balances`, `GET /api/chain/rpc-health` — wallet and chain health
- `GET /api/events` — Server-Sent Events stream for real-time notifications

> The V9 `GET /api/apps` endpoint (and the `/apps/*` iframe host) was retired in
> V10 along with the installable apps framework — the daemon now returns
> `410 Gone` on those paths. See [Extending the Node](#extending-the-node) below.

All endpoints (except public paths like `/api/status`, `/api/chain/rpc-health`, and `/.well-known/skill.md`) require an API token via `Authorization: Bearer <token>` header.

The full API surface — including request bodies, response shapes, and error codes — is documented in [`skills/dkg-node/SKILL.md`](./skills/dkg-node/SKILL.md).

## Local Benchmarks

The live publish/get benchmark measures four operation timings against a running
DKG daemon: synchronous publish end-to-end latency, async publisher enqueue
latency, async job completion/finalization latency, and SPARQL get latency for
the published benchmark content.

Prerequisites:

- Start a node with `dkg start`.
- Use a context graph that is safe for benchmark writes and publish costs.
- Ensure the async publisher is enabled when measuring async completion:
  `dkg publisher enable`.
- For local daemon targets, use normal discovery or `DKG_API_PORT`; the command
  loads the local auth token from `DKG_HOME`. For non-loopback `--api-url`
  targets, pass `--auth-token` or `DKG_AUTH_TOKEN` explicitly.

Run from the repository after building the CLI package:

```bash
pnpm --filter @origintrail-official/dkg build
```

```bash
pnpm --filter @origintrail-official/dkg benchmark:publish-async-get -- \
  --context-graph-id my-project \
  --repeat 30 \
  --warmups 3 \
  --payload-size 10kb \
  --output-format json
```

Useful environment variables mirror the flags: `DKG_BENCH_CONTEXT_GRAPH_ID`,
`DKG_BENCH_REPEAT`, `DKG_BENCH_WARMUPS`, `DKG_BENCH_TIMEOUT_MS`,
`DKG_BENCH_PAYLOAD_SIZE`, `DKG_BENCH_FIXTURE`, `DKG_BENCH_OUTPUT_FORMAT`,
`DKG_BENCH_POLL_INTERVAL_MS`, `DKG_API_PORT`, `DKG_API_URL`, and
`DKG_AUTH_TOKEN`.

`--payload-size` and `DKG_BENCH_PAYLOAD_SIZE` accept raw bytes or generated-size
labels such as `10kb`, `100kb`, `2mb`, and `200mb`. The repository ESBench suite
uses those four generated sizes by default.

The output includes per-operation timing records and summary rows for
`syncPublish`, `asyncEnqueue`, `asyncCompletion`, and `get`. Each summary reports
count, success count, failure count, min, max, mean, median/p50, and p95. Failure
records include operation, iteration, error message, root entity, marker, context
graph, and a reproduction command. Warmups are excluded from summaries.

The repository-level ESBench workflow for this same benchmark feature is
documented in `BENCHMARKING.md`. It uses a deterministic layered DKG client, not
a live daemon, so the generated reports avoid auth tokens and local node paths.
`pnpm bench:html` writes the combined ESBench report plus one focused HTML page
for each benchmark flow and payload size. The full default matrix includes the
`200mb` scene; set `DKG_ESBENCH_PAYLOAD_SIZES=10kb` or another comma-separated
subset while doing quick local smoke checks:

- get/read retrieval
- synchronous publish with finalization
- asynchronous publish enqueue and finalization
- upload payload to local working memory
- lift local working memory to shared working memory

### SWM Large-Payload Benchmark

The live SWM large-payload benchmark is aimed at replication and storage
amplification regressions. It writes large public literals through every node in
a running devnet, waits until every node can query every benchmark payload from
shared working memory, and verifies that the run did not create
`dkg:publicStagedQuads` snapshot literals in SWM metadata.

For the 5-node, 500 MiB regression case, start or reuse a 5-node devnet and run:

```bash
pnpm bench:swm-large-payload -- \
  --ports 19101,19102,19103,19104,19105 \
  --payload-mib-per-node 100 \
  --chunk-mib 0.5 \
  --output bench/results/swm-large-payload-500mib.json
```

Use `--auth-token`, `--auth-token-file`, or `DKG_BENCH_AUTH_TOKEN` when the
target nodes require bearer auth. The final JSON includes per-node payload
counts, write timing summaries, replication polls, metadata counts for
`shareOperationId`, `rootEntity`, and `publishedAt`, the global
`publicStagedQuads` delta, and an appended log scan for known
Oxigraph/GossipSub failure signatures when a devnet directory is available.

### SWM Triple-Volume Benchmark

The live SWM triple-volume benchmark is aimed at Oxigraph graph/index scale,
not large literal storage. It writes many small triples through every node in a
running devnet, waits until every node can count all replicated benchmark
triples from shared working memory, and stores a JSON report with write timing,
replication polls, sample triples, and log-scan results.

For a 5-node run targeting roughly 1 GiB of serialized N-Quad triples per node:

```bash
DEVNET_SWM_SYNC_ON_CONNECT=0 ./scripts/devnet.sh start 5
pnpm bench:swm-triple-volume -- \
  --ports 20101,20102,20103,20104,20105 \
  --target-gib-per-node 1 \
  --triples-per-write 1000 \
  --write-concurrency 5 \
  --output bench/results/swm-triple-volume-1gib-per-node.json
```

The target is based on estimated serialized N-Quad bytes for generated triples.
This benchmark can be much harder on local Oxigraph than the large-literal
benchmark because every triple and index entry still lives in the RDF store.
`DEVNET_SWM_SYNC_ON_CONNECT=0` avoids a peer-connect catch-up storm during bulk
write runs; live SWM gossip still replicates new writes. The report also checks
that per-operation public snapshots are stored as disk refs, not Oxigraph
snapshot graphs or `dkg:publicStagedQuads` literals.

For throughput-drop diagnosis, add `--max-writes <count>` to stop at a smaller
partial run and leave diagnostics enabled. The JSON report records interval
throughput, write latency percentiles, per-node `store.nq`/snapshot/log/process
samples, and appended daemon-log counters. A Markdown summary is written to
`<output>.analysis.md` by default, or to `--analysis-output <path>`.

## Extending the Node

The V9 "installable apps" framework (iframe-hosted third-party UIs loaded from
`node_modules` with a `dkgApp` manifest) was retired in V10 to shrink the
security surface and simplify the daemon. The supported extension surface is now
the `dkg integration` CLI (see `packages/cli/src/integrations/`), which installs
trusted `cli` / `mcp` integrations from a registry with npm provenance
verification.

## Internal Dependencies

- `@origintrail-official/dkg-agent` — agent runtime, wallet, publishing, querying
- `@origintrail-official/dkg-core` — P2P node, memory model, event bus
- `@origintrail-official/dkg-publisher` — publish pipeline (SWM → VM)
- `@origintrail-official/dkg-storage` — triple-store adapters
- `@origintrail-official/dkg-chain` — blockchain abstraction
- `@origintrail-official/dkg-node-ui` — web dashboard serving
