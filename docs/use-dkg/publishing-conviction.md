---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Publishing Conviction

Publishing Conviction Accounts let a publisher commit TRAC, register publishing agents, and use the account as the publish authority for curated Context Graph flows.

Use this page for the current CLI/API surface. For the economics model, see [Conviction & Economics](../how-dkg-works/conviction-and-economics.md).

## Create a PCA

```bash
dkg pca create --tokens 100000 --primary-node <identityId>
```

The daemon EOA becomes the owner of the PCA NFT. Owner-gated write operations must be run from the node whose EOA owns that NFT.

## Register a Publishing Agent

```bash
dkg pca register-agent <accountId> <agentAddress>
```

The agent address must be a valid non-zero EVM address. Register the transaction-signing wallet address that will publish with the PCA. The daemon verifies registration with an on-chain read after the transaction lands when the adapter supports it.

The agent wallet still needs native gas, but it does not need an on-chain node identity. Node identity is only publisher-node attribution; PCA payment eligibility comes from PCA agent registration.

## Deregister a Publishing Agent

```bash
dkg pca deregister-agent <accountId> <agentAddress>
```

This is owner-gated on-chain.

## Add Funds

```bash
dkg pca funds <accountId> --tokens 50000
```

The CLI asks the daemon to approve token spend automatically before submitting the top-up transaction.

## Settle

```bash
dkg pca settle <accountId>
```

Settlement is permissionless. It runs the lazy-settlement sweep for the account.

## Inspect

```bash
dkg pca info <accountId>
dkg pca info <accountId> --probe-key <agentAddress>
```

The read-only snapshot includes owner, committed TRAC, top-up buffer, base epoch allowance, creation and expiry epochs, agent count, settlement window, and discount basis points.

## Use PCA With a Curated Context Graph

Attach a PCA to curated Context Graph registration with `--pca-account-id`:

```bash
dkg context-graph register <contextGraphId> --publish-policy 0 --pca-account-id <accountId>
```

`pcaAccountId` is valid only for curated publish policy. The registration transaction signer may be either the PCA owner or a wallet currently registered to that exact PCA. The daemon verifies the exact account binding and requires the local curator to match the signer, because that signer receives the Context Graph NFT. The PCA owner remains the live publish authority.

When the PCA is active, meets the governance commitment floor, and still has quota, registration consumes one quota-backed waiver instead of pulling the separate liquid-TRAC registration deposit. The signer still needs native gas. Waiver quota is `committedTRAC / contextGraphRegistrationDeposit`; using a slot does not debit or unlock the PCA's committed TRAC.

The same flow is available through `POST /api/context-graph/register` with `publishPolicy: 0` and `pcaAccountId`, and through MCP with `dkg_context_graph_register`.

### Publishing into a PCA-curated graph requires membership (ContextGraphs 10.1.0)

ContextGraphs 10.1.0, proposed and not deployed on any network yet, separates who pays from whose Knowledge Asset it is:

- A wallet registered on the graph's PCA (or the PCA owner) may still send, and pay through the PCA for, a publish into the graph.
- The publish's attested author must be a member of the graph: on its participant roster, or the holder of the graph's NFT. Being registered on the PCA, or owning it, does not make an author a member.

A publish whose author is not a member is refused before ACK collection with HTTP 403 and code `AUTHOR_NOT_CONTEXT_GRAPH_MEMBER`, or on chain with `AuthorNotContextGraphMember`. The graph's owner or curator can add the author as a participant agent.

### Members send and pay for their own publishes (ContextGraphs 10.2.0)

ContextGraphs 10.2.0, proposed on top of 10.1.0 and not deployed on any network yet, also lets every member of a curated graph send its own publish, without being the curator or a PCA agent.

- **The member pays with its own TRAC, not with the PCA's allowance.** Payment follows the sending wallet: a wallet that is not registered as an agent of a PCA pays the full publish price from its own balance, so it needs TRAC and an allowance for `KnowledgeAssetsLifecycle`, as for a publish into an open graph. The graph's PCA pays only when one of its own agents sends.
- **The curator, the PCA owner and the PCA's agents send as before.** Their sender check reads nothing new; it costs about 220 gas more than under 10.1.0.
- **A node picks from more wallets.** The node offers a curated publish to every wallet of its signer pool that the graph accepts as a sender. A wallet on the graph's roster that holds TRAC can now be picked and pay the full price, where only the PCA's agents could before.

## API Routes

| Route                                | Purpose              |
| ------------------------------------ | -------------------- |
| `POST /api/pca`                      | Create a PCA.        |
| `POST /api/pca/:id/agent`            | Register an agent.   |
| `DELETE /api/pca/:id/agent/:address` | Deregister an agent. |
| `POST /api/pca/:id/funds`            | Top up funds.        |
| `POST /api/pca/:id/settle`           | Run settlement.      |
| `GET /api/pca/:id`                   | Read account info.   |

These routes require a configured chain adapter with V10 PCA support. Nodes without that surface return feature-unavailable responses instead of pretending the account does not exist.
