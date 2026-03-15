# SDK Quickstart

## 1) Start a local node

```bash
dkg start
```

By default, daemon API is on `http://127.0.0.1:9200`.

## 2) Install and create client

```ts
import { createDKG } from '@origintrail-official/dkg-sdk';

const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
  token: process.env.DKG_TOKEN,
});
```

## 3) Check node and paranets

```ts
const status = await dkg.node.status();
console.log('Peer ID:', status.peerId);

const paranets = await dkg.paranet.list();
console.log('Paranets:', paranets.paranets.map((p) => p.id));
```

## 4) Publish and query

```ts
const paranetId = 'dev-coordination';
const graph = `did:dkg:paranet:${paranetId}`;

await dkg.publish.quads({
  paranetId,
  quads: [
    {
      subject: 'urn:entity:test:1',
      predicate: 'http://schema.org/name',
      object: '"SDK Quickstart"',
      graph,
    },
  ],
});

const queryResult = await dkg.query.sparql('SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10', {
  paranetId,
});

console.log(queryResult.result);
```
