# Shard timing baselines

## Agent

`agent-shard-policy.json` owns lane configurations, shard topology, reserved
overhead, and expected JUnit filenames for both the planner and refresher.
`agent.json` records suite durations from all agent JUnit artifacts of the
successful main run identified in its `source` field. These timings include
per-file hooks; the planner adds 1.1 seconds per file for collection/import
overhead observed in that run. Global Hardhat setup is shared only by the five
integration shards. Six shards use the existing hermetic unit configuration.
Shard 11 reserves 160 seconds for the RFC-64 evidence and process-death sidecar
steps (`matrix.sidecars`): 40 seconds for the existing evidence steps and 120
seconds for the three-boundary catalog durability campaign. The latter runs six
serial disposable workers, with no full devnet bootstrap, and has a four-minute
step deadline. Calibrate its reservation from successful CI timings when available.
In September 2026 CI runs the original evidence steps took about 31 seconds
together: the rollout certificate about 20 s, Gate 1 live evidence about 10 s,
and the Gate 0 unit tests about 1 s.

The fifth integration shard leaves artifact-upload time inside the existing
ten-minute job budget. With four shards, CI run 39720748357 passed all 763 tests
on shard 2 in both attempts (561/572 seconds), then the job timed out during
artifact handling and could not satisfy the merged coverage gate. Test inventory,
unit-shard count, deadlines and coverage requirements are unchanged.

The planner discovers eligible files using both actual Vitest configurations,
then partitions the full suite into disjoint integration and unit sets. The
checked-in timings determine distribution, never eligibility. New or previously
skipped-only files get a conservative 60-second body estimate and are reported
as unmeasured. Stale baseline entries do not add tests to a run.

To refresh from a successful full run:

```sh
gh run download RUN_ID --repo OriginTrail/dkg --pattern 'vitest-agent-*' --dir REPORTS
python3 scripts/ci/refresh-agent-timings.py REPORTS \
  --run-id RUN_ID --commit FULL_COMMIT_SHA --output scripts/ci/timings/agent.json
node --test scripts/lib/__tests__/agent-ci-shards.test.mjs scripts/lib/__tests__/agent-timing-refresh.test.mjs
```

Use a fresh report directory containing exactly that run's expected artifacts.
The refresher requires every report identity from the policy and rejects missing,
duplicate, or unexpected report names. To refresh a historical run with a
different topology, pass `--policy PATH` pointing to that run's policy snapshot. The
refresh tool accepts extracted XML or downloaded ZIPs, rejects duplicate or
failed suites, and does not turn skipped-only tests into zero-cost weights.
Review the diff and the estimated shard loads before committing it. Do not
refresh the baseline from arbitrary PR-provided reports in a privileged job.

## CLI and chain

`cli.json` and `chain.json` weight the shards that `plan-vitest-shard.mjs`
plans for the CLI and chain lanes. For every test file each records the median,
over the successful runs in `sources`, of its Vitest file duration: the file
task's `result.duration`, its hooks and tests without import. Vitest prints that
number on the file's line in the job log and as the JUnit `testsuite` `time`.
`perFileOverheadMs` is the median import (collection) time per file in those
runs' Vitest summaries; transform time is cached across files, so it is mostly a
per-shard cost and is left out. A median over several runs matters for the CLI,
whose subprocess suites vary by up to two times between runners: the
knowledge-asset smoke suite took 103 to 200 seconds in the November 2026 source
runs.

Unlike the agent baseline, skipped-only files are recorded at 0 ms. CI always
skips them (`blazegraph-integration` and `publisher-findings.local` in the CLI),
and the 60-second fallback would put two minutes of phantom load on CLI shards.
New files still get the 60-second fallback until a refresh measures them.
`estimatedBodyWeightsMs` holds reviewed weights for files that no source run has
measured yet, passed as `--estimate test/NAME.test.ts=MS`. The planner treats
them as known, and the refresher refuses an estimate for a file it measured, so
the next refresh retires them. The current estimates are for the three suites
split from `knowledge-asset-cli-smoke.test.ts`: each is the sum of its tests'
median durations in the source runs.

To refresh, put each recent successful run's shard job logs (push or merge
queue) into a directory of its own. Logs carry the import summary and outlive the
14-day JUnit artifacts:

```sh
RUN=RUN_ID
mkdir -p REPORTS/$RUN
for job in $(gh api "repos/OriginTrail/dkg/actions/runs/$RUN/jobs?per_page=100" --paginate \
    --jq '.jobs[] | select(.name | test("^(Bura: cli|Tornado: chain) \\[")) | .id'); do
  gh api --allow-escape-sequences "repos/OriginTrail/dkg/actions/jobs/$job/logs" > "REPORTS/$RUN/$job.log"
done
node scripts/ci/refresh-vitest-timings.mjs cli --output scripts/ci/timings/cli.json \
  RUN_ID:FULL_COMMIT_SHA:REPORTS/RUN_ID ...
node scripts/ci/refresh-vitest-timings.mjs chain --output scripts/ci/timings/chain.json \
  RUN_ID:FULL_COMMIT_SHA:REPORTS/RUN_ID ...
node --test scripts/lib/__tests__/vitest-shards.test.mjs scripts/lib/__tests__/vitest-timing-refresh.test.mjs
```

The JUnit artifacts (`gh run download RUN_ID --pattern 'vitest-cli-*'` or
`--pattern 'vitest-tornado-core-chain-*'`) give the same per-file numbers but no
import time, so pass `--per-file-overhead-ms` with them. Every run must provide
each shard report (`cli-1.xml` to `cli-N.xml`, named in the log's `JUNIT report
written to` line) exactly once, with N taken from `scripts/lib/ci-lanes.mjs`;
pass `--shards N` for runs of another topology. The refresher rejects failed or
incomplete shards, files that ran in two shards and unsafe paths. It skips other
packages' reports and drops measured files that no longer exist. Review the
estimated shard loads (`node scripts/ci/plan-vitest-shard.mjs cli 1` and so on)
before committing.
