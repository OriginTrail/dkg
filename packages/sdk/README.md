# @dkg/sdk

Resource-first TypeScript SDK for DKG daemon APIs.

## Docs

- Quickstart: `packages/sdk/docs/quickstart.md`
- Publish/Query flow: `packages/sdk/docs/publish-query-flow.md`
- Auth: `packages/sdk/docs/auth.md`
- Examples: `packages/sdk/examples/`

## Quick Start

```ts
import { createDKG } from '@dkg/sdk';

const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
  token: process.env.DKG_TOKEN,
});

const status = await dkg.node.status();
console.log(status.peerId);

const paranets = await dkg.paranet.list();
console.log(paranets.paranets.length);

const published = await dkg.publish.quads({
  paranetId: 'dev-coordination',
  quads: [
    {
      subject: 'urn:entity:test',
      predicate: 'http://schema.org/name',
      object: '"SDK test"',
      graph: 'did:dkg:paranet:dev-coordination',
    },
  ],
});
console.log(published.kcId);

const rows = await dkg.query.sparql('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10', {
  paranetId: 'dev-coordination',
});
console.log(rows.result);

const discovered = await dkg.agent.list({ framework: 'OpenClaw' });
console.log(discovered.agents.map((a) => a.name));

const context = await dkg.context.create({
  participantIdentityIds: [101, 202, 303],
  requiredSignatures: 2,
});

const enshrined = await dkg.publish.workspaceEnshrine({
  paranetId: 'dev-coordination',
  contextGraphId: context.contextGraphId,
});
console.log(enshrined.contextGraphId);
```

## Auth

- If your daemon requires auth, pass a bearer token via `token`.
- If auth is disabled, omit `token`.

```ts
const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
  token: process.env.DKG_TOKEN,
});
```

## Publish/Query Flow

```ts
const paranetId = 'dev-coordination';
const graph = `did:dkg:paranet:${paranetId}`;

await dkg.publish.quads({
  paranetId,
  quads: [
    {
      subject: 'urn:entity:alice',
      predicate: 'http://schema.org/name',
      object: '"Alice"',
      graph,
    },
  ],
});

const out = await dkg.query.sparql(
  'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 25',
  { paranetId },
);
```

## Current Resources

- `dkg.node.status()`
- `dkg.paranet.list()`
- `dkg.paranet.create({ id, name, description? })`
- `dkg.paranet.exists(id)`
- `dkg.paranet.subscribe(paranetId, { includeWorkspace? })`
- `dkg.paranet.catchupStatus(paranetId)`
- `dkg.publish.quads({ paranetId, quads, privateQuads?, accessPolicy?, allowedPeers? })`
- `dkg.publish.workspaceWrite({ paranetId, quads })`
- `dkg.publish.workspaceEnshrine({ paranetId, selection?, clearAfter?, contextGraphId? })`
- `dkg.context.create({ participantIdentityIds, requiredSignatures })`
- `dkg.query.sparql(sparql, { paranetId? })`
- `dkg.query.remote({ peerId, lookupType, ... })`
- `dkg.agent.list({ framework?, skillType? })`
- `dkg.agent.skills({ skillType? })`
- `dkg.agent.invokeSkill({ peerId, skillUri, input? })`
- `dkg.agent.chat({ to, text })`
- `dkg.agent.messages({ peer?, since?, limit? })`

This is the initial SDK foundation; next step is expanding each resource with additional typed operations.

## Testing

- Unit tests: `pnpm --filter @dkg/sdk test`
- Integration tests (against a running local daemon):

```bash
DKG_SDK_INTEGRATION_BASE_URL=http://127.0.0.1:9200 \
DKG_SDK_INTEGRATION_TOKEN=<optional-token> \
pnpm --filter @dkg/sdk test:integration
```
