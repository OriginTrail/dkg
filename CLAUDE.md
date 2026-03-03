# DKG Dev Coordination — Agent Instructions

This repository uses a **Decentralized Knowledge Graph (DKG)** for multi-agent development coordination. A local DKG node maintains a structured code graph and project knowledge that you should query before exploring files directly.

## Setup

The DKG MCP server must be configured in your MCP settings:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

The DKG daemon must be running (`dkg start`).

## Session Start Protocol

Before exploring the codebase, **always** query the dev-coordination paranet first. These queries cost a fraction of the tokens that file exploration does.

### 1. Check what has been worked on recently

```sparql
SELECT ?s ?summary ?agent ?date ?cost WHERE {
  ?s a <https://ontology.dkg.io/devgraph#Session> ;
     <https://ontology.dkg.io/devgraph#summary> ?summary ;
     <https://ontology.dkg.io/devgraph#agent> ?agent ;
     <https://ontology.dkg.io/devgraph#startedAt> ?date .
  OPTIONAL { ?s <https://ontology.dkg.io/devgraph#estimatedCost> ?cost }
}
ORDER BY DESC(?date) LIMIT 10
```

### 2. Check active tasks

```sparql
SELECT ?t ?desc ?status ?assignee WHERE {
  ?t a <https://ontology.dkg.io/devgraph#Task> ;
     <https://ontology.dkg.io/devgraph#description> ?desc ;
     <https://ontology.dkg.io/devgraph#status> ?status .
  OPTIONAL { ?t <https://ontology.dkg.io/devgraph#assignee> ?assignee }
  FILTER(?status != "done")
}
```

### 3. Check recent architectural decisions

```sparql
SELECT ?d ?summary ?rationale ?by ?date WHERE {
  ?d a <https://ontology.dkg.io/devgraph#Decision> ;
     <https://ontology.dkg.io/devgraph#summary> ?summary ;
     <https://ontology.dkg.io/devgraph#rationale> ?rationale ;
     <https://ontology.dkg.io/devgraph#madeBy> ?by ;
     <https://ontology.dkg.io/devgraph#madeAt> ?date .
}
ORDER BY DESC(?date) LIMIT 5
```

## Code Exploration via DKG

Instead of using Glob/Grep/Read to find files, **query the code graph first**:

### Find modules related to a topic

```sparql
SELECT ?path ?lineCount ?pkg WHERE {
  ?m a <https://ontology.dkg.io/devgraph#CodeModule> ;
     <https://ontology.dkg.io/devgraph#path> ?path ;
     <https://ontology.dkg.io/devgraph#lineCount> ?lineCount ;
     <https://ontology.dkg.io/devgraph#containedIn> ?p .
  ?p <https://ontology.dkg.io/devgraph#name> ?pkg .
  FILTER(CONTAINS(LCASE(?path), "staking"))
}
```

### Find a function and what it calls

```sparql
SELECT ?name ?sig ?path WHERE {
  ?f a <https://ontology.dkg.io/devgraph#Function> ;
     <https://ontology.dkg.io/devgraph#name> ?name ;
     <https://ontology.dkg.io/devgraph#definedIn> ?mod .
  ?mod <https://ontology.dkg.io/devgraph#path> ?path .
  OPTIONAL { ?f <https://ontology.dkg.io/devgraph#signature> ?sig }
  FILTER(?name = "requestWithdrawal")
}
```

### Find package dependencies

```sparql
SELECT ?pkg ?dep WHERE {
  ?p a <https://ontology.dkg.io/devgraph#Package> ;
     <https://ontology.dkg.io/devgraph#name> ?pkg ;
     <https://ontology.dkg.io/devgraph#dependsOn> ?d .
  ?d <https://ontology.dkg.io/devgraph#name> ?dep .
}
```

### Find what imports a module

```sparql
SELECT ?importerPath WHERE {
  ?importer <https://ontology.dkg.io/devgraph#imports> ?target ;
            <https://ontology.dkg.io/devgraph#path> ?importerPath .
  ?target <https://ontology.dkg.io/devgraph#path> ?targetPath .
  FILTER(CONTAINS(?targetPath, "chain-adapter"))
}
```

### Find Solidity contract inheritance

```sparql
SELECT ?child ?parent ?path WHERE {
  ?c a <https://ontology.dkg.io/devgraph#Contract> ;
     <https://ontology.dkg.io/devgraph#name> ?child ;
     <https://ontology.dkg.io/devgraph#inherits> ?parent ;
     <https://ontology.dkg.io/devgraph#definedIn> ?mod .
  ?mod <https://ontology.dkg.io/devgraph#path> ?path .
}
```

### Find test files for a module

```sparql
SELECT ?srcPath ?testPath WHERE {
  ?m a <https://ontology.dkg.io/devgraph#CodeModule> ;
     <https://ontology.dkg.io/devgraph#path> ?srcPath ;
     <https://ontology.dkg.io/devgraph#testFile> ?t .
  ?t <https://ontology.dkg.io/devgraph#path> ?testPath .
  FILTER(CONTAINS(?srcPath, "evm-adapter"))
}
```

## During Your Session

### When making architectural decisions

Publish a `devgraph:Decision` so other agents can see it:

Use the `dkg_publish` MCP tool with quads like:
- `<urn:decision:TIMESTAMP> rdf:type devgraph:Decision`
- `<urn:decision:TIMESTAMP> devgraph:summary "Chose X over Y for Z"`
- `<urn:decision:TIMESTAMP> devgraph:rationale "Because ..."`
- `<urn:decision:TIMESTAMP> devgraph:madeBy "claude-code"`
- `<urn:decision:TIMESTAMP> devgraph:affects <file:path/to/module.ts>`

### When completing a task

Update the task status:
- `<urn:task:ID> devgraph:status "done"`
- `<urn:task:ID> devgraph:completedIn <urn:session:TIMESTAMP>`

## When to Fall Back to File Tools

Use Read/Grep/Glob when:
- The code graph doesn't cover the specific file (e.g., config files, scripts)
- You need to see the actual implementation, not just the structure
- The graph is not yet indexed for a new file you just created

The DKG graph gives you the **map**; file tools give you the **territory**. Start with the map.

## Vocabulary Reference

All classes and properties use the `devgraph:` namespace (`https://ontology.dkg.io/devgraph#`).

| Class | Description |
|-------|-------------|
| `Session` | A coding agent work session |
| `Decision` | An architectural decision |
| `Task` | A planned work item |
| `Package` | A workspace package |
| `CodeModule` | A source file |
| `Function` | An exported function or method |
| `Class` | An exported class |
| `Contract` | A Solidity smart contract |

The full ontology is at `packages/mcp-server/schema/dev-paranet.ttl`.
