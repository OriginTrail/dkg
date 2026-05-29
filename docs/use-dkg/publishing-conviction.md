---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Publishing Conviction

Publishing Conviction Accounts let a publisher commit TRAC, register publishing agents, and use the account as the publish authority for curated Context Graph flows.

Use this page for the current CLI/API surface. For the economics model, see [Conviction and Economics](../how-dkg-works/conviction-and-economics.md).

## Create a PCA

```bash
dkg pca create --tokens 100000
```

The daemon EOA becomes the owner of the PCA NFT. Owner-gated write operations must be run from the node whose EOA owns that NFT.

## Register a Publishing Agent

```bash
dkg pca register-agent <accountId> <agentAddress>
```

The agent address must be a valid non-zero EVM address. The daemon verifies registration with an on-chain read after the transaction lands when the adapter supports it.

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

`pcaAccountId` is valid only for curated publish policy. The daemon checks that the local curator matches the PCA owner before registering the Context Graph with the PCA.

## API Routes

| Route | Purpose |
| --- | --- |
| `POST /api/pca` | Create a PCA. |
| `POST /api/pca/:id/agent` | Register an agent. |
| `DELETE /api/pca/:id/agent/:address` | Deregister an agent. |
| `POST /api/pca/:id/funds` | Top up funds. |
| `POST /api/pca/:id/settle` | Run settlement. |
| `GET /api/pca/:id` | Read account info. |

These routes require a configured chain adapter with V10 PCA support. Nodes without that surface return feature-unavailable responses instead of pretending the account does not exist.
