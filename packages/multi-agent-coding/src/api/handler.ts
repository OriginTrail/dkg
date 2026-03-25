import type { IncomingMessage, ServerResponse } from 'node:http';
import { GitHubCollabCoordinator, type RepoConfig } from '../dkg/coordinator.js';
import { GitHubClient } from '../github/client.js';

const PREFIX = '/api/apps/github-collab';

/** Strip characters that could break IRI syntax in SPARQL interpolation. */
function sanitizeIriSegment(value: string): string {
  return value.replace(/[<>"{}|\\^`\s]/g, '');
}

function json(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export type AppRequestHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

/**
 * Creates the GitHub Collaboration app request handler.
 * When a DKG agent is provided, the handler uses full DKG integration.
 * Without an agent, it falls back to limited mode.
 */
export default function createHandler(agent?: any, config?: any): AppRequestHandler & { destroy: () => void } {
  let coordinator: GitHubCollabCoordinator | null = null;

  if (agent && typeof agent.peerId === 'string' && agent.gossip) {
    coordinator = new GitHubCollabCoordinator(agent, config, (msg: string) => {
      console.log(`[GitHubCollab] ${msg}`);
    });
  }

  const handler = (async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!path.startsWith(PREFIX)) return false;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }

    const subpath = path.slice(PREFIX.length) || '/';

    try {
      // --- GET /info ---
      if (req.method === 'GET' && subpath === '/info') {
        return json(res, 200, {
          id: 'github-collab',
          label: 'GitHub Collaboration',
          version: '0.1.0',
          dkgEnabled: !!coordinator,
          peerId: coordinator?.myPeerId ?? null,
          nodeName: config?.name ?? null,
        });
      }

      // --- GET /status ---
      if (req.method === 'GET' && subpath === '/status') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repos = coordinator.getConfiguredRepos().map(r => ({
          repoKey: `${r.owner}/${r.repo}`,
          paranetId: r.paranetId,
          syncStatus: coordinator!.getSyncStatusForRepo(`${r.owner}/${r.repo}`)?.status ?? 'idle',
          lastSyncAt: r.lastSyncAt ?? null,
          webhookActive: !!r.webhookSecret,
        }));
        return json(res, 200, { ok: true, repos, dkgEnabled: true, peerId: coordinator.myPeerId });
      }

      // --- GET /config ---
      if (req.method === 'GET' && subpath === '/config') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repos = coordinator.getConfiguredRepos().map(r => ({
          owner: r.owner,
          repo: r.repo,
          paranetId: r.paranetId,
          syncEnabled: true,
          hasToken: !!r.githubToken,
          webhookSecret: r.webhookSecret ? 'configured' : null,
          pollIntervalMs: r.pollIntervalMs,
          syncScope: r.syncScope,
          privacyLevel: r.privacyLevel,
        }));
        return json(res, 200, { repos, githubTokenConfigured: repos.some(r => r.syncEnabled) });
      }

      // --- POST /config/repo ---
      if (req.method === 'POST' && subpath === '/config/repo') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo) return json(res, 400, { error: 'Missing owner or repo' });

        const result = await coordinator.addRepo({
          owner: body.owner,
          repo: body.repo,
          githubToken: body.githubToken,
          webhookSecret: body.webhookSecret,
          pollIntervalMs: body.pollIntervalMs,
          syncScope: body.syncScope,
          paranetId: body.paranetId,
          privacyLevel: body.privacyLevel ?? 'local',
        });

        // Start polling if token provided
        if (body.githubToken) {
          coordinator.startPolling(`${body.owner}/${body.repo}`);
        }

        return json(res, 200, { ok: true, ...result });
      }

      // --- POST /convert-to-shared ---
      if (req.method === 'POST' && subpath === '/convert-to-shared') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo) return json(res, 400, { error: 'Missing owner or repo' });
        const result = await coordinator.convertToShared(body.owner, body.repo);
        return json(res, 200, { ok: true, paranetId: result.paranetId, syncJobId: result.syncJobId ?? null });
      }

      // --- DELETE /config/repo ---
      if (req.method === 'DELETE' && subpath === '/config/repo') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo) return json(res, 400, { error: 'Missing owner or repo' });
        coordinator.removeRepo(body.owner, body.repo);
        return json(res, 200, { ok: true });
      }

      // --- POST /webhook ---
      if (req.method === 'POST' && subpath === '/webhook') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = await readBody(req);
        const event = req.headers['x-github-event'] as string;
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        const deliveryId = req.headers['x-github-delivery'] as string | undefined;

        if (!event) return json(res, 400, { error: 'Missing X-GitHub-Event header' });

        let payload: any;
        try { payload = JSON.parse(body.toString()); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

        const action = payload.action;
        const result = await coordinator.processWebhook(event, action, payload, deliveryId, body, signature);
        return json(res, result.ok ? 200 : 400, result);
      }

      // --- POST /sync ---
      if (req.method === 'POST' && subpath === '/sync') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo) return json(res, 400, { error: 'Missing owner or repo' });
        const job = await coordinator.startSync(body.owner, body.repo, body.scope, body.since);
        return json(res, 200, { ok: true, jobId: job.jobId, status: job.status });
      }

      // --- GET /sync/status ---
      if (req.method === 'GET' && subpath === '/sync/status') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const jobId = url.searchParams.get('jobId');
        const repo = url.searchParams.get('repo');
        const job = jobId
          ? coordinator.getSyncStatus(jobId)
          : repo ? coordinator.getSyncStatusForRepo(repo) : undefined;
        if (!job) return json(res, 404, { error: 'Sync job not found' });
        return json(res, 200, job);
      }

      // --- POST /query ---
      if (req.method === 'POST' && subpath === '/query') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.sparql) return json(res, 400, { error: 'Missing sparql' });
        const result = await coordinator.query(body.sparql, body.repo, body.includeWorkspace !== false);
        return json(res, 200, { result });
      }

      // --- POST /auth/test ---
      if (req.method === 'POST' && subpath === '/auth/test') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.token) return json(res, 400, { error: 'Missing token' });
        const client = new GitHubClient({ token: body.token });
        const result = await client.validateToken();
        return json(res, 200, result);
      }

      // --- POST /review/request ---
      if (req.method === 'POST' && subpath === '/review/request') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo || !body.prNumber) {
          return json(res, 400, { error: 'Missing owner, repo, or prNumber' });
        }
        const session = await coordinator.createReviewSession(
          body.owner, body.repo, body.prNumber,
          body.reviewers ?? [], body.requiredApprovals ?? 1,
        );
        return json(res, 200, { ok: true, ...session });
      }

      // --- POST /review/submit ---
      if (req.method === 'POST' && subpath === '/review/submit') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.sessionId || !body.decision) {
          return json(res, 400, { error: 'Missing sessionId or decision' });
        }
        const session = await coordinator.submitReview(body.sessionId, body.decision, body.comment);
        const approvals = session.reviews.filter(r => r.decision === 'approve').length;
        return json(res, 200, {
          ok: true,
          decision: body.decision,
          signaturesCollected: approvals,
          signaturesRequired: session.requiredApprovals,
          consensusReached: session.status !== 'pending',
        });
      }

      // --- GET /review/status ---
      if (req.method === 'GET' && subpath === '/review/status') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return json(res, 400, { error: 'Missing sessionId' });
        const session = coordinator.getReviewSession(sessionId);
        if (!session) return json(res, 404, { error: 'Review session not found' });
        return json(res, 200, session);
      }

      // --- POST /invite ---
      if (req.method === 'POST' && subpath === '/invite') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.owner || !body.repo || !body.peerId) {
          return json(res, 400, { error: 'Missing owner, repo, or peerId' });
        }
        const invitation = await coordinator.sendInvitation(`${body.owner}/${body.repo}`, body.peerId);
        return json(res, 200, { ok: true, ...invitation });
      }

      // --- GET /invitations ---
      if (req.method === 'GET' && subpath === '/invitations') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repoFilter = url.searchParams.get('repo') ?? undefined;
        const invitations = coordinator.getInvitations(repoFilter);
        return json(res, 200, invitations);
      }

      // --- POST /invitations/:id/accept ---
      // --- POST /invitations/:id/decline ---
      // --- DELETE /invitations/:id ---
      {
        const invMatch = subpath.match(/^\/invitations\/([^/]+)\/(accept|decline)$/);
        if (invMatch && req.method === 'POST') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const [, invitationId, action] = invMatch;
          if (action === 'accept') {
            const invitation = await coordinator.acceptInvitation(invitationId);
            return json(res, 200, { ok: true, ...invitation });
          } else {
            const invitation = await coordinator.declineInvitation(invitationId);
            return json(res, 200, { ok: true, ...invitation });
          }
        }

        const revokeMatch = subpath.match(/^\/invitations\/([^/]+)$/);
        if (revokeMatch && req.method === 'DELETE') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const [, invitationId] = revokeMatch;
          coordinator.revokeInvitation(invitationId);
          return json(res, 200, { ok: true });
        }
      }

      // --- GET /collaborators ---
      if (req.method === 'GET' && subpath === '/collaborators') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repoParam = url.searchParams.get('repo');
        if (!repoParam) return json(res, 400, { error: 'Missing repo query parameter' });
        const collaborators = coordinator.getCollaborators(repoParam);
        return json(res, 200, { collaborators });
      }

      // --- GET /repos/:owner/:repo/prs ---
      const prsMatch = subpath.match(/^\/repos\/([^/]+)\/([^/]+)\/prs$/);
      if (req.method === 'GET' && prsMatch) {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const owner = sanitizeIriSegment(prsMatch[1]);
        const repo = sanitizeIriSegment(prsMatch[2]);

        const allowedStates = ['open', 'closed', 'merged', 'all'];
        const rawState = url.searchParams.get('state') ?? 'all';
        const state = allowedStates.includes(rawState) ? rawState : 'all';

        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 50, 1), 200);
        const parsedOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const offset = Math.max(Number.isFinite(parsedOffset) ? parsedOffset : 0, 0);

        const sparql = `
          SELECT ?pr ?number ?title ?state ?author ?createdAt ?mergedAt WHERE {
            ?pr a <https://ontology.dkg.io/ghcode#PullRequest> ;
                <https://ontology.dkg.io/ghcode#prNumber> ?number ;
                <https://ontology.dkg.io/ghcode#inRepo> <urn:github:${owner}/${repo}> .
            OPTIONAL { ?pr <https://ontology.dkg.io/ghcode#title> ?title }
            OPTIONAL { ?pr <https://ontology.dkg.io/ghcode#state> ?state }
            OPTIONAL { ?pr <https://ontology.dkg.io/ghcode#author> ?authorUri . ?authorUri <https://ontology.dkg.io/ghcode#login> ?author }
            OPTIONAL { ?pr <https://ontology.dkg.io/ghcode#createdAt> ?createdAt }
            OPTIONAL { ?pr <https://ontology.dkg.io/ghcode#mergedAt> ?mergedAt }
            ${state !== 'all' ? `FILTER(?state = "${state}")` : ''}
          }
          ORDER BY DESC(?createdAt)
          LIMIT ${limit} OFFSET ${offset}
        `;

        const result = await coordinator.query(sparql, `${owner}/${repo}`);
        const bindings = result?.bindings ?? result?.result?.bindings ?? [];
        return json(res, 200, { pullRequests: bindings, total: bindings.length });
      }

      // --- GET /repos/:owner/:repo/prs/:number ---
      const prDetailMatch = subpath.match(/^\/repos\/([^/]+)\/([^/]+)\/prs\/(\d+)$/);
      if (req.method === 'GET' && prDetailMatch) {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const owner = sanitizeIriSegment(prDetailMatch[1]);
        const repo = sanitizeIriSegment(prDetailMatch[2]);
        const numStr = prDetailMatch[3];
        const prNumber = Number(numStr);

        const sparql = `
          SELECT ?p ?o WHERE {
            <urn:github:${owner}/${repo}/pr/${prNumber}> ?p ?o .
          }
        `;
        const result = await coordinator.query(sparql, `${owner}/${repo}`);
        const bindings = result?.bindings ?? result?.result?.bindings ?? [];
        return json(res, 200, { prNumber, triples: bindings });
      }

      // --- GET /repos/:owner/:repo/branches ---
      const branchesMatch = subpath.match(/^\/repos\/([^/]+)\/([^/]+)\/branches$/);
      if (req.method === 'GET' && branchesMatch) {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const owner = sanitizeIriSegment(branchesMatch[1]);
        const repo = sanitizeIriSegment(branchesMatch[2]);
        const repoConfig = coordinator.getRepoConfig(owner, repo);
        if (!repoConfig?.githubToken) {
          return json(res, 400, { error: 'No GitHub token configured for this repo' });
        }
        const client = new GitHubClient({ token: repoConfig.githubToken });
        const branches = await client.listBranches(owner, repo);
        return json(res, 200, { branches: branches.map((b: any) => ({ name: b.name, protected: b.protected })) });
      }

      // =====================================================================
      // Agent Activity Endpoints
      // =====================================================================

      // --- POST /sessions ---
      if (req.method === 'POST' && subpath === '/sessions') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.agentName || !body.repoKey) return json(res, 400, { error: 'Missing agentName or repoKey' });
        const session = await coordinator.startAgentSession(body.repoKey, body.agentName, {
          goal: body.goal,
          relatedPr: body.relatedPr,
          relatedIssue: body.relatedIssue,
        });
        return json(res, 200, { ok: true, sessionId: session.sessionId, startedAt: new Date(session.startedAt).toISOString() });
      }

      // --- GET /sessions ---
      if (req.method === 'GET' && subpath === '/sessions') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const status = url.searchParams.get('status') ?? undefined;
        const sessions = coordinator.getAgentSessions({ status });
        return json(res, 200, { sessions });
      }

      // --- POST /sessions/:id/heartbeat ---
      {
        const hbMatch = subpath.match(/^\/sessions\/([^/]+)\/heartbeat$/);
        if (hbMatch && req.method === 'POST') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const session = await coordinator.heartbeatAgentSession(hbMatch[1]);
          const sessionAge = Math.floor((Date.now() - session.startedAt) / 1000);
          const activeClaims = coordinator.getActiveClaims().filter(c => c.sessionId === hbMatch[1]).length;
          return json(res, 200, { ok: true, sessionAge, activeClaims });
        }
      }

      // --- POST /sessions/:id/files ---
      {
        const filesMatch = subpath.match(/^\/sessions\/([^/]+)\/files$/);
        if (filesMatch && req.method === 'POST') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const body = JSON.parse((await readBody(req)).toString());
          if (!Array.isArray(body.files)) return json(res, 400, { error: 'Missing files array' });
          const repoKeyParam = body.repoKey ?? url.searchParams.get('repo') ?? '';
          const result = await coordinator.addSessionFiles(filesMatch[1], body.files, repoKeyParam);
          return json(res, 200, { ok: true, totalFiles: result.totalFiles, warnings: result.warnings });
        }
      }

      // --- POST /sessions/:id/end ---
      {
        const endMatch = subpath.match(/^\/sessions\/([^/]+)\/end$/);
        if (endMatch && req.method === 'POST') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const body = JSON.parse((await readBody(req)).toString());
          const repoKeyParam = body.repoKey ?? '';
          const result = await coordinator.endAgentSession(endMatch[1], repoKeyParam, body.summary);
          const duration = Math.floor((Date.now() - result.session.startedAt) / 1000);
          return json(res, 200, {
            ok: true,
            sessionId: endMatch[1],
            duration,
            filesModified: result.session.modifiedFiles.length,
            claimsReleased: result.releasedClaims.length,
          });
        }
      }

      // --- POST /claims ---
      if (req.method === 'POST' && subpath === '/claims') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!Array.isArray(body.files) || !body.sessionId || !body.agentName || !body.repoKey) {
          return json(res, 400, { error: 'Missing files, sessionId, agentName, or repoKey' });
        }
        const result = await coordinator.claimFiles(body.repoKey, body.files, body.sessionId, body.agentName);
        return json(res, 200, {
          ok: true,
          claims: result.claimed.map(c => ({ claimId: c.claimId, file: c.filePath, status: 'active' })),
          conflicts: result.conflicts.map(c => ({
            file: c.file,
            status: 'conflict',
            existingClaim: {
              claimId: c.existingClaim.claimId,
              claimedBy: c.existingClaim.agentName,
              since: new Date(c.existingClaim.claimedAt).toISOString(),
            },
          })),
        });
      }

      // --- GET /claims ---
      if (req.method === 'GET' && subpath === '/claims') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repoFilter = url.searchParams.get('repo') ?? undefined;
        const claims = coordinator.getActiveClaims(repoFilter);
        return json(res, 200, {
          claims: claims.map(c => ({
            claimId: c.claimId,
            file: c.filePath,
            agent: c.agentName,
            sessionId: c.sessionId,
            since: new Date(c.claimedAt).toISOString(),
          })),
        });
      }

      // --- DELETE /claims/:id ---
      {
        const claimDeleteMatch = subpath.match(/^\/claims\/([^/]+)$/);
        if (claimDeleteMatch && req.method === 'DELETE') {
          if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
          const released = await coordinator.releaseClaim(claimDeleteMatch[1]);
          if (!released) return json(res, 404, { error: 'Claim not found' });
          return json(res, 200, { ok: true, claimId: claimDeleteMatch[1], releasedAt: new Date().toISOString() });
        }
      }

      // --- POST /decisions ---
      if (req.method === 'POST' && subpath === '/decisions') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.summary || !body.rationale || !body.agentName || !body.repoKey) {
          return json(res, 400, { error: 'Missing summary, rationale, agentName, or repoKey' });
        }
        const decision = await coordinator.recordDecision(body.repoKey, {
          summary: body.summary,
          rationale: body.rationale,
          alternatives: body.alternatives,
          affectedFiles: body.affectedFiles ?? [],
          agentName: body.agentName,
          sessionId: body.sessionId,
        });
        return json(res, 200, { ok: true, decisionId: decision.decisionId });
      }

      // --- GET /decisions ---
      if (req.method === 'GET' && subpath === '/decisions') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repoFilter = url.searchParams.get('repo') ?? undefined;
        const decisions = coordinator.getDecisions(repoFilter);
        return json(res, 200, { decisions });
      }

      // --- POST /annotations ---
      if (req.method === 'POST' && subpath === '/annotations') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.targetUri || !body.kind || !body.content || !body.agentName || !body.repoKey) {
          return json(res, 400, { error: 'Missing targetUri, kind, content, agentName, or repoKey' });
        }
        const annotation = await coordinator.addAnnotation(body.repoKey, {
          targetUri: body.targetUri,
          kind: body.kind,
          content: body.content,
          agentName: body.agentName,
          sessionId: body.sessionId,
        });
        return json(res, 200, { ok: true, annotationId: annotation.annotationId });
      }

      // --- GET /activity ---
      if (req.method === 'GET' && subpath === '/activity') {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const repoFilter = url.searchParams.get('repo') ?? undefined;
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
        const activities = coordinator.getAgentActivity(repoFilter, limit);
        return json(res, 200, { activities });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const msg = err.message ?? '';
      const isClientError = err instanceof SyntaxError
        || /Missing|not found|not configured|shared mode|Invalid/i.test(msg);
      return json(res, isClientError ? 400 : 500, { error: msg });
    }
  }) as AppRequestHandler & { destroy: () => void };

  handler.destroy = () => coordinator?.destroy();
  return handler;
}
