# Two-laptop test for the V10 invite + sync + publish flow

End-to-end smoke test of the curated context-graph invite flow, encrypted
SWM gossip, and on-chain publish — exercised across two real DKG nodes
on the public V10 testnet (Base Sepolia + the public relays in
`network/testnet.json`).

The test is automated in [`scripts/two-laptop-test.sh`](../../scripts/two-laptop-test.sh).
This doc covers the bring-up. The script can run from either laptop or a
third machine; it just calls each node's HTTP API.

## Prerequisites

- Both laptops have **Node.js 22+** and **pnpm 10+**.
- Both wallets are **already funded** on Base Sepolia (ETH + TRAC). If
  not, see [the testnet faucet guide](../setup/TESTNET_FAUCET.md).
- You can reach each node's API from wherever you'll run the script
  (see [reachability](#reachability) below).

## 1. Per-laptop bring-up

Run on **both** laptops:

```bash
git clone https://github.com/OriginTrail/dkg.git
cd dkg
# Use the merged release tag for the V10 RC that contains the
# agent-delegation + SWM-encryption-fix work. As of this writing that
# is the latest `v10.0.0-rc*` tag on `main`. If you need to test an
# unmerged branch, substitute its name here AND match the autoUpdate
# branch below — but expect the doc to drift if the branch is later
# rebased or deleted.
git checkout main                        # or: git checkout v10.0.0-rc.6
pnpm install
pnpm build
pnpm dkg init                            # name + EVM key (already-funded wallet); accept defaults
```

**Critical: disable auto-update before starting.** The default testnet
config tracks `main`, which can move under you mid-test:

```bash
# edit ~/.dkg/config.json — set autoUpdate.enabled to false
node -e '
  const fs=require("fs"),p=`${process.env.HOME}/.dkg/config.json`;
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.autoUpdate=Object.assign({},c.autoUpdate,{enabled:false});
  fs.writeFileSync(p,JSON.stringify(c,null,2));
  console.log("autoUpdate disabled");
'
```

Then start the daemon:

```bash
pnpm dkg start -f                        # foreground; watch the logs
```

Look for these lines on each node:

```
Network config: DKG V10 Testnet
PeerId: 12D3KooW...
Circuit reservation granted (...)        # registered with a public relay
API listening on http://127.0.0.1:9200
```

If you don't see "Circuit reservation granted", the node failed to
reserve a relay slot — check firewall / network. The invite flow needs
the curator's PeerId to be reachable, which on testnet means
relay-routed.

## Reachability

The test script needs to call **both** nodes' HTTP APIs. Pick whichever
of these fits your setup:

### Option A — SSH local-port-forward (recommended)

From the machine where you'll run the script (often laptop A):

```bash
# leave the local node listening on 127.0.0.1:9200 (default)
ssh -L 19200:localhost:9200 user@laptop-B
# now laptop B's API is reachable as http://localhost:19200 from your script-runner
```

### Option B — bind both APIs to 0.0.0.0 + use LAN IPs

On both laptops, edit `~/.dkg/config.json`:

```json
{
  "apiHost": "0.0.0.0",
  "listenPort": 9200
}
```

Restart the daemons. Then use `http://<laptop-A-LAN-IP>:9200` and
`http://<laptop-B-LAN-IP>:9200`. **Note:** binding the API to all
interfaces with the auth token still required, but exposes the API
to your LAN. Don't do this on untrusted networks.

## 2. Run the test

From whichever machine you set up reachability on:

```bash
# grab the auth tokens from each laptop (one-liner via SSH or just
# cat them on each machine)
N_A_TOKEN=$(ssh user@laptop-A 'grep -v "^#" ~/.dkg/auth.token | tr -d "[:space:]"')
N_B_TOKEN=$(ssh user@laptop-B 'grep -v "^#" ~/.dkg/auth.token | tr -d "[:space:]"')

N_A_API=http://localhost:9200  N_A_TOKEN="$N_A_TOKEN" \
N_B_API=http://localhost:19200 N_B_TOKEN="$N_B_TOKEN" \
  ./scripts/two-laptop-test.sh
```

The script runs through ten steps and exits non-zero on any failure:

| # | Step | Expected |
|---|---|---|
| 0 | Identify both nodes (peer-id + agent-address via `/api/agents`) | both resolve |
| 1 | Node A creates curated CG with `[A]` allowlist | `accessPolicy=private` written |
| 2 | Node A writes WM (working-memory) data into a `widget-info` assertion | 2 quads written |
| 3 | Node B `subscribe` (not allowlisted yet) | catch-up status = `denied` |
| 4 | Node B `sign-join` + `request-join` carrying A's peer-id | `delivered ≥ 1` |
| 5 | Node A `/join-requests` shows B's pending request | `found = yes` |
| 6 | Node A `approve-join` for B's address | `ok = true` |
| 7 | Node B re-subscribes → catch-up = `done`, `_meta` arrives | `_meta` triple count > 0 |
| 8 | Node A promotes WM → SWM, **B receives the encrypted gossip** | B sees the entity within `SWM_GOSSIP_TIMEOUT` (default 30s) |
| 9 | Node A registers CG on-chain, then publishes SWM → VM | `kcId` returned |
| 10 | Both A and B see VM data (VM is on-chain → public) | non-empty VM count |

Step 8 is the regression check for the SWM Sender-Key encryption work
(merged from main as PR #453, with the publish-side fix `43a9d25a` for
the `assertionPromote` path that was missed). Step 9-10 verifies the
on-chain publish path against real Base Sepolia.

## 3. Tweaking timeouts

Real testnet is much slower than devnet — relay-routed peer dial,
gossip propagation, and on-chain settlement all add real seconds. The
defaults err on the side of patience but you can tune via env:

| Env | Default | What it bounds |
|-----|---------|---------------|
| `DENIED_TIMEOUT` | 60 | step 3 catch-up = denied |
| `APPROVED_TIMEOUT` | 180 | step 7 catch-up = done (post-approval, full multi-peer fan-out) |
| `SWM_GOSSIP_TIMEOUT` | 30 | step 8 promote-gossip propagation A → B |
| `VM_SYNC_TIMEOUT` | 60 | step 10 VM appears on each node |
| `ONCHAIN_REGISTER_SLEEP` | 5 | post-register settle before publish |
| `TEST_PUBLISH` | 1 | set `0` to skip steps 9-10 (no gas) |

## 4. UI verification (optional but worth doing once)

After the script passes, open `http://localhost:9200/ui` on each
laptop and verify the user-facing surface (`JoinProjectModal`,
`ShareProjectModal`, Participants view, project subscription state):

- Laptop A: project tab shows the new CG with status `Subscribed`, B
  listed under Participants.
- Laptop B: project tab shows the same CG, the `widget-info` assertion
  visible in SWM.

The UI uses the same endpoints the script exercises, so a green script
strongly implies a green UI.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not resolve Node X's agent address` | Auth token wrong or daemon not running | `pnpm dkg status` on the failing node; check `~/.dkg/auth.token` matches what you're passing |
| Step 3 stays `running` past timeout | B never got the catch-up "denied" verdict — A's CG creation didn't gossip OR no peer connection yet | Check both `pnpm dkg peers` lists — both should see each other after relay reservation |
| Step 4 `delivered = 0` | Curator's peer-id couldn't be dialed (no relay route) | Verify A's "Circuit reservation granted" line; restart A if missing |
| Step 7 hits `APPROVED_TIMEOUT` | Catch-up multi-peer fan-out is unusually slow on testnet | Bump `APPROVED_TIMEOUT=300` and re-run from step 7 only by reusing the same `CG_ID` (TODO: not yet supported) |
| Step 8 fails (B never sees SWM) | The encryption fix `43a9d25a` is missing — both nodes must be on `followup/436-ui-fixes` post-merge | `git log --oneline | head -5` on both nodes; rebuild + restart |
| Step 9 register fails with "insufficient funds" | The agent wallet ran out of Base Sepolia ETH | Re-fund via [the testnet faucet](../setup/TESTNET_FAUCET.md) |
| Auto-update kicked in mid-test | `autoUpdate.enabled` wasn't set to false | Edit `~/.dkg/config.json` per step 1, restart, re-run |
