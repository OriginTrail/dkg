# Agent-key HTTP authentication

An agent authenticates with its existing Ethereum/secp256k1 signing key. Each request carries `Authorization: DKG-Agent <compact-JWT>`. The JWT is signed by the agent, not minted by the node. There is no login exchange, node-issued bearer secret, HMAC or private-key transfer. Existing bearer clients remain supported independently.

The shared daemon boundary verifies this proof before dispatching any protected route. Its public-key-derived agent address becomes the request actor, whether or not it has an operator role. No default wallet is substituted. Public endpoints remain public when no proof is supplied; an invalid proof cannot downgrade to public or auth-disabled admission.

## Signature profile

The only accepted JOSE algorithm is **ES256K**: ECDSA over secp256k1 with SHA-256 and a 64-byte `R || S` signature, as specified in [RFC 8812](https://www.rfc-editor.org/rfc/rfc8812.html). Algorithm, explicit type and audience checks follow [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html). This is a DKG request-proof profile, not a generic session JWT or DPoP implementation.

The protected header contains exactly `alg: "ES256K"`, `typ: "dkg-agent-http+jwt"` and a public `jwk` with `kty: "EC"`, `crv: "secp256k1"` and 32-byte base64url `x`/`y` coordinates. Remote key URLs, private-key fields and algorithm negotiation are rejected.

| Claim | Meaning |
| --- | --- |
| `iss` | Agent wallet address; must match the address derived from the verified public key. |
| `aud` | Receiving node's physical peer ID, checked against local state rather than the HTTP Host header. |
| `iat`, `exp` | Integer Unix seconds; at most 60 seconds validity and 5 seconds allowed issuance clock skew; expiration is not extended. |
| `jti` | Fresh 16–32-byte random lowercase hex nonce. |
| `method`, `path` | Exact uppercase HTTP method and origin-form target including query order and percent encoding. |
| `contentType` | Exact Content-Type value, or empty string when absent. |
| `bodySha256` | Lowercase SHA-256 of the exact request bytes, including whitespace. |

The body is bounded to 10 MiB and 30 seconds before routing; endpoint-specific limits still apply. Compressed request bodies are rejected. Live nonces are retained in the daemon's SQLite database across restarts; concurrent replay fails atomically. Expired records may be removed, but live records are never evicted to admit new requests. Store unavailability/capacity exhaustion returns 503 and fails closed.

Authentication failures return 401 with `AGENT_HTTP_SIGNATURE_INVALID`, `AGENT_HTTP_TARGET_MISMATCH`, `AGENT_HTTP_EXPIRED`, `AGENT_HTTP_REQUEST_MISMATCH` or `AGENT_HTTP_REPLAY`. Retry with fresh request authentication, not the same JWT. Authorization failures remain governed by each route and graph policy.

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
