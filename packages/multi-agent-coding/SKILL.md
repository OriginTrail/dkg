# Multi-agent Coding — Agent Skill Guide

This document describes how coding agents interact with the Multi-agent Coding coordination system. It provides the API surface, recommended workflows, and SPARQL query examples needed for any agent framework (Claude Code, Codex, Cursor, etc.) to participate in coordinated multi-agent development on a shared codebase.

## What This System Does

The Multi-agent Coding app maintains a **knowledge graph** of a GitHub repository — its code structure, PRs, issues, branches, and agent activity. When multiple agents work on the same repo, this system provides:

- **Session tracking** — declare what you're working on so others can see
- **File claims** — reserve files to prevent merge conflicts
- **Decision records** — log architectural decisions for team visibility
- **Annotations** — attach findings, warnings, or suggestions to code entities
- **Knowledge graph queries** — understand the codebase structure via SPARQL
- **Conflict detection** — get warned before modifying files another agent owns

## How to Connect

**Base URL:** `http://localhost:<PORT>/api/apps/github-collab`

The port is configured by the DKG node operator (default: 8900). All endpoints accept and return JSON. No authentication token is required for local nodes.

**Headers:**
```
Content-Type: application/json
```

## Agent Lifecycle

### 1. Before Starting Work

**Start a session** to announce your presence and intent:

```
POST /sessions
{
  "agentName": "claude-code-1",
  "repoKey": "owner/repo",
  "goal": "Fix authentication bug in login flow",
  "relatedPr": 42,
  "relatedIssue": 15
}
```

Response:
```json
{ "ok": true, "sessionId": "sess-a1b2c3d4", "startedAt": "2026-03-25T10:00:00.000Z" }
```

**Check what other agents are doing:**

```
GET /sessions?status=active
```

**Check existing file claims** before touching files:

```
GET /claims?repo=owner/repo
```

**Claim the files you plan to modify:**

```
POST /claims
{
  "files": ["src/auth/login.ts", "src/auth/session.ts"],
  "sessionId": "sess-a1b2c3d4",
  "agentName": "claude-code-1",
  "repoKey": "owner/repo"
}
```

Response includes any conflicts:
```json
{
  "ok": true,
  "claims": [{ "claimId": "clm-x1y2z3", "file": "src/auth/login.ts", "status": "active" }],
  "conflicts": [{
    "file": "src/auth/session.ts",
    "status": "conflict",
    "existingClaim": { "claimId": "clm-other", "claimedBy": "codex-agent", "since": "2026-03-25T09:30:00Z" }
  }]
}
```

If a conflict is returned, **do not modify that file** — coordinate with the claiming agent or work on something else.

### 2. During Work

**Send heartbeats** every 2-3 minutes to keep your session alive (sessions are abandoned after 5 minutes without a heartbeat):

```
POST /sessions/{sessionId}/heartbeat
```

**Report modified files** as you work:

```
POST /sessions/{sessionId}/files
{
  "files": ["src/auth/login.ts", "src/auth/middleware.ts"],
  "repoKey": "owner/repo"
}
```

**Record architectural decisions** when you make non-trivial choices:

```
POST /decisions
{
  "summary": "Switched from JWT to session cookies for auth",
  "rationale": "JWT refresh token rotation added too much client complexity",
  "alternatives": ["Keep JWT with silent refresh", "Use OAuth2 PKCE flow"],
  "affectedFiles": ["src/auth/login.ts", "src/auth/middleware.ts"],
  "agentName": "claude-code-1",
  "repoKey": "owner/repo",
  "sessionId": "sess-a1b2c3d4"
}
```

**Add annotations** to flag issues or suggestions on code entities:

```
POST /annotations
{
  "targetUri": "urn:github:owner/repo/file/src/auth/login.ts",
  "kind": "warning",
  "content": "This function has no rate limiting — vulnerable to brute force",
  "agentName": "claude-code-1",
  "repoKey": "owner/repo",
  "sessionId": "sess-a1b2c3d4"
}
```

Annotation kinds: `finding`, `suggestion`, `warning`, `note`.

### 3. After Finishing Work

**End your session** with a summary:

```
POST /sessions/{sessionId}/end
{
  "summary": "Fixed login bug by adding session validation. Added rate limiting middleware.",
  "repoKey": "owner/repo"
}
```

This automatically releases all your file claims.

To release a single claim early (e.g., you finished with one file but are still working on others):

```
DELETE /claims/{claimId}
```

## Read-Only Endpoints

### Activity Timeline

Get a unified feed of all agent activity:

```
GET /activity?repo=owner/repo&limit=50
```

### Active Sessions

```
GET /sessions?status=active
```

### Active Claims

```
GET /claims?repo=owner/repo
```

### Decisions

```
GET /decisions?repo=owner/repo
```

### Pull Requests

```
GET /repos/{owner}/{repo}/prs?state=open&limit=20
```

### PR Detail

```
GET /repos/{owner}/{repo}/prs/{number}
```

## Querying the Knowledge Graph (SPARQL)

For advanced queries about the codebase structure, use the SPARQL endpoint:

```
POST /query
{
  "sparql": "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10",
  "repo": "owner/repo",
  "includeWorkspace": true
}
```

The `includeWorkspace` flag (default: true) includes local workspace data that hasn't been enshrined to the DKG yet.

### Common SPARQL Queries

**1. Find all files in the repo:**
```sparql
SELECT ?file ?path WHERE {
  ?file a <https://ontology.dkg.io/ghcode#File> ;
        <https://ontology.dkg.io/ghcode#path> ?path .
}
ORDER BY ?path
```

**2. Find all classes and their files:**
```sparql
SELECT ?class ?name ?path WHERE {
  ?class a <https://ontology.dkg.io/ghcode#Class> ;
         <https://ontology.dkg.io/ghcode#name> ?name ;
         <https://ontology.dkg.io/ghcode#inFile> ?file .
  ?file <https://ontology.dkg.io/ghcode#path> ?path .
}
```

**3. Find functions in a specific file:**
```sparql
SELECT ?fn ?name ?sig WHERE {
  ?fn a <https://ontology.dkg.io/ghcode#Function> ;
      <https://ontology.dkg.io/ghcode#name> ?name ;
      <https://ontology.dkg.io/ghcode#inFile> ?file .
  ?file <https://ontology.dkg.io/ghcode#path> ?path .
  FILTER(CONTAINS(?path, "auth/login"))
  OPTIONAL { ?fn <https://ontology.dkg.io/ghcode#signature> ?sig }
}
```

**4. Find what imports a module:**
```sparql
SELECT ?importerPath WHERE {
  ?importer <https://ontology.dkg.io/ghcode#imports> ?target ;
            <https://ontology.dkg.io/ghcode#path> ?importerPath .
  ?target <https://ontology.dkg.io/ghcode#path> ?targetPath .
  FILTER(CONTAINS(?targetPath, "auth/session"))
}
```

**5. Get open PRs with their authors:**
```sparql
SELECT ?pr ?number ?title ?author WHERE {
  ?pr a <https://ontology.dkg.io/ghcode#PullRequest> ;
      <https://ontology.dkg.io/ghcode#prNumber> ?number ;
      <https://ontology.dkg.io/ghcode#title> ?title ;
      <https://ontology.dkg.io/ghcode#state> "open" .
  OPTIONAL {
    ?pr <https://ontology.dkg.io/ghcode#author> ?authorUri .
    ?authorUri <https://ontology.dkg.io/ghcode#login> ?author
  }
}
ORDER BY DESC(?number)
```

**6. Find files changed by a PR:**
```sparql
SELECT ?path ?changeType WHERE {
  <urn:github:owner/repo/pr/42> <https://ontology.dkg.io/ghcode#modifies> ?file .
  ?file <https://ontology.dkg.io/ghcode#path> ?path .
  OPTIONAL { ?file <https://ontology.dkg.io/ghcode#changeType> ?changeType }
}
```

**7. Find active agent sessions:**
```sparql
SELECT ?session ?agent ?goal ?started WHERE {
  ?session a <https://ontology.dkg.io/ghcode#AgentSession> ;
           <https://ontology.dkg.io/ghcode#agentName> ?agent ;
           <https://ontology.dkg.io/ghcode#status> "active" ;
           <https://ontology.dkg.io/ghcode#startedAt> ?started .
  OPTIONAL { ?session <https://ontology.dkg.io/ghcode#goal> ?goal }
}
```

**8. Find all file claims:**
```sparql
SELECT ?claim ?file ?agent ?since WHERE {
  ?claim a <https://ontology.dkg.io/ghcode#CodeClaim> ;
         <https://ontology.dkg.io/ghcode#filePath> ?file ;
         <https://ontology.dkg.io/ghcode#agentName> ?agent ;
         <https://ontology.dkg.io/ghcode#claimedAt> ?since .
}
```

**9. Graph visualization (CONSTRUCT query):**
```sparql
CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <https://ontology.dkg.io/ghcode#PullRequest> ; ?p ?o .
}
LIMIT 200
```

**10. Find recent architectural decisions:**
```sparql
SELECT ?decision ?summary ?agent ?date WHERE {
  ?decision a <https://ontology.dkg.io/ghcode#Decision> ;
            <https://ontology.dkg.io/ghcode#summary> ?summary ;
            <https://ontology.dkg.io/ghcode#agentName> ?agent ;
            <https://ontology.dkg.io/ghcode#createdAt> ?date .
}
ORDER BY DESC(?date) LIMIT 10
```

## Best Practices

1. **Always start a session** before doing any work. This makes your activity visible to other agents.

2. **Claim files before modifying them.** Check `GET /claims` first. If a file is already claimed by another agent, do not modify it.

3. **Send heartbeats regularly.** Sessions without a heartbeat for 5 minutes are marked as abandoned and their claims are released.

4. **Record architectural decisions.** When you choose between approaches, log it. Future agents (and humans) benefit from understanding why things were built a certain way.

5. **End your session cleanly.** Always call `POST /sessions/{id}/end` with a summary. This releases your claims and creates a clear activity record.

6. **Use SPARQL for codebase understanding.** Before exploring files directly, query the knowledge graph to understand the structure. It costs far fewer tokens than reading files.

7. **Check the activity timeline.** Before starting work, call `GET /activity` to see what has been happening recently. This prevents duplicating work or conflicting with in-progress changes.

8. **Handle conflicts gracefully.** If `POST /claims` returns a conflict, do not force your way through. Either work on different files, wait for the other agent to finish, or coordinate through annotations.

## Claims and Branches

File claims are **branch-agnostic**. They reference file paths within the repository, not specific branch snapshots. A claim on `src/auth/login.ts` means "I am actively modifying this file" regardless of which branch you are on. The graph represents the repo's latest synced state.

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Start a coding session |
| GET | /sessions | List sessions (filter by status) |
| POST | /sessions/:id/heartbeat | Keep session alive |
| POST | /sessions/:id/files | Report modified files |
| POST | /sessions/:id/end | End session with summary |
| POST | /claims | Claim files (with conflict detection) |
| GET | /claims | List active claims |
| DELETE | /claims/:id | Release a claim |
| POST | /decisions | Record an architectural decision |
| GET | /decisions | List decisions |
| POST | /annotations | Annotate a code entity |
| GET | /activity | Unified activity timeline |
| POST | /query | Execute a SPARQL query |
| GET | /repos/:owner/:repo/prs | List pull requests |
| GET | /repos/:owner/:repo/prs/:number | PR detail |
