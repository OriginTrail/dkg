---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# Networks & RPCs

OriginTrail DKG V10 runs across multiple EVM-compatible chains. Pick the network you want your node to operate on and use the matching RPC URL, chain ID, and block explorer below.

{% hint style="info" %}
DKG V10 is live on mainnet. A freshly set-up node defaults to **Gnosis mainnet** (`mainnet-gnosis`); choose another network at setup with the `dkg init` network prompt or `--network <name>` (`mainnet-base`, `testnet`). NeuroWeb mainnet is not yet selectable. See the [V10 Mainnet Release Timeline](../origintrail-v9-v10/v10-mainnet-release-timeline.md).
{% endhint %}

## DKG Mainnet

| Network | RPC URL | Chain ID | Gas token | Block explorer |
| --- | --- | --- | --- | --- |
| Base | `https://mainnet.base.org` | 8453 | ETH | https://basescan.org |
| Gnosis | `https://rpc.gnosischain.com` | 100 | xDAI | https://gnosisscan.io |
| NeuroWeb | `https://astrosat-parachain-rpc.origin-trail.network/` | 2043 | NEURO | https://neuroweb.subscan.io/ |

## DKG Testnet

| Network | RPC URL | Chain ID | Gas token | Block explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | `https://sepolia.base.org` | 84532 | ETH | https://sepolia.basescan.org |
| Gnosis Chiado | `https://rpc.chiadochain.net` | 10200 | xDAI | https://blockscout.chiadochain.net |
| NeuroWeb Testnet | `https://lofar-testnet.origin-trail.network` | 20430 | NEURO | https://neuroweb-testnet.subscan.io/ |

{% hint style="warning" %}
Public RPCs rate-limit and can silently stall publishing. For anything beyond quick testing, use a dedicated RPC endpoint (e.g. Infura, Alchemy, or your own node).
{% endhint %}

{% hint style="info" %}
To try the DKG on testnet you'll need test TRAC and native gas tokens — see [Funding](../use-dkg/funding.md). To run a local network for development, see the [Quickstart](../getting-started/quickstart.md).
{% endhint %}
