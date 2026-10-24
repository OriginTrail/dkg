---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Your first node + agent workflow

Start with a contribution your agent can inspect and use: a small project fact with a source. You will store it in your node, retrieve it through an agent in a fresh conversation, and then choose whether to share it. This is the first step toward working with knowledge that other participants can use and build on.

The tutorial uses public sample data and covers private drafts and optional sharing. Publishing a Knowledge Asset on-chain is a separate continuation. Commands use a POSIX shell; Windows users can follow them in WSL2.

Prerequisites: Node.js 22.23.4+, 24.22.1+ or 26.12.1+, npm 10+, and a supported agent runtime if you want the conversational step. The command surface below is based on DKG 10.0.23. Check [feature availability](../references/availability.md) before using newer features.

DKG starts on Node.js 22.13+ (or 23.4+), but older releases miss the [2026-10-21 Node.js security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), and `dkg start` and `dkg doctor` warn about them.

## 1. Install and choose your connection

```bash
npm install -g @origintrail-official/dkg
dkg --version
```

Choose **one** path in [Connect an agent or application](../integrations/README.md): MCP, Hermes, OpenClaw, Prime Agent, a local model, or HTTP. Setup differs by runtime. MCP/Hermes/OpenClaw can bootstrap a node; Prime Agent needs an initialized node and its own live session.

For a node you will connect manually, initialize a fresh Edge Node on testnet:

```bash
dkg init --role edge --network testnet
dkg start
dkg status
```

The wizard asks for node and storage settings. Allow storage provisioning to finish. Open `http://127.0.0.1:9200/ui` (or the configured port). Success means the daemon and store are healthy, not just that the web page loads. If you already run a node, use that node's home, port, and network; do not reinitialize it to follow this tutorial. [Troubleshooting](../use-dkg/troubleshooting.md).

WM work needs no funded wallet. Adapter setup defaults to mainnet unless a network is selected on a fresh node; the integration pages explicitly use testnet. Model/provider charges are separate from DKG publication fees.

## 2. Create a project

Use a fresh, unfunded testnet node for this sample. On a chain-enabled node, graph creation can attempt on-chain graph registration as a best-effort side effect when funds and prerequisites are available. That graph-metadata operation is separate from publishing the Knowledge Assets below. See [Context Graphs](../how-dkg-works/context-graphs.md) before using an already funded node.

```bash
dkg context-graph create atlas-demo
```

Copy the exact `ID:` from the output, including an address prefix when present:

```bash
CG='<exact ID printed by create>'
```

Use that same ID in every command and agent request. A display name is not a canonical identifier. Choose a different project slug if this tutorial was already run.

## 3. Write a small, inspectable fact

Save the following as `atlas.ttl` in your working directory. The source is a fictional tutorial identifier, not an external fact to verify.

```turtle
@prefix ex: <https://example.org/dkg-tutorial/> .
@prefix schema: <https://schema.org/> .
ex:atlas schema:name "Atlas" ;
    ex:usesDatabase ex:oxigraph ;
    schema:citation ex:source .
ex:oxigraph schema:name "Oxigraph" .
ex:source schema:name "Atlas architecture note (tutorial fixture)" .
```

```bash
dkg ka create atlas -c "$CG"
dkg ka write atlas -c "$CG" --input-file ./atlas.ttl
dkg ka query atlas -c "$CG"
```

Expect **five triples** containing the project name, its database relationship, the database name, and its source. This is a WM draft. If a write fails, inspect the same named KA before retrying; do not create duplicate assets to hide a partial operation.

The same fixture is maintained in the repository at [`examples/docs/atlas.ttl`](https://github.com/OriginTrail/dkg/blob/main/examples/docs/atlas.ttl).

## 4. Ask your agent, then start a fresh conversation

Give your connected agent this task, replacing the ID:

> Use my DKG node and Context Graph `<exact ID>`. Read the Working Memory KA named `atlas`. Which database does Atlas use? Include the source identifier and memory layer. Retrieve the evidence now; do not answer from conversation history. Do not share or publish anything.

Expected answer: **Atlas uses Oxigraph**, supported by `https://example.org/dkg-tutorial/source`, from **Working Memory**. Have the agent show the tool result or graph relationships it used. Start a fresh conversation with the same authorized agent identity and repeat the task. The answer should still come from the node.

A different agent identity may have different WM access. Persistence across conversations does not imply cross-agent permission. Prime Agent's chat bridge alone does not supply memory tools; use an integration that exposes them for this step.

## 5. Optionally share the sample

Sharing turns this draft into a contribution that authorized participants can use. When you want to share the sample, seal it and make it available through the Context Graph:

```bash
dkg ka finalize atlas -c "$CG"
dkg ka share atlas -c "$CG"
dkg ka history atlas -c "$CG"
dkg query "$CG" --include-shared-memory -q 'SELECT ?project ?database ?source WHERE { GRAPH ?g { ?p <https://schema.org/name> ?project ; <https://example.org/dkg-tutorial/usesDatabase> ?db ; <https://schema.org/citation> ?source . ?db <https://schema.org/name> ?database . } }'
```

Expect one row: `Atlas`, `Oxigraph`, `https://example.org/dkg-tutorial/source`. A successful local share is not proof that every peer has received it. Follow [two-agent collaboration](../build/collaborate.md) to check a second node. If sharing fails, inspect the existing KA and follow the [share recovery guide](../use-dkg/knowledge-asset-lifecycle.md#synchronous-share-failures).

## Continue

- [Import documents](../build/import-documents.md) or [Google OKF bundles](../build/okf-tutorial.md).
- [Integrate an application](../build/http-application.md).
- [Publish selected knowledge](../use-dkg/publish-and-query.md) when on-chain provenance is intended and funded.

You have completed the first-use workflow when a fresh conversation retrieves the expected answer and source from the node. Continue with another agent to prove it can use your shared contribution, or import knowledge from your own project. Publish selected results when others need a durable provenance record.
