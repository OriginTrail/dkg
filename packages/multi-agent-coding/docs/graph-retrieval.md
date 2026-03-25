# GitHub Code Ontology — Graph Retrieval Strategy

## URI Patterns

All entities use deterministic URIs based on GitHub's stable identifiers:

| Entity | URI Pattern | Example |
|--------|-------------|---------|
| Repository | `urn:github:{owner}/{repo}` | `urn:github:OriginTrail/dkg-v9` |
| PR | `urn:github:{owner}/{repo}/pr/{number}` | `urn:github:OriginTrail/dkg-v9/pr/220` |
| Issue | `urn:github:{owner}/{repo}/issue/{number}` | `urn:github:OriginTrail/dkg-v9/issue/42` |
| Commit | `urn:github:{owner}/{repo}/commit/{sha}` | `urn:github:OriginTrail/dkg-v9/commit/abc123...` |
| Branch | `urn:github:{owner}/{repo}/branch/{name}` | `urn:github:OriginTrail/dkg-v9/branch/main` |
| Tag | `urn:github:{owner}/{repo}/tag/{name}` | `urn:github:OriginTrail/dkg-v9/tag/v1.0.0` |
| User | `urn:github:user/{login}` | `urn:github:user/jurij` |
| Org | `urn:github:user/{login}` | `urn:github:user/OriginTrail` |
| Review | `urn:github:{owner}/{repo}/pr/{pr_number}/review/{review_id}` | `urn:github:OriginTrail/dkg-v9/pr/220/review/12345` |
| Label | `urn:github:{owner}/{repo}/label/{name}` | `urn:github:OriginTrail/dkg-v9/label/bug` |
| CheckSuite | `urn:github:checksuite:{owner}/{repo}/{id}` | `urn:github:checksuite:OriginTrail/dkg-v9/99` |
| CheckRun | `urn:github:checkrun:{owner}/{repo}/{id}` | `urn:github:checkrun:OriginTrail/dkg-v9/456` |
| Workflow | `urn:github:workflow:{owner}/{repo}/{id}` | `urn:github:workflow:OriginTrail/dkg-v9/7` |
| Release | `urn:github:release:{owner}/{repo}/{tag}` | `urn:github:release:OriginTrail/dkg-v9/v1.0.0` |
| AgentSession | `urn:ghcollab:session:{agent}:{timestamp}` | `urn:ghcollab:session:claude-code:1711324800` |
| ClaimedRegion | `urn:ghcollab:claim:{agent}:{path}:{timestamp}` | `urn:ghcollab:claim:claude-code:src/index.ts:1711324800` |

### Nested Entity Skolemization

Nested entities (FileDiff, ReviewComment, IssueComment, Hunk) use blank nodes that skolemize under their parent rootEntity per DKG convention (`{rootEntity}/.well-known/genid/{label}`):

- FileDiff in a PR: `urn:github:pr:{...}/.well-known/genid/diff-{sha256(path)}`
- FileDiff in a commit: `urn:github:commit:{...}/.well-known/genid/diff-{sha256(path)}`
- Hunk: `urn:github:pr:{...}/.well-known/genid/hunk-{sha256(path+oldStart)}`
- ReviewComment: `urn:github:pr:{...}/.well-known/genid/rc-{comment_id}`
- IssueComment: `urn:github:issue:{...}/.well-known/genid/ic-{comment_id}`

## rootEntity Mapping

The DKG publish system requires a `rootEntity` for each Knowledge Asset. The GitHub Code Ontology uses three natural root entity types:

| Root Entity | Contains | Update Frequency |
|-------------|----------|------------------|
| **Repository** | Repo metadata, branches, tags, contributors, labels, milestones, workflows, build configs | Low (daily sync) |
| **PullRequest** | PR metadata, commits, file diffs, hunks, reviews, review comments, check results | Medium (per webhook event) |
| **Issue** | Issue metadata, comments, labels | Medium (per webhook event) |

This mapping means:
- One KA per repository snapshot, one KA per PR, one KA per issue
- All nested entities (commits in a PR, comments on an issue) are skolemized children of their parent rootEntity
- Workspace writes (upserts) handle updates without needing on-chain confirmation for every change

## Paranet Strategy

All GitHub data for a project goes into a single paranet:
- Paranet ID: `github-collab:{owner}/{repo}` (e.g., `github-collab:OriginTrail/dkg-v9`)
- Data graph: `did:dkg:paranet:github-collab:OriginTrail/dkg-v9`
- Workspace graph: `did:dkg:paranet:github-collab:OriginTrail/dkg-v9/_workspace`

Real-time webhook data goes to the **workspace graph** first (fast, no chain), then periodically gets enshrined to the **data graph** (with Merkle proofs and chain confirmation).

## Incremental Sync Strategy

1. **Initial sync**: Full repository snapshot -> publish as one KC with repo + all open PRs + all open issues as separate KAs
2. **Webhook-driven updates**: On PR/issue events, upsert the affected KA in the workspace graph
3. **Periodic enshrinement**: Every N hours, batch workspace changes into a formal publish (data graph with Merkle proofs)
4. **Conflict resolution**: Use `ghcode:snapshotAt` timestamps to determine freshness; latest snapshot wins

### Data Flow

```
GitHub API / Webhooks
        |
        v
  GitHub API Client  (fetch repo, PRs, issues, commits)
        |
        v
  RDF Transformer    (JSON -> ghcode: quads)
        |
        v
  DKG Coordinator    (publish/workspace write)
        |
    +---+---+
    |       |
    v       v
Workspace  Data Graph
 (fast)    (enshrined)
```

## Query Optimization Notes

- **Graph scoping**: All queries are automatically scoped to the paranet's data graph by the DKG query engine. Use `includeWorkspace: true` to also search workspace (draft) data.
- **Index-friendly patterns**: Start triple patterns with the most selective term (specific URI > `rdf:type` > property scan).
- **Avoid unbounded traversals**: Use `LIMIT` on all user-facing queries. The QueryHandler enforces MAX_LIMIT=1000.
- **FILTER placement**: Place FILTERs immediately after the triple patterns they constrain.
- **OPTIONAL last**: Put OPTIONAL patterns at the end of WHERE clauses to avoid unnecessary joins.
- **No SERVICE/GRAPH/FROM**: Remote queries (via QueryHandler) strip these clauses. Only use them in local-only contexts.
- **CONSTRUCT for visualization**: Use CONSTRUCT queries to build subgraphs for the graph pane (e.g., PR with all connected entities).

## Cross-Domain Queries

The ontology bridges to `devgraph:` via `ghcode:touchesModule`, `ghcode:touchesFunction`, `ghcode:touchesClass`, `ghcode:touchesPackage`. This enables queries like "which functions were affected by PRs merged this week" by joining across both vocabularies:

```sparql
PREFIX ghcode: <https://ontology.dkg.io/ghcode#>
PREFIX devgraph: <https://ontology.dkg.io/devgraph#>

SELECT ?prTitle ?funcName ?filePath WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:title ?prTitle ;
      ghcode:state "merged" ;
      ghcode:touchesFunction ?func .
  ?func devgraph:name ?funcName ;
        devgraph:definedIn ?mod .
  ?mod devgraph:path ?filePath .
}
```

Agent coordination entities (`ghcode:AgentSession`, `ghcode:ClaimedRegion`, `ghcode:WorkInProgress`) extend `devgraph:Session` and link to `devgraph:Task`, enabling queries that span agent work tracking and GitHub collaboration in a single graph.
