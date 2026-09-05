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

The `--pca-account-id` option selects the PCA that authorizes publishing to a curated Context Graph. It does not by itself guarantee a registration-deposit waiver: registration has separate eligibility and quota checks described below. If they fail, the registering wallet pays the normal liquid-TRAC deposit as well as native gas.

Attach a PCA to curated Context Graph registration with `--pca-account-id`:

```bash
dkg context-graph register <contextGraphId> --publish-policy 0 --pca-account-id <accountId>
```

`pcaAccountId` is valid only for curated publish policy. The registration transaction signer may be either the PCA owner or a wallet currently registered to that exact PCA. The daemon verifies the exact account binding and requires the local curator to match the signer, because that signer receives the Context Graph NFT. The PCA owner remains the live publish authority.

When the PCA is active, meets the governance commitment floor, and still has quota, registration consumes one quota-backed waiver instead of pulling the separate liquid-TRAC registration deposit. The signer still needs native gas. Waiver quota is `committedTRAC / contextGraphRegistrationDeposit`; using a slot does not debit or unlock the PCA's committed TRAC.

The same flow is available through `POST /api/context-graph/register` with `publishPolicy: 0` and `pcaAccountId`, and through MCP with `dkg_context_graph_register`.

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
