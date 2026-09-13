# RFC-64 catalog activation and staged rollout

On a persistent DKG 10.0.16 node, RFC-64 catalog synchronization is enabled by
default. Omitting both RFC-64 configuration blocks does not disable it. Normal
DKG lifecycle facts determine which Context Graphs this node is responsible for:

- an Edge subscription selects a public CG;
- Core public hosting selects a public CG; and
- independently verified current membership selects a private CG.

The node resolves authority for each responsibility from trusted local and
finalized-chain state. Unknown policy, missing membership, and incomplete
authority stay fail-closed. Unsubscribing removes an Edge responsibility without
deleting data that was already verified. The normal persisted-subscription
rehydration limit still bounds the work activated at startup.

`rfc64Catalog` is therefore an optional operator-control and compatibility-seed
block, not the source of ordinary lifecycle selection. Use it to stage a bounded
rollout, apply a global stop, or provide independently verified policy, roster,
provider, and authoring inputs for an explicit graph. The deprecated
`rfc64PublicCatalog` block remains supported for selected-public compatibility,
but new operational controls belong under `rfc64Catalog`.

Setting `rfc64Catalog.enabled` to `false` is a compatibility rollback for the
current release: it changes all ordinary responsibilities back to the legacy
lane. Omission is different and keeps the 10.0.16 RFC-64 default. Prefer the
rollout controls below for staged operation because they preserve verified
catalog state and make the intended authority visible in status.

An explicit bootstrap manifest does not subscribe an Edge node to its CGs.
Existing `contextGraphs`, live subscriptions, and persisted restart state still
decide what the Edge follows. Core nodes retain their configured hosting
responsibilities. Neither lifecycle discovery nor a bootstrap manifest turns a
discovered peer into an authority or weakens policy, roster, or peer-identity
verification.

Only an operator-pinned `completeSwmProviders` peer may prove an entire selected
SWM scope terminal. Without that assertion, recovery retains multi-peer union
convergence and never treats one ordinary peer's local manifest as graph-complete.
Private recovery remains membership-gated, and finalized VM reconciliation
remains chain-authoritative.

## Configuration

For a one-graph canary, add this control block to `~/.dkg/config.json`:

```json
{
  "rfc64Catalog": {
    "rollout": {
      "defaultMode": "legacy",
      "killSwitch": false,
      "contextGraphModes": {
        "0x.../canary-cg": "shadow"
      }
    }
  }
}
```

`defaultMode: "legacy"` is the bounding control: existing, newly discovered,
and otherwise unlisted responsibilities stay on the legacy lane. Only the
listed CG enters shadow mode. After validating it, change that CG to `catalog`
and restart; leave the default at `legacy` until the next cohort is explicitly
listed.

The older selected-public compatibility shape remains accepted when an operator
must pin a complete policy and provider manifest:

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

`enabled: true` remains accepted but is redundant. `enabled: false` on the
unified block disables release-native RFC-64 selection for all responsibilities
as a compatibility rollback. The operational emergency stop is the dedicated
`rollout.killSwitch`; it stops Track-2 protocols and workers, restores the
ordinary legacy correctness lane for responsible CGs, and does not delete
verified catalog data. Clearing the switch restores each configured desired
mode after restart.

Each graph may be assigned exactly one restart-stable mode. An override may be
declared before the graph is discovered so the first lifecycle transition uses
the intended lane:

- `legacy`: only the existing durable/SWM correctness path runs; Track 2 is dormant;
- `shadow`: the existing path stays authoritative while Track 2 fetches and durably
  stages signed heads for comparison, without activating catalog content; or
- `catalog`: Track 2 is authoritative for SWM and every overlapping legacy
  durable/SWM recovery path is excluded.

Unlisted responsibilities use `rollout.defaultMode`. If `defaultMode` itself is
omitted, it resolves to `catalog`, preserving the 10.0.16 default. For a bounded
canary, set `defaultMode` to `legacy`, list only the canary as `shadow`, verify
it, then advance that explicit override to `catalog`. `defaultMode` belongs only
under `rfc64Catalog`; the deprecated public-only block remains scoped to its
manifest.

RFC-64 rollout configuration is snapshotted during daemon startup. Changes to
`defaultMode`, `contextGraphModes`, `killSwitch`, activation, policy, roster, or
provider bindings require a daemon restart. Finalized public VM reconciliation
remains chain-inventoried in every per-CG mode.

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

`autoPublish` is optional compatibility configuration for explicit bootstrap
authoring controls, including announcement peers and delegation bounds.
Release-native 10.0.16 responsibilities maintain their signed SWM inventories
and catalog projections from ordinary durable share/finalization lifecycle
events when current authority and signing capability are available. Receiver-
only nodes do not need `autoPublish`.

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
completion reasons. `rfc64Catalog.rollout` exposes `defaultMode`, the per-CG
mode map, and the kill-switch state. Its `configuration` block repeats the
privacy-safe effective default and counts overrides without revealing private
graph identifiers. On edges,
`runtimeSelection.selectedContextGraphs` is the current subscribed intersection
of the eligible runtime responsibilities, derived directly from the canonical
live subscription registry. Sync-scope tracking does not select RFC-64
independently. Bootstrap targets for eligible but unsubscribed CGs report
`inactive`.

The same block exposes `authorityRpcCircuit`, containing only `state`,
`consecutiveExhaustions`, and `retryAtMs`. `open` means authority reads are
cooling down after all configured RPC endpoints were exhausted; `half-open`
means one recovery probe is in flight; `closed` is normal. This status omits
endpoint URLs, RPC payloads, and graph identifiers.

```json
{
  "rfc64Catalog": {
    "rollout": {
      "defaultMode": "legacy",
      "killSwitch": false,
      "contextGraphModes": {
        "0x.../canary-cg": "shadow"
      }
    },
    "configuration": {
      "defaultMode": "legacy",
      "legacyOverrideCount": 0,
      "shadowOverrideCount": 1
    },
    "authorityRpcCircuit": {
      "state": "closed",
      "consecutiveExhaustions": 0,
      "retryAtMs": null
    }
  }
}
```

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

This release enables release-native RFC-64 responsibilities from ordinary DKG
lifecycle state and retains explicit bootstrap targets for compatibility and
controlled recovery. Authority remains fail-closed: registered graphs use
finalized chain state, private graphs require verified current membership, and
only an operator assertion may mark a provider graph-complete. Broad automatic
provider trust is not inferred from peer discovery.
