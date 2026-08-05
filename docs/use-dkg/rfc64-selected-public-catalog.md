# RFC-64 selected-public catalog activation

RFC-64 public catalog synchronization is opt-in. A node with no
`rfc64PublicCatalog` block, or with `enabled: false`, keeps the catalog lane
fail-closed: it accepts no catalog policy, starts no bootstrap pulls, and does
not advance catalogs after ordinary KA publication.

This activation is intentionally selective. The operator supplies a bounded
manifest of independently verified, finalized public-CG policy envelopes. The
CG IDs in that manifest are the single source for both:

- durable graph subscriptions; and
- the optional post-publication catalog producer hook.

There is no `sync all public CGs` mode in this release. Existing `contextGraphs`
selection continues to work normally, and CGs outside the RFC-64 manifest stay
on the existing publication and synchronization paths.

## Configuration

Add the following shape to `~/.dkg/config.json`:

```json
{
  "rfc64PublicCatalog": {
    "enabled": true,
    "autoPublish": {
      "peers": ["12D3Koo...receiver"],
      "catalogIssuerDelegationExpiresAt": "1893456000000"
    },
    "bootstrap": {
      "retryIntervalMs": 30000,
      "acceptedPublicPolicies": [
        {
          "policyEnvelope": {
            "issuer": "0x...verified-policy-issuer",
            "objectType": "ContextGraphPolicyV1",
            "payload": {
              "networkId": "base:84532",
              "contextGraphId": "0x.../selected-public-cg",
              "governanceChainId": "...",
              "governanceContractAddress": "0x...",
              "ownershipTransitionDigest": null,
              "era": "0",
              "version": "0",
              "previousPolicyDigest": null,
              "accessPolicy": 0,
              "publishPolicy": 1,
              "publishAuthority": null,
              "publishAuthorityAccountId": "0",
              "projectionId": "cg-shared-v1",
              "administrativeDelegationDigest": null,
              "source": {
                "kind": "finalized-chain",
                "chainId": "...",
                "contractAddress": "0x...",
                "blockNumber": "...",
                "blockHash": "0x..."
              },
              "effectiveAt": "...",
              "issuedAt": "..."
            },
            "signatureEvidence": { "kind": "none" },
            "signatureSuite": "eip191-personal-sign-digest-v1"
          },
          "targets": [
            {
              "authorAddress": "0x...catalog-author",
              "providers": ["12D3Koo...provider-primary", "12D3Koo...provider-backup"]
            }
          ]
        }
      ]
    }
  }
}
```

The example shows structure only. Do not invent or copy placeholder control
values. The complete `policyEnvelope` must be the output of an independent
finality/policy verifier. The daemon validates the canonical policy before the
network transport starts and rejects non-public policies, duplicate selections,
unknown fields, non-canonical identifiers, oversized manifests, and any policy
whose `networkId` differs from the daemon's effective `chain.chainId`.

`autoPublish` is optional. Configure it on a publisher that should advance its
catalog after a confirmed public KA mint. A receiver can omit `autoPublish` and
keep only the bootstrap targets. Catalog work after a confirmed mint is
fail-open: a catalog error is logged but does not rewrite the already-confirmed
KA result into a publication failure.

`deploymentProfile` is also optional on a normal chain-connected node. When it
is omitted, the agent resolves the chain ID and Knowledge Assets Lifecycle
address from its trusted chain adapter. An explicit override is intended for a
deterministic harness and must exactly match the selected network.
Its `networkId` and numeric `assertedAtChainId` are checked against the same
effective chain identity before subscriptions, stores, or agent startup begin.

## Verify activation

Restart the daemon and inspect `GET /api/status`:

```json
{
  "rfc64PublicCatalog": {
    "enabled": true,
    "selectedContextGraphs": ["0x.../selected-public-cg"],
    "autoPublishEnabled": true,
    "service": {},
    "bootstrap": {
      "running": false,
      "pass": 1,
      "targets": [
        {
          "outcome": "applied",
          "providerPeerId": "12D3Koo...provider-primary",
          "appliedHeadDigest": "0x...",
          "catalogVersion": "50",
          "inventoryRowCount": "50",
          "lastError": null
        }
      ]
    }
  }
}
```

For a release gate, `enabled: true` is not sufficient. Every intended target
must report `outcome: "applied"`, a non-null `appliedHeadDigest`, and the
expected `inventoryRowCount`. Validate the same evidence again after receiver
restart and during provider failover. A `not-found` or `failed` target is a
failed completeness gate even if the ordinary durable-sync job reports done.

## Current boundary

This release activates the already-built public RFC-64 catalog data plane for
an explicit operator-selected set. Provider peer IDs and finalized policy
envelopes are still pinned inputs. Automatic provider discovery and automatic
chain-to-policy control-plane generation are later work; this activation does
not claim either capability.
