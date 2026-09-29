# misc

Archived one-offs that used to sit at the repository root. Nothing here is
built, tested, packaged or read by a running node. It is kept for reference and
for the hand-run scripts noted below.

| Path | What it is |
|---|---|
| `snapshots/` | V8 → V10 publisher refund data from 8–10 April 2026: per-chain epoch-16 publisher snapshots (Base, Gnosis, NeuroWeb) and the per-publisher distribution totals. Many of the timestamped files are empty output from aborted runs, and `gnosis+base wallets.zip` holds copies of two JSONs already in the folder. `snapshot-100-15.json` is a separate Gnosis epoch-15 staker/delegator snapshot from `scripts/epoch-snapshot.ts`, which writes to the current directory. |
| `sample-data/big-publish.ttl` | Synthetic ~550-triple knowledge graph (AI research landscape, `urn:dkg:` IRIs), used for manual large-publish testing in March 2026. |
| `codex-review/` | Prompt and output schema of the Codex PR-review workflow, which was removed in [#1211](https://github.com/OriginTrail/dkg/pull/1211). The files were kept so a local agent can be pointed at them for a manual review. The prompt still describes the V9 repository. |

## Scripts that use `snapshots/`

The mainnet-ops scripts below are run by hand with `npx tsx` and read or write
`misc/snapshots/`:

- `scripts/publisher-epoch-snapshot.ts`, `scripts/publisher-epoch-snapshot-fast.ts`
- `scripts/generate-aggregates.ts`
- `scripts/chain-analysis.ts`
- `scripts/distribute-publisher-trac.ts`

`distribute-publisher-trac.ts` records transfers it has already sent in an
untracked `<chain>_distribution_ledger.json` in this folder, so it does not pay
twice. If you have such a ledger under the old root `snapshots/` folder, move it
to `misc/snapshots/` before running the script again.
