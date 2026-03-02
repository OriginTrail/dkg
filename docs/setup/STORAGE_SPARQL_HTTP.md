# Using an external SPARQL store (Oxigraph server, etc.)

The DKG node can use any **SPARQL 1.1 Protocol**–compliant store instead of the built-in in-memory store. That gives you:

- **Real on-disk persistence** (e.g. Oxigraph server with RocksDB)
- **Larger graphs** without holding everything in the Node process
- **Existing infrastructure** (GraphDB, Blazegraph, Jena Fuseki, Neptune, Stardog)

## Backend: `sparql-http`

Configure the node to use the **`sparql-http`** backend with a **query endpoint** and an **update endpoint**. If your server uses a single URL for both (e.g. Blazegraph), set both options to the same URL.

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

- **`timeout`** — request timeout in ms (default `30000`).
- **`auth`** — `Authorization` header value, e.g. `"Bearer <token>"` or `"Basic <base64>"`.

### Oxigraph server

1. **Install and run Oxigraph** (Rust binary with RocksDB):

   - Download from [oxigraph/oxigraph releases](https://github.com/oxigraph/oxigraph/releases) or build from source.
   - Run the server, e.g.:
     ```bash
     oxigraph serve --bind 127.0.0.1:7878 --storage-path /path/to/oxigraph-data
     ```
   - Default paths are often `/query` and `/update` (check the server’s docs).

2. **Point the DKG at it** using the `sparql-http` config above with your host/port.

3. Start the DKG node as usual; it will use the remote store for all triples.

### Other stores

- **Blazegraph:** One URL for both query and update. Set `queryEndpoint` and `updateEndpoint` to the same URL (e.g. `http://127.0.0.1:9999/blazegraph/namespace/kb/sparql`).
- **Apache Jena Fuseki:** Typically `http://host:3030/dataset/query` and `http://host:3030/dataset/update`.
- **GraphDB, Neptune, Stardog:** Use the vendor’s SPARQL query and update URLs; add `auth` if required.

## Programmatic (DKGAgent)

When creating an agent in code, pass `storeConfig`:

```ts
import { DKGAgent } from '@dkg/agent';

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

## Default when no store is set

If you do **not** set `store` / `storeConfig`, the node uses **`oxigraph-worker`** with a file under `dataDir` (N-Quads dump). That is fine for development and small nodes; for production or large graphs, use `sparql-http` with an external store.
