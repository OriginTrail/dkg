# Agent-key HTTP authentication

An agent authenticates by signing each HTTP request directly with its existing Ethereum/secp256k1 private key. The backend configures that key once; the client signs automatically. There is no JWT, login exchange, token issuance, token renewal or private-key transfer. Existing bearer clients remain supported independently; the former agent HTTP JWT envelope is no longer accepted.

The shared daemon boundary verifies the signature before dispatching any protected route. The recovered agent address becomes the request actor, whether or not it has an operator role. It must match the public address in the signed request. No default wallet is substituted. Public endpoints remain public when no proof is supplied; invalid or incomplete signature headers cannot downgrade to public, bearer or auth-disabled admission.

## Signature profile

Use [EIP-191 personal_sign](https://eips.ethereum.org/EIPS/eip-191), version 0x45, over this exact UTF-8 JSON array, with no whitespace outside string values:

```text
["DKG-HTTP-REQUEST-V1",lowercaseAgentAddress,targetPeerId,method,path,contentType,bodySha256,timestamp,nonce]
```

All nine items are strings. Use normal JSON string escaping. The domain prevents reuse as another kind of signature. `method` is uppercase; `path` preserves the exact origin-form path, query order and percent encoding. `contentType` is the exact Content-Type header or an empty string. `bodySha256` is the lowercase SHA-256 hex digest of the exact request bytes, including whitespace. The signature uses the ordinary 65-byte Ethereum `r || s || v` encoding as `0x`-prefixed hex. No algorithm negotiation, public-key fetch or JWT parsing is involved.

| Header | Meaning |
| --- | --- |
| `Authorization: DKG-Agent <signature>` | EIP-191 signature of this request. Contains no private key. |
| `X-DKG-Agent-Address` | Public agent wallet address; must match the recovered signer. |
| `X-DKG-Agent-Target` | Receiving node's physical peer ID, checked against local state rather than the HTTP Host header. |
| `X-DKG-Agent-Timestamp` | Canonical decimal Unix milliseconds as a string. A request is accepted for 60 seconds, with at most 5 seconds of future clock skew. |
| `X-DKG-Agent-Nonce` | Fresh 16–32-byte random lowercase hex nonce. |
| `Content-Type` | Exact signed content type; omit when the signed value is empty. |

The 60-second window protects request freshness. It does **not** expire the agent key, require renewed graph approval or limit the execution time of an admitted Program. A backend can keep running using the same key. Sign immediately before sending; retries use a new timestamp, nonce and signature.

The body is bounded to 10 MiB and 30 seconds before routing; endpoint-specific limits still apply. Compressed request bodies are rejected. Live nonces are retained in the daemon's SQLite database across restarts; concurrent replay fails atomically. Expired records may be removed, but live records are never evicted to admit new requests. Store unavailability/capacity exhaustion returns 503 and fails closed.

Authentication failures return 401 with `AGENT_HTTP_HEADERS_INVALID`, `AGENT_HTTP_SIGNATURE_INVALID`, `AGENT_HTTP_TARGET_MISMATCH`, `AGENT_HTTP_EXPIRED` or `AGENT_HTTP_REPLAY`. Modified method, path, body or signed headers invalidate the signature. Authorization failures remain governed by each route and graph policy.

## Configure a backend once

The package exports a small Node.js client at `@origintrail-official/dkg/agent-http`. It accepts an ethers-compatible signer, so signing can remain in the backend or an external key service. No private key is stored on the DKG node for this path.

```js
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { createAgentHttpClient } from '@origintrail-official/dkg/agent-http';

const client = createAgentHttpClient({
  baseUrl: process.env.DKG_NODE_URL, // node HTTP(S) origin
  targetPeerId: process.env.DKG_NODE_PEER_ID,
  signer: new Wallet(readFileSync(process.env.AGENT_KEY_FILE, 'utf8').trim()),
});

const response = await client.request('/api/query', {
  method: 'POST',
  body: JSON.stringify({
    contextGraphId: 'OWNER_ADDRESS/program-library',
    sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
    view: 'shared-working-memory',
  }),
});
if (!response.ok) throw new Error(`DKG returned HTTP ${response.status}`);
console.log(await response.json());
```

Every `client.request()` signs the exact supplied body automatically. The client refuses cross-origin paths, URL normalization and redirects. It does not retry mutations automatically or grant graph access. Use the same client for uploads, binding management and other authorized API calls. Remote Program execution additionally carries the existing invocation authorization described below.

## Explicit node administration

The node operator adds approved addresses to its normal `config.json`, preserving other fields, then restarts the daemon:

```json
{"auth":{"enabled":true,"operatorAgentAddresses":["0xREPLACE_WITH_APPROVED_AGENT_ADDRESS"]}}
```

Addresses are validated at startup. An empty or absent list grants no agent an operator role. The signed principal remains the agent address; operator role does not turn a private WM query into another wallet's query. Graph ownership alone permits only the owner's own custodial executor in Program approval. An explicit operator may select other authorized local custodial executors, under the existing Program-management contract.

## Signing and remote execution

Build the CLI and use `packages/cli/scripts/sign-agent-request.mjs`. Its `http` mode reads a local key file and writes a header file for `curl -H @headers.txt`. Its `invocation` mode adds the existing agent-signed, version-3 bound-operation authorization to a JSON payload. Keep key files mode 0600 on the signer. No private key is placed in curl arguments, headers or payloads.

HTTP proof authorizes delivery to the calling node. The separate invocation delegation binds the original agent, forwarding peer, execution peer, canonical data graph, operation and invocation UUID. Both peers verify it; the executor also checks its current binding, source pins, caller permissions and revocation. Supplied invalid authorization never falls back to custodial signing. Omitting authorization retains signing with the authenticated caller's own custodial key, if available; no default-key fallback exists.

For retries, retain the invocation UUID and issue a fresh HTTP proof. Renew an expired invocation delegation against the same UUID. Execution idempotency and HTTP replay protection are independent.

The [complete Program walkthrough](program-authorization-api.md) includes upload, approval, routing, shared-source readback, invocation, receipt verification, isolation checks and revocation with full JSON payloads and a sequence diagram. Source tests are not proof of live deployment; deployment reports must identify the actual commit and responses separately.
