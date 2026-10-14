# Documentation maintenance

Run these tools with Node.js 22.13+ (check `node --version` in the shell running them).

## Source and ownership

- Human guides and task procedures live in `docs/`; `docs/SUMMARY.md` defines the GitBook navigation. A file existing in the repository is not evidence that it is published.
- Exact operational instructions remain in `packages/cli/skills/dkg-node/SKILL.md`, its runtime rendering, and runtime tool schemas. The generated tool/route map is a discovery aid, not an OpenAPI schema or proof of executable route parity.
- `scripts/docs/capabilities.json` records the responsible maintainer role, supported baseline, review date, availability, and validation coverage. DKG maintainers must replace a role with a concrete owner when assigning a work item. A reviewed baseline is not the feature's earliest release version.
- Feature changes should update their guide, task pack, capability record, examples, and operational skill in the same PR. If a surface is unaffected, explain why in the PR.
- Private specifications are internal coverage inputs. Publish only public, reviewed explanations; a draft or prototype does not establish released availability. Do not copy private customer or infrastructure details into docs.

## Static checks

```bash
node scripts/docs/check.mjs --write
node scripts/docs/check.mjs
```

The writer refreshes the availability page and tool/route map. The checker validates published local file links/navigation, capability records, generated output freshness, and parity between the inline Turtle and supplied fixture. It deliberately does not crawl external URLs, validate every fragment anchor, infer semantic truth from prose, or execute a daemon. `docs/reports`, ADRs, and engineering archives stay outside GitBook navigation.

The `Documentation contracts` workflow runs these static checks on relevant PRs with read-only permissions and no secrets.

## Released-package smoke

Install the intended package into an isolated prefix; do not replace an operator's global installation to test a guide. Pass its executable explicitly:

```bash
node scripts/docs/smoke.mjs --cli /absolute/path/to/prefix/node_modules/.bin/dkg
```

This checks 20 documented command-help surfaces and the supplied OKF mapping without starting a node, connecting frameworks, or publishing. The executable's shebang also needs the supported Node version on `PATH`.

For the live example, provision an isolated loopback Edge node with a dedicated `DKG_HOME`, an unused port, and an unfunded testnet configuration. Keep automatic updates disabled during the recorded test. Set `DKG_DOCS_AUTH_TOKEN` from that node's local credential without printing it. Then explicitly allow sample writes and, optionally, local sharing:

```bash
node scripts/docs/smoke.mjs \
  --cli /absolute/path/to/prefix/node_modules/.bin/dkg \
  --api-url http://127.0.0.1:19341 \
  --allow-write --share
```

The script creates a uniquely named sample graph. It checks the HTTP application's five WM triples, the expected query row from separate client processes, and optional sealing/SWM readback. It never publishes to chain and does not delete existing state. The sample remains in the isolated home for inspection; stop that test daemon when finished.

Record the package/version, platform, backend, command results, and exclusions in a dated validation report. Do not label fresh-process retrieval as a framework conversation test or a local share as peer replication. A complete release check also exercises an installed framework in a fresh conversation, the two-node recipe, and any separately authorized funded publication flow.

## Publication checklist

1. Validate against the intended release and its supported tool schemas; `main`, `testnet-canary`, and npm can differ.
2. Run static and relevant runtime checks; record unavailable tests as pending.
3. Verify the guide in GitBook preview, including code blocks, diagrams, navigation, links, and redirects for any moved paths.
4. Confirm the published page and `llms.txt` after the normal reviewed merge/promotion. Updating repository files does not itself prove GitBook publication.
5. Refresh capability metadata when a source-only feature is released. Keep a supported baseline and first-introduction version distinct.
