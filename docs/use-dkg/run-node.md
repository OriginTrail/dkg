---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Daemon Lifecycle

Common commands:

```bash
dkg start
dkg start -f
dkg stop
dkg status
dkg logs
dkg auth show
dkg auth rotate
```

The daemon API defaults to:

```text
http://127.0.0.1:9200
```

The Node UI defaults to:

```text
http://127.0.0.1:9200/ui
```

## Core Node Profile Registration

The two node roles are `edge` and `core`.

An Edge Node can run, sync, query, and serve local agents without an on-chain node profile. A Core Node needs an on-chain profile because Storage ACKs, Random Sampling, staking, and node-operator authorization use its numeric `identityId`.

Initialize a Core Node explicitly:

```bash
dkg init --role core --network mainnet-gnosis
dkg start
```

`dkg init` writes `nodeRole: "core"` to `~/.dkg/config.json` and creates `~/.dkg/wallets.json` if it does not exist. A fresh wallet file contains one admin wallet and three operational wallets. The admin wallet is used for profile/key-management transactions; the primary operational wallet creates the profile, signs node operations, and pays the initial staking transaction.

Before registration, fund the Core wallets for the selected network:

| Wallet | Needed for |
| --- | --- |
| Primary operational wallet | Native gas token and TRAC for profile creation, TRAC approval, and the initial staking conviction |
| Other operational wallets | Native gas token for node operations and publishing |
| Admin wallet | Native gas token for key-management transactions, including registering additional operational wallets |

Async publisher wallets are separate transaction signers stored in `publisher-wallets.json`. They need native gas plus PCA registration or TRAC for direct spend, but they do not need to be operational wallets unless you want them to carry a node identity for publisher-node attribution. See [Async Publisher Wallets](async-publisher-wallets.md).

On `testnet`, setup attempts to fund these generated wallets automatically when the faucet is reachable. On `mainnet-gnosis` and `mainnet-base`, fund them yourself. Use:

```bash
dkg wallet
```

### What The Daemon Does

At Core startup the daemon reads the primary operational wallet's on-chain identity:

1. If `identityId > 0`, the node uses the existing profile.
2. If `identityId == 0` and `nodeRole` is `core`, it calls the profile provisioning path.
3. If `identityId == 0` and `nodeRole` is `edge`, it skips profile creation.

The Core provisioning path sends `Profile.createProfile` from the primary operational wallet, sets the generated admin wallet as the profile admin, and does not pass extra operational keys in the initial call. It then approves TRAC to `StakingV10` and calls `DKGStakingConvictionNFT.createConviction(identityId, stakeAmount, lockTier)`. The current daemon default attempts to stake `50000` TRAC with lock tier `1`.

After the profile exists, the daemon can also register additional operational wallets for ACK signing. That follow-up path requires the admin wallet.

### Manual registration with an external admin key

If the operator does not want to store the admin wallet private key on the node host, do not rely on `POST /api/identity/ensure` for initial setup. That route is the daemon convenience path and requires `adminPrivateKey` for profile creation and later profile/key-management repair transactions.

Instead:

1. Run `dkg init --role core --network <network>` on the node host.
2. Run `dkg wallet` and collect the admin wallet address plus all operational / ACK wallet addresses. Treat the primary operational address as `op1`.
3. Register the profile manually on-chain:
   * If signing from the primary operational wallet, call `Profile.createProfile(adminAddress, [op2, op3, ...], nodeName, nodeId, initialOperatorFee)`.
   * If signing from the external admin wallet, call `Profile.createProfile(adminAddress, [op1, op2, op3, ...], nodeName, nodeId, initialOperatorFee)`.

Include all operational / ACK wallets in the initial `createProfile` call if the admin key will not be present on the node host. Otherwise the daemon cannot later run `addOperationalWallets`, because that repair path requires the admin private key. If `dkg init` generated the admin key on the host, move that private key into the external signer according to your key-management process and make sure the node host does not retain it.

After profile creation, stake from the primary operational wallet:

1. Approve TRAC to the `StakingV10` contract address resolved from the Hub.
2. Call `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`.
3. Verify `IdentityStorage.getIdentityId(op1)` or `GET /api/identity` returns a non-zero `identityId`.

Once this is done, the daemon should discover the existing profile on startup instead of creating one.

### Manual Trigger

If the daemon started before the wallets were funded, or a transient RPC failure left identity unresolved, fix the funding or RPC issue and trigger registration without restarting:

```bash
TOKEN=$(dkg auth show)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9200/api/identity/ensure
```

The response is:

```json
{
  "identityId": "123",
  "hasIdentity": true
}
```

Registration is complete when `identityId` is not `"0"` and `hasIdentity` is `true`.

You can also check the read-only status:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/identity
curl http://127.0.0.1:9200/api/status
```

After identity exists, set the node ask if this Core Node should advertise a non-default ask:

```bash
dkg set-ask <amount>
```

For prover binding status, use:

```bash
dkg random-sampling status --json
```

### If Staking Fails After Profile Creation

Profile creation and staking are separate transactions. If `Profile.createProfile` succeeds but the TRAC approval or `createConviction` transaction fails, the node keeps the new `identityId`; the profile is not rolled back.

In that case, `POST /api/identity/ensure` will report the existing identity and will not submit a second automatic stake. Stake manually after funding the operational wallet:

1. Approve TRAC to the `StakingV10` contract address resolved from the Hub.
2. Call `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`.
3. Confirm the node's stake appears for that `identityId`.

Use the same `identityId` returned by `/api/identity`. Do not create another profile for the same node wallet, and do not use legacy V8 staking paths for V10 Core stake recovery.

If an agent gets auth errors, first identify the caller:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agent/identity
```
