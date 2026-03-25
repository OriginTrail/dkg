---
name: multi-agent-coding
description: Multi-agent coding coordination via the DKG V9 knowledge graph — start sessions, claim files, record decisions, query the codebase graph, and coordinate with other agents to avoid conflicts.
---

# Multi-agent Coding — Agent Skill

You are connected to the **Multi-agent Coding** coordination system running on a DKG V9 node. This system maintains a knowledge graph of a GitHub repository — its code structure (files, classes, functions, imports), PRs, issues, commits, and agent activity. Use it to coordinate with other agents working on the same codebase.

## Connection

**Base URL:** `http://localhost:9200/api/apps/github-collab`

**Authentication:** Read the auth token from `~/.dkg/auth.token`:
```bash
AUTH_TOKEN=$(grep -v '^#' ~/.dkg/auth.token | head -1)
```

**Headers for all requests:**
```
Content-Type: application/json
Authorization: Bearer <AUTH_TOKEN>
```

## Before Starting Work

**1. Check what other agents are doing:**
```
GET /sessions?status=active
GET /claims?repo=owner/repo
GET /activity?repo=owner/repo&limit=10
GET /decisions?repo=owner/repo
```

**2. Start a session** to announce your presence:
```
POST /sessions
{
  "agentName": "your-agent-name",
  "repoKey": "owner/repo",
  "goal": "What you plan to do",
  "relatedPr": 42,
  "relatedIssue": 15
}
→ { "ok": true, "sessionId": "sess-xxx", "startedAt": "..." }
```

**3. Claim files** you plan to modify:
```
POST /claims
{
  "files": ["src/auth/login.ts", "src/auth/session.ts"],
  "sessionId": "sess-xxx",
  "agentName": "your-agent-name",
  "repoKey": "owner/repo"
}
→ { "ok": true, "claims": [...], "conflicts": [...] }
```

If conflicts are returned, **do not modify those files**. Work on something else or wait.

## During Work

**Send heartbeats** every 2-3 minutes (sessions abandoned after 5 min without heartbeat):
```
POST /sessions/{sessionId}/heartbeat
```

**Report modified files** as you work:
```
POST /sessions/{sessionId}/files
{ "files": ["src/auth/login.ts"] }
```

**Record architectural decisions** when you make non-trivial choices:
```
POST /decisions
{
  "summary": "Use JWT instead of session cookies",
  "rationale": "Stateless auth scales better for P2P",
  "alternatives": ["Session cookies", "OAuth2 PKCE"],
  "affectedFiles": ["src/auth/handler.ts"],
  "agentName": "your-agent-name",
  "sessionId": "sess-xxx",
  "repoKey": "owner/repo"
}
```

**Add annotations** to flag findings on code entities:
```
POST /annotations
{
  "targetUri": "urn:github:owner/repo/file/src%2Fauth%2Flogin.ts",
  "kind": "warning",
  "content": "No rate limiting on login endpoint",
  "agentName": "your-agent-name",
  "sessionId": "sess-xxx",
  "repoKey": "owner/repo"
}
```
Annotation kinds: `finding`, `suggestion`, `warning`, `note`.

## After Finishing Work

**End your session** with a summary (automatically releases all claims):
```
POST /sessions/{sessionId}/end
{ "summary": "What you accomplished" }
```

To release a single claim early:
```
DELETE /claims/{claimId}
```

## Querying the Knowledge Graph

Use SPARQL to understand the codebase before exploring files directly — it costs far fewer tokens:

```
POST /query
{
  "sparql": "SELECT ?class ?name ?path WHERE { ?class a <https://ontology.dkg.io/ghcode#Class> ; <https://ontology.dkg.io/ghcode#name> ?name ; <https://ontology.dkg.io/ghcode#definedIn> ?file . ?file <https://ontology.dkg.io/ghcode#path> ?path } LIMIT 20",
  "repo": "owner/repo",
  "includeWorkspace": true
}
```

### Useful Queries

| What | Query |
|------|-------|
| All files | `SELECT ?path WHERE { ?f a <ghcode:File> ; <ghcode:path> ?path } ORDER BY ?path` |
| Classes + files | `SELECT ?name ?path WHERE { ?c a <ghcode:Class> ; <ghcode:name> ?name ; <ghcode:definedIn> ?f . ?f <ghcode:path> ?path }` |
| Functions in a file | `SELECT ?name WHERE { ?fn a <ghcode:Function> ; <ghcode:name> ?name ; <ghcode:definedIn> ?f . ?f <ghcode:path> ?p . FILTER(CONTAINS(?p, "auth")) }` |
| Open PRs | `SELECT ?num ?title WHERE { ?pr a <ghcode:PullRequest> ; <ghcode:prNumber> ?num ; <ghcode:title> ?title ; <ghcode:state> "open" }` |
| Active sessions | `SELECT ?agent ?goal WHERE { ?s a <ghcode:AgentSession> ; <ghcode:agentName> ?agent ; <ghcode:sessionStatus> "active" . OPTIONAL { ?s <ghcode:goal> ?goal } }` |
| Recent decisions | `SELECT ?summary ?agent WHERE { ?d a <ghcode:Decision> ; <ghcode:decisionSummary> ?summary ; <ghcode:madeBy> ?agent } LIMIT 10` |

Replace `ghcode:` with `https://ontology.dkg.io/ghcode#` in actual queries.

## Best Practices

1. **Always start a session** before doing any work
2. **Claim files before modifying** — check `GET /claims` first
3. **Send heartbeats regularly** (every 2-3 min)
4. **Record decisions** when choosing between approaches
5. **End sessions cleanly** with a summary
6. **Use SPARQL first** to understand code structure before reading files
7. **Check activity timeline** before starting to avoid duplicating work
8. **Handle conflicts gracefully** — don't force modify claimed files

## Claims and Branches

File claims are branch-agnostic. A claim on `src/auth/login.ts` means "I am actively modifying this file" regardless of which branch you're on.

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Start a coding session |
| GET | /sessions | List sessions (?status=active) |
| POST | /sessions/:id/heartbeat | Keep session alive |
| POST | /sessions/:id/files | Report modified files |
| POST | /sessions/:id/end | End session with summary |
| POST | /claims | Claim files (conflict detection) |
| GET | /claims | List active claims |
| DELETE | /claims/:id | Release a claim |
| POST | /decisions | Record a decision |
| GET | /decisions | List decisions |
| POST | /annotations | Annotate a code entity |
| GET | /activity | Activity timeline |
| POST | /query | SPARQL query |
