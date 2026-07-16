# DKGKnowledgeAssets 10.0.4 high-water getter rollout

Procedure for rolling out `DKGKnowledgeAssets` 10.0.4, which adds
`getMaxKaNumberForAuthor(address)`. This is needed because a Solidity
`_VERSION` bump does not by itself redeploy existing network metadata.

## Why this is manual

`hre.helpers.deploy()` first checks `deployments/<network>_contracts.json`.
If `contracts.DKGKnowledgeAssets.deployed` is `true`, the helper returns the
recorded address and does not compare the recorded `version` to the Solidity
`_VERSION`.

At the time this runbook was added, `base_sepolia_v10_contracts.json` still
records:

```jsonc
"DKGKnowledgeAssets": {
  "version": "10.0.3",
  "deployed": true
}
```

A plain deploy would therefore keep the old 10.0.3 address. The chain package
has a selector-gated fallback for that state, but operators must redeploy the
storage contract before relying on the O(1) getter path.

## Base Sepolia V10 rollout

Run from `packages/evm-module/` with `RPC_BASE_SEPOLIA_V10` and
`EVM_PRIVATE_KEY_BASE_SEPOLIA_V10` configured. The deployer wallet must be the
Hub owner for the target deployment.

```bash
npx hardhat compile
```

Force only `DKGKnowledgeAssets` through the deploy helper:

```bash
node -e '
  const fs = require("fs");
  const p = "deployments/base_sepolia_v10_contracts.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const c = j.contracts.DKGKnowledgeAssets;
  if (!c) throw new Error(`DKGKnowledgeAssets missing from ${p}`);
  if (c.version !== "10.0.3") {
    throw new Error(`Expected Base Sepolia to start from 10.0.3, got ${c.version}`);
  }
  c.deployed = false;
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + "\n");
  console.log("Marked DKGKnowledgeAssets for redeploy.");
'
```

Deploy and let the helper update the Hub asset-storage pointer:

```bash
npx hardhat deploy --network base_sepolia_v10
```

Commit the resulting post-deploy metadata only after the JSON records the new
address, `version: "10.0.4"`, and `deployed: true`.

## Verification

Read the deployed addresses from the post-deploy
`deployments/base_sepolia_v10_contracts.json`:

```bash
DKG_KA_ADDR=<contracts.DKGKnowledgeAssets.evmAddress>
HUB_ADDR=<contracts.Hub.evmAddress>
AUTHOR=0x0000000000000000000000000000000000000001
```

The storage contract must expose the new version and getter:

```bash
cast call "$DKG_KA_ADDR" 'version()(string)' --rpc-url "$RPC_BASE_SEPOLIA_V10"
cast call "$DKG_KA_ADDR" 'getMaxKaNumberForAuthor(address)(int256)' "$AUTHOR" --rpc-url "$RPC_BASE_SEPOLIA_V10"
```

The Hub must point `DKGKnowledgeAssets` asset storage at the redeployed address:

```bash
cast call "$HUB_ADDR" 'getAssetStorageAddress(string)(address)' DKGKnowledgeAssets --rpc-url "$RPC_BASE_SEPOLIA_V10"
```

Expected:

- `version()` returns `10.0.4`.
- `getMaxKaNumberForAuthor(AUTHOR)` returns an `int256` value.
- `getAssetStorageAddress("DKGKnowledgeAssets")` equals `DKG_KA_ADDR`.

