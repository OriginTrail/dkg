# GitHub Code Ontology — SPARQL Query Examples & Retrieval Strategy

Prefix declarations for all queries:

```sparql
PREFIX ghcode: <https://ontology.dkg.io/ghcode#>
PREFIX devgraph: <https://ontology.dkg.io/devgraph#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX prov: <http://www.w3.org/ns/prov#>
```

---

## Example SPARQL Queries

### 1. List all repositories with metadata

```sparql
SELECT ?repo ?name ?visibility ?lang ?stars ?defaultBranch WHERE {
  ?repo a ghcode:Repository ;
        ghcode:fullName ?name .
  OPTIONAL { ?repo ghcode:visibility ?visibility }
  OPTIONAL { ?repo ghcode:language ?lang }
  OPTIONAL { ?repo ghcode:starCount ?stars }
  OPTIONAL { ?repo ghcode:defaultBranch ?defaultBranch }
}
ORDER BY ?name
```

### 2. Find open PRs for a repository

```sparql
SELECT ?pr ?number ?title ?authorLogin ?created ?baseBranch WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:state "open" ;
      ghcode:createdAt ?created ;
      ghcode:baseBranch ?baseBranch ;
      ghcode:inRepo ?repo ;
      ghcode:author ?author .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?author ghcode:login ?authorLogin .
}
ORDER BY DESC(?created)
```

### 3. Get a PR with all its reviews and verdict

```sparql
SELECT ?pr ?title ?reviewer ?verdict ?reviewBody ?submittedAt WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber 220 ;
      ghcode:title ?title ;
      ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?review a ghcode:Review ;
          ghcode:reviewOf ?pr ;
          ghcode:reviewState ?verdict ;
          ghcode:author ?reviewerUser .
  ?reviewerUser ghcode:login ?reviewer .
  OPTIONAL { ?review ghcode:body ?reviewBody }
  OPTIONAL { ?review ghcode:submittedAt ?submittedAt }
}
ORDER BY ?submittedAt
```

### 4. Find PRs that touch a specific package

```sparql
SELECT DISTINCT ?pr ?number ?title ?state WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:state ?state ;
      ghcode:touchesPackage ?pkg .
  ?pkg devgraph:name ?pkgName .
  FILTER(CONTAINS(LCASE(?pkgName), "publisher"))
}
ORDER BY DESC(?number)
```

### 5. Files changed most frequently across recent PRs

```sparql
SELECT ?path (COUNT(?diff) AS ?changeCount) WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:state "merged" ;
      ghcode:mergedAt ?merged ;
      ghcode:prFileDiff ?diff .
  ?diff ghcode:diffPath ?path .
  FILTER(?merged > "2026-03-01T00:00:00Z"^^xsd:dateTime)
}
GROUP BY ?path
ORDER BY DESC(?changeCount)
LIMIT 20
```

### 6. CI check status for a PR's head commit

```sparql
SELECT ?checkName ?status ?conclusion ?completed WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber 220 ;
      ghcode:headSha ?sha ;
      ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?commit a ghcode:Commit ; ghcode:sha ?sha .
  ?suite a ghcode:CheckSuite ;
         ghcode:triggeredBy ?commit .
  ?run a ghcode:CheckRun ;
       ghcode:inSuite ?suite ;
       ghcode:checkName ?checkName ;
       ghcode:checkStatus ?status .
  OPTIONAL { ?run ghcode:checkConclusion ?conclusion }
  OPTIONAL { ?run ghcode:completedCheckAt ?completed }
}
ORDER BY ?checkName
```

### 7. Find open issues with labels

```sparql
SELECT ?issue ?number ?title ?labelName ?authorLogin ?created WHERE {
  ?issue a ghcode:Issue ;
         ghcode:issueNumber ?number ;
         ghcode:title ?title ;
         ghcode:state "open" ;
         ghcode:createdAt ?created ;
         ghcode:author ?author ;
         ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?author ghcode:login ?authorLogin .
  OPTIONAL {
    ?issue ghcode:hasLabel ?label .
    ?label ghcode:labelName ?labelName .
  }
}
ORDER BY DESC(?created)
```

### 8. Contributor activity summary

```sparql
SELECT ?login (COUNT(DISTINCT ?commit) AS ?commits)
       (COUNT(DISTINCT ?pr) AS ?prs)
       (COUNT(DISTINCT ?review) AS ?reviews) WHERE {
  ?user a ghcode:User ; ghcode:login ?login .
  OPTIONAL { ?commit a ghcode:Commit ; ghcode:author ?user }
  OPTIONAL { ?pr a ghcode:PullRequest ; ghcode:author ?user }
  OPTIONAL { ?review a ghcode:Review ; ghcode:author ?user }
}
GROUP BY ?login
HAVING (COUNT(DISTINCT ?commit) + COUNT(DISTINCT ?pr) + COUNT(DISTINCT ?review) > 0)
ORDER BY DESC(?commits)
```

### 9. Agent code claims (conflict detection)

```sparql
SELECT ?claim ?file ?agent ?scope ?startLine ?endLine ?expires WHERE {
  ?claim a ghcode:CodeClaim ;
         ghcode:claimedFile ?file ;
         ghcode:claimedByAgent ?agent ;
         ghcode:claimScope ?scope ;
         ghcode:expiresAt ?expires .
  OPTIONAL { ?claim ghcode:claimStartLine ?startLine }
  OPTIONAL { ?claim ghcode:claimEndLine ?endLine }
  FILTER(?expires > NOW())
}
ORDER BY ?file ?startLine
```

### 10. PRs that implement a devgraph Decision

```sparql
SELECT ?pr ?number ?title ?decisionSummary WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:implementsDecision ?decision .
  ?decision devgraph:summary ?decisionSummary .
}
ORDER BY DESC(?number)
```

### 11. Recent commits with their diffs and affected modules

```sparql
SELECT ?sha ?message ?path ?diffStatus ?additions ?deletions WHERE {
  ?commit a ghcode:Commit ;
          ghcode:sha ?sha ;
          ghcode:message ?message ;
          ghcode:committedAt ?date ;
          ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?diff a ghcode:FileDiff ;
        ghcode:inCommit ?commit ;
        ghcode:diffPath ?path ;
        ghcode:diffStatus ?diffStatus .
  OPTIONAL { ?diff ghcode:additions ?additions }
  OPTIONAL { ?diff ghcode:deletions ?deletions }
  FILTER(?date > "2026-03-20T00:00:00Z"^^xsd:dateTime)
}
ORDER BY DESC(?date) ?path
LIMIT 100
```

### 12. Active agent sessions with work-in-progress

```sparql
SELECT ?agent ?repo ?branch ?wipFile ?wipDesc ?started WHERE {
  ?session a ghcode:AgentSession ;
           devgraph:agent ?agent ;
           devgraph:startedAt ?started .
  OPTIONAL { ?session ghcode:worksOnRepo ?repoNode . ?repoNode ghcode:fullName ?repo }
  OPTIONAL { ?session ghcode:sessionBranch ?branch }
  OPTIONAL {
    ?wip a ghcode:WorkInProgress ;
         ghcode:wipAgent ?agent ;
         ghcode:wipFile ?wipFile ;
         ghcode:wipDescription ?wipDesc .
  }
  FILTER NOT EXISTS { ?session devgraph:endedAt ?ended }
}
ORDER BY ?agent
```

### 13. PR review coverage (PRs without reviews)

```sparql
SELECT ?pr ?number ?title ?authorLogin ?created WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:state "open" ;
      ghcode:createdAt ?created ;
      ghcode:author ?author ;
      ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?author ghcode:login ?authorLogin .
  FILTER NOT EXISTS {
    ?review a ghcode:Review ;
            ghcode:reviewOf ?pr ;
            ghcode:reviewState ?state .
    FILTER(?state != "PENDING")
  }
}
ORDER BY ?created
```

### 14. Cross-reference: issues closed by merged PRs

```sparql
SELECT ?issueNumber ?issueTitle ?prNumber ?prTitle ?mergedAt WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?prNumber ;
      ghcode:title ?prTitle ;
      ghcode:state "merged" ;
      ghcode:mergedAt ?mergedAt ;
      ghcode:closesIssue ?issue .
  ?issue ghcode:issueNumber ?issueNumber ;
         ghcode:title ?issueTitle .
}
ORDER BY DESC(?mergedAt)
```

### 15. CONSTRUCT: build a subgraph for a single PR (for visualization)

```sparql
CONSTRUCT {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:state ?state ;
      ghcode:author ?author ;
      ghcode:prFileDiff ?diff ;
      ghcode:prCommit ?commit .
  ?author ghcode:login ?login .
  ?diff ghcode:diffPath ?path ; ghcode:diffStatus ?dstatus .
  ?commit ghcode:shortSha ?sha ; ghcode:message ?msg .
  ?review ghcode:reviewOf ?pr ; ghcode:reviewState ?verdict ;
          ghcode:author ?reviewer .
  ?reviewer ghcode:login ?rLogin .
} WHERE {
  ?pr a ghcode:PullRequest ;
      ghcode:prNumber 220 ;
      ghcode:prNumber ?number ;
      ghcode:title ?title ;
      ghcode:state ?state ;
      ghcode:author ?author ;
      ghcode:inRepo ?repo .
  ?repo ghcode:fullName "OriginTrail/dkg-v9" .
  ?author ghcode:login ?login .
  OPTIONAL {
    ?pr ghcode:prFileDiff ?diff .
    ?diff ghcode:diffPath ?path ; ghcode:diffStatus ?dstatus .
  }
  OPTIONAL {
    ?pr ghcode:prCommit ?commit .
    ?commit ghcode:shortSha ?sha ; ghcode:message ?msg .
  }
  OPTIONAL {
    ?review a ghcode:Review ;
            ghcode:reviewOf ?pr ;
            ghcode:reviewState ?verdict ;
            ghcode:author ?reviewer .
    ?reviewer ghcode:login ?rLogin .
  }
}
```

---

## Graph Retrieval Strategy

### URI Patterns

All entities use deterministic URIs based on GitHub's stable identifiers:

| Entity | URI Pattern | Example |
|--------|-------------|---------|
| Repository | `urn:github:repo:{owner}/{repo}` | `urn:github:repo:OriginTrail/dkg-v9` |
| PR | `urn:github:pr:{owner}/{repo}/{number}` | `urn:github:pr:OriginTrail/dkg-v9/220` |
| Issue | `urn:github:issue:{owner}/{repo}/{number}` | `urn:github:issue:OriginTrail/dkg-v9/42` |
| Commit | `urn:github:commit:{owner}/{repo}/{sha}` | `urn:github:commit:OriginTrail/dkg-v9/abc123...` |
| Branch | `urn:github:branch:{owner}/{repo}/{name}` | `urn:github:branch:OriginTrail/dkg-v9/main` |
| Tag | `urn:github:tag:{owner}/{repo}/{name}` | `urn:github:tag:OriginTrail/dkg-v9/v1.0.0` |
| User | `urn:github:user:{login}` | `urn:github:user:jurij` |
| Org | `urn:github:org:{login}` | `urn:github:org:OriginTrail` |
| Review | `urn:github:review:{owner}/{repo}/{pr_number}/{review_id}` | `urn:github:review:OriginTrail/dkg-v9/220/12345` |
| Label | `urn:github:label:{owner}/{repo}/{name}` | `urn:github:label:OriginTrail/dkg-v9/bug` |
| CheckSuite | `urn:github:checksuite:{owner}/{repo}/{id}` | `urn:github:checksuite:OriginTrail/dkg-v9/99` |
| CheckRun | `urn:github:checkrun:{owner}/{repo}/{id}` | `urn:github:checkrun:OriginTrail/dkg-v9/456` |
| Workflow | `urn:github:workflow:{owner}/{repo}/{id}` | `urn:github:workflow:OriginTrail/dkg-v9/7` |
| Release | `urn:github:release:{owner}/{repo}/{tag}` | `urn:github:release:OriginTrail/dkg-v9/v1.0.0` |
| AgentSession | `urn:ghcollab:session:{agent}:{timestamp}` | `urn:ghcollab:session:claude-code:1711324800` |
| CodeClaim | `urn:ghcollab:claim:{agent}:{path}:{timestamp}` | `urn:ghcollab:claim:claude-code:src/index.ts:1711324800` |

Nested entities (FileDiff, ReviewComment, IssueComment) use blank nodes that skolemize under their parent rootEntity:
- FileDiff in commit: `urn:github:commit:{...}/.well-known/genid/diff-{path-hash}`
- ReviewComment: `urn:github:pr:{...}/.well-known/genid/rc-{comment_id}`
- IssueComment: `urn:github:issue:{...}/.well-known/genid/ic-{comment_id}`

### rootEntity Mapping

The DKG publish system requires a `rootEntity` for each Knowledge Asset. The GitHub Code Ontology uses three natural root entity types:

| Root Entity | Contains | Update Frequency |
|-------------|----------|------------------|
| **Repository** | Repo metadata, branches, tags, contributors, labels, milestones, workflows | Low (daily sync) |
| **PullRequest** | PR metadata, commits, file diffs, reviews, review comments, check results | Medium (per webhook event) |
| **Issue** | Issue metadata, comments, labels, reactions | Medium (per webhook event) |

This mapping means:
- One KA per repository snapshot, one KA per PR, one KA per issue
- All nested entities (commits in a PR, comments on an issue) are skolemized children of their parent rootEntity
- Workspace writes (upserts) handle updates without needing on-chain confirmation for every change

### Paranet Strategy

All GitHub data for a project goes into a single paranet:
- Paranet ID: `github-collab:{owner}/{repo}` (e.g., `github-collab:OriginTrail/dkg-v9`)
- Data graph: `did:dkg:paranet:github-collab:OriginTrail/dkg-v9`
- Workspace graph: `did:dkg:paranet:github-collab:OriginTrail/dkg-v9/_workspace`

Real-time webhook data goes to the **workspace graph** first (fast, no chain), then periodically gets enshrined to the **data graph** (with Merkle proofs and chain confirmation).

### Incremental Sync Strategy

1. **Initial sync**: Full repository snapshot → publish as one KC with repo + all open PRs + all open issues as separate KAs
2. **Webhook-driven updates**: On PR/issue events, upsert the affected KA in the workspace graph
3. **Periodic enshrinement**: Every N hours, batch workspace changes into a formal publish (data graph with Merkle proofs)
4. **Conflict resolution**: Use `snapshotAt` timestamps to determine freshness; latest snapshot wins

### Query Optimization Notes

- **Graph scoping**: All queries are automatically scoped to the paranet's data graph by the DKG query engine. Include `includeWorkspace: true` to also search workspace (draft) data.
- **Index-friendly patterns**: Start triple patterns with the most selective term (specific URI > `rdf:type` > property scan)
- **Avoid unbounded traversals**: Use `LIMIT` on all user-facing queries. The QueryHandler enforces MAX_LIMIT=1000.
- **FILTER placement**: Place FILTERs immediately after the triple patterns they constrain for optimal execution.
- **OPTIONAL last**: Put OPTIONAL patterns at the end of WHERE clauses to avoid unnecessary joins.
- **No SERVICE/GRAPH/FROM**: Remote queries (via QueryHandler) strip these clauses. Only use them in local-only contexts.
