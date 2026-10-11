# Promote queue operations

The daemon configures the promote queue before its first access. Five attempts remain the default. Existing jobs retain the budget persisted when they were enqueued; changing configuration affects new jobs. The existing one-hour retry window for typed prerequisite failures can keep those jobs retrying beyond the attempt budget; these settings do not change that window.

```json
{
  "promoteQueue": {
    "enabled": true,
    "maxRetries": 5,
    "retryBaseMs": 60000,
    "retryMaxMs": 900000,
    "retryJitterRatio": 0.2
  }
}
```

The retry delay doubles from `retryBaseMs`, with symmetric multiplicative jitter, capped at `retryMaxMs`. Delay and budget values must be positive safe integers, the maximum delay must be at least the base delay, and jitter must be in `[0, 1]`. Invalid policy prevents daemon startup.

Local enqueue, recovery, resume and job writes invalidate the worker's idle claim hint. When no job can run, full scans occur at most once per second, with an earlier scan for a known retry or lease deadline. Out-of-process writes are discovered by the bounded poll. Queue state remains authoritative.

Automatic post-commit recovery is bounded by each job's persisted budget. Exhausted shares remain visible for operator recovery: inspect `GET /api/knowledge-assets/swm/share-jobs/:jobId`, correct the prerequisite, then use `POST /api/knowledge-assets/swm/share-jobs/:jobId/recover`. Recovery follows the existing replay-safety checks; configuration does not automatically reset exhausted jobs or bypass an ambiguous started promote.
