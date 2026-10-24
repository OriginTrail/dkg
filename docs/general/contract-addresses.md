---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Contract addresses

{% hint style="info" %}
DKG V10 is live on **Base and Gnosis mainnet** and on **Base Sepolia testnet**. NeuroWeb mainnet is not yet selectable. The checked-in [`network/*.json`](https://github.com/OriginTrail/dkg/tree/main/network) files are the source of truth for network availability and active Hub addresses.
{% endhint %}

## TRAC token

TRAC is the ERC-20 utility token used across the DKG. The token contract address is different on each chain — use the one for the network your node operates on.

On **mainnet**, TRAC is the original token contract (unchanged from V8). On the active V10 testnet (**Base Sepolia**), V10 uses a freshly redeployed test-TRAC contract (different from the V8 one).

### Mainnet

| Network | TRAC token address |
| --- | --- |
| Base | `0xa81a52b4dda010896cdd386c7fbdc5cdc835ba23` |
| Gnosis | `0xEddd81E0792E764501AaE206EB432399a0268DB5` |

### Testnet

| Network | TRAC token address |
| --- | --- |
| Base Sepolia | `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8` |

{% hint style="info" %}
The test-TRAC faucet currently serves **Base Sepolia** only — that is the active V10 testnet. See the [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) for canonical deployed-network addresses.
{% endhint %}

## DKG smart contracts

The full set of DKG V10 contract deployments (Hub, Staking, Conviction, Random Sampling, ParametersStorage, …) lives in [`packages/evm-module/deployments`](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) — one file per deployed network, listing contract addresses and versions.

The **Hub** is the entry point — it resolves the addresses of every other V10 contract on a given network, so in most cases the Hub address is all you need. Note that V10 Hub addresses are **new** (they differ from V8 on every network, including mainnet).

| Network | V10 Hub address |
| --- | --- |
| Base (mainnet) | `0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13` |
| Gnosis (mainnet) | `0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f` |
| Base Sepolia (testnet) | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` |

{% hint style="info" %}
Use the matching checked-in [network configuration](https://github.com/OriginTrail/dkg/tree/main/network) for node setup. The [deployments folder](https://github.com/OriginTrail/dkg/tree/main/packages/evm-module/deployments) contains the complete contract set for deployed networks.
{% endhint %}
