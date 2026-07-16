---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Bridging TRAC

TRAC is an ERC-20 token that originates on Ethereum. To use it on a DKG network — for funding nodes, staking, or publishing — you bridge it to that network. The TRAC token address on each chain is on the [Contract addresses](contract-addresses.md) page.

## Base

Bridge TRAC from Ethereum to Base with [Superbridge](https://superbridge.app/base) (or any other Base bridge). See the [Base documentation](https://docs.base.org/) for more on bridging.

## Gnosis

Bridge TRAC from Ethereum to Gnosis with the [official Gnosis bridge](https://bridge.gnosischain.com/) or [OmniBridge](https://omnibridge.gnosischain.com/bridge).

## NeuroWeb

NeuroWeb is a permissionless, EVM-enabled Polkadot parachain; its native token is **NEURO** (used for gas). It evolved from the original OriginTrail Parachain via a December 2023 community governance vote. Dedicated docs live at [docs.neuroweb.ai](https://docs.neuroweb.ai/).

Bridge TRAC between Ethereum and NeuroWeb via [Snowbridge](https://app.snowbridge.network/). Step-by-step instructions are in the [NeuroWeb documentation](https://docs.neuroweb.ai/ethereum-neuroweb-trac-bridge).

### Adding TRAC on NeuroWeb to your wallet

The TRAC token address is the same on NeuroWeb mainnet and testnet:

```
0xFfFFFFff00000000000000000000000000000001
```

In MetaMask (connected to NeuroWeb): open **Assets → Import tokens** → paste the address above (the other fields auto-populate) → **Add custom token**. Your TRAC balance will then display.
