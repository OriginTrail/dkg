# RFC-64 selected-public catalog activation

RFC-64 public catalog synchronization is opt-in. A node with no
`rfc64PublicCatalog` block, or with `enabled: false`, keeps the catalog lane
fail-closed: it accepts no catalog policy, starts no bootstrap pulls, and does
not advance catalogs after ordinary KA publication.

This activation is intentionally selective. The operator supplies a bounded
manifest of independently verified, finalized public-CG policy envelopes. The
CG IDs in that manifest are the single source for:

- durable graph subscriptions;
- explicit signed-catalog targets; and
- optional graph-complete-provider native SWM recovery.

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
          "completeSwmProviders": ["12D3Koo...complete-swm-provider"],
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

`completeSwmProviders` is optional and stronger than a target's `providers`.
Each listed peer is an operator assertion that the peer serves the complete
public SWM snapshot for this exact accepted policy generation. Catch-up then
contacts that peer for SWM first and may stop the SWM fan-out after verified
coverage, while VM remains chain/curator driven. Omit this field unless that
graph-wide property has been established; ordinary per-author catalog providers
do not imply it.

`autoPublish` is optional and arms the explicit low-level catalog-authoring
capability. It does **not** make ordinary KA publication author or advance a
signed catalog in 10.0.14. Ordinary publication only updates the signed SWM
inventory shadow, which remains audit evidence and does not drive receiver
synchronization. A receiver can omit `autoPublish` and keep only the bootstrap
controls.

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

For a signed-catalog target gate, `enabled: true` is not sufficient. Every
intended target must report `outcome: "applied"`, a non-null
`appliedHeadDigest`, and the expected `inventoryRowCount`. A `not-found` or
`failed` target is a failed catalog gate even if ordinary durable sync reports
done. For a configuration that uses only `completeSwmProviders`, `targets` may
be empty; gate that lane by exact SWM asset/byte coverage before and after
receiver restart, plus exact chain-derived VM coverage. In either mode, test
provider loss/failover explicitly.

## Current boundary

This release exposes the already-built public RFC-64 catalog receiver data
plane for explicit targets and the selected native SWM recovery lane for
operator-approved graph-complete providers. Provider peer IDs and finalized
policy envelopes are still pinned inputs. Signed catalog authoring is explicit;
the ordinary-publication SWM inventory shadow is not connected to receiver
convergence. Automatic catalog production, automatic provider discovery, and
automatic chain-to-policy control-plane generation are later work.
