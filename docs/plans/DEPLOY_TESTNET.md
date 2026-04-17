# DKG V9 Testnet Deployment Plan

Actionable checklist to get the V9 testnet live. Covers contract deployment, relay server, node bootstrapping, and smoke testing.

## Current State

| Component | Status |
|-----------|--------|
| P2P networking (libp2p) | Working — tested locally |
| GossipSub replication | Working — tested locally |
| Publish flow (P2P + chain) | Working — tested with EVMChainAdapter + Hardhat |
| Update flow | Working — tested with EVMChainAdapter + Hardhat |
| Query engine + SPARQL guard | Working — unit + e2e tests pass |
| ChainEventPoller (dual confirmation) | Working — tested with EVMChainAdapter + Hardhat |
| Two-level Merkle (flat + entityProofs) | Working — tested |
| Tentative → confirmed lifecycle | Working — tested |
| CLI | Working — all commands implemented |
| EVMChainAdapter | Working — tested against local Hardhat |
| V8 contracts (Base Sepolia) | Deployed — Hub at `0xf21CE8f8b01548D97DCFb36869f1ccB0814a4e05` |
| V9 contracts (Base Sepolia) | **NOT DEPLOYED** — deploy scripts exist (040, 041) |
| Relay server | **NOT VERIFIED** — `167.71.33.105:9090` configured in testnet.json |
| Testnet nodes running | **NONE** — no nodes deployed yet |

---

## Phase 1: Contract Deployment (30 min)

Deploy V9 contracts (`KnowledgeAssetsStorage` + `KnowledgeAssets`) to Base Sepolia testnet.

### Prerequisites

- [ ] **Hub owner private key** — the wallet that deployed V8 contracts to `0xf21CE...05`. Only this wallet can register new contracts in the Hub via `setContractAddress` / `setAssetStorageAddress`.
- [ ] **Base Sepolia ETH** in the hub owner wallet (~0.01 ETH for two contract deploys). Free from [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia) or [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet).
- [ ] **RPC endpoint** — public `https://sepolia.base.org` works but is rate-limited. Recommended: free Alchemy or Infura key.

### Steps

```bash
# 1. Set environment variables
cd packages/evm-module
cat > .env << 'EOF'
EVM_PRIVATE_KEY_BASE_SEPOLIA_TEST=<hub_owner_private_key>
RPC_BASE_SEPOLIA_TEST=https://base-sepolia.g.alchemy.com/v2/<your_key>
EOF

# 2. Compile contracts (generates fresh ABIs)
npx hardhat compile --config hardhat.config.ts --force

# 3. Deploy V9 contracts only
npx hardhat deploy --network base_sepolia_test --config hardhat.config.ts --tags v9
```

Expected output:
```
deploying "KnowledgeAssetsStorage" — deployed at 0xAAAA...
deploying "KnowledgeAssets" — deployed at 0xBBBB...
```

### Verify

```bash
npx hardhat console --network base_sepolia_test --config hardhat.config.ts
```

```javascript
const Hub = await ethers.getContract('Hub');
console.log('KnowledgeAssets:', await Hub.getContractAddress('KnowledgeAssets'));
console.log('KnowledgeAssetsStorage:', await Hub.getAssetStorageAddress('KnowledgeAssetsStorage'));
```

Both should return non-zero addresses.

### Optional: Basescan verification

```bash
npx hardhat verify --network base_sepolia_test --config hardhat.config.ts <KnowledgeAssetsStorage_addr> <Hub_addr>
npx hardhat verify --network base_sepolia_test --config hardhat.config.ts <KnowledgeAssets_addr> <Hub_addr>
```

---

## Phase 2: Relay Server (30 min)

The relay enables NAT traversal — edge nodes behind firewalls connect through it. The relay address `167.71.33.105:9090` is already in `testnet.json`.

### Option A: Relay is already running

If the relay at `167.71.33.105` is already running from earlier V9 development:

```bash
# Test from your machine
nc -zv 167.71.33.105 9090
```

If it connects, skip to Phase 3.

### Option B: Deploy a new relay

Requirements: A VPS with a public IP (DigitalOcean, Hetzner, AWS Lightsail — ~$5/mo). Ports 9090 TCP must be open.

```bash
# On the VPS
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install && pnpm build

# Start as a core relay node
pnpm dkg init
# name: relay-1
# role: core
# No relay needed (it IS the relay)
# No chain private key needed (relay doesn't publish)

pnpm dkg start
```

After starting, note the PeerId from the output. Update `network/testnet.json`:

```json
{
  "relays": [
    "/ip4/<VPS_PUBLIC_IP>/tcp/9090/p2p/<RELAY_PEER_ID>"
  ]
}
```

Commit and push — all nodes pulling from `main` will auto-discover the relay.

### Keep relay running

```bash
# pm2 (recommended)
npm install -g pm2
pm2 start "node packages/cli/dist/cli.js start -f" --name dkg-relay --cwd ~/dkg-v9
pm2 save && pm2 startup
```

---

## Phase 3: First Node Smoke Test (15 min)

Before inviting others, test the full flow yourself with a single node. The `testing` paranet is auto-created and auto-subscribed on startup (via `defaultParanets` in `testnet.json`).

### Steps

```bash
cd ~/dkg-v9

# 1. Init with chain config
pnpm dkg init
# Provide your EVM private key (or set DKG_PRIVATE_KEY env var)

# 2. Fund the wallet
pnpm dkg wallet
# Copy the address, send it Base Sepolia ETH from a faucet

# 3. Start
pnpm dkg start -f
# The node auto-creates and subscribes to the "testing" paranet

# 4. Check relay connection
pnpm dkg status
# Should show "Circuit reservation granted"

# 5. Publish to the testing paranet (auto-created on startup)
pnpm dkg publish testing --subject "did:dkg:test:hello" \
  --predicate "https://schema.org/name" --object "Hello World"

# 6. Verify on-chain finality
pnpm dkg query testing --sparql "SELECT ?s ?name WHERE { GRAPH ?g { ?s <https://schema.org/name> ?name } }"
# Should return: did:dkg:test:hello → "Hello World"

# 7. Check wallet for gas spent
pnpm dkg wallet
```

### What to verify

- [ ] Node starts and connects to relay (circuit reservation)
- [ ] `pnpm dkg wallet` shows correct address and ETH balance
- [ ] Publishing succeeds with `status: confirmed` (not tentative)
- [ ] Query returns the published data
- [ ] No errors in logs (`pnpm dkg logs`)
- [ ] The publish tx is visible on [sepolia.basescan.org](https://sepolia.basescan.org)

### If publish stays tentative

This means the on-chain tx failed. Common causes:
- V9 contracts not deployed (Phase 1 not done)
- Wallet has no ETH for gas
- Wrong Hub address in config

Check logs: `pnpm dkg logs | grep -i "chain\|tx\|revert"`

---

## Phase 4: Two-Node Test (20 min)

Test P2P replication and chain event polling between two nodes.

### Steps

```bash
# Terminal 1: Start Node A (already running from Phase 3)

# Terminal 2: Start Node B
cd ~/dkg-v9
DKG_PRIVATE_KEY=<different_key> pnpm dkg init --name node-b
pnpm dkg start -f
```

Wait for both nodes to discover each other via the relay (~30 seconds).

```bash
# On Node A
pnpm dkg peers                   # Should show Node B
pnpm dkg subscribe smoke-test --save

# On Node B
pnpm dkg subscribe smoke-test --save
```

```bash
# On Node A: publish
pnpm dkg publish smoke-test --subject "did:dkg:test:from-a" \
  --predicate "https://schema.org/name" --object "From Node A"
```

```bash
# On Node B: query (wait a few seconds for GossipSub propagation)
pnpm dkg query smoke-test --sparql "SELECT ?name WHERE { ?s <https://schema.org/name> ?name }"
# Should include "From Node A"
```

### What to verify

- [ ] Nodes discover each other via relay
- [ ] GossipSub delivers publish data to Node B
- [ ] Node B receives data as tentative
- [ ] ChainEventPoller on Node B confirms data via on-chain event
- [ ] Query on Node B returns confirmed data
- [ ] Encrypted chat works: `pnpm dkg send node-b "hello from A"`

---

## Phase 5: Update Flow Test (10 min)

Test the update flow end-to-end.

```bash
# On Node A: note the KC ID from the publish output
pnpm dkg update <kc-id> --paranet smoke-test \
  --subject "did:dkg:test:from-a" \
  --predicate "https://schema.org/name" --object "Updated from Node A"

# Query should now return the updated value
pnpm dkg query smoke-test --sparql \
  "SELECT ?name WHERE { <did:dkg:test:from-a> <https://schema.org/name> ?name }"
# → "Updated from Node A"
```

- [ ] Update succeeds with new merkle root on-chain
- [ ] Old data is replaced, not duplicated
- [ ] On-chain merkle root changed (check Basescan)

---

## Phase 6: Integration Tests (15 min)

Run the agent-level tests against the live testnet to verify everything works end-to-end with real contracts. This uses the existing Hardhat E2E tests but pointed at Base Sepolia.

```bash
# Quick local verification (Hardhat node — no testnet ETH needed)
cd packages/agent
pnpm test

# Publisher lifecycle tests
cd packages/publisher
pnpm test
```

All tests should pass. The publisher test suite includes:
- Flat + entityProofs merkle roots
- Synthetic privateMerkleRoot triple
- Tentative → confirmed via ChainEventPoller
- Update flow with merkle root change
- SPARQL guard (query safety)

---

## Phase 7: Documentation & Announce (10 min)

- [ ] Verify `docs/setup/JOIN_TESTNET.md` is up to date (includes quick start, first things to try, share-with-friends note)
- [ ] Verify `network/testnet.json` has correct relay and chain config
- [ ] Update `docs/setup/DEPLOY_BASE_SEPOLIA.md` with actual deployed V9 contract addresses
- [ ] Push all changes to `main`
- [ ] Share `JOIN_TESTNET.md` with initial testers

---

## Rollback Plan

If something goes wrong after contract deployment:

| Issue | Fix |
|-------|-----|
| V9 contracts deployed but broken | Hub owner can update the contract address to a new deployment. Storage is separate from logic. |
| Relay down | Nodes can still connect directly via `--bootstrap-peers` if they know each other's multiaddrs. |
| On-chain tx reverts | Check contract state via Hardhat console. Common: missing permissions, wrong Hub address. |
| Nodes can't find each other | Check relay connectivity. Restart with `pnpm dkg stop && pnpm dkg start`. |

---

## Infrastructure Summary

```
┌──────────────────────────────────────────────────────────┐
│                    Base Sepolia (84532)                    │
│                                                           │
│  Hub ─── KnowledgeAssets ─── KnowledgeAssetsStorage      │
│    │                                                      │
│    ├── Token (V8)                                        │
│    ├── Identity (V8)                                     │
│    ├── Profile (V8)                                      │
│    ├── Staking (V8)                                      │
│    ├── KnowledgeCollection (V8, legacy)                  │
│    └── Paranets (V8)                                     │
└──────────────────────────────────────────────────────────┘
            ▲                        ▲
            │ RPC                    │ RPC
┌───────────┴──────┐    ┌───────────┴──────┐
│   Relay Node     │    │   Edge Node A    │
│   (core, VPS)    │◄──►│   (your Mac)     │
│   167.71.33.105  │    │   behind NAT     │
└──────────────────┘    └──────────────────┘
            ▲
            │ circuit relay
┌───────────┴──────┐
│   Edge Node B    │
│   (another Mac)  │
│   behind NAT     │
└──────────────────┘

P2P: libp2p TCP + GossipSub + Circuit Relay
Chain: Base Sepolia via EVMChainAdapter
Confirmation: GossipSub (fast) + ChainEventPoller (trustless)
```

---

## Time Estimate

| Phase | Time | Blocker |
|-------|------|---------|
| 1. Contract deployment | 30 min | Need Hub owner key |
| 2. Relay server | 30 min | Need VPS (or verify existing) |
| 3. Single-node smoke test | 15 min | Need Base Sepolia ETH |
| 4. Two-node test | 20 min | — |
| 5. Update flow test | 10 min | — |
| 6. Integration tests | 15 min | — |
| 7. Docs & announce | 10 min | — |
| **Total** | **~2 hours** | Hub owner key is the critical path |

The **Hub owner private key** is the single blocker for Phase 1. Everything else can proceed once contracts are deployed.
