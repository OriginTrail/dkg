---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Knowledge Asset Lifecycle CLI

Use `dkg knowledge-asset ...` or its short alias `dkg ka ...` for named Knowledge Asset work:

```mermaid
flowchart LR
  Create["create"] --> Write["write"]
  Write --> Finalize["finalize / seal"]
  Finalize --> Share["share to SWM"]
  Share --> Publish["publish to VM"]
```

## One-shot WM to SWM

```bash
dkg ka create notes \
  --context-graph-id my-project \
  --input-file ./notes.ttl \
  --share
```

This creates the KA named `notes`, writes RDF from `--input-file`, finalizes the draft, and shares it to Shared Working Memory. It does not publish to Verifiable Memory.

`-f` is a short alias for `--input-file`. Prefer `--input-file <path>` in scripts and docs so the local payload source is never confused with the positional KA `<name>`.

## Step-by-step Lifecycle

```bash
dkg ka create notes -c my-project
dkg ka write notes -c my-project --input-file ./notes.ttl
dkg ka finalize notes -c my-project
dkg ka share notes -c my-project
dkg ka publish notes -c my-project
```

Use `dkg ka publish-async notes -c my-project` for an async VM publish job. `dkg publisher publish-async my-project notes` remains an operational alias.

Async VM publish requires the async publisher to be enabled and backed by publisher wallets with native gas plus PCA registration or TRAC for direct spend. Publisher wallet node identity is optional attribution: if the wallet resolves to identity `0`, the publish runs in no-attribution mode. Use `--publisher-node-identity-id 0` to force no-attribution for one publish. See [Async Publisher Wallets](async-publisher-wallets.md).

## Editing a published Knowledge Asset

```bash
dkg ka pull-from notes -c my-project --layer vm
dkg ka write notes -c my-project --input-file ./notes-v2.ttl
dkg ka finalize notes -c my-project
dkg ka share notes -c my-project
dkg ka publish notes -c my-project
```

`pull-from` re-opens the published (or shared) content as a new WM draft; `--on-conflict replace` replaces a draft that already exists. An update is published as the version **one above the KA's latest confirmed version**, and `finalize` seals the draft with that number (`assertionVersion` in the `wm/finalize` response). Because the number comes from the confirmed version, a finalized draft that you abandon — you edit again, discard it, or `pull-from` over it — does not use up a number: the next draft is numbered the same.

If a finalized update carries a different number (it was sealed by an older node, or the published version moved on in the meantime) the node refuses it before anything is staged or sent — `409 PUBLISH_INTENT_STALE`, naming the two numbers — instead of failing later as a retryable publish error. Recover with `dkg ka pull-from <name> -c <cg> --layer swm` (`--layer vm` when the published version moved on; then re-apply your edits), `finalize`, `share`, and publish again. An async publish job that already failed for the KA keeps owning it until it is cleared (`dkg publisher clear failed`, or `POST /api/publisher/clear-job` for one job); retry skips a job whose budget is spent.

A core that already ACK-signed the abandoned draft declines its replacement transiently for a few minutes (`DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS`, 5 minutes by default); retry the publish after that. Peers that already hold an earlier shared draft of the KA may keep showing it in Shared Working Memory until the update is published. Finalizing a replacement draft also replaces the private payload sealed under the same number, so an earlier shared draft that carried private content can no longer be re-opened from Shared Working Memory once its replacement is finalized.

## Async share recovery

Use `dkg ka share-job <job-id>` to observe an accepted async share. A `failed_retrying` job follows the queue's existing backoff and attempt limit; do not submit another share to restart it.

If the worker cannot save or read a promotion failure, the `async_promote_failure_bookkeeping_uncertain` log event identifies the affected job and bookkeeping stage. This event does not establish whether promotion changed SWM. A result already saved in the queue remains authoritative. Otherwise, the job can remain `running` until its lease expires (15 minutes by default), after which ordinary queue polling or startup recovery reconciles it. A started promotion with uncertain effects becomes an explicit **partial promote ambiguity** inspection hold. Inspect its SWM/VM state before recovery; do not blindly reshare or reset its retry budget.

Genuine fatal operation failures still become terminal, and a successfully saved retryable failure still uses normal automatic retry. A bookkeeping outage alone does not justify an immediate fatal asset verdict.

## Command Reference

| Command | Purpose |
|---|---|
| `dkg ka create <name> -c <cg> [--input-file <rdf>] [--share]` | Create a WM draft; optionally write/finalize/share in one call |
| `dkg ka write <name> -c <cg> --input-file <rdf>` | Append RDF payload quads |
| `dkg ka import-file <name> -c <cg> --input-file <file>` | Extract a local document into WM |
| `dkg ka extraction-status <name> -c <cg>` | Check document extraction status |
| `dkg ka finalize <name> -c <cg>` | Seal the WM draft |
| `dkg ka share <name> -c <cg>` | Share finalized WM to SWM |
| `dkg ka share-async <name> -c <cg>` | Enqueue async WM-to-SWM share |
| `dkg ka share-jobs [--context-graph-id <cg>] [--state <states>] [--limit <n>]` | List async share jobs |
| `dkg ka share-job <job-id>` | Show one async share job |
| `dkg ka cancel-share-job <job-id>` | Cancel a queued/retrying share job |
| `dkg ka recover-share-job <job-id>` | Recover a failed share job |
| `dkg ka publish <name> -c <cg>` | Synchronously publish finalized, fully shared SWM to VM |
| `dkg ka publish-async <name> -c <cg> [--publisher-node-identity-id 0]` | Enqueue VM publish |
| `dkg ka pull-from <name> -c <cg> --layer swm|vm` | Seed WM from SWM or VM |
| `dkg ka discard <name> -c <cg>` | Discard a WM draft |
| `dkg ka query <name> -c <cg>` | Read WM quads |
| `dkg ka history <name> -c <cg>` | Read lifecycle descriptor |

`dkg assertion ...` remains as compatibility for older document import/query/promote flows. New docs and agents should prefer `dkg ka ...`.
