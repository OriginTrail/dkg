# Greenfield Knowledge Asset model (rc.12)

## UAL (canonical)

```
did:dkg:{chainId}/{DKGKnowledgeAssetsAddress}/{kaId}
```

Example (Hardhat):

```
did:dkg:evm:31337/0xabc...def/1
```

Resolvable as `dkg://{chainId}/{address}/{kaId}` per `20_PROTOCOL_URL_SCHEME.md`.

- `kaId` equals ERC-721 `tokenId` on `DKGKnowledgeAssets`.
- UAL is **stable** across merkle-root updates.
- Publisher pays TRAC and collects node ACKs; **KA owner** (721 holder) attests updates once via EIP-712 `UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress, schemeVersion)` (domain `KnowledgeAssetsLifecycle` v2.0.0). Pass the seal as `precomputedUpdateAttestation` on the first `publisher.update()` call.

## Hub contracts

| Hub name | Solidity |
|----------|----------|
| `DKGKnowledgeAssets` | `storage/DKGKnowledgeAssets.sol` |
| `KnowledgeAssetsLifecycle` | `KnowledgeAssetsLifecycle.sol` |

Legacy `KnowledgeCollectionStorage` / `KnowledgeAssetsV10` remain in-tree for reference; active deploy scripts use the greenfield pair.

## Publish constraints

- Exactly **one** KA per `publish` (`knowledgeAssetsAmount == 1`).
- ERC-721 minted to **author** at publish.
- No ERC-1155 mint/burn on update.
