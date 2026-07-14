# V10 publish tests

`npm test` runs the legacy generic lifecycle suite against a configured node.
It is not suitable for pull-request CI because it needs live node credentials
and chain access.

`npm run test:harness` runs the self-contained regression suite with local mock
HTTP nodes and fake database clients. Pull requests targeting `test/publish`
run this exact command in the `Harness Test` GitHub Actions check after `npm ci`
installs the locked `package-lock.json` dependencies.

Chain and node topology is defined once in `src/suite-manifest.js`. Aggregate
and single-node commands in `package.json` both delegate to
`scripts/run_node_suites.js`.
