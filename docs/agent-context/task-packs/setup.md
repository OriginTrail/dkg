---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Set up and verify a node + agent

**Inputs:** intended runtime, local/remote node location, network, existing installation if any, and the task's write/sharing scope. Use the [integration selector](../../integrations/README.md).

1. Inspect the existing node first. Use `dkg doctor --json` for installation ambiguity and status for the running version. Do not change the network/home of an existing node to satisfy a tutorial.
2. For a fresh installation, follow the chosen runtime guide. Explicitly select the intended network. Framework/model installation and credentials are separate prerequisites.
3. Confirm daemon and store health. Confirm the runtime can discover DKG tools and call status. A Node UI chat reply alone does not prove memory integration; Prime Agent's bridge currently provides that narrower capability.
4. If sample writes are authorized, follow the [Atlas quickstart](../../getting-started/quickstart.md), using its five-triple fixture, exact graph ID, and KA name. Keep the sample in WM unless sharing is authorized.
5. Retrieve the KA through tools. Expected evidence: Atlas uses Oxigraph, with source `https://example.org/dkg-tutorial/source`, from WM. Show the actual relationships returned.
6. In a fresh conversation under the same authorized identity, repeat the read. Do not use the prior conversation as the evidence.

**Done:** report the node version, runtime, exact graph/KA, retrieved answer/source/layer, and whether the fresh-session check actually ran. Never mark an unavailable framework or unexecuted conversation test as passed.

**Recover:** if tools are missing, inspect setup and restart the appropriate client/gateway. If the graph is absent, check node/home/identity and exact ID. If another identity cannot read WM, do not broaden access implicitly; use the [collaboration procedure](collaborate.md) when sharing is intended.
