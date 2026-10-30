---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Async Queue Operations

The node runs two job queues. The share queue moves Knowledge Assets from Working Memory to Shared Working Memory. The publish queue moves them on to Verifiable Memory, once [Async Publisher Wallets](async-publisher-wallets.md) are set up. A client hands over the work and gets a job ID back at once. The node finishes the job in the background, even across restarts.

Most nodes need no changes. This page covers the four settings you might change. If you are writing a client, see [Async Share and Publish Jobs](../build/async-jobs.md). To find out where a node is slow, see [Monitor Store and Queue Pressure](backpressure-observability.md).

## Settings at a glance

All four take effect after a daemon restart.

| Setting | What it does | Default |
| --- | --- | --- |
| [Store control path](#store-control-path) | Gives queue bookkeeping its own store slots | On with Blazegraph or managed Oxigraph on more than 2 CPUs |
| [Write preflight sharing](#write-preflight-sharing) | Lets identical write checks share one store read | On |
| [Share retries](#share-retries) | How often a failed share is retried | 5 attempts |
| [Finished-job cleanup](#clean-up-finished-jobs) | Removes old finished jobs | Off |

## Store control path

The queues use the store constantly, to claim jobs and record progress. The control path gives them their own store slots, one for sharing and two for publishing, so they don't wait behind client queries and data writes.

**Default:** on for Blazegraph and managed Oxigraph stores on hosts with more than 2 CPUs. Off for other backends, including `sparql-http`, and on hosts with 2 CPUs or fewer. The embedded store never uses it.

**When to turn it off:** if share or publish jobs got slower after the update, or clients see more `503` answers with `"priority": "control"`. [Monitor Store and Queue Pressure](backpressure-observability.md) shows which log fields to compare.

**How:** add `"controlReservedSlots": 0` to the `store` block of `~/.dkg/config.json` and restart. `DKG_STORE_CONTROL_RESERVED_SLOTS=0` in the daemon's environment does the same and wins over the config. `"share:1,publisher:2"` in either setting turns the path on where it is off by default.

**What you'll see:** one start-up line that names the deciding setting. A value it cannot read logs a warning and leaves the path off.

```text
Store control path: on (added slots share=1 publisher=2; default for oxigraph-server, 8 CPUs; effective until daemon restart)
```

## Write preflight sharing

Before a write, the node checks that the target context graph exists and that the caller may write to it. When many writes from one caller to one graph arrive at once, they share one check.

It is on by default. To turn it off, set `DKG_WRITE_PREFLIGHT_COALESCING=0` in the daemon's environment and restart. The startup log then shows `Write preflight coalescing: off`.

## Share retries

A share that fails with a retryable error gets up to 5 attempts in all. The wait starts at about 1 minute and doubles each time, up to 15 minutes. To change this, set `maxRetries`, `retryBaseMs` or `retryMaxMs` in a `promoteQueue` block in `~/.dkg/config.json`. A new attempt limit applies only to new jobs; each job shows its limit as `maxAttempts`. An invalid value stops the daemon from starting.

A job that runs out of attempts stays `failed`. Read its last error, fix the cause, then recover it:

```bash
dkg ka share-job <job-id>
dkg ka recover-share-job <job-id>
```

## Clean up finished jobs

The queues keep every finished job until someone clears it. On a busy node the queue data keeps growing, and reads over it get slower. Cleanup removes these jobs 7 days after they finished:

- **Share queue:** succeeded jobs, and cancelled or rejected jobs that provably never started the share.
- **Publish queue:** finalized jobs, oldest first for each Knowledge Asset. An older failed job of the same asset holds the newer ones back until you clear it.

Every other failed job stays until you clear it, for inspection or recovery.

Cleanup ships for evaluation. Leave it off on production nodes until a later release says it is ready; to try it, run `report` mode, which removes nothing, on a node whose store is backed up.

Each queue has its own mode: `off` (the default), `report`, which counts what it would remove, or `delete`.

```json
{
  "queueRetention": {
    "share": { "mode": "report" },
    "publisher": { "mode": "report" }
  }
}
```

To change the 7-day window, set `succeededMaxAgeMs` and `benignFailedMaxAgeMs` (share) or `finalizedMaxAgeMs` (publisher), in milliseconds, 24 hours at least. A wrong value or unknown key stops the daemon at start. A mode already in `config.json` takes effect on the first start after an update.

**What you'll see:** the startup log shows `[retention] share retention started in report mode` (or `publisher`).

### Before you switch to delete

{% hint style="warning" %}
Removed jobs cannot be restored.
{% endhint %}

1. Run `report` for at least two weeks.
2. Check `wouldDelete` on the `async_promote_retention_pass` and `async_lift_retention_pass` log lines against what you expect to lose.
3. Just before you switch, back up both queue graphs: `urn:dkg:promote-queue:control-plane` and `urn:dkg:publisher:control-plane`.
4. Set `mode` to `delete` and restart.

### After a job is removed

Its status read returns `404`. A resend after a job succeeded or finalized is never joined to it, whether or not cleanup removed it. The window only sets how long status reads, `job-by-intent` and share reconciliation can still find the job, so keep it longer than your clients poll or reconcile.

### Cautions

- While cleanup is on, only the daemon may write the queue graphs: no scripts or other tools.
- On a node that has published one Knowledge Asset thousands of times, cleanup reads all of that asset's jobs each time it judges one of them, as a new publish of the asset does. It checks the older jobs only as far as its short time budget allows and keeps the rest of the asset's jobs for that pass, so there `report` counts fewer jobs than the first `delete` pass removes.
- A forward clock jump, or minutes of host sleep, pauses cleanup until a restart. Correct the clock, then restart.
