---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# External Signer

A node can delegate EVM signing to an external signer (for example an HSM-backed signer or a separate signing service), so that the node holds no operational private keys. The node still does all of the protocol work: it builds every transaction, populates the nonce, gas limit and fees from its own RPC endpoints, asks the signer for a signature, checks the answer, records the signed bytes in its write-ahead log and broadcasts them itself. The signer only signs.

External signing is supported for **edge nodes**. It is off by default; without the `chain.signer` block below nothing changes.

## Configuration

Add a `signer` block to `chain` in `~/.dkg/config.json`:

```json
{
  "nodeRole": "edge",
  "chain": {
    "signer": {
      "type": "remote",
      "socketPath": "/run/signer/signer.sock",
      "authTokenFile": "/etc/dkg/signer.token",
      "author": { "authTokenFile": "/etc/dkg/signer-author.token" }
    }
  }
}
```

Only the static parts are required: `type`, one of `url` or `socketPath`, and usually a credential. The node learns its accounts from the signer at startup (`eth_accounts`); it does not need a per-node address list.

| Field | Meaning |
| --- | --- |
| `type` | `"remote"` to use an external signer. `"local"` (or no `signer` block) keeps the operational keys in `wallets.json`. |
| `url` | `http://` or `https://` URL of the signer's JSON-RPC endpoint. Credentials in the URL are rejected; use a token. For a private CA, set `NODE_EXTRA_CA_CERTS`. |
| `socketPath` | Unix domain socket on which the signer serves HTTP. Requests are `POST /`. Use instead of `url`. |
| `authTokenFile` | File holding a bearer token, sent as `Authorization: Bearer <token>`. Keep it readable by the node's user only; the node warns otherwise. |
| `authTokenEnv` | Name of an environment variable holding the token, instead of `authTokenFile`. |
| `api` | JSON-RPC dialect: `"eth"` (default) or `"clef"`. See [JSON-RPC methods](#json-rpc-methods). |
| `addresses` | Optional. Use only these payer accounts, in this order; each must be served by the signer. |
| `timeoutMs` | Optional per-request deadline in milliseconds (default `30000`). |
| `author` | Optional. Where the author keys come from; see below. |

When the node starts with an external signer it:

- does not create or read `wallets.json`, and holds no operational or admin key;
- logs the signer endpoint (host only) and the accounts it will use;
- fails to start, with a specific message, if the signer cannot be reached, a configured address is not served, the block is invalid, or the configuration cannot be served (see [Not supported](#not-supported)).

`dkg wallet` lists the signer's payer accounts with their balances, and its author accounts.

## Payers and authors

A knowledge asset is minted to the author named in its EIP-712 author attestation, not to the account that sends the transaction, and only that owner can attest an update. The node therefore keeps two kinds of keys apart. Both can live in the external signer.

- **Payers** are the operational accounts. They sign token approvals and publish/update transactions and pay for them. They are the accounts of the main signer connection (narrowed by `addresses`). With several payers, publishes run in parallel, each account with its own nonce lane.
- **Authors** own published assets. They only sign author attestations (EIP-712 typed data) and never pay for a transaction. Each agent can have its own author key.

A payer account is never used as an author, and an author account is never used as a payer.

Author keys come from the `author` block:

| `author` | Author accounts | Default author |
| --- | --- | --- |
| `{ "authTokenFile": "…" }` (or `authTokenEnv`, `url`, `socketPath`) | Every account of that connection (missing endpoint fields are taken from the main block). Keys added to the signer later are picked up without a restart. | The connection's only account, or `author.address` when it serves several. |
| `{ "address": "0x…" }` | Just that account of the main connection, which is then not a payer. | That account. |

A signing service that scopes accounts by credential can expose payer keys to one token and author keys to another. A signer without such scoping (for example one Web3Signer instance holding every key) can use `addresses` for the payers and `author.address` for the author, or run the author keys behind a separate endpoint.

Who signs the author attestation:

- A request made with an **agent token** is authored by that agent. If the agent was registered by address (below), its attestation is signed by the external signer with `eth_signTypedData_v4`. A custodial agent, whose key you chose to keep on the node, still signs with that key.
- A request made with the **node or admin token** is authored by the **default author**, through the signer. Without a default author such a publish fails with a clear error; the node never falls back to a payer.
- The node's default agent is the default author, else the signer's first author account. Node-token requests act as it where they need an agent, for example as the curator of the context graphs they create and register, while their publishes are still authored by the default author as above. It is registered by address on first start, like the agents below, so the node holds no key for it; with payer accounts only, the node has no default agent.

### Registering an agent whose key the signer holds

Register the agent with the existing endpoint and the author address instead of a public key. The node asks the signer to sign an `AgentRegistration(address agent, string name)` typed-data statement (domain `DKG Agent Registration`, version `1`), recovers the public key from it and stores the agent as self-sovereign: the node keeps no key for it.

```bash
curl -s -X POST http://127.0.0.1:9200/api/agent/register \
  -H "Authorization: Bearer $(dkg auth show)" \
  -H 'Content-Type: application/json' \
  -d '{"name": "research-agent", "address": "0x…"}'
```

The address must be an author account of the signer; payer accounts are refused. You may also pass the agent's `publicKey` together with `address`; it is then only checked against the address. The response contains the agent token; requests made with it are authored by that agent.

### Funding

Payers need native gas. For the publish cost they need either TRAC or registration as an agent of a Publishing Conviction Account by its owner (for example `dkg pca register-agent <accountId> <address>` on the owning node). Wallet selection treats a payer covered by such an account as funded even when it holds no TRAC; the account then covers the publish (a publish lifetime equal to the account's lock duration). Author accounts need no funds.

### Curated context graphs backed by a Publishing Conviction Account

An agent registered by address can curate a context graph backed by a Publishing Conviction Account: with the agent's token, create the graph and register it with `publishPolicy: 0` and `pcaAccountId` (`POST /api/context-graph/register`). The author key signs no transactions, so the first payer account sends the registration. That payer must be the account's owner or a registered agent of that exact account and receives the Context Graph NFT; the agent stays the graph's curator on the node and is added as a participant agent. Every registered agent of the account is an authorized publisher of the graph, so register each payer that should publish to it. The registration deposit is waived while the account meets the waiver floor and has quota left (see [Publishing Conviction](publishing-conviction.md#use-pca-with-a-curated-context-graph)); otherwise it is pulled from that payer, which then needs TRAC.

## JSON-RPC methods

The node speaks the standard Ethereum JSON-RPC signing API. Addresses are sent in lowercase.

| Purpose | `api: "eth"` (Web3Signer-compatible) | `api: "clef"` (Clef external API) |
| --- | --- | --- |
| List accounts | `eth_accounts` | `account_list` |
| Sign a transaction | `eth_signTransaction` `[tx]`, returns the raw signed transaction | `account_signTransaction` `[tx]`, returns `{ raw, tx }` |
| Sign EIP-712 typed data | `eth_signTypedData_v4` `[address, typedDataJson]`; if the signer answers "method not found" (`-32601`), `eth_signTypedData` with the same parameters | `account_signTypedData` `[address, typedData]` |
| Sign an EIP-191 message | `eth_sign` `[address, hexData]`; on "method not found", `personal_sign` `[hexData, address]` | `account_signData` `["text/plain", address, hexData]` |

Transactions are sent fully populated: `from`, `to`, `gas`, `nonce`, `value`, `data`, `chainId`, and `type: "0x2"` with `maxFeePerGas` and `maxPriorityFeePerGas` (or `gasPrice` on chains without EIP-1559). The signer must sign exactly that transaction and must not change any field or broadcast it.

Payer accounts sign transactions and, for some node-to-node proofs such as authenticated sync requests, EIP-191 messages over 32-byte digests. Author accounts sign typed data: author attestations under the `KnowledgeAssetsLifecycle` domain (version `3.0.0`, the chain id, and the `KnowledgeAssetsLifecycle` contract as verifying contract), with primary type `AuthorAttestation` or `UpdateAuthorAttestation`, and agent registrations as above. When an agent whose key the signer holds shares into a public context graph with a curated publish policy, its author account also signs the shared-memory envelope as an EIP-191 message (`eth_sign`): four length-framed fields (a big-endian uint32 length, then the bytes) holding `share-write`, the context graph id, an ISO-8601 timestamp and the share payload.

## What the node verifies

Every answer is checked before it is used:

- a signed transaction must decode, carry a canonical (low-s) signature, recover to the requested account, be canonically encoded, and be byte-for-byte the transaction that was requested (type, chain id, nonce, gas limit, fees, recipient, value, data, access list);
- a message or typed-data signature must recover to the requested account for the digest the node computes itself. A high-s signature or `v` of `0`/`1` is normalized to the canonical form on-chain verifiers accept.

A failed check is an error (`REMOTE_SIGNER_TRANSACTION_MISMATCH`, `REMOTE_SIGNER_INVALID_SIGNATURE`, …); the answer is discarded.

## Failures and retries

A signing request is sent once. It is never retried, never sent again with a different payload, and a signer failure is never failed over to another RPC endpoint: one prepared transaction is signed at most once. The RPC work around it keeps its usual failover, and publish and update transactions are recorded in the write-ahead log (hash and nonce) before they are broadcast, exactly as with local keys. Each request is bounded by `timeoutMs`. Errors carry a `REMOTE_SIGNER_*` code: `UNAVAILABLE` (connection, socket or TLS failure), `TIMEOUT`, `UNAUTHORIZED` (HTTP 401/403), `REJECTED` (a JSON-RPC error such as a policy refusal), `METHOD_NOT_SUPPORTED`, `HTTP_ERROR`, `BAD_RESPONSE`, `ADDRESS_NOT_AVAILABLE`, `TRANSACTION_NOT_SIGNABLE` (an unpopulated transaction was handed to the signer), `CONFIG`, plus the verification codes above. The operation that hit the error fails; publishing again later starts a new transaction.

## Security notes

- The node never sees a private key. Treat the signer as the place where policy is enforced: allow only the expected chain id; for transactions, only the contracts your node uses (at least the TRAC token, for approvals with the `KnowledgeAssetsLifecycle` contract as spender, and `KnowledgeAssetsLifecycle` for publish and update; context graph and Publishing Conviction Account management add `ContextGraphs` and `DKGPublishingConvictionNFT`; resolve current addresses from the Hub); for typed data, only the domains above. Rate limits and value caps belong there too.
- Give payer and author keys separate credentials when the signer supports it, so that an author key cannot be used to pay and a payer key cannot author.
- Protect the credential (file mode `600`, or a secret store feeding `authTokenEnv`) and, for a unix socket, the socket's permissions. The token is never logged and is removed from any error text the signer returns.
- The signer must be sign-only. A signer that broadcasts what it signs (for example through `eth_sendTransaction`) is not needed and should be disabled for the node's accounts.

## Not supported

With `chain.signer.type: "remote"` the node refuses, before creating any key:

- `nodeRole: "core"`. A core node signs StorageACKs, VERIFY approvals and profile operations with local keys.
- `publisher.enabled: true`. The async publisher runtime signs with the keys in `publisher-wallets.json`.
- `chain.type: "mock"`.

Operations that need a key the node does not hold fail with a specific error: admin-key operations such as registering or removing operational wallets or creating a profile (`AdminKeyNotConfigured`; perform them with the admin key outside the node), `dkg set-ask`, and raw-key accessors in the SDK (`OperationalKeyUnavailableError`). The node does not answer VERIFY proposals.

Publishing to a curated (private) context graph additionally needs an agent whose key is on the node, for the shared-memory sender keys that protect private content; public context graphs need none.
