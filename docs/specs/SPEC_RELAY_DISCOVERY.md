# Relay Auto-Discovery

**Status**: Draft
**Depends on**: [SPEC_CONTEXT_GRAPH_LIFECYCLE.md](./SPEC_CONTEXT_GRAPH_LIFECYCLE.md), [SPEC_TRUST_LAYER.md](../SPEC_TRUST_LAYER.md)

---

## Problem

New nodes currently require the relay multiaddr to be manually configured
in `~/.dkg/config.json` or passed via `testnet.json`. This is fragile:

- If the relay changes IP, PeerId, or port, all nodes need config updates
- New users must copy-paste the relay address from documentation
- There's no fallback if the configured relay is unreachable

## Goal

Nodes should discover relay addresses automatically, with manual config
as an optional override.

## Approaches

### Option A: Network config file (current, improved)

The `testnet.json` (or `mainnet.json`) file already contains a `relay`
field. Nodes fetch this file from the GitHub repo on startup. This works
today but is centralized.

**Improvement**: Add a `relays` array (plural) with multiple relay
addresses. The node tries each in order until one succeeds. The network
config file is versioned and cached locally.

```json
{
  "relays": [
    "/ip4/167.71.33.105/tcp/9090/p2p/12D3KooW...",
    "/ip4/backup-relay.example.com/tcp/9090/p2p/12D3KooW..."
  ]
}
```

### Option B: On-chain relay registry

Relay operators register their multiaddrs on-chain. New nodes query the
chain for the list of active relays.

```solidity
contract RelayRegistry {
    struct Relay {
        string multiaddr;
        uint256 stakeAmount;
        uint256 lastHeartbeat;
    }

    mapping(address => Relay) public relays;

    function registerRelay(string calldata multiaddr) external;
    function deregisterRelay() external;
    function heartbeat() external;
    function getActiveRelays() external view returns (Relay[] memory);
}
```

Relays must stake TRAC and send periodic heartbeats. Stale relays
(no heartbeat for N epochs) are automatically deregistered.

### Option C: DHT-based discovery

Relay nodes advertise themselves on the libp2p DHT under a well-known
key (e.g., `/dkg/relays/v1`). New nodes query the DHT for relay
addresses.

**Limitation**: Requires at least one bootstrap node to reach the DHT,
which is a chicken-and-egg problem. Works well as a secondary mechanism
after initial bootstrap.

## Recommended approach

**Option A (short term)** + **Option B (long term)**:

1. Immediately: add `relays[]` array to network config with fallbacks
2. Later: implement on-chain relay registry as part of contextGraph staking
   (relay operators are node operators who stake to the relay role)
3. DHT discovery as optional enhancement for resilience

## Node bootstrap flow

```
1. Load config.json → check for manual relay override
2. If no override:
   a. Fetch network config (testnet.json) → try relays[] in order
   b. If all fail and chain is configured:
      query RelayRegistry.getActiveRelays()
   c. If chain not configured: fail with helpful error
3. Cache last-known-good relay address locally
4. On relay disconnect: try next relay in list
```
