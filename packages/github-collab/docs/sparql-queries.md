# GitHub Code Ontology — SPARQL Query Examples

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

