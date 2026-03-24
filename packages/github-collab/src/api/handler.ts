import type { IncomingMessage, ServerResponse } from 'node:http';
import { GitHubCollabCoordinator, type RepoConfig } from '../dkg/coordinator.js';
import { GitHubClient } from '../github/client.js';

const PREFIX = '/api/apps/github-collab';

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
          syncEnabled: !!r.githubToken,
          webhookSecret: r.webhookSecret ? 'configured' : null,
          pollIntervalMs: r.pollIntervalMs,
          syncScope: r.syncScope,
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
        });

        // Start polling if token provided
        if (body.githubToken) {
          coordinator.startPolling(`${body.owner}/${body.repo}`);
        }

        return json(res, 200, { ok: true, ...result });
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

      // --- GET /repos/:owner/:repo/prs ---
      const prsMatch = subpath.match(/^\/repos\/([^/]+)\/([^/]+)\/prs$/);
      if (req.method === 'GET' && prsMatch) {
        if (!coordinator) return json(res, 503, { error: 'DKG agent not available' });
        const [, owner, repo] = prsMatch;

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
        const [, owner, repo, numStr] = prDetailMatch;
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
        const [, owner, repo] = branchesMatch;
        const repoConfig = coordinator.getRepoConfig(owner, repo);
        if (!repoConfig?.githubToken) {
          return json(res, 400, { error: 'No GitHub token configured for this repo' });
        }
        const client = new GitHubClient({ token: repoConfig.githubToken });
        const branches = await client.listBranches(owner, repo);
        return json(res, 200, { branches: branches.map((b: any) => ({ name: b.name, protected: b.protected })) });
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err: any) {
      return json(res, 400, { error: err.message });
    }
  }) as AppRequestHandler & { destroy: () => void };

  handler.destroy = () => coordinator?.destroy();
  return handler;
}
