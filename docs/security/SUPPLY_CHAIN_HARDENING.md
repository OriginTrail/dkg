# Supply-chain hardening — OriginTrail/dkg

This document is the single source of truth for the supply-chain controls
that protect the repo, its CI, and the npm packages it ships. It is the
human-readable side of the policies enforced by the files in this same PR
(workflow SHA-pins, `dependabot.yml`, `supply-chain-scan.yml`, `.npmrc`)
plus the admin-only changes that must be applied via the GitHub UI or
`gh` CLI by a maintainer with appropriate permissions.

The threat model is the **TeamPCP campaign** (March 2026, CVE-2026-33634)
and equivalent supply-chain compromises — tag-poisoning of consumed
GitHub Actions, credential-stealer injection in `pull_request_target`
workflows, and self-propagating npm worms like CanisterWorm.

If you are reading this because something looks compromised, jump to
[§Incident response](#incident-response).

---

## Controls already enforced by code in this repo

### 1. Every GitHub Action is pinned to a full commit SHA

Every `uses:` line in `.github/workflows/*.yml` references an action by
**full 40-character commit SHA**, never by a `vN` tag. Each pin carries
a `# vX.Y.Z` comment so humans can see the version at a glance.

Why: the TeamPCP attackers force-pushed 75 of 76 `aquasecurity/trivy-action`
tags to malicious commits. Anyone consuming the action by tag would have
silently run the credential stealer; consumers pinned to a SHA were
unaffected because GitHub commits are immutable.

Enforced by: `supply-chain-scan.yml` runs `zizmor --persona auditor
--min-severity low` on every PR. Tag pins fail the check.

### 2. Every workflow declares an explicit minimum `permissions:` block

`ci.yml`, `knip.yml`, and `evm-integration.yml` declare `permissions:
contents: read` at the workflow root. `release.yml` and
`npm-continuous-publish.yml` keep `contents: read` at root and narrow
write scopes to the single job that needs them. `codex-review.yml` has
always had this.

Why: without an explicit block, the `GITHUB_TOKEN` inherits the
permissive legacy default. A successful code-execution exploit on any
step then has a write-default token in the runner environment.

### 3. No `pull_request_target`, `workflow_run`, or `issue_comment` triggers

This is verified by inspection (see the matching gh-actions audit notes
in the v10-ui-tests PR review). `pull_request_target` is the trigger
class TeamPCP exploited to plant the initial foothold against Aqua
Security. We do not use it anywhere; `codex-review.yml` uses the safer
`pull_request` event AND additionally guards on
`github.event.pull_request.head.repo.full_name == github.repository`
to short-circuit fork PRs.

### 4. `npm-continuous-publish.yml` separates verification, code execution, and credential access

The workflow is split into **three** jobs so the credential-bearing job
never runs repository or package code:

- `verify-environment` — **no** `environment:`, **no** `NPM_TOKEN`,
  **no** repo checkout. Queries the `npm-publish` environment via the
  GitHub REST API and asserts:
  1. environment exists,
  2. has ≥1 required reviewer,
  3. `prevent_self_review` is true,
  4. a `wait_timer > 0` is configured,
  5. `deployment_branch_policy` restricts the environment to the
     release branch (`main`) — either via "protected branches only" or
     an explicit custom allow-list containing `main` and no wildcards.
  All five checks fail-closed. The job only has `contents: read` +
  `actions: read` (the minimum scope for the environments API).
- `build-and-pack` — `needs: verify-environment`. **No** `environment:`,
  **no** `NPM_TOKEN`. Runs `pnpm install`, `pnpm build`, bumps each
  public package to the dev pre-release suffix, then `pnpm pack`s each
  one (`prepack`/`prepare` lifecycle hooks run HERE, with no
  credentials in scope). Tarballs and a `SHASUMS256.txt` manifest are
  uploaded as a workflow artifact.
- `publish` — `needs: [verify-environment, build-and-pack]`,
  `environment: npm-publish`, `permissions: { contents: read,
  id-token: write }`. This is the ONLY job that has `NPM_TOKEN` in its
  env. It does NOT check out the source tree (nothing for `npm publish
  <tarball>` to consume from it), downloads the artifact, re-verifies
  `SHASUMS256.txt` against the downloaded tarballs, and runs
  `npm publish <tarball> --ignore-scripts --provenance --tag dev`
  for each tarball. `--ignore-scripts` is mandatory: lifecycle hooks
  do not run with `NPM_TOKEN` in scope on the publish job.

Why the three-way split: GitHub resolves `environment:` and injects its
secrets **before** the first step of a job runs. A verification step
that lives inside the publish job cannot prevent NPM_TOKEN exposure —
by the time step 1 logs `Run …`, the secret is already in the runner's
env. Promoting verification to a sibling preflight job is the
structural fix for environment misconfiguration. Separating
build-and-pack from publish is the structural fix for the larger gap
the security review called out: a credential-bearing job that also
runs repository/package code is one rogue `postinstall` away from an
exfiltration. Splitting build from publish closes that door.

When the environment is correctly configured, the publish job pauses
for reviewer approval + the configured wait timer before `NPM_TOKEN`
becomes accessible to its single `npm publish` step.

**`--tag dev`, not `--tag latest`**: continuous publishes go to the
`dev` npm dist-tag so `npm install <pkg>` keeps resolving to the most
recent intentional release. A bad merge that gets through the env gate
cannot become the default install target by accident. `latest` is
reserved for signed releases promoted through `release.yml`.

**`--provenance`** + `id-token: write` mint an in-toto SLSA provenance
attestation for every tarball. Consumers verify via `npm view <pkg>@<ver>
--json` → `dist.attestations.provenance.url`. The attestation does not
replace `NPM_TOKEN` authentication today; it is the precondition for
the npm Trusted Publishing migration in §F that retires `NPM_TOKEN`
entirely.

**Disable mechanism** (replaces the older "remove the NPM_TOKEN repo
secret" approach, which stopped working once the token moved into the
environment per §C step 4):

- **Recommended**: disable the workflow from the Actions UI (Actions
  tab → Continuous NPM Publish → `…` → Disable workflow). The push
  trigger goes inert immediately, no code change required.
- **Alternative**: delete the `npm-publish` GitHub Environment in repo
  Settings → Environments. The `verify-environment` job then fails
  closed (it cannot find the environment), publish never starts, and
  `NPM_TOKEN` is never injected into a runner.

### 5. Lifecycle scripts of dependencies are blocked by default

pnpm 10 refuses to run any package's `preinstall` / `install` / `postinstall`
unless the package is listed in the repo-root `package.json`'s
`pnpm.onlyBuiltDependencies` allowlist. Today that list is:
`better-sqlite3`, `esbuild`, `oxigraph`, `protobufjs`. The list lives at
`/package.json` and is reviewed in every PR.

Why: CanisterWorm spread via `postinstall` hooks. A poisoned transitive
dep cannot execute on our runners without explicit allowlisting.

`.npmrc` documents this and pins `verify-store-integrity=true` so a
locally-cached tarball that was tampered with after the fact fails the
SHA-256 verification on next install.

### 6. Dependabot is enabled for `github-actions` and `npm`

`.github/dependabot.yml` opens weekly PRs to bump:
- every `uses:` SHA when upstream cuts a new release (one grouped PR
  for first-party `actions/*` updates; individual PRs for third-party
  actions so each can be reviewed in isolation);
- every direct npm dep (one PR per runtime dep so behaviour changes
  are reviewable in isolation; dev/build tooling and the hardhat
  ecosystem are grouped to manage review noise);
- every **transitive** runtime npm dep, grouped into a single weekly
  PR via the `transitive` group on `dependency-type: production` +
  `update-types: [minor, patch]`. Earlier revisions applied an
  `allow: dependency-type: direct` filter which blocked transitive
  fixes from appearing as normal weekly PRs and silently relied on
  Dependabot security alerts to catch them. That gap is closed: a
  transitive-only CVE fix now reaches reviewers within a week of
  upstream landing the patch, regardless of whether GitHub's
  security-advisory feed has indexed it yet.

Why: the cheapest defence against a zero-day in a dep we already pull is
to land the patched version fast. Manual lockfile bumps slip; automated
PRs with release notes do not.

### 7. Static analysis of every workflow file on every PR

`.github/workflows/supply-chain-scan.yml` runs three audits whenever a
PR touches `.github/workflows/`, `.github/actions/`, `.github/dependabot.yml`,
`.github/zizmor.yml`, `pnpm-lock.yaml`, any `package.json`, or `.npmrc`
(and weekly via cron). The scan target covers both `.github/workflows/`
AND `.github/actions/` (added conditionally when the directory exists)
so a future composite action cannot inherit the workflow trust boundary
without going through the same gate.

- **zizmor** (`--persona auditor --min-severity low`) — flags
  PWN-request misconfigs, unpinned actions, unsafe expansions in
  `run:` blocks, missing permissions blocks, cache-poisoning vectors,
  and credential-persistence patterns. Critically, the workflow passes
  `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` so zizmor's four ONLINE
  audits run too:
  - `impostor-commit` — verifies the pinned SHA actually exists on the
    action's repo history. **This is the exact audit that would catch
    a TeamPCP-style tag-poisoning attack** (where the SHA points at a
    commit from a fork's branch rather than the maintainer's tree).
  - `ref-confusion` — branch/tag/SHA naming ambiguity.
  - `known-vulnerable-actions` — maintained CVE list.
  - `stale-action-refs` — pin is far behind upstream.
- **actionlint** — workflow syntax + schema linter, with `shellcheck`
  sub-linter enabled. Installed from the GitHub release asset
  `actionlint_<VERSION>_linux_amd64.tar.gz` with the SHA-256 digest
  pinned verbatim in the workflow (resolved from the upstream
  release's `actionlint_<VERSION>_checksums.txt`). We deliberately do
  NOT `curl … | bash` from `raw.githubusercontent.com` — even though
  the upstream installer self-verifies, fetching the installer via a
  mutable tag ref and piping straight to `bash` reintroduces the exact
  tag-poisoning class this workflow exists to detect. Catches
  malformed workflows and `run:` shell bugs before they ship to a runner.
- **pnpm audit** (informational) — runs against production deps with
  `--audit-level=high` and branches on three outcomes that the previous
  revision collapsed into a single "table or all-clear" rendering:
  - **clean** — `pnpm audit` exited 0 AND the JSON report parsed as
    an object AND zero entries match the severity threshold; renders
    a confident "No advisories ≥ high. ✓" banner.
  - **findings** — `pnpm audit` exited 1 AND a count ≥ 1 can be
    extracted from the report. Both schemas are rendered: the legacy
    pnpm/npm v1 `.advisories` map AND the npm v2 / pnpm 10
    `.vulnerabilities` map. Earlier the workflow only parsed
    `.advisories`, so high/critical findings emitted under the v2
    shape rendered as an empty table that looked clean.
  - **inconclusive (operational failure)** — `pnpm audit` exited >1
    OR the output is empty OR the JSON is not a valid object. Captured
    stderr is appended to
    the job summary so reviewers can see the registry / auth /
    network error that caused the run to short-circuit; the banner
    says explicitly "this result does NOT mean the dependency tree is
    clean — it means the audit did not complete and cannot certify
    either outcome." This closes the false-confidence path the
    security review flagged.
  - **inconclusive (schema mismatch)** — `pnpm audit` exited 1
    (= findings exist at or above the threshold) but the jq
    extraction returned 0 (= neither the legacy `.advisories` shape
    nor the npm v2 `.vulnerabilities` shape produced matching
    entries). This means a FUTURE pnpm version has introduced a new
    output schema, and rendering "Findings: 0" would be exactly the
    false-confidence pattern this step exists to prevent. The branch
    refuses to certify clean, emits a `::warning::` annotation, and
    dumps the first 200 lines of the raw `pnpm-audit.json` into the
    job summary so a human can update the jq extraction before
    treating the run as evidence either way.

  Still `continue-on-error: true` for now because the lockfile carries
  a known 15-high + 1-critical baseline (Tier 3 §H is the follow-up
  that flips this to a hard gate after those are remediated). Even
  while informational, the four-state output stops the workflow from
  printing a green badge over a guilty conscience.

zizmor findings upload to GitHub Security → Code scanning so they
survive past the PR's discussion timeline.

**`persist-credentials: false` is enforced everywhere.** Every
`actions/checkout` invocation passes the flag so the workflow does not
leave the GitHub token persisted in `.git/config` after the checkout
step. An earlier revision suppressed the `artipacked` zizmor rule
because the repo carried orphan submodule gitlinks under
`experiments/agenthub-vs-dkg/` without a corresponding `.gitmodules`,
which caused checkout cleanup to fatally fail when persist-credentials
was off. Those gitlinks were removed from the index in the same commit
that re-enabled the flag, and the global `artipacked` exemption in
`.github/zizmor.yml` was deleted — a future PR that adds a checkout
without the flag is now blocked at the audit gate.

### 8. `CODEOWNERS` routes review for security-sensitive paths

`.github/CODEOWNERS` names the maintainers responsible for reviewing
changes to:

- every file under `.github/` (workflows, composite actions, the
  Dependabot config, the zizmor config, the CODEOWNERS file itself);
- every `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and
  `.npmrc` at every depth — the surface that determines what gets
  packed, published, or marked public;
- `scripts/` and `packages/cli/scripts/` — the release-asset build
  scripts that determine what `pnpm build` and the release workflow
  produce;
- `docs/security/` and `SECURITY.md`.

Each path lists at least two named owners. CODEOWNERS is **only a
routing file** — it tells GitHub which accounts should be requested
for review. None of the protection that the security review expects
("no single-account self-approval") comes from this file by itself.
The protection is configured server-side in repo Settings → Rules →
Rulesets → `protect-main`, and the ruleset must carry every one of
these settings together:

| Ruleset toggle | What it does | Why it matters |
|----------------|--------------|----------------|
| Require a pull request before merging — **Required approvals: 2** | Two distinct accounts must approve. | A single compromised maintainer account cannot self-approve. |
| Require a pull request before merging — **Require review from Code Owners** | At least one of those approvals must come from the path's CODEOWNERS. | Random reviewers cannot rubber-stamp `.github/workflows/*` or `pnpm-lock.yaml`. |
| Require a pull request before merging — **Dismiss stale pull request approvals when new commits are pushed** | Any push after approval invalidates the approval. | An attacker who lands a push after approval has to be re-approved. |
| Require a pull request before merging — **Require approval of the most recent reviewable push** | The reviewer cannot be the same account that made the most recent push. | Closes the "approve-then-push-then-merge" race. |
| Require conversation resolution before merging | All review threads must be marked resolved. | Stops "ignore the security comment and merge anyway". |
| Require signed commits | Every commit must be signed. | Forged commits in an attacker-stolen branch cannot enter `main`. |

Without those toggles, CODEOWNERS routes the review request but
**does not enforce** it. The runbook in §A walks through enabling
each of them via `gh api`; the runbook should be treated as part of
the hardening, not a separate task.

### 9. Continuous publish goes to `--tag dev`, never `--tag latest`

`latest` is the npm dist-tag `npm install <pkg>` defaults to. Earlier
revisions of `npm-continuous-publish.yml` set `--tag latest` on every
push to `main`, which meant a bad merge that cleared the env gate
became the default install target by accident.

The workflow now publishes to `--tag dev`. `latest` is reserved for
intentional signed releases promoted by `release.yml` (currently
`release.yml` only creates GitHub Releases; npm publication on tagged
releases is a future step that will set `--tag latest` explicitly).

### 10. `TURBO_TOKEN` / `TURBO_TEAM` are scoped to `push` events only

`ci.yml`'s `Build all Node packages` step references the Turbo remote
cache credentials via:

```yaml
TURBO_TOKEN: ${{ github.event_name == 'push' && secrets.TURBO_TOKEN || '' }}
TURBO_TEAM: ${{ github.event_name == 'push' && secrets.TURBO_TEAM || '' }}
```

On `pull_request` runs the expression evaluates to an empty string and
turbo's remote-cache integration transparently no-ops. This closes a
specific exfiltration path: package `build` scripts under
`packages/*/package.json` are PR-controlled — a malicious PR could
replace a build script and `curl` `$TURBO_TOKEN` to an attacker
endpoint. Restricting the secret to protected push events means the
PR-controlled code paths never see it. Local `.turbo/` caching via
`actions/cache` still keeps PR builds fast.

### 11. `release.yml` hardens tag trust and emits build-provenance attestations

The release-preflight job now:
- runs after `Validate tag format` with a `Verify tag points at a
  commit reachable from a release branch` step. `git merge-base
  --is-ancestor` exits 0 only if the pushed tag's commit is in the
  linear history of `main` or `v10-rc`. Without this check, anyone
  with `push --tags` rights could tag an arbitrary commit they
  crafted locally — bypassing every branch-protection control — and
  the release workflow would happily build and publish it.
- requires a **structurally signed annotated tag as a hard gate**.
  The step inspects the tag object: if it's a lightweight ref (no
  object body, can't carry a signature) OR an annotated tag whose
  body does NOT contain a `-----BEGIN PGP SIGNATURE-----` or
  `-----BEGIN SSH SIGNATURE-----` block, the workflow fails and no
  release is produced. This closes the "advisory-only signed-tag
  check" gap that the security review (round 2) flagged on `d4f2353`:
  the workflow is no longer relying on the ruleset alone for the
  signed-tag gate; the workflow refuses to proceed even if the
  ruleset is misconfigured or temporarily disabled. See §D for the
  maintainer-side setup (one-time `git config --global tag.gpgsign
  true` plus a registered signing key).
- runs `git tag --verify` as a SECOND layer (advisory). This is the
  "who signed it" check, but GitHub-hosted runners don't ship
  maintainer keys, so verify-status is surfaced in the job summary
  rather than failing the build. The WHO gate lives in the branch
  ruleset "Require signed tags" toggle on §A; the runtime structural
  check above is the no-key-required runtime fallback.
- generates a CycloneDX 1.5 JSON SBOM via `@cyclonedx/cdxgen` (run in
  this no-credentials job, not in the credential-bearing release job)
  and uploads it as an artifact for the release job to consume.

The release job now:
- holds `id-token: write` and `attestations: write` in addition to
  `contents: write`;
- aggregates every release asset (MarkItDown binaries, per-asset
  `.sha256`s, the CycloneDX SBOM) into a single `SHASUMS256.txt`;
- emits a build-provenance attestation covering all of them via
  `actions/attest-build-provenance`. Consumers verify with
  `gh attestation verify <asset> --repo OriginTrail/dkg` — the
  attestation records the workflow run id, the workflow file SHA, the
  runner image, and a digest of every covered file. A tampered
  release asset fails verification.
- ships a "Verifying this release" footer in every release body with
  copy-pasteable verification commands.
- creates the GitHub Release via the preinstalled `gh` CLI (`gh release
  create`) rather than `softprops/action-gh-release`. This removes the
  last third-party action from the credential-bearing job's executable
  surface — the most privileged step in any workflow (`contents:write`
  \+ `id-token:write` \+ `attestations:write`) now runs only
  first-party `actions/*` and `gh` (shipped with the GitHub-hosted
  runner image). A future supply-chain compromise of any third-party
  release action cannot reach this token because no third-party code
  executes here. This closes PR460-12 (P2: "Third-party write-token
  actions") from the security review.
- passes every workflow context value into shell via `env:` rather
  than direct `${{ … }}` interpolation. Although the upstream
  `Validate tag format` step enforces a semver regex on the version,
  routing values through the env namespace closes the
  template-injection class at the parser level regardless of how the
  upstream validation evolves.

---

## Tier 2 admin steps (require maintainer GitHub UI/API access)

The following must be applied manually because they live in repo settings,
not in repo files. A maintainer with admin permission should run through
this section once, end-to-end.

### A. Tighten the `protect-main` ruleset

The existing ruleset (`gh api repos/OriginTrail/dkg/rulesets/14325863`)
already enforces no force-push, no deletion, and a code-owner-approved PR.
Add the following parameters so a single stale approval cannot rubber-stamp
a malicious follow-up push (the exact pattern an attacker would use after
compromising one maintainer's session):

```bash
gh api -X PUT repos/OriginTrail/dkg/rulesets/14325863 -f - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 2,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "rebase", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Build packages" },
          { "context": "Tornado: core + storage + chain" },
          { "context": "Bura: cli" },
          { "context": "Bura: query" },
          { "context": "Kosava: node-ui" },
          { "context": "Kosava: adapters + epcis + graph-viz + mcp-server + network-sim" },
          { "context": "Codex Review" },
          { "context": "zizmor (GitHub Actions audit)" },
          { "context": "actionlint (workflow syntax + schema)" }
        ]
      }
    }
  ]
}
JSON
```

What each new bit does:
- `required_approving_review_count: 2`: two distinct accounts must
  approve. Without this, a single compromised maintainer account
  approves their own PR and merges. **This is the toggle the
  security review specifically called out** ("if the goal is no
  single-account self-approval, branch protection should require 2
  approvals"). Bumping from 1 → 2 here is the structural fix; the
  CODEOWNERS file in this PR routes who gets asked, but only the
  approval-count rule blocks self-approval.
- `required_signatures`: blocks unsigned commits. The TeamPCP tag-poisoning
  attack used unsigned commits with cloned author/timestamp metadata.
  Enforcing signatures stops that exact technique.
- `dismiss_stale_reviews_on_push: true`: any new commit invalidates prior
  approvals. Stops the "approve-then-push-malicious-commit" pattern.
- `require_last_push_approval: true`: the merger must be a different
  account from the last pusher. Stops a single compromised account from
  approving + merging its own PR.
- `required_review_thread_resolution: true`: blocks merge until reviewer
  threads are explicitly resolved (no silently-overridden objections).
- `required_status_checks`: makes the CI + supply-chain-scan jobs hard
  merge gates, not just informational signals.

### B. Replicate the ruleset for `v10-rc`

`v10-rc` is a release branch that feeds npm-continuous-publish. It is
currently unprotected:

```bash
gh api repos/OriginTrail/dkg/rules/branches/v10-rc   # → []
```

Create a parallel ruleset targeting `refs/heads/v10-rc`:

```bash
gh api -X POST repos/OriginTrail/dkg/rulesets -f - <<'JSON'
{
  "name": "protect-v10-rc",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/v10-rc"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 2,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "rebase", "squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Build packages" },
          { "context": "Tornado: core + storage + chain" },
          { "context": "Bura: cli" },
          { "context": "zizmor (GitHub Actions audit)" }
        ]
      }
    }
  ]
}
JSON
```

### C. Configure the `npm-publish` GitHub Environment

The workflow is structurally safe by code: a `verify-environment`
preflight job (without `environment:`, without `NPM_TOKEN` in scope)
runs first and queries the GitHub API for the `npm-publish` environment
config; the `publish` job has `needs: verify-environment` AND
`environment: npm-publish`, so `NPM_TOKEN` is only injected into a
runner whose environment has already been proven to require reviewer
approval. This section walks through the one-time admin setup that
lets the preflight pass.

Settings → Environments → **New environment** → name it `npm-publish`,
then:

1. **Required reviewers**: add at least one (ideally two) maintainer
   accounts. The `verify-environment` job will refuse to run otherwise —
   that is what fail-closes the otherwise fail-open auto-creation
   behaviour GitHub Actions ships with.
2. **Prevent self-review**: enable "Prevent self-review" on the
   required-reviewers rule. Without it, the same maintainer who
   merged a malicious change can approve `npm-publish` themselves and
   unlock `NPM_TOKEN`, which defeats the separation-of-duties control
   this preflight enforces. `verify-environment` fails-closed unless
   this flag is set.
3. **Wait timer**: 5 minutes is the minimum useful value. Gives a
   reviewer a window to abort if something looks wrong.
   `verify-environment` fails-closed unless a non-zero wait_timer is
   configured.
4. **Deployment branches**: restrict to `main` only. Default allows any
   branch, which would let a feature branch publish if the workflow were
   ever triggered against it. `verify-environment` now ALSO enforces
   this: it walks `deployment_branch_policy` (and the sibling
   `/deployment-branch-policies` endpoint for custom allow-lists) and
   refuses to publish if the policy is `null` (all branches allowed),
   the custom allow-list omits `main`, or any entry contains a wildcard.
5. **Environment secrets**: move `NPM_TOKEN` from repo-level secrets to
   this environment. Repo-level `NPM_TOKEN` would still be accessible to
   any workflow run on `main`, defeating the point.

Verify via:

```bash
gh api repos/OriginTrail/dkg/environments/npm-publish \
  | jq '{
      reviewers: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers | length] | first,
      prevent_self_review: [.protection_rules[] | select(.type == "required_reviewers") | .prevent_self_review] | first,
      wait_timer: [.protection_rules[] | select(.type == "wait_timer") | .wait_timer] | first,
      deployment_branch_policy: .deployment_branch_policy
    }'
# Must print:
#   { "reviewers": ≥1,
#     "prevent_self_review": true,
#     "wait_timer": ≥1,
#     "deployment_branch_policy": { "protected_branches": true, ... }
#       OR { "protected_branches": false, "custom_branch_policies": true } AND
#       gh api repos/OriginTrail/dkg/environments/npm-publish/deployment-branch-policies
#       must list `main` (and no wildcards) }
# — exactly the four properties verify-environment asserts.
```

### D. Enable required signed commits AND signed tags on the personal level

`required_signatures` in §A enforces commit signatures server-side, but
that toggle does not touch tags. **Tag signing is enforced at runtime by
the `release.yml` workflow itself** (the "Require structurally signed
tag" step, hard-fails on a lightweight tag OR an annotated tag with no
PGP/SSH signature block in its body). That means:

- Every maintainer who cuts a release **must** have local git
  configured to sign tags, OR call `git tag -s` explicitly.
- Cutting a release with `git tag vX.Y.Z` (lightweight) or
  `git tag -a vX.Y.Z` (annotated but unsigned) will land in CI, the
  release workflow will refuse to proceed, and no release page or
  artifact will be produced. This is intentional — the security review
  flagged the previous "advisory only" behaviour as inadequate.

To configure local git for both commit + tag signing (one-time setup
per maintainer machine; either GPG or SSH-key signing works):

```bash
# SSH-based signing (simplest if you already have an SSH key in your
# GitHub account's "Signing keys" list):
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true     # ← also signs tags
```

Then verify on the next commit + tag:

```bash
git log -1 --show-signature   # should print "Good signature" / "Good "git ..."
git tag -s test-sig-only -m "verify signing works"
git tag --verify test-sig-only            # exits 0 if the runner has your key,
                                          # but the structural check in release.yml
                                          # works WITHOUT keys — it only requires
                                          # that a signature block is present in
                                          # the tag body.
git tag -d test-sig-only                  # clean up local test tag
```

**Why structural check, not key-verify, at runtime.** GitHub-hosted
runners ship no maintainer keys, so `git tag --verify` would always
fail on a hard gate (false negative). The structural detection in
`release.yml` ("does the annotated tag's body contain a PGP/SSH
signature block?") works on any runner without any key material —
it cannot tell us WHO signed it, but it reliably rejects unsigned and
lightweight tags. The WHO check stays at the ruleset level (§A
`required_signatures` covers the commit side; admin-side "Require
signed tags" rule on the same `protect-main` ruleset covers the tag
side end-to-end).

### E. Enable repo-level security features

Settings → Code security:
- **Private vulnerability reporting**: ON. Gives external researchers a
  triaged path instead of forcing them to post on X.
- **Dependency graph**: ON (probably already on for public repos).
- **Dependabot alerts**: ON.
- **Dependabot security updates**: ON.
- **Secret scanning**: ON.
- **Push protection**: ON. Refuses pushes that contain detected secret
  patterns; the cheapest defence against accidentally landing an
  unrotated NPM_TOKEN in a commit.
- **Code scanning default setup**: leave the existing CodeQL workflow.
  Our supply-chain-scan job complements it.

---

## Tier 3 admin steps — defence-in-depth

These reduce the blast radius of a successful attack further, but are
more involved than the Tier 2 list above. Apply when there's bandwidth.

### F. Migrate `NPM_TOKEN` to npm Trusted Publishing (OIDC)

npm supports OIDC-based publishing for github.com publishers, removing
the long-lived `NPM_TOKEN` entirely. The hardening in this PR is the
**code-side precondition**: the `publish` job already runs with
`permissions: { id-token: write }` and `npm publish --provenance`, so
the GitHub-side surface is OIDC-ready right now. What remains is the
npmjs.com registry-side switch and a single env-line removal — both
admin actions, run in this exact sequence:

**Step 1 (npmjs.com — does not affect CI yet).** On npmjs.com, for
each `@origintrail-official/*` package, enable **Trusted publishing**
under Package settings → Publishing access → Add trusted publisher.
Configure exactly:
- Publisher: `GitHub Actions`
- Repository owner: `OriginTrail`
- Repository: `dkg`
- Workflow filename: `npm-continuous-publish.yml`
- Environment name: `npm-publish` (must match the `environment:` value
  on the `publish` job — already configured)

After this step the workflow keeps working unchanged — `NPM_TOKEN`
auth still flows, OIDC is not yet required. Verifying both auth paths
work side-by-side is intentional; do not skip this verification.

**Step 2 (one-line PR — turns off `NPM_TOKEN` use).** Open a PR that
removes exactly these three lines from the `Publish each tarball with
provenance` step in `npm-continuous-publish.yml`:

```yaml
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

With `id-token: write` already on the job and a trusted-publisher
record on every package, `npm publish` will mint an OIDC token, send
it to npm, and npm will validate the token's `repo:`, `workflow:`,
and `environment:` claims against the trusted-publisher record before
accepting the publish. **This is the only code change needed** — the
rest of the workflow stays as-is.

**Step 3 (npmjs.com — finalisation).** Once a publish via OIDC has
succeeded end-to-end (verify by inspecting any published version's
`dist.attestations.provenance.predicateType` — it will be the
in-toto SLSA provenance statement):
- npmjs.com → Account → Access Tokens → revoke `NPM_TOKEN`.
- GitHub → repo Settings → Environments → `npm-publish` → Secrets →
  delete `NPM_TOKEN`.
- GitHub → repo Settings → Secrets and variables → Actions → confirm
  `NPM_TOKEN` is also absent at the repo level.

After this sequence, no long-lived npm credential exists anywhere
in the system. A CanisterWorm-style worm cannot exfiltrate something
that no longer exists. The OIDC token is minted per-run, scoped to
the publish job's environment, and expires within the run window
(typically minutes).

**Rollback note.** Trusted Publishing has no real rollback — once
the npm-side trusted-publisher record exists, an attacker who
compromises the workflow file could in theory cause an OIDC-signed
publish. The structural defence is the `npm-publish` environment
gate (required reviewers + wait timer + branch policy = exactly
`main`) that this PR already enforces — `id-token: write` only
fires inside that gate.

### G. Turn on GitHub immutable releases on this repo

Settings → Code & automation → **Releases** → **Immutable releases**:
ON. Once enabled, no one — not even an admin — can move an existing
release tag, and the GitHub web UI marks each release as "Immutable".
This is the single control that protected `trivy-action@0.35.0` during
the TeamPCP attack.

### H. Flip `pnpm audit` from informational to hard gate

`supply-chain-scan.yml` already runs `pnpm audit --audit-level=high
--prod` on every PR that touches the lockfile and weekly via cron.
Today it carries `continue-on-error: true` because the lockfile has
15 high + 1 critical baseline advisories (notably a `protobufjs <8.0.1`
in `@dkg-core` and `fast-uri <3.1.2` transitively via `@dkg-epcis`).

To convert to a hard gate:

1. Remediate the existing advisories. Either:
   - Bump the offending direct dep to a patched version.
   - Add a `pnpm.overrides` entry in repo-root `package.json` pinning
     the transitive dep to the patched range (e.g. add
     `"fast-uri@<3.1.2": "3.1.2"` next to the existing overrides).
2. Verify clean: `pnpm audit --audit-level=high --prod` must exit 0.
3. In `.github/workflows/supply-chain-scan.yml`, remove
   `continue-on-error: true` from the `Run pnpm audit` step.
4. Optionally tighten to `--audit-level=moderate` after a settling
   period to land Dependabot's lower-severity PRs as well.

### I. Reduce direct npm-publish surface area

Most of our 11 workspace packages are private workspace deps consumed
internally. Re-audit which packages actually need to be published to
npm; mark the rest `"private": true`. The fewer packages we publish, the
narrower the CanisterWorm attack surface.

---

## What this PR does and does not change

**Done in this PR (file-level changes):**
- SHA-pinned every `uses:` in every workflow.
- Added explicit `permissions:` blocks to `ci.yml`, `knip.yml`,
  `evm-integration.yml`, and narrowed scope in `release.yml`.
- Split `npm-continuous-publish.yml` into three jobs:
  `verify-environment` (no secrets, validates the npm-publish env's
  reviewers / self-review block / wait timer / deployment branch
  policy), `build-and-pack` (no secrets, builds and packs tarballs),
  and `publish` (gated by `environment: npm-publish`, holds
  `NPM_TOKEN` + `id-token: write`, runs only
  `npm publish <tarball> --ignore-scripts --provenance --tag dev`).
  This is the structural fix for the "secret-bearing job executes
  package code" risk the security review called out.
- Switched continuous publish from `--tag latest` to `--tag dev`.
  `latest` is reserved for signed release tags.
- Added `id-token: write` + `--provenance` so each continuous publish
  ships an in-toto SLSA provenance attestation. Precondition for npm
  Trusted Publishing (Tier 3 §F).
- Hardened `release.yml` with a tag-ancestry check, an advisory
  signed-tag check, a CycloneDX 1.5 SBOM generated in
  `release-preflight` (no privileged credentials), aggregated
  `SHASUMS256.txt` over every release asset, and an
  `actions/attest-build-provenance` attestation covering them all.
- Scoped `TURBO_TOKEN` / `TURBO_TEAM` to `push` events in `ci.yml`
  so PR-controlled build scripts never see the cache credentials.
- Created `.github/dependabot.yml` covering direct npm deps,
  github-actions, **and** a new `transitive` group on
  `dependency-type: production` so transitive-only fixes get bumped
  via the normal weekly cadence (the earlier
  `allow: dependency-type: direct` filter was removed).
- Created `.github/CODEOWNERS` mapping every security-sensitive path
  (workflows, package manifests, lockfiles, release scripts, security
  docs) to ≥2 named owners; effective once admin enables "Require
  review from Code Owners" on `main` / `v10-rc` (§A).
- Created `.github/workflows/supply-chain-scan.yml` (zizmor +
  actionlint + a four-state pnpm audit that distinguishes clean /
  findings / inconclusive-operational-failure / inconclusive-schema-mismatch).
  zizmor scans both
  `.github/workflows/` AND `.github/actions/`. actionlint installs
  from a SHA-256-pinned GitHub release asset (not `curl | bash`).
  zizmor installs from hash-pinned PyPI wheels via
  `pip install --require-hashes --no-deps`. SARIF upload is gated
  off forked PRs to avoid 403s on the downgraded write scope.
- Removed the six orphan submodule gitlinks under
  `experiments/agenthub-vs-dkg/` that previously blocked
  `persist-credentials: false`. Restored
  `persist-credentials: false` on every `actions/checkout`. Removed
  the global `artipacked` suppression from `.github/zizmor.yml`.
- Hardened `.npmrc` (explicit `verify-store-integrity`; comments
  documenting why `ignore-scripts` is NOT set).
- This document.

**Not done in this PR (require maintainer admin clicks):**
- Tighten the `protect-main` ruleset (Tier 2 §A) — enables
  CODEOWNERS enforcement, signed commits, dismiss-stale-reviews,
  last-push-approval.
- Create the `protect-v10-rc` ruleset (Tier 2 §B).
- Configure the `npm-publish` Environment: reviewers,
  `prevent_self_review`, wait timer, **deployment branch policy
  restricted to `main`** (the new fourth assertion in
  `verify-environment`), and move `NPM_TOKEN` into the environment
  (Tier 2 §C).
- Enable required-signed-commits + each maintainer's signing key
  (Tier 2 §D).
- Repo-level security features: private vulnerability reporting,
  secret-scanning push protection (Tier 2 §E).
- npm Trusted Publishing migration on npmjs.com (Tier 3 §F) — the
  code side is ready (`id-token: write`, `--provenance`), the
  registry-side trusted-publisher record still needs creating.
- Immutable releases setting (Tier 3 §G).
- Flip `pnpm audit` from informational to a hard CI gate after the
  baseline 15-high + 1-critical advisories are remediated (Tier 3 §H).
- Workspace-package publish surface review (Tier 3 §I).

**Out of scope for code-only changes (tracked separately):**
- **Egress restrictions for credential-bearing jobs.** The release +
  publish jobs hold high-trust tokens (`contents: write`,
  `id-token: write`, `attestations: write`, `NPM_TOKEN`). A
  compromised dep with arbitrary code execution can still exfiltrate
  by making an outbound HTTP request, and SHA-pinning does not stop
  runtime egress. The only effective controls are
  (a) a hardened/self-hosted runner image with egress firewalling,
  (b) GitHub Actions ARC + a network policy on the runner pods, or
  (c) a third-party egress-monitoring service. All three are infra
  decisions, not YAML ones. Tracked as a follow-up.
- **Node 24 forced migration (deprecation deadline: 2026-06-02).**
  Every action we currently pin runs on Node 20 (`actions/checkout@v4`,
  `actions/setup-node@v4`, `pnpm/action-setup@v4`,
  `github/codeql-action/*@v3`, `actions/upload-artifact@v4`,
  `actions/download-artifact@v4`, `actions/cache@v4`,
  `actions/setup-python@v5`, `actions/attest-build-provenance@v2`,
  `dorny/paths-filter@v3`). GitHub's runner image will force Node 24
  for these starting 2026-06-02, removing Node 20 entirely on
  2026-09-16. Dependabot is configured to bump action SHAs weekly
  via `.github/dependabot.yml` (the `github-actions` ecosystem + the
  `actions-core` group), so the major-version bumps will land on
  review schedule. If June arrives and Dependabot hasn't yet opened
  the bump PRs, run the supply-chain-scan `scanner-freshness` cron
  manually and bump by hand.

**Automated drift detection (in this PR):**
- `supply-chain-scan.yml` carries a `scanner-freshness` job that
  runs on the weekly cron + `workflow_dispatch`. It parses the
  pinned versions of `actionlint`, `zizmor`, and
  `@cyclonedx/cdxgen` directly out of the workflow YAMLs, queries
  upstream registries for the latest releases, and emits a
  `::warning::` annotation + job-summary table when any pin lags
  behind. This closes PR460-06 / P3 ("Add a documented scheduled
  check or Dependabot-compatible mechanism for scanner versions").
  The job is informational (`continue-on-error: true`) — drift
  surfaces in the weekly cron's run summary; the bump itself goes
  through a normal review PR with the new pin + recomputed
  hashes/digests.

---

## Incident response

If you have specific evidence of compromise (a tag we use was force-pushed,
a CI run showed an unexpected `pip`/`curl` to an attacker domain, a leaked
NPM_TOKEN appears in a public paste, etc.):

1. **Rotate first, investigate second.** In order: `NPM_TOKEN`,
   `OPENAI_API_KEY`, `TURBO_TOKEN`, every personal access token any
   maintainer has against the repo. Force-revoke each one in the
   provider UI rather than just deleting and replacing the secret.
2. **Suspend the affected workflows.** Settings → Actions → General →
   "Disable Actions for this repository" while you investigate.
3. **Pull the runner audit log.** `gh api repos/OriginTrail/dkg/actions/runs/<id>/logs`
   and grep for unexpected `pip install`, `npm install`, `curl`, `wget`
   to non-localhost.
4. **Check for `tpcp-docs` or similar fallback-exfiltration repos** on
   the GitHub org and on every maintainer's account. The TeamPCP stealer
   creates a public repo named `tpcp-docs` under the victim's GitHub
   account when its primary C2 is unreachable.
5. **Mass-replace npm tokens AND any cloud-provider OIDC trust** since
   the credential-stealer scrapes ~50 paths including `~/.aws/credentials`
   and Kubernetes config.
6. Once contained, file a private security advisory on the repo:
   `gh api repos/OriginTrail/dkg/security-advisories -X POST …`.
