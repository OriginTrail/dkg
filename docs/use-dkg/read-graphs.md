---
status: current
version: v10
audience: human+agent
doc_type: runbook
---

# Search Across Assets

A view query (`POST /api/query` with a `view`) matches each pattern inside one asset at a time. **Search across assets** lets one query link facts from different assets of a context graph. To answer such queries, the node keeps a combined copy of the context graph's assets for a memory layer. The CLI, the API and the logs call that copy a **read graph**.

Search across assets is off by default, for every context graph. You switch it per context graph and memory layer while the node runs, from the CLI, the API, an agent or the node UI. No restart is needed. Queries that don't ask for it are answered per asset, as before.

## The settings

| Setting | The API's value | What the node does |
| --- | --- | --- |
| **Off** | `off` | Keeps no combined copy. This is the default. |
| **Preview** | `build` | Prepares the combined copy and shows how results would change, without changing any results yet. |
| **On** | `serve` | Lets queries that ask for it search across assets. |

- **Layers:** each setting applies to one memory layer of a context graph. They are named as follows:

  | Layer | The API's name |
  | --- | --- |
  | Published assets | `verifiable-memory` |
  | Shared memory, shared with your team | `shared-working-memory` |
  | Private drafts | `working-memory` |

- **Asking for it:** with the setting On, a query asks to search across assets with `"semantics": "merged"`. A query that doesn't ask is answered per asset (`"semantics": "per-asset"`), unless you make searching across assets the context graph's default.
- **Who can change it:** only the node admin, with the node-admin token. That holds for every surface below, agent tools included.
- **Where it is kept:** the node keeps the settings in its own directory and keeps them across restarts and updates.

## Before you start

- **The store must support it.** These stores do:
  - Blazegraph;
  - the managed `oxigraph-server`;
  - embedded Oxigraph;
  - a `sparql-http` endpoint whose `consistencyProfile` is `atomic-update` or stronger.

  On any other store the node refuses the setting with `READ_GRAPHS_UNSUPPORTED`.
- **One node per store backend.** The combined copies assume that the node is its store's only writer, as the node's graph catalog does. Two nodes that share one store backend are not supported with search across assets in 10.1.2.
- **Not on a checkpoint node.** A node that starts from a public checkpoint keeps no settings, and refuses every change with `READ_GRAPHS_CHECKPOINT_NODE`.
- **The rollback target must recognize it.** The rollback target is the release `dkg rollback` would activate: the other slot on a Core, or the version in `previous-version` on an Edge. A release that doesn't recognize read graphs would treat them as ordinary graphs, so the node refuses Preview and On while the rollback target is such a release. The refusal is `READ_GRAPHS_ROLLBACK_TARGET_OLDER`, with the target's version and the first release that recognizes read graphs. Once a node that runs such a release updates again, its rollback target recognizes read graphs too.
- **Plan for the space.** A combined copy holds one copy of each distinct triple of its layer, so the store grows by up to the size of that layer.

## Switch it on for a context graph

The examples use the context graph `my-project` and its published assets.

### 1. Turn on Preview

```bash
dkg store read-graphs enable -c my-project
```

- **Defaults:** without options, `enable` sets Preview for published assets. `--layer` picks the layer: `verifiable-memory`, `shared-working-memory`, `working-memory`, or `all` for the three.
- **What happens:** the node fills the combined copy on its background lane, so client queries and writes go first. From then on, every write to the layer's assets also updates the copy.

### 2. Wait until it is ready, then run the full check

```bash
dkg store read-graphs status -c my-project
```

The status shows "Getting ready" while the copy fills (state `building`), then "Ready to turn on" (state `ready`). Then compare every ready copy on the node with its assets, in both directions:

```bash
dkg store read-graphs check
```

- **What the full check finds:** a triple an asset holds that the copy lacks, and a triple the copy holds that no asset holds.
- **The answer:** each copy is `consistent`, `mismatch`, `skipped` (not ready) or `interrupted` (writes kept overlapping it). Run it again until every one is `consistent`.
- **A mismatch:** the copy is marked dirty and rebuilt before it is used, and the command exits 1. It also exits 1 when the check itself fails.
- **The sampled check:** `--sampled` runs a quicker one. The node also runs it in the background for as long as a copy exists.

### 3. Run your workload, then check again

Let the node take its usual traffic, or drive every kind of write it takes:

- creating and sharing assets;
- promoting and publishing them;
- updates and removals;
- sync and catch-up;
- sub-graph registration;
- drafts.

Then run `dkg store read-graphs check` again.

### 4. Read the delta report with the context graph's owner

```bash
dkg view-semantics report -c my-project
```

The command needs the node-admin token.

- **How it is built:** while the copy is in Preview and ready, the node samples view queries on the context graph and compares the answer across assets with the per-asset one.
- **What it shows:** how many sampled queries would get the same rows, how many lose only duplicate copies, and how many would get other rows. It lists the query shapes behind the changed rows.
- **Where changed rows come from:** patterns that join triples of different assets.

Go on only when the context graph's owner and its callers expect those answers.

### 5. Turn it On

**Where another process writes the same store,** for example a standalone `dkg publisher run` against a shared Blazegraph or `oxigraph-server`, keep it at Preview until [#3839](https://github.com/OriginTrail/dkg/issues/3839) is fixed. Until the node's catalog revalidates, queries across assets with `GRAPH` parts can miss rows that the other process wrote.

```bash
dkg store read-graphs enable -c my-project --mode on
```

- **Mode names:** `--mode` takes `preview` and `on`, or the API's `build` and `serve`.
- **Callers:** they can now ask to search across assets, per request:

  ```json
  {
    "contextGraphId": "my-project",
    "view": "verifiable-memory",
    "semantics": "merged",
    "sparql": "SELECT ?product ?maker WHERE { ?product <https://schema.org/manufacturer> ?m . ?m <https://schema.org/name> ?maker }"
  }
  ```

  From the CLI: `dkg query … --semantics merged`.
- **Requests without `semantics`** still get per-asset answers.
- **The response's `semantics` field** says which semantics answered.
- **The status** shows "In use".

### 6. Make it the default (optional)

When the context graph's callers are ready, search across assets for requests that don't ask:

```bash
dkg store read-graphs default-semantics -c my-project merged
```

- **Pinning:** a caller can still pin `"semantics": "per-asset"`.
- **Other layers:** a request that takes the default on a layer that isn't On is answered per asset.
- **Undo:** `default-semantics -c my-project none` removes the default.

### When you create a context graph

```bash
dkg context-graph create … --read-graphs preview
```

- **Layers:** `--read-graph-layer` picks them, as `--layer` does for `enable`.
- **Checks:** the setting is applied after the creation, with the same checks as `enable`.
- **A refusal:** a refused setting doesn't fail the creation. The command says why the setting was refused.

## Turn it off

```bash
dkg store read-graphs disable -c my-project
```

- **Queries:** answered per asset from the next query.
- **The copy:** the node stops updating it and removes its data in the background.
- **Keep the copy, stop using it:** set Preview instead (`enable -c my-project --mode preview`). The copy stays up to date, and requests that ask to search across assets get the answer for a layer that isn't On.
- **`dkg rollback`:** it drops the combined copies as part of the rollback.

## Shared memory

The same steps work for shared memory (`--layer shared-working-memory`), but keeping its copy costs more on one path. A snapshot import, such as a catch-up from peers, updates the copy for every asset graph it replaces.

Measured on a local Blazegraph, importing 1,000 asset graphs of 20 triples each (medians of three runs):

| Import | Shared memory Off | Shared memory in Preview | Extra |
| --- | --- | --- | --- |
| Fresh | 39.6 s | 72.4 s | +83 %, about 33 ms per asset graph |
| Replacing existing graphs | 38.3 s | 75.2 s | +97 %, about 37 ms per asset graph |

Rebuilding the same copy in one pass took 0.17 s. In every run the copy equalled the union of its asset graphs.

- **What it means:** keeping the shared-memory copy roughly doubles a snapshot import. A catch-up of 100,000 asset graphs takes about an hour longer.
- **Until imports skip per-graph maintenance and rebuild once ([#3831](https://github.com/OriginTrail/dkg/issues/3831)):** keep shared memory Off on nodes that catch up many asset graphs.

## Other ways to switch it

### The API

The settings calls need the node-admin token.

- **`GET /api/store/read-graphs/settings`:** the node's policy, and for each context graph that has a setting or a copy: its settings, the effective setting of each layer, and the state of each copy. `?contextGraphId=<id>` narrows it to one context graph, with or without settings.
- **`PUT /api/store/read-graphs/settings`:** changes one context graph's settings in one step. It returns that context graph's settings and states afterwards, with the changes it made. It uses the API's values:

  ```json
  {
    "contextGraphId": "my-project",
    "layers": { "verifiable-memory": "build" },
    "viewSemantics": "merged"
  }
  ```

  - **`layers`:** maps layers to `off`, `build` or `serve`. Layers you leave out keep their setting.
  - **`viewSemantics`:** `"merged"` or `"per-asset"` sets the default; `null` removes it.
  - **The checks, in order:** the node-admin token, the body's shape, the node's policy (below), store support, that the node is not a checkpoint node, the rollback target, and then that the node can write its settings.
  - **Off is always allowed:** switching a layer Off, or changing the default semantics, skips the policy, store and rollback-target checks. Only a checkpoint node refuses it, as it keeps no settings.
  - **A refusal:** the answer is `{ "code": …, "error": … }`, where `error` is one sentence for the operator, and the settings stay as they were. The codes are listed under [What you'll see](#what-youll-see).
  - **Concurrent changes:** they apply one at a time, and the last one wins.
- **`POST /api/context-graph/create`:** takes an optional `"readGraphs": { "layers": { "verifiable-memory": "build" } }`.
  - **A malformed setting:** the request is refused with `400 READ_GRAPH_SETTINGS_INVALID`, and nothing is created.
  - **Otherwise:** the setting goes through the same checks after the creation, the node-admin token included. The response's `readGraphs` says whether it was applied, or why it was refused, with a code: those of a change, or `NODE_ADMIN_REQUIRED` without the node-admin token.
  - **A refused setting** doesn't fail the creation.

### Agents

The node's MCP server, OpenClaw and Hermes offer two tools:

- `dkg_read_graphs_status` reads the settings and states;
- `dkg_read_graphs_set` changes them.

- **The node-admin token:** both tools need it and refuse without it.
- **`dkg_context_graph_create`:** takes the same optional setting as the creation call. Without the node-admin token, it creates the context graph without the setting and says why.
- **Wording:** agents describe the settings as Off, Preview and On.

### The node UI

- **A context graph's page:** shows the setting and state of each layer. The node admin can switch each layer between Off, Preview and On.
- **The query view:** has a switch to search across assets for one query.

## Node-wide settings in `config.json`

Node-wide policy stays in `~/.dkg/config.json`. The daemon reads it at start, so restart after a change. An invalid value stops the start with `QUERY_CONFIG_INVALID` and names the key.

| Key | What it sets |
| --- | --- |
| `query.readGraphs` | The node's default setting, as one value for every layer, or `{ "default": …, "layers": { … } }` with a setting per layer |
| `query.viewSemantics.default` | The node's default semantics |
| `query.readGraphsPolicy.enabled` | `false` turns search across assets off on the node, whatever the settings say |
| `query.readGraphsPolicy.layers` | The layers that may be switched on (all three by default) |

- **Precedence:** the most specific setting wins:
  1. a context graph's setting for the layer, from any of the surfaces above;
  2. the node's setting for the layer;
  3. the node's default.
- **The rollback target, at start:** a node-wide setting that isn't Off makes `dkg start` refuse while the rollback target doesn't recognize read graphs:

  ```text
  [QUERY-CONFIG] 1 validation error(s) - refusing to start.
    query.readGraphs: must be "off" while the rollback target (…) is older than …, the first release that recognizes read graphs
  ```

- **A context graph's setting at start:** it never stops the start. If the policy, the store or the rollback target doesn't allow it, the layer stays Off, and the daemon log says why.
- **Deprecated: per-context-graph rules in `config.json`** (`query.readGraphs.contextGraphs` and `query.viewSemantics.contextGraphs`):
  - **The first start that keeps settings as node state** imports them once and logs a warning naming the keys.
  - **From then on** they are ignored, with that warning at each start.
  - **What to do:** remove them after the import, and use the surfaces above instead.

## The commands

`dkg store read-graphs` asks the running daemon, with the node-admin token, so the daemon must be up.

| Command | What it does |
| --- | --- |
| `enable -c <id>` | Preview for published assets; `--layer` and `--mode` pick others |
| `disable -c <id>` | Off for published assets; `--layer` picks others |
| `settings` | The settings, and the effective setting of each context graph and layer |
| `default-semantics -c <id> merged\|per-asset\|none` | A context graph's default semantics |
| `status` | Each copy with its layer, state and generation, a count per state, what the builder is doing, and the last check |
| `check` | The full check of every ready copy; `--sampled` for the quicker one |
| `rebuild` | Marks copies dirty; the node rebuilds them on its next pass. Watch with `status`. |
| `drop --yes` | Removes copies and frees their space |

- **Options:** `status`, `rebuild` and `drop` take `-c <context graph ID>` and `--layer wm|swm|vm` to narrow them. Every command takes `--json` to print the node's answer.
- **HTTP:**
  - **Status and maintenance:** `GET /api/store/read-graphs`, and `POST /api/store/read-graphs/check`, `/rebuild` and `/drop`.
  - **Settings:** `GET` and `PUT /api/store/read-graphs/settings`.

## What you'll see

| Signal | Meaning |
| --- | --- |
| "Getting ready", with progress (state `building`) | The copy is filling. |
| "Ready to turn on" (Preview, state `ready`) | The copy is complete and kept up to date, and no query uses it. |
| "In use" (On, state `ready`) | Queries that ask to search across assets use it. |
| "Checking" | A check is comparing the copy with its assets. |
| "Rebuilding" (state `dirty`, `repairing` or `rebuilding`) | The copy is being made again. Only a `ready` copy is checked and used. |
| `[read-graph-check] Read graph <…> does not equal the union of its member graphs (…)` in the daemon log | A check found a mismatch. The copy is marked dirty and rebuilt before it is used again. |
| `dkg.store.read_graph_mismatches_total` | Mismatches, as a counter. Alert on any increase. |
| `dkg.store.read_graph_checks_total`, `dkg.store.read_graph_check_ms` | Checks by mode, outcome and layer, and how long they take. |
| `dkg.store.read_graphs` | Copies by state. |
| `503 VIEW_NOT_READY` with `Retry-After` | A request to search across assets while the copy is not ready, for example during a rebuild. Per-asset requests are not affected. |
| `400 SEMANTICS_UNSUPPORTED` | A request to search across assets where it doesn't apply, such as a layer that isn't On. |
| `400 READ_GRAPH_SETTINGS_INVALID` | A setting's shape, layer or value is wrong, or the context graph can't have a combined copy. |
| `409 READ_GRAPHS_DISABLED` | `query.readGraphsPolicy.enabled` is `false` on the node. |
| `409 READ_GRAPHS_LAYER_NOT_ALLOWED` | The layer isn't in `query.readGraphsPolicy.layers`. |
| `409 READ_GRAPHS_UNSUPPORTED` | The node's store can't keep combined copies. |
| `409 READ_GRAPHS_CHECKPOINT_NODE` | The node starts from a public checkpoint, and keeps no settings. |
| `409 READ_GRAPHS_ROLLBACK_TARGET_OLDER` | The rollback target doesn't recognize read graphs. The answer names the target's version and the first release that recognizes read graphs. |
| `409 READ_GRAPHS_APPLY_REFUSED` | The node couldn't apply the change. The settings were put back, and the answer lists the changes it tried. |
| `503 READ_GRAPH_SETTINGS_UNAVAILABLE` | The node can't open its settings. |

Metrics are exported once an OTLP endpoint is set; see [Monitor Store and Queue Pressure](backpressure-observability.md).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `enable` is refused with `READ_GRAPHS_UNSUPPORTED` | The store can't keep combined copies. Move to a store listed above, or leave it Off. |
| `enable` is refused with `READ_GRAPHS_ROLLBACK_TARGET_OLDER` | Update so that the rollback target recognizes read graphs, then try again. |
| `enable` is refused with `READ_GRAPHS_DISABLED` or `READ_GRAPHS_LAYER_NOT_ALLOWED` | `query.readGraphsPolicy` turns it off on the node, or doesn't allow the layer. |
| A change is refused with `READ_GRAPHS_APPLY_REFUSED` | The settings were put back. Read the answer's `error` and the daemon log, wait for running checks or rebuilds to end, and try again. |
| Settings calls answer `503 READ_GRAPH_SETTINGS_UNAVAILABLE` | The node can't open its settings file. Look for the reason in the daemon log. Queries keep working with the settings in force. |
| `dkg start` refuses: the rollback target is older than the first release that recognizes read graphs | A node-wide setting in `config.json` isn't Off. Update so that the rollback target recognizes read graphs, or set it to `off`. |
| A layer stays Off after a start, and the daemon log says why | The setting isn't allowed on this node now: the policy, the store or the rollback target. It applies again once allowed; switch it again to apply it at once. |
| A copy stays "Rebuilding" | Requests to search across assets get `503` until it is ready; per-asset answers keep working. Look for the check line in the daemon log. If it repeats, turn it Off and open an issue with those log lines. |
| Every copy is rebuilt after a start | Expected after `dkg publisher cancel`, `retry` or `clear` ran while the daemon was down. Nothing maintains copies in that process, so it marks them all dirty before it writes. Wait for them to be ready; requests to search across assets get `503` until then. |
| You suspect a copy's answers | Run `dkg store read-graphs check`. To start one over, run `dkg store read-graphs rebuild -c <id>`. |
| Writes are slower | Compare the store's queue waits with the layer On or in Preview and with it Off ([Monitor Store and Queue Pressure](backpressure-observability.md)). Turn the layer Off if they rise. |
