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

# Create a context graph (project), write/finalize/share a KA, then publish to VM
dkg context-graph create my-project
dkg ka import-file notes --input-file data.md -c my-project
dkg ka finalize notes -c my-project
dkg ka share notes -c my-project
dkg ka publish-async notes -c my-project

# Query the knowledge graph
dkg query my-project -q "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10"
```

## WAL parallel-protocol modes

WAL synchronization is opt-in. An omitted `sync` block, or an explicit
`"mode": "legacy"`, preserves the existing daemon exactly: no WAL runtime,
directory, worker, timer, port, or protocol is created.

To prepare the isolated shadow runtime while keeping the current synchronization
mechanism authoritative and using the same existing DKG/SWM/VM semantic core
for both mechanisms, add this
to `<DKG_HOME>/config.json`:

```json
{
  "sync": {
    "mode": "parallel",
    "wal": {
      "protocolVersion": 1,
      "adapterVersion": 1
    }
  }
}
```

`parallel` creates only `<DKG_HOME>/wal-v1/{objects,range-staging,quarantine,
shadow-rdf,control}` and reports the runtime through `dkg status` and
`GET /api/status`. WAL-002 registers zero network protocols and starts zero
background workers; later tasks add those capabilities without changing the
authority boundary.

For a single run, the configuration can be overridden with:

```bash
dkg start --sync-mode parallel
```

The override is passed only to the child daemon and does not rewrite
`config.json`. The accepted values are `legacy`, `parallel`, and `wal`.
`wal` is reserved for signed cutover: the daemon currently fails closed with
`WAL_CUTOVER_VERIFIER_UNAVAILABLE`, even when a syntactically valid
`sync.wal.cutoverId` is configured. A text flag or cutover identifier alone
cannot make the shadow projection authoritative.

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
| `dkg start [-f] [--sync-mode <mode>]` | Start the node daemon; `-f` runs in foreground and the optional WAL mode override applies to this run only |
| `dkg stop` | Graceful daemon shutdown |
| `dkg status` | Node health, peer count, identity |
| `dkg logs` | Tail the daemon log |
| `dkg peers` | List connected peers and transport info |
| `dkg peer info <peer-id>` | Inspect a peer's identity and addresses |
| `dkg send <name> <msg>` | Encrypted direct message to a peer |
| `dkg chat <name>` | Interactive chat with a peer |
| `dkg context-graph create <id>` | Create a local context graph (project) |
| `dkg context-graph register <id>` | Register an existing CG on-chain (unlocks Verifiable Memory) |
| `dkg context-graph list` | List subscribed context graphs |
| `dkg context-graph add-agent <id> --agent <addr>` | Add an agent to a curated CG allowlist |
| `dkg context-graph subscribe <id>` | Subscribe to a CG without creating it |
| `dkg knowledge-asset ...` / `dkg ka ...` | First-class Knowledge Asset lifecycle namespace |
| `dkg ka create <name> -c <cg> [--input-file <rdf>] [--share]` | Create a WM draft; optionally write/finalize/share in one call without VM publish |
| `dkg ka write <name> -c <cg> --input-file <rdf>` | Append RDF payload quads into WM |
| `dkg ka import-file <name> -c <cg> --input-file <file>` | Import a document into WM through extraction |
| `dkg ka extraction-status <name> -c <cg>` | Check document extraction status |
| `dkg ka finalize <name> -c <cg>` | Seal a WM draft; existing root-scoped SWM assets remain read-only |
| `dkg ka share <name> -c <cg> [--entity <uri...>]` | Share finalized WM to Shared Working Memory |
| `dkg ka share-async <name> -c <cg>` | Enqueue async WM-to-SWM share |
| `dkg ka share-jobs [--context-graph-id <cg>]` | List async SWM share jobs |
| `dkg ka publish <name> -c <cg>` | Synchronously publish an already finalized and fully shared KA from SWM to VM |
| `dkg ka publish-async <name> -c <cg> [--publisher-node-identity-id 0]` | Enqueue VM publish for an already finalized and fully shared KA |
| `dkg ka pull-from <name> -c <cg> --layer swm\|vm` | Seed WM from SWM or VM |
| `dkg ka discard <name> -c <cg>` | Discard a WM draft |
| `dkg ka query <name> -c <cg>` | Read KA WM quads |
| `dkg ka history <name> -c <cg>` | Show KA lifecycle state/history |
| `dkg assertion ...` | Compatibility aliases for older assertion-oriented workflows |
| `dkg verify <batchId>` | Propose M-of-N verification for a published batch |
| `dkg endorse <ual>` | Endorse a published Knowledge Asset |
| `dkg query [cg] -q <sparql>` | SPARQL query against the local store |
| `dkg query-remote <peer>` | Query a remote peer's knowledge store |
| `dkg subscribe <cg>` | Subscribe to a context graph and sync its data |
| `dkg sync` | Catch up on data from peers |
| `dkg index [directory]` | Index a code repository into the dev-coordination CG |
| `dkg publisher ...` | Inspect/control async publisher jobs and wallets; `publisher publish-async` remains an operational alias for `ka publish-async` |
| `dkg auth show` | Display the current API auth token |
| `dkg auth rotate` | Generate a new API auth token |
| `dkg wallet` | Show operational wallet addresses and balances |
| `dkg set-ask <amount>` | Set the node's on-chain ask (TRAC per KB·epoch) |
| `dkg openclaw setup` | Install and configure the OpenClaw adapter |
| `dkg update` | Update the node software from npm (blue-green slots for Core nodes) |
| `dkg rollback` | Roll back to the previous software slot |

Run `dkg <command> --help` for per-command options.

NPM/dist-tag auto-update is the recommended production path. Advanced Core nodes
can opt into daemon-polled git updates with `autoUpdate.source: "git"`,
`repo`, and `branch` or `ref` in `~/.dkg/config.json`; git mode builds from
source in the inactive blue-green slot and rollback is limited to already-built
slots.

Async publisher wallets need valid keys and native gas. Register the wallet as a PCA agent or fund TRAC for direct spend before expecting jobs to publish successfully. An on-chain node identity is optional publisher-node attribution; identity `0` is valid no-attribution mode. See [Async Publisher Wallets](../../docs/use-dkg/async-publisher-wallets.md).

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
  createSourceWorkerDeps({ knowledgeAssets }) {
    return {
      async getFingerprint(source) {
        return source.contentHash;
      },
      async processSource(source, fingerprint) {
        const name = `source-${source.id}`;
        const share = await knowledgeAssets.createAndShare(
          source.contextGraphId,
          name,
          source.quads,
          { subGraphName: source.subGraphName }
        );
        const publish = await knowledgeAssets.publishAsync(
          source.contextGraphId,
          name,
          { subGraphName: source.subGraphName }
        );
        const jobId = publish.jobId;
        return {
          sourceId: source.id,
          skipped: false,
          jobIds: [jobId],
          jobStatuses: { [jobId]: "queued" },
          status: "queued",
          nextState: {
            fingerprint,
            assertionName: name,
            shareOperationId: share.shareOperationId,
            intentKey: publish.intentKey,
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
- `POST /api/knowledge-assets`, `/{name}/wm/write`, `/{name}/swm/share`, `/{name}/vm/publish`, `/{name}/vm/publish-async`, `/{name}/wm/discard`, `/{name}/wm/import-file`, `GET /api/knowledge-assets/{name}` — named knowledge asset lifecycle
- `POST /api/query`, `POST /api/query-remote` — SPARQL querying
- `POST /api/endorse`, `POST /api/verify`, `POST /api/update` — Verifiable Memory trust operations
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
DKG daemon: synchronous publish end-to-end latency, async lifecycle publish
request latency, async job completion/finalization latency, and SPARQL get
latency for the published benchmark content.

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

### Route plugins

Route plugins are an in-process extension hook for fork operators who need to
add custom HTTP routes to the daemon without patching upstream. They are
distinct from the `dkg integration` system: integrations are third-party
packages installed by end-users from a registry, while route plugins are
loaded from a fork's own configured module paths and run inside the daemon's
own request loop with access to the same `RequestContext` that built-in
routes receive.

A plugin is a module exporting an object matching this shape:

```ts
import type { RoutePlugin } from '@origintrail-official/dkg/daemon/plugin-api';

export const plugin: RoutePlugin = {
  name: 'my-fork-routes',
  async handle(ctx) {
    if (ctx.url.pathname === '/my-fork/hello') {
      ctx.res.statusCode = 200;
      ctx.res.end('hi');
    }
  },
};
```

Plugins are wired into the daemon via `~/.dkg/config.json`:

```json
{
  "routePlugins": [
    "/opt/my-fork/plugins/my-fork-routes.js",
    "@my-fork/dkg-extra-routes"
  ]
}
```

Each entry is either:

- An **absolute filesystem path** to a built plugin module — loaded
  directly via `pathToFileURL` + dynamic `import()`.
- A **resolvable package name** (`@scope/name` or `name`) — resolved by
  Node's ESM resolver first (`await import(spec)`, which honours both
  `import` and `default` conditions in the package's `exports` map). If
  ESM **resolution** fails because the package's `exports` map matches
  no ESM condition (e.g. a CJS-only package whose `exports` declares
  only a `require` condition), the loader falls back to
  `createRequire(import.meta.url).resolve(spec)` and re-imports the
  resolved file URL. ESM **runtime** failures — a `SyntaxError` in the
  ESM source, a missing transitive import inside the loaded ESM, a
  rejected top-level `await` — are NOT rescued by CJS; they bubble up
  as `route-plugin-load-failed` so plugin authors actually see their
  broken ESM build instead of getting a silent CJS sidestep.

**Relative paths** (`./foo`, `../foo`) are explicitly rejected — Node's
dynamic import would otherwise resolve them relative to the loader's
source file inside `packages/cli/dist/daemon/`, not relative to
`~/.dkg/config.json`. Use an absolute path or a package name instead.

On path collisions the first plugin listed in `routePlugins` wins: the
dispatcher invokes plugins in array order and stops at the first one that
writes a response, so earlier entries shadow later ones for the same path.

#### ESM-only public API

`@origintrail-official/dkg/daemon/plugin-api` is published as **ES Modules
only** — the `exports` block in `package.json` intentionally declares only
an `import` condition (no `require`, no `default`). ESM plugins consume the
helpers directly:

```ts
import { jsonResponse, readBody } from '@origintrail-official/dkg/daemon/plugin-api';
```

The loader itself supports CommonJS plugin **modules** (the orchestrator's
loader honours `module.exports`, `module.exports.plugin`, and ESM
`default`/`plugin` named exports — see `plugin-loader.ts`), so a CJS plugin
still loads fine. The narrow gap is only synchronous `require()` of the
public helper module from CJS code. From a CommonJS plugin, load the
helpers with dynamic import inside an async function instead:

```js
// my-cjs-plugin.cjs
module.exports.plugin = {
  name: 'cjs-plugin',
  async handle(ctx) {
    const { jsonResponse, readBody } = await import(
      '@origintrail-official/dkg/daemon/plugin-api'
    );
    if (ctx.url.pathname === '/my-fork/echo') {
      const body = await readBody(ctx.req);
      return jsonResponse(ctx.res, 200, { received: body });
    }
  },
};
```

This is by design: the CLI package is `"type": "module"` end-to-end and
ships only ESM build artifacts under `dist/`, so an `exports` `require`
condition pointing at the same `.js` files would put us in the "require
ESM" mode that is unreliable across Node versions. Plugin authors who
write CommonJS use the one-line `await import()` workaround above.

See [`docs/adr/0001-daemon-route-plugins.md`](../../docs/adr/0001-daemon-route-plugins.md)
for the design rationale, threat model, and stability guarantees.

## Internal Dependencies

- `@origintrail-official/dkg-agent` — agent runtime, wallet, publishing, querying
- `@origintrail-official/dkg-core` — P2P node, memory model, event bus
- `@origintrail-official/dkg-publisher` — publish pipeline (SWM → VM)
- `@origintrail-official/dkg-storage` — triple-store adapters
- `@origintrail-official/dkg-chain` — blockchain abstraction
- `@origintrail-official/dkg-node-ui` — web dashboard serving
