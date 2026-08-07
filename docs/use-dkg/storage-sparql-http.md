---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Using an external SPARQL store (Oxigraph server, etc.)

The DKG node can use any **SPARQL 1.1 Protocol**–compliant store you run yourself, instead of its default daemon-managed local Oxigraph server (or the embedded `oxigraph-worker` fallback). That gives you:

- **Real on-disk persistence** (e.g. Oxigraph server with RocksDB)
- **Larger graphs** without holding everything in the Node process
- **Existing infrastructure** (GraphDB, Blazegraph, Jena Fuseki, Neptune, Stardog)

## Backend: `sparql-http`

Configure the node to use the **`sparql-http`** backend with a **query endpoint**. `updateEndpoint` is optional and defaults to `queryEndpoint`, which covers stores that use one URL for both query and update.

### Config (CLI / config.json)

In `~/.dkg/config.json` (or your `DKG_HOME` config):

```json
{
  "name": "my-node",
  "apiPort": 9200,
  "listenPort": 9001,
  "store": {
    "backend": "sparql-http",
    "options": {
      "queryEndpoint": "http://127.0.0.1:7878/query",
      "updateEndpoint": "http://127.0.0.1:7878/update"
    }
  }
}
```

Optional:

- **`updateEndpoint`** — SPARQL update endpoint. Defaults to `queryEndpoint` when omitted.
- **`timeout`** — request timeout in ms (default `30000`).
- **`auth`** — `Authorization` header value, e.g. `"Bearer <token>"` or `"Basic <base64>"`.

### Oxigraph server

1. **Install and run Oxigraph** (Rust binary with RocksDB):

   - Download from [oxigraph/oxigraph releases](https://github.com/oxigraph/oxigraph/releases) or build from source.
   - Run the server, e.g.:
     ```bash
     oxigraph serve --bind 127.0.0.1:7878 --location /path/to/oxigraph-data
     ```
   - Default paths are often `/query` and `/update` (check the server’s docs).

2. **Point the DKG at it** using the `sparql-http` config above with your host/port.

3. Start the DKG node as usual; it will use the remote store for all triples.

{% hint style="info" %}
For a local Oxigraph server you do **not** have to run it yourself: set `"store": { "backend": "oxigraph-server" }` (the `dkg init` default) and the daemon fetches the pinned `oxigraph` binary, spawns it on `127.0.0.1`, and supervises it. Use the manual `sparql-http` steps above only when you run Oxigraph (or another SPARQL store) yourself or off-host.
{% endhint %}

Managed Oxigraph accepts optional launch settings under `store.options`:

```json
{
  "store": {
    "backend": "oxigraph-server",
    "options": {
      "port": 7878,
      "location": "/var/lib/dkg/oxigraph-data",
      "cacheDir": "/var/lib/dkg/oxigraph-bin",
      "readyTimeoutMs": 180000,
      "clientTimeoutMs": 180000,
      "queryTimeoutS": 35,
      "memoryHighMiB": 2048,
      "memoryMaxMiB": 3072
    }
  }
}
```

`readyTimeoutMs` is the maximum startup readiness wait in milliseconds. It must be a positive integer; invalid values are ignored and the default 30-second timeout is used. Increase it when a large or recovering RocksDB database needs longer to open.

`clientTimeoutMs` is the SPARQL HTTP client deadline in milliseconds. It can be raised independently when a valid store mutation needs longer than the default 30 seconds, without enabling a native Oxigraph query timeout. When set, it takes precedence over the client deadline derived from `queryTimeoutS`.

`queryTimeoutS` is the native Oxigraph query timeout in seconds and is passed to `oxigraph serve --timeout-s`. When `clientTimeoutMs` is omitted, the rewritten HTTP store timeout includes an additional five-second grace period so Oxigraph can return its timeout response before the client aborts the request.

On Linux hosts using systemd, `memoryMaxMiB` runs managed Oxigraph in a dedicated transient user scope with a finite hard limit and disables swap for that scope, so database pressure cannot spill into host swap and stall the node. Optional `memoryHighMiB` sets its soft reclaim threshold and must not exceed `memoryMaxMiB`. This keeps Oxigraph outside the DKG daemon service's cgroup, so a finite `MemoryMax` on the daemon cannot kill the store or throttle the Node.js control plane as one combined process group. Enable lingering once for the node service account (`sudo loginctl enable-linger <dkg-user>`) so its user manager and bus exist before the system service starts at boot; verify with `systemctl --user is-system-running` as that account. The daemon supplies the required user-bus environment automatically. Startup fails rather than silently dropping configured limits when the scope cannot be created.

Size the daemon service and Oxigraph scope independently, while keeping their combined maxima within host capacity. For example, an 8 GiB node can reserve 3 GiB for managed Oxigraph and place a separate finite 4 GiB cap on the DKG service, leaving roughly 1 GiB for the OS. These options are deliberately opt-in and are not supported on non-systemd platforms.

### Other stores

- **Blazegraph:** One URL for both query and update. Set only `queryEndpoint` or set both options to the same URL (e.g. `http://127.0.0.1:9999/blazegraph/namespace/kb/sparql`).
- **Apache Jena Fuseki:** Typically `http://host:3030/dataset/query` and `http://host:3030/dataset/update`.
- **GraphDB, Neptune, Stardog:** Use the vendor’s SPARQL query and update URLs; add `auth` if required.

### Blazegraph provisioned by `dkg init` (Docker)

When you pick the `blazegraph` backend in `dkg init` and leave the URL blank, the CLI offers to provision a container itself. For new containers, the provisioner uses the pinned multi-architecture image and data path declared in `blazegraph-image.json`, stores the journal in a named Docker volume, and uses `--restart unless-stopped`. Blazegraph output uses Docker's compressed `local` log driver with a 4 GB rotation budget (`200m` × 20 files), so an unattended container cannot fill the host disk. The provisioner auto-bumps the host port if 9999 is taken and is idempotent — re-running `dkg init` against an already-provisioned namespace reuses the running container.

A reused legacy container is never recreated automatically, because doing so could discard its journal. If its volume or log policy does not match the current configuration, the CLI prints explicit backup/migration and unbounded-log warnings instead.

## Programmatic (DKGAgent)

When creating an agent in code, pass `storeConfig`:

```ts
import { DKGAgent } from '@origintrail-official/dkg-agent';

const agent = await DKGAgent.create({
  name: 'MyAgent',
  storeConfig: {
    backend: 'sparql-http',
    options: {
      queryEndpoint: 'http://127.0.0.1:7878/query',
      updateEndpoint: 'http://127.0.0.1:7878/update',
    },
  },
});
await agent.start();
```

## Store defaults

New installs default to a **daemon-managed local Oxigraph server** (`store.backend: "oxigraph-server"`): `dkg init`, `dkg openclaw/hermes/mcp setup`, or accepting the wizard default writes this block. The daemon fetches the pinned `oxigraph` binary on first boot and runs it on loopback, giving MVCC concurrent reads and incremental RocksDB persistence.

If a config has **no** `store` block at all, the runtime falls back to the embedded in-process **`oxigraph-worker`** (a single-writer store that rewrites its on-disk N-Quads dump under `dataDir` on every flush) — fine for development and small nodes. For very large graphs or existing infrastructure, use `sparql-http` with an external store.
