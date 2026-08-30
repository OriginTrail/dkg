# RFC-64 selected-public catalog activation

RFC-64 catalog synchronization is selected and fail-closed. A valid
`rfc64PublicCatalog.bootstrap.acceptedPublicPolicies` manifest makes the exact
CGs it names eligible for RFC-64; no second enable switch is required. A node with no
`rfc64PublicCatalog` block, or with explicit `enabled: false`, accepts no catalog
policy, starts no bootstrap pulls, and does not advance catalogs after ordinary
KA publication.

This activation is intentionally selective. The operator supplies a bounded
manifest of independently verified, finalized public-CG policy envelopes. The
CG IDs in that manifest are the single source for:

- per-CG legacy, shadow, or catalog authority eligibility;
- explicit signed-catalog targets; and
- optional graph-complete-provider native SWM recovery.

There is no `sync all public CGs` mode in this release. On an edge node, the
manifest is not a subscription list. Existing `contextGraphs`, foreground
subscriptions, and their persisted restart state decide which eligible CGs the
edge follows. Subscribing to an eligible CG immediately makes RFC-64 its SWM
rail; unsubscribing stops its catalog pulls without deleting already verified
data. Other eligible public or private CGs remain inactive. The rehydration cap
still bounds how many persisted user subscriptions are activated at boot.

Core nodes retain their configured manifest-wide behavior for the corpus they
are configured to host. This edge/core distinction changes runtime work selection only;
it does not turn discovered peers into catalog authorities or weaken the
configured policy, roster, or peer-identity trust roots.

Signed-catalog activation remains the stronger, separate control plane described
below. Only an operator-pinned `completeSwmProviders` peer may prove the whole
selected SWM scope terminal. Without that assertion, the receiver retains
multi-peer union convergence and never treats one ordinary peer's local manifest
as graph-complete. Private CGs retain curator recovery, and VM remains
chain/curator driven.

## Configuration

Add the following shape to `~/.dkg/config.json`:

```json
{
  "rfc64PublicCatalog": {
    "rollout": {
      "killSwitch": false,
      "contextGraphModes": {
        "0x.../selected-public-cg": "shadow"
      }
    },
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

`enabled: true` remains accepted for compatibility, but is redundant when a
valid manifest is present. `enabled: false` disables the complete activation
block. The operational emergency stop is the dedicated
`rollout.killSwitch`; it stops Track-2 protocols and workers without deleting
verified data or changing any graph's persisted authority mode.

Each selected graph may be assigned exactly one restart-stable mode:

- `legacy`: only the existing durable/SWM correctness path runs; Track 2 is dormant;
- `shadow`: the existing path stays authoritative while Track 2 fetches and durably
  stages signed heads for comparison, without activating catalog content; or
- `catalog`: Track 2 is authoritative for SWM and every overlapping legacy
  durable/SWM recovery path is excluded.

Omitted modes retain the earlier selected-catalog behavior and resolve to
`catalog`. New rollouts should set every mode explicitly and begin with
`shadow`. A `catalog` graph does not silently fall back when the kill switch is
active; changing authority requires an explicit config edit to `legacy` or
`shadow` followed by restart. Finalized public VM reconciliation remains
chain-inventoried in every mode and is not disabled by the catalog kill switch.

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

### Experimental Releases 1-3: selected private SWM, VM, and provider failover

`rfc64Catalog` is the additive policy-neutral form. Release 1 lets a current
member recover SWM for one explicitly selected owner-signed, unregistered
private CG from one pinned complete provider. Release 2 also accepts a
registered private CG whose policy source is `finalized-chain`. For that graph,
the receiver recovers SWM from the same pinned provider and materializes VM
from the exact finalized chain ordinal set before it commits the catalog head.
Release 3 accepts 1-8 current roster providers for the same exact graph-complete
head. It discovers at most four providers at once, selects the highest exact
head, rejects a same-version conflict, and retries another retained provider
when a transfer fails.

Verified control objects and KA bundles are stored as they arrive. A retry or
process restart reads these objects from the local durable cache. It does not
download the same verified bytes again. Private status exposes only aggregate
attempt, switch, backoff, cache, network, and byte counters. It does not expose
private provider identities.

Private VM recovery fails closed. The accepted roster must bind to the exact
policy digest. The catalog author and the content provider must be current
members. Content requests use the private V2 scoped protocols; the public V1
protocols do not serve private data. If chain truth lists an author asset but
the authorized catalog cannot supply its bytes, status reports
`known-incomplete` with reason `no-authorized-provider`. The receiver does not
use a public or curator fallback.

Release 2 private VM recovery supports only the root catalog
(`subGraphName: null`). A private named-subgraph catalog is rejected before any
chain read or store change. Named-subgraph VM recovery needs an authoritative
chain-to-catalog lane map and is not inferred from the asset author.

The bounded operator shape is:

```json
{
  "rfc64Catalog": {
    "rollout": {
      "killSwitch": false,
      "contextGraphModes": {
        "0x.../selected-private-cg": "shadow"
      }
    },
    "bootstrap": {
      "acceptedPolicies": [
        {
          "policyEnvelope": "<canonical independently verified ContextGraphPolicyV1 envelope>",
          "rosterEnvelope": "<canonical independently verified MemberRosterV1 envelope>",
          "completeSwmProviders": [
            "12D3Koo...private-provider-a",
            "12D3Koo...private-provider-b"
          ],
          "targets": [
            {
              "authorAddress": "0x...catalog-author",
              "providers": [
                "12D3Koo...private-provider-a",
                "12D3Koo...private-provider-b"
              ]
            }
          ]
        }
      ]
    },
    "accessPolicyAuthority": {
      "localAgentAddress": "0x...current-local-member",
      "peerAgentBindings": [
        {
          "peerId": "12D3Koo...private-provider-a",
          "agentAddress": "0x...current-roster-provider"
        },
        {
          "peerId": "12D3Koo...private-provider-b",
          "agentAddress": "0x...other-current-roster-provider"
        }
      ]
    }
  }
}
```

The envelope strings above stand for full JSON objects; they are abbreviated
only to keep the example readable. `peerAgentBindings` is manual operator trust,
not discovery output. Every private target or complete provider needs an exact
binding to a current roster member with the `provider` role. The local address
must also be a current member. The daemon rejects a missing or conflicting
policy, roster, provider binding, network, or local membership before it starts.

Releases 1-3 do not follow roster successors automatically. When a member is
removed, install the new independently verified policy/roster snapshot, remove
obsolete peer bindings, and restart the node. This fences the removed peer from
new transfers. Content already received by that member cannot be
revoked.

`rfc64PublicCatalog` remains valid. If both blocks select the same CG, their
canonical policy, targets, and completeness assertion must be identical; a
conflict stops activation.

## Verify activation

Restart the daemon and inspect `GET /api/status`:

The public compatibility block lists public targets only. Private provider
identities stay out of status. The `rfc64Catalog.privateRecovery` array gives
local aggregate counts, the effective mode, whether VM is required, and safe
completion reasons. Both RFC-64 status blocks expose the configured per-CG mode
map, the kill-switch state, and `runtimeSelection`. On edges,
`runtimeSelection.selectedContextGraphs` is the current subscribed intersection
of the eligible manifest. Bootstrap targets for eligible but unsubscribed CGs
report `inactive`.

```json
{
  "rfc64PublicCatalog": {
    "enabled": true,
    "selectedContextGraphs": ["0x.../selected-public-cg"],
    "rollout": {
      "killSwitch": false,
      "contextGraphModes": {
        "0x.../selected-public-cg": "shadow"
      }
    },
    "autoPublishEnabled": true,
    "service": {},
    "bootstrap": {
      "running": false,
      "pass": 1,
      "targets": [
        {
          "mode": "shadow",
          "outcome": "shadow-staged",
          "providerPeerId": "12D3Koo...provider-primary",
          "appliedHeadDigest": null,
          "stagedHeadDigest": "0x...",
          "catalogVersion": "50",
          "inventoryRowCount": "50",
          "lastError": null
        }
      ]
    }
  }
}
```

The independent scheduling-default projection is visible even when no signed
catalog is configured:

```json
{
  "rfc64SelectedPublicSync": {
    "defaultEnabled": true,
    "requestedContextGraphs": ["0x.../selected-public-cg"],
    "catalogBackedContextGraphs": []
  }
}
```

`requestedContextGraphs` is the agent's live explicit scheduling scope. Entries
are not classified as public merely by appearing there: the public-CG catch-up
boundary applies selected scheduling, while the private-CG boundary ignores it
and retains curator recovery.

### Repair an existing public graph

Readiness recorded by an older release does not prove that every historical SWM
snapshot was visited. An operator can request one bounded reconciliation without
resetting the graph's current ready state:

```bash
dkg subscribe <context-graph-id> --repair
```

The equivalent API request is:

```json
{
  "contextGraphId": "<context-graph-id>",
  "includeSharedMemory": true,
  "forceCatchup": true
}
```

For a public graph this enters the RFC-64 selected scheduler and resumes large
snapshot walks across bounded continuation jobs. The switch is off by default
and applies to this request only. Concurrent requests for the same graph dedupe
onto its active job. Run repairs in small waves and gate the next wave on catch-up
status, store backpressure, CPU, and disk headroom. Ordinary peers contribute to
multi-peer union convergence; only an operator-pinned `completeSwmProviders`
peer can prove the selected SWM scope terminal.

For a signed-catalog target gate, activation alone is not sufficient. Every
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
