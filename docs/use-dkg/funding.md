---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Funding

Working Memory, Shared Working Memory, querying, local imports, discovery, and direct messages do not require on-chain funds.

Verifiable Memory publishing, updates, endorsement, verification, and other chain operations require gas and TRAC.

Setup flows try to fund generated testnet wallets when a faucet is configured:

* `dkg init` — auto-funds when a faucet is reachable; has no `--no-fund` flag
* `dkg mcp setup`
* `dkg hermes setup`
* `dkg openclaw setup`

Skip funding on the `setup` commands with:

```bash
--no-fund
```

Check balances:

```bash
dkg wallet
dkg status
```

Faucet failures should not block local memory or P2P validation. They block only operations that need on-chain finality.
