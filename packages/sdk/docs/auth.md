# SDK Auth

`@dkg/sdk` uses bearer auth when a token is provided.

## With token

```ts
import { createDKG } from '@dkg/sdk';

const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
  token: process.env.DKG_TOKEN,
});
```

## Without token

If daemon auth is disabled, omit `token`:

```ts
const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
});
```

## Custom headers and timeout

```ts
const dkg = createDKG({
  baseUrl: 'http://127.0.0.1:9200',
  token: process.env.DKG_TOKEN,
  timeoutMs: 30_000,
  headers: {
    'X-Request-Source': 'my-app',
  },
});
```

SDK throws `DKGSDKError` for HTTP/network/timeout failures.
