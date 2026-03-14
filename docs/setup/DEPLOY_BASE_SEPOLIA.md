# Deploy DKG V9 Contracts to Base Sepolia

Add the V9 KnowledgeAssets contracts to the existing DKG deployment on Base Sepolia.

## Existing Deployments

V8 contracts are already deployed. The V9 upgrade adds two new contracts into the existing Hub:

| Network | Environment | Hub Address | Chain ID |
|---------|-------------|-------------|----------|
| `base_sepolia_dev` | devnet | `0xE043daF4cC8ae2c720ef95fc82574a37a429c40A` | 84532 |
| `base_sepolia_test` | testnet | `0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6` | 84532 |

The Hub already contains all V8 contracts (Token, Identity, Profile, Staking, KnowledgeCollection, Paranets, etc.). We're deploying:
- **`KnowledgeAssetsStorage`** — new V9 storage (registered as asset storage in Hub)
- **`KnowledgeAssets`** — new V9 logic (registered as contract in Hub)

## Prerequisites

- **Node.js** v20+
- **pnpm** v9+
- The **Hub owner private key** (same wallet that deployed the V8 contracts — required to register new contracts in the Hub)
- Base Sepolia ETH for gas (~0.01 ETH, two contract deploys)
- A Base Sepolia **RPC endpoint** (public or Alchemy/Infura)

### Get Base Sepolia ETH

Base Sepolia is a testnet — ETH is free:
1. [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia)
2. [Coinbase faucet](https://portal.cdp.coinbase.com/products/faucet)

### Get an RPC Endpoint

The public endpoint `https://sepolia.base.org` works but is rate-limited. For a smoother deploy, get a free key from:
- [Alchemy](https://www.alchemy.com/) → Create app → Base Sepolia
- [Infura](https://www.infura.io/) → Create project → Base Sepolia

---

## 1. Set Environment Variables

Create a `.env` file in `packages/evm-module/`:

```bash
cd packages/evm-module
cp .env.example .env 2>/dev/null || touch .env
```

For **devnet** (`base_sepolia_dev`):

```env
# Hub owner private key (the wallet that owns the Hub contract)
EVM_PRIVATE_KEY_BASE_SEPOLIA_DEV=your_hub_owner_private_key

# RPC endpoint (optional — defaults to https://sepolia.base.org)
RPC_BASE_SEPOLIA_DEV=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY
```

For **testnet** (`base_sepolia_test`):

```env
EVM_PRIVATE_KEY_BASE_SEPOLIA_TEST=your_hub_owner_private_key
RPC_BASE_SEPOLIA_TEST=https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY
```

> **Important**: The deployer must be the Hub owner. Only the Hub owner can register new contracts via `setContractAddress` / `setAssetStorageAddress`.

> **Security**: Never commit `.env` to git. It's already in `.gitignore`.

---

## 2. Build the Contracts

From the monorepo root:

```bash
pnpm install
cd packages/evm-module
npx hardhat compile --config hardhat.config.ts
```

Verify the ABI files were generated:

```bash
ls abi/KnowledgeAssets.json abi/KnowledgeAssetsStorage.json
```

---

## 3. Deploy V9 Contracts

Since V8 contracts are already deployed, use `--tags v9` to deploy only the new V9 contracts:

```bash
# Deploy to devnet
npx hardhat deploy --network base_sepolia_dev --config hardhat.config.ts --tags v9

# Or deploy to testnet
npx hardhat deploy --network base_sepolia_test --config hardhat.config.ts --tags v9
```

This runs only the two V9 deploy scripts:
- **`040_deploy_knowledge_assets_storage.ts`** — deploys `KnowledgeAssetsStorage`, registers it as asset storage in Hub
- **`041_deploy_knowledge_assets.ts`** — deploys `KnowledgeAssets`, registers it as a contract in Hub, calls `initialize()`

Expected output:

```
deploying "KnowledgeAssetsStorage" — deployed at 0xAAAA...
deploying "KnowledgeAssets" — deployed at 0xBBBB...
```

### Full Deploy (fresh network)

If deploying from scratch to a new network, run without `--tags` to deploy everything:

```bash
npx hardhat deploy --network base_sepolia_dev --config hardhat.config.ts
```

---

## 4. Verify the Deployment

Run a quick check that contracts are registered in the Hub:

```bash
npx hardhat console --network base_sepolia_dev --config hardhat.config.ts
```

```javascript
const Hub = await ethers.getContract('Hub');

// V9 contracts
const kaAddr = await Hub.getContractAddress('KnowledgeAssets');
const kasAddr = await Hub.getAssetStorageAddress('KnowledgeAssetsStorage');
console.log('KnowledgeAssets:', kaAddr);
console.log('KnowledgeAssetsStorage:', kasAddr);

// V8 contracts (should still be there)
const kcAddr = await Hub.getContractAddress('KnowledgeCollection');
console.log('KnowledgeCollection:', kcAddr);

// Check names
const KA = await ethers.getContractAt('KnowledgeAssets', kaAddr);
console.log('KA name:', await KA.name());     // "KnowledgeAssets"
console.log('KA version:', await KA.version()); // "1.0.0"
```

---

## 5. Verify on Basescan (Optional)

Verify contracts on [Basescan Sepolia](https://sepolia.basescan.org/) for public ABI access:

```bash
# Install the verify plugin if not already present
npx hardhat verify --network base_sepolia_dev --config hardhat.config.ts CONTRACT_ADDRESS CONSTRUCTOR_ARGS
```

For Hub-dependent contracts, the constructor arg is the Hub address:

```bash
# Example: verify KnowledgeAssetsStorage
npx hardhat verify --network base_sepolia_dev --config hardhat.config.ts 0xAAAA... 0xHUB_ADDRESS

# Example: verify KnowledgeAssets
npx hardhat verify --network base_sepolia_dev --config hardhat.config.ts 0xBBBB... 0xHUB_ADDRESS
```

---

## 6. Configure DKG Nodes to Use the Deployment

Once deployed, configure your DKG V9 nodes to point at the contracts. In `~/.dkg/config.json` (or the CLI init), you'll need:

```json
{
  "chain": {
    "type": "evm",
    "chainId": "evm:84532",
    "rpcUrl": "https://sepolia.base.org",
    "hubAddress": "0xE043daF4cC8ae2c720ef95fc82574a37a429c40A",
    "privateKey": "YOUR_NODE_PRIVATE_KEY"
  }
}
```

The node's `EVMChainAdapter` will resolve all contract addresses from the Hub automatically — both V8 and V9 contracts.

---

## Network Reference

| Network | Chain ID | Environment | Hub Address | Hardhat Name |
|---------|----------|-------------|-------------|--------------|
| Base Sepolia (dev) | 84532 | `devnet` | `0xE043daF4cC8ae2c720ef95fc82574a37a429c40A` | `base_sepolia_dev` |
| Base Sepolia (test) | 84532 | `testnet` | `0xf21CE8f8b01548D97DCFb36869f1ccB0814a4e05` | `base_sepolia_test` |

## Contract Addresses

Deployment data is tracked in:

```
packages/evm-module/deployments/base_sepolia_dev_contracts.json
packages/evm-module/deployments/base_sepolia_test_contracts.json
```

After deploying V9 contracts, the new entries (`KnowledgeAssets`, `KnowledgeAssetsStorage`) will be appended to these files automatically.

---

## Troubleshooting

**"insufficient funds for gas"** — Your deployer wallet needs Base Sepolia ETH. Use the faucets above.

**"nonce too low"** — Previous deploy was partially completed. Either wait for pending txs to confirm, or reset nonce: `npx hardhat clean && npx hardhat deploy ...`

**"ContractDoesNotExist"** — A dependency wasn't deployed. Run the full deploy without `--tags` to ensure all dependencies are present.

**Rate-limited on public RPC** — Switch to Alchemy or Infura. The public `sepolia.base.org` endpoint has aggressive rate limits for deployments.
