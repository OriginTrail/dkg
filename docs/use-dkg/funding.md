---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Funding

Working Memory, Shared Working Memory, querying, local imports, discovery, and direct messages do not require on-chain funds.

Verifiable Memory publishing, updates, endorsement, verification, and other chain operations require gas and TRAC.

Your node's network is chosen at setup (default: **mainnet-gnosis**) and persisted as `config.networkConfig`; pass `--network <name>` to pick another (`mainnet-base`, `testnet`).

Async publisher wallets also need native gas, plus PCA agent registration or TRAC for direct spend. Publisher wallet identity is optional attribution, not a funding prerequisite. See [Async Publisher Wallets](async-publisher-wallets.md).

**On mainnet (gnosis / base) there is no faucet** — fund the node's operational wallets yourself with the chain's native gas token (xDAI on Gnosis, ETH on Base) and TRAC before publishing.

**On testnet**, setup flows auto-fund the generated wallets when a faucet is configured (the bundled testnet config provides one); this is skipped automatically on mainnet:

* `dkg init` — auto-funds on testnet when the faucet is reachable; has no `--no-fund` flag
* `dkg mcp setup`
* `dkg hermes setup`
* `dkg openclaw setup`

Core Node profile registration also needs funded node wallets. A fresh Core wallet file has one admin wallet plus operational wallets. The primary operational wallet needs the native gas token and enough TRAC for the initial V10 staking conviction; the admin wallet should have native gas for profile key-management and operational-wallet registration. See [Daemon Lifecycle](run-node.md#core-node-profile-registration) for the full Core checklist.

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
