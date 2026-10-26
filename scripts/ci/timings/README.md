# Agent shard timing baseline

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
