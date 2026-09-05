# Agent shard timing baseline

`agent-shard-policy.json` owns lane configurations, shard topology, reserved
overhead, and expected JUnit filenames for both the planner and refresher.
`agent.json` records suite durations from all agent JUnit artifacts of the
successful main run identified in its `source` field. These timings include
per-file hooks; the planner adds 1.1 seconds per file for collection/import
overhead observed in that run. Global Hardhat setup is shared only by the four
integration shards. Six shards use the existing hermetic unit configuration.
Shard 10 reserves another 40 seconds for the rollout and Gate 1 evidence steps.

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
