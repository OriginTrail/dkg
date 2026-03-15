# Publish/Query Flow

This flow shows the typical write/read cycle using `@origintrail-official/dkg-sdk`.

## Publish

```ts
const paranetId = 'dev-coordination';
const graph = `did:dkg:paranet:${paranetId}`;

const publishResult = await dkg.publish.quads({
  paranetId,
  quads: [
    {
      subject: 'urn:entity:doc:42',
      predicate: 'http://schema.org/name',
      object: '"Design Notes"',
      graph,
    },
    {
      subject: 'urn:entity:doc:42',
      predicate: 'http://schema.org/text',
      object: '"Important internal text"',
      graph,
    },
  ],
});

console.log(publishResult.kcId, publishResult.status, publishResult.txHash);
```

## Query

```ts
const rows = await dkg.query.sparql(
  `
  PREFIX schema: <http://schema.org/>
  SELECT ?s ?name WHERE {
    ?s schema:name ?name .
  }
  LIMIT 25
  `,
  { paranetId },
);

console.log(rows.result);
```

## Optional: workspace and context

```ts
await dkg.publish.workspaceWrite({
  paranetId,
  quads: [
    {
      subject: 'urn:entity:workspace:1',
      predicate: 'http://schema.org/name',
      object: '"Workspace Draft"',
      graph,
    },
  ],
});

const context = await dkg.context.create({
  participantIdentityIds: [101, 202, 303],
  requiredSignatures: 2,
});

const enshrined = await dkg.publish.workspaceEnshrine({
  paranetId,
  contextGraphId: context.contextGraphId,
});

console.log(enshrined.kcId, enshrined.contextGraphError);
```
