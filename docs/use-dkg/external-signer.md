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
- **Authors** own published assets and are the node's agents. They sign author attestations (EIP-712 typed data) and the messages an agent signs (see [What each account signs](#what-each-account-signs)), and never pay for a transaction. Each agent can have its own author key.

A payer account is never used as an author, and an author account is never used as a payer.

Author keys come from the `author` block:

| `author` | Author accounts | Default author |
| --- | --- | --- |
| `{ "authTokenFile": "…" }` (or `authTokenEnv`, `url`, `socketPath`) | Every account of that connection (missing endpoint fields are taken from the main block). Keys added to the signer later are picked up without a restart. | The connection's only account, or `author.address` when it serves several. |
| `{ "address": "0x…" }` | Just that account of the main connection, which is then not a payer. | That account. |

A signing service that scopes accounts by credential can expose payer keys to one token and author keys to another. A signer without such scoping (for example one Web3Signer instance holding every key) can use `addresses` for the payers and `author.address` for the author, or run the author keys behind a separate endpoint.

Who signs the author attestation:

- A request made with an **agent token** is authored by that agent. If the agent was registered by address (below), its attestation is signed by the external signer with `eth_signTypedData_v4`. A custodial agent, whose key you chose to keep on the node, still signs with that key; if you move that key into the signer as an author key and remove it from the node's agent keystore, the agent keeps its token and signs through the signer.
- A request made with the **node or admin token** is authored by the **default author**, through the signer. Without a default author such a publish fails with a clear error; the node never falls back to a payer.
- The node's default agent is the default author, else the signer's first author account. Node-token requests act as it where they need an agent, for example as the curator of the context graphs they create and register, while their publishes are still authored by the default author as above. It is registered by address on first start, like the agents below, so the node holds no key for it; with payer accounts only, the node has no default agent. When the default author changes, or a node that signed with a local wallet moves to the signer, the node makes the default author its default agent on the next start, so the drafts it opens with the node token belong to the author that publishes them. The previous default agent stays registered, and its drafts and assets keep their author.

### Registering an agent whose key the signer holds

Register the agent with the existing endpoint and the author address instead of a public key. The node asks the signer to sign an `AgentRegistration(address agent, string name)` typed-data statement (domain `DKG Agent Registration`, version `1`), recovers the public key from it and stores the agent as self-sovereign: the node keeps no key for it.

```bash
curl -s -X POST http://127.0.0.1:9200/api/agent/register \
  -H "Authorization: Bearer $(dkg auth show)" \
  -H 'Content-Type: application/json' \
  -d '{"name": "research-agent", "address": "0x…"}'
```

The address must be an author account of the signer; payer accounts are refused. You may also pass the agent's `publicKey` together with `address`; it is then only checked against the address. The response contains the agent token; requests made with it are authored by that agent.

The node also gives the agent a workspace encryption key for [private context graphs](#private-context-graphs): it generates the key and keeps it, and the signer signs the proof that binds it to the agent. A signer that refuses that proof leaves the agent registered without a key, which only keeps it out of private context graphs (the node logs a warning). Agents registered by address before this existed get their key the next time the node starts.

### Funding

Payers need native gas. For the publish cost they need either TRAC or registration as an agent of a Publishing Conviction Account by its owner (for example `dkg pca register-agent <accountId> <address>` on the owning node). Wallet selection treats a payer covered by such an account as funded even when it holds no TRAC; the account then covers the publish (a publish lifetime equal to the account's lock duration). Author accounts need no funds.

### Curated context graphs backed by a Publishing Conviction Account

An agent registered by address can curate a context graph backed by a Publishing Conviction Account: with the agent's token, create the graph and register it with `publishPolicy: 0` and `pcaAccountId` (`POST /api/context-graph/register`). The author key signs no transactions, so the first payer account sends the registration. That payer must be the account's owner or a registered agent of that exact account and receives the Context Graph NFT; the agent stays the graph's curator on the node and is added as a participant agent. Every registered agent of the account is an authorized publisher of the graph, so register each payer that should publish to it. The registration deposit is waived while the account meets the waiver floor and has quota left (see [Publishing Conviction](publishing-conviction.md#use-pca-with-a-curated-context-graph)); otherwise it is pulled from that payer, which then needs TRAC.

## JSON-RPC methods

The node speaks the standard Ethereum JSON-RPC signing API. With `api: "eth"` addresses are sent in lowercase; with `api: "clef"` they are sent EIP-55 checksummed, because Clef warns about a transaction recipient without a valid checksum. Outside its advanced mode (`--advanced`) Clef refuses every transaction it warns about, including one whose call data names a method its signature database does not know, so run it in advanced mode: the warnings then go to its rules or approver instead.

| Purpose | `api: "eth"` (Web3Signer-compatible) | `api: "clef"` (Clef external API) |
| --- | --- | --- |
| List accounts | `eth_accounts` | `account_list` |
| Sign a transaction | `eth_signTransaction` `[tx]`, returns the raw signed transaction | `account_signTransaction` `[tx]`, returns `{ raw, tx }` |
| Sign EIP-712 typed data | `eth_signTypedData_v4` `[address, typedDataJson]` (the typed data as a JSON string); if the signer answers "method not found" (`-32601`), `eth_signTypedData` `[address, typedData]` (the typed data as an object) | `account_signTypedData` `[address, typedData]` |
| Sign an EIP-191 message | `eth_sign` `[address, hexData]`; on "method not found", `personal_sign` `[hexData, address]` | `account_signData` `["text/plain", address, hexData]` |
| Sign an authenticated sync request (optional) | `dkg_signSyncRequest` `[address, request]`, returns the EIP-191 signature over the request digest; see [Authenticated sync requests](#authenticated-sync-requests) | the same method; Clef answers "method not found" |
| Sign an RFC-64 control object (optional) | `dkg_signControlObject` `[address, { domain, envelope }]`, returns the EIP-191 signature over the object digest; see [RFC-64 control objects](#rfc-64-control-objects) | the same method; Clef answers "method not found" |

Transactions are sent fully populated: `from`, `to`, `gas`, `nonce`, `value`, `data`, `chainId`, and `type: "0x2"` with `maxFeePerGas` and `maxPriorityFeePerGas` (or `gasPrice` on chains without EIP-1559). The signer must sign exactly that transaction and must not change any field or broadcast it.

### Messages the signer can check before it signs

An EIP-191 message the node asks for is either a self-describing payload of length-framed fields (each a big-endian uint32 length, then the bytes; the first fields name what it is), or a 32-byte digest of structured data. For a digest, the node first calls a method that takes the structured data (`dkg_signSyncRequest` for sync requests, `dkg_signControlObject` for RFC-64 control objects), from which the signer recomputes the digest and checks every field. Only a signer that answers "method not found" (`-32601`) is then asked for the digest itself with `eth_sign` (or `personal_sign`, or Clef's `account_signData`), and the node does not offer that method on the connection again. Any other answer to it, a refusal included, is final. A signer that does not sign bare digests can therefore implement the methods and refuse `eth_sign` over 32 bytes; the few features that still ask for a bare digest are listed under [Not supported](#not-supported).

### What each account signs

| Account | What | How |
| --- | --- | --- |
| Payer | Token approvals, publish and update transactions, context graph and Publishing Conviction Account management | `eth_signTransaction` |
| Payer, when it is an operational key of the node's on-chain identity | [Authenticated sync requests](#authenticated-sync-requests) made as the node identity | `dkg_signSyncRequest` (fallback `eth_sign` over the 32-byte digest) |
| Author | Author attestations under the `KnowledgeAssetsLifecycle` domain (version `3.0.0`, the chain id, the `KnowledgeAssetsLifecycle` contract as verifying contract), primary type `AuthorAttestation` or `UpdateAuthorAttestation` | `eth_signTypedData_v4` |
| Author | Its registration: `AgentRegistration(address agent, string name)`, domain `DKG Agent Registration`, version `1` | `eth_signTypedData_v4` |
| Author | [Authenticated sync requests](#authenticated-sync-requests) made on behalf of the agent: catch-up of a graph, member recovery, reads of imported artifacts | `dkg_signSyncRequest` (fallback `eth_sign` over the 32-byte digest) |
| Author | The shared-memory envelope of a share, by the sharing agent into a graph whose writes are agent-gated (a curated publish policy, or a private graph), and by the node's default agent into an open graph, which has no signing roster: four framed fields `share-write`, the context graph id, an ISO-8601 timestamp, the share payload | `eth_sign` over the framed payload |
| Author | The proof binding its workspace encryption key (once per agent): framed fields `domain`, `dkg.workspace.agent-encryption-key-proof.v1`, `agentAddress`, the address in lowercase, `encryptionKeyAlgorithm`, `X25519`, `publicEncryptionKey`, the 32 key bytes (214 bytes in all) | `eth_sign` over the framed payload |
| Author | [RFC-64 control objects](#rfc-64-control-objects) it issues where RFC-64 catalog authority is active: the inventory of its shared assets and its author catalog in a graph in catalog mode, and the policy seed of its wallet-namespaced, unregistered public graph | `dkg_signControlObject` (fallback `eth_sign` over the 32-byte digest) |
| Author | The sender-key setup package for each member of a private graph it shares into: framed fields `domain`, `dkg.swm.sender-key.setup-aad.v1`, then name/value pairs `version`, `type` (`swm.sender-key.package`), `contextGraphId`, `subGraphName`, `senderAgentAddress`, `epochId`, `membershipHash`, `recipientAgentAddress`, `recipientKeyId`, `createdAtMs`, `initialMessageIndex`, `senderSigningPublicKey`, `keyAgreementAlgorithm`, `ephemeralPublicKey`, `nonce`, `ciphertext` (about 0.9 KB) | `eth_sign` over the framed payload |

A payer account never signs an author's message. A signer can check every framed field it understands: the domain, that the agent address or sender is the signing account, the context graph, the recipient and the epoch. The ciphertext, ephemeral key and nonce of a setup package are opaque by construction (they wrap the epoch's chain key for one recipient).

## Authenticated sync requests

A node asks peers for the pages of a context graph with sync requests. A request for a graph that is private, or whose metadata the node has not yet confirmed (the first catch-up of every graph, the system graphs `agents` and `ontology` included), carries an EIP-191 signature over a 32-byte request digest:

- by the agent the request is made for (the node's default agent, or the local agent the graph allowlists) when the node has no on-chain identity, which is the usual case for an edge node: with an external signer, its author key;
- by the node's primary payer when the node has an on-chain identity whose operational key that payer is.

Receivers verify it as they always have: the responder recomputes the digest from the request, recovers the signer, checks that the request is fresh (at most 90 s old, at most 5 s ahead), not replayed, and bound to the two peers on the connection, and then, for a private graph only, that the recovered agent is on the graph's agent allowlist (or holds a delegation), or that the recovered key is an operational key of the claimed identity and that identity participates. Requests for public graphs are served without checking the signature. The request and its digest are unchanged; only who signs differs, so released nodes accept these requests.

The node asks the signer with `dkg_signSyncRequest` `[address, request]`, where `request` is a JSON object with exactly these members:

| Member | Type | Value |
| --- | --- | --- |
| `contextGraphId` | string | The graph requested, as the node names it (`agents`, `ontology`, or a context graph id). |
| `offset` | integer ≥ 0 | First row of the page. |
| `limit` | integer, 1 to 500 | Rows per page as signed. A responder that supports byte-budgeted pages may return up to 8,192 rows on an unsigned hint. |
| `includeSharedMemory` | boolean | `true` for shared memory, `false` for durable data. |
| `targetPeerId` | string | libp2p peer ID (base58) of the node asked. |
| `requesterPeerId` | string | libp2p peer ID of the requesting node. |
| `requestId` | string | `0x` and 24 lowercase hex digits: 12 random bytes, new for every request. |
| `issuedAtMs` | integer | Time of the request, in milliseconds since the Unix epoch. |
| `requesterAgentAddress` | string | The agent the request is made for, `0x` and 40 lowercase hex digits. It is the signing account for an author key; for a payer it is an agent the node hosts, or empty when the request names none. |
| `authPurpose`, `authSelector` | strings | Present together, only on reads of imported artifacts: `imported-artifact:v1`, and `imported-artifact:v1:0x` with 64 hex digits (a keccak-256 commitment to the graph, assertion, artifact kind, content hash and byte range read). |

The digest is `keccak256(abi.encodePacked(contextGraphId, offset, limit, includeSharedMemory, targetPeerId, requesterPeerId, requestId, issuedAtMs, requesterAgentAddress[, authPurpose, authSelector]))` with the Solidity types `string, uint256, uint256, bool, string, string, string, uint256, string[, string, string]`. The answer is the 65-byte EIP-191 signature over the 32 digest bytes, `keccak256("\x19Ethereum Signed Message:\n32" ‖ digest)`, exactly what `eth_sign` over the digest returns; the node checks that it recovers to the account.

A signer that implements the method should, before it signs:

- for an author account, require `requesterAgentAddress` to be that account;
- require every member above with its type and form, and no other member;
- require `issuedAtMs` to be close to its own clock, and `requesterPeerId` to be the node's peer ID if it knows it;
- apply its own policy to `contextGraphId` and `targetPeerId`;
- compute the digest itself, from the members.

Recomputing the digest alone is not enough: the strings are packed without length prefixes, so moving bytes across a boundary between two adjacent strings (for example from `targetPeerId` into `requesterPeerId`) leaves the digest unchanged. Checking the form of each member (peer IDs that decode as libp2p peer IDs, the fixed-length `requestId`, a lowercase address) is what fixes those boundaries.

Volume: one request per page fetched with authentication, that is, for each graph and each phase (metadata, data, and for shared memory its metadata and data), one per page with rows plus one for the final empty page; for each peer synced from. A private graph is signed for on every sync pass; a public or system graph only until the node has synced it and confirmed its metadata. A request is about 0.5 KB. Catching up the `ontology` graph of a small network (40 triples) took three requests, a public graph with one knowledge asset four, the `agents` graph two.

## RFC-64 control objects

In a context graph in catalog mode, an author also issues signed control objects about what it shared and published: after a share, the inventory of its shared assets (`SwmAuthorInventoryHeadV1`), and from it and from its publications its author catalog (`AuthorCatalogHeadV1`, `AuthorCatalogBucketV1`, `AuthorCatalogDirectoryNodeV1`, and once per catalog `AuthorCatalogIssuerDelegationV1`). The owner of a wallet-namespaced, unregistered public graph also signs the graph's policy seed (`ContextGraphPolicyV1`) when it creates the graph. Each is signed with EIP-191 over its 32-byte object digest, and receivers recover the issuer from that digest; nothing about them changes.

The node asks the signer with `dkg_signControlObject` `[address, { domain, envelope }]`: `domain` is `dkg-control-object-v1` followed by a newline (`\n`), and `envelope` is the unsigned object as canonical JSON text (RFC 8785: no whitespace, members sorted), with exactly the members `issuer`, `objectType`, `payload`, `signatureEvidence` and `signatureSuite`. The object digest is `sha256` of the UTF-8 bytes of `domain` followed by those of `envelope`, and the answer is the 65-byte EIP-191 signature over the 32 digest bytes. A signer that implements the method should hash exactly the text it received, and before it signs require:

- `issuer` to be the signing account (in lowercase), `signatureSuite` to be `eip191-personal-sign-digest-v1` and `signatureEvidence` to be `{"kind":"none"}`;
- `objectType` to be one it allows (an author key needs the five author types above, and `ContextGraphPolicyV1` for the policy seed of its own graphs);
- the text to be canonical, so that it has no duplicate members and reads the same to every parser; re-serializing the parsed object must give the same text.

The node sends such a request only while it is producing that object, for the digest of that object; it never asks for a control-object digest on its own. Volume: one share into a graph in catalog mode, and its publication, took ten requests on a small network (inventory heads after the share and after the publication, the catalog's issuer delegation, directory nodes, heads and a bucket), each 0.5 to 1.1 KB of object text. A retried inventory update (a concurrent change of the same inventory) signs its new head again.

## What the node verifies

Every answer is checked before it is used:

- a signed transaction must decode, carry a canonical (low-s) signature, recover to the requested account, be canonically encoded, and be byte-for-byte the transaction that was requested (type, chain id, nonce, gas limit, fees, recipient, value, data, access list);
- a message or typed-data signature must recover to the requested account for the digest the node computes itself. A high-s signature or `v` of `0`/`1` is normalized to the canonical form on-chain verifiers accept.

A failed check is an error (`REMOTE_SIGNER_TRANSACTION_MISMATCH`, `REMOTE_SIGNER_INVALID_SIGNATURE`, …); the answer is discarded.

## Failures and retries

A transaction is prepared first (populated, and its nonce, gas and fees read, with the usual RPC failover and retries) and then signed: the signing request is sent once, after every retry and recovery of the preparation. It is never retried, never sent again with a different payload, and a signer failure is never failed over to another RPC endpoint: one prepared transaction is signed at most once. Publish and update transactions are recorded in the write-ahead log (hash and nonce) before they are broadcast, exactly as with local keys. Each request is bounded by `timeoutMs`. Errors carry a `REMOTE_SIGNER_*` code: `UNAVAILABLE` (connection, socket or TLS failure), `TIMEOUT`, `UNAUTHORIZED` (HTTP 401/403), `REJECTED` (a JSON-RPC error such as a policy refusal), `METHOD_NOT_SUPPORTED`, `HTTP_ERROR`, `BAD_RESPONSE`, `ADDRESS_NOT_AVAILABLE`, `TRANSACTION_NOT_SIGNABLE` (an unpopulated transaction was handed to the signer), `CONFIG`, `FAILED` (any other failure while signing), plus the verification codes above. The operation that hit the error fails; publishing again later starts a new transaction. A failure before the broadcast sends nothing, so a context graph registration the signer refused stays unregistered and can be registered again.

The same holds for a sync request: when the signer fails or refuses to sign one, that page is not retried, and the sync of that graph from that peer ends; the next sync pass (the next connection or catch-up) builds new requests. A page attempt that fails for any other reason is retried, at most three times, each time with a new request (a new `requestId` and `issuedAtMs`) and so a new signature.

## Private context graphs

Shared memory in a private context graph is encrypted, and every member encrypts to every agent the graph allowlists. An agent whose key the signer holds takes part as follows; receivers verify everything as before, since every signature is the one a key on the node would make over the same bytes.

- **Its encryption key.** Members encrypt to an X25519 key that each agent binds to itself with a signature by its own key. For an agent registered by address, the node generates the X25519 key and keeps it in its agent keystore, as it does for an agent whose key it holds; the key only decrypts shared memory addressed to the agent and signs nothing. The signer signs the binding proof (see [What each account signs](#what-each-account-signs)). The node publishes the key with the default agent's profile, which is how other members find it, so the agent that takes part in private graphs is the node's default agent.
- **Catching up and recovering** a private graph are authenticated sync requests signed by the agent.
- **Sharing into** a private graph signs the shared-memory envelope and, once per member key at the start of each sender-key epoch, a setup package for that member. An epoch starts with the agent's first share into a (sub)graph and again whenever the members or their keys change. Each encrypted message is signed with the epoch's own Ed25519 key, which the node generates; it is not an account key.
- **Membership** is by invitation: the curator adds the agent's address to the graph, and the node then catches it up. Asking to join is not supported yet: a join request carries the agent's signatures over two 32-byte digests, the delegation (`dkg.agent-delegation.v2`) and its key bundle (`dkg.join-encryption-keys.v1`), and the node does not ask a signer for a bare digest where it can offer the structured data instead.

## Security notes

- The node never sees a private key. Treat the signer as the place where policy is enforced: allow only the expected chain id; for transactions, only the contracts your node uses (at least the TRAC token, for approvals with the `KnowledgeAssetsLifecycle` contract as spender, and `KnowledgeAssetsLifecycle` for publish and update; context graph and Publishing Conviction Account management add `ContextGraphs` and `DKGPublishingConvictionNFT`; resolve current addresses from the Hub); for typed data, only the domains above. Rate limits and value caps belong there too.
- For EIP-191 messages, allow only the framed payloads listed in [What each account signs](#what-each-account-signs) (check their domain and that the agent or sender they name is the signing account), `dkg_signSyncRequest` and `dkg_signControlObject`. A signer that implements both methods can refuse `eth_sign` over 32 bytes: the only features that would still ask for a bare digest are listed under [Not supported](#not-supported).
- Give payer and author keys separate credentials when the signer supports it, so that an author key cannot be used to pay and a payer key cannot author.
- Protect the credential (file mode `600`, or a secret store feeding `authTokenEnv`) and, for a unix socket, the socket's permissions. The token is never logged and is removed from any error text the signer returns.
- The signer must be sign-only. A signer that broadcasts what it signs (for example through `eth_sendTransaction`) is not needed and should be disabled for the node's accounts.

## Not supported

With `chain.signer.type: "remote"` the node refuses, before creating any key:

- `nodeRole: "core"`. A core node signs StorageACKs, VERIFY approvals and profile operations with local keys.
- `publisher.enabled: true`. The async publisher runtime signs with the keys in `publisher-wallets.json`.
- `chain.type: "mock"`.

Operations that need a key the node does not hold fail with a specific error: admin-key operations such as registering or removing operational wallets or creating a profile (`AdminKeyNotConfigured`; perform them with the admin key outside the node), `dkg set-ask`, and raw-key accessors in the SDK (`OperationalKeyUnavailableError`). The node does not answer VERIFY proposals.

Some signatures are not made through the signer yet, so the features that need them are unavailable to an agent whose key the signer holds:

- asking to join a private context graph (see [Private context graphs](#private-context-graphs));
- the discovery beacon of a private context graph the node curates, which lets cores host the graph's encrypted shared memory before it is registered: skipped, with a warning, when the graph is created for an agent; created without one, the node asks its primary payer to sign the beacon's 32-byte digest;
- catching up a private graph's shared memory from a hosting core with the host catch-up fallback, which needs the member agent's signature over a 32-byte digest: the node asks its primary payer for that digest instead, which a signer that refuses bare digests refuses and a host would not accept from a payer that is not a member.

## Design notes: running without local keys

A node whose payers and authors all live in an external signer should be able to do what an edge node with local keys does. For each signature that needs, this is what is signed, by which key, what receivers verify, and how the node gets it without holding the key. No receiver changes: each signature is the one a local key would make over the same bytes, in an unchanged message, so released core and edge nodes accept it.

1. **Catch-up sync.** Authenticated sync requests carry an EIP-191 signature over a 32-byte digest of the request fields, by the agent the request is made for, or by an operational key of the node's on-chain identity. Responders check freshness, replay, the peer binding and, for private graphs, that the recovered signer is an allowed agent or an operational key of a participating identity. The node asks its signer with `dkg_signSyncRequest`, which carries the fields, and falls back to `eth_sign` over the digest only for a signer without that method. See [Authenticated sync requests](#authenticated-sync-requests).
2. **Private context graphs.** Members encrypt to an X25519 key bound by the agent's EIP-191 signature over a framed proof payload, and verify each sender-key setup package by the sender agent's EIP-191 signature over the package's framed associated data. The X25519 and per-epoch Ed25519 keys are node-local keys, as for any agent; the node keeps them and asks the signer for the two EIP-191 signatures over the full framed payloads (`eth_sign`). Joining by request needs two signatures over bare digests; the smallest design for it is one more structured method in the style of `dkg_signSyncRequest` that carries the delegation (scope, agent, delegatee peer and operational key, validity) and the key bundle it binds, until then membership is by invitation. See [Private context graphs](#private-context-graphs).
3. **RFC-64 control objects.** After a share into a graph in catalog mode, the node records the author's inventory of shared assets in a control object and projects it into the author's catalog; after a publication it updates the catalog; creating a wallet-namespaced, unregistered public graph signs its policy seed. Each control object is signed by the author with EIP-191 over its 32-byte object digest, `sha256("dkg-control-object-v1\n" ‖ canonical JSON of the unsigned object)`, and receivers recover the issuer from that digest. The node asks the signer with `dkg_signControlObject`, which carries the canonical object, and falls back to `eth_sign` over the digest only for a signer without that method; the producers mark the object they are signing, and the node refuses to send a digest that is not the digest of the marked object. See [RFC-64 control objects](#rfc-64-control-objects).
