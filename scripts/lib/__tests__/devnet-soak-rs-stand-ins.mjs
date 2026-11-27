// Stand-ins for the RS soak's share tests: the answers a node gives to a share
// (shaped as the daemon's share routes shape them), and a node API that gives
// planned answers and records every request.
import { once } from 'node:events';
import { createServer } from 'node:http';

export const PREREQUISITE_MESSAGE = 'A promote prerequisite is temporarily unavailable';
export const jobUrl = (jobId) => `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}`;
const pendingJob = (jobId) => ({ recoveryJobId: jobId, recoveryState: 'pending', recoveryStatusUrl: jobUrl(jobId) });

/** A share the node finished, to the create (201) or to a share (200). */
export const sharedAnswer = (status = 200) => ({
  status, body: { created: true, status: 'swm-shared', swmShared: true, promotedCount: 3, sealed: true, publishReady: true },
});

/**
 * A share whose prerequisite the node could not read just then: 503 with
 * Retry-After: 1. With `job`, the share was admitted and its job retries it.
 */
export const prerequisiteAnswer = ({ job, message = PREREQUISITE_MESSAGE } = {}) => ({
  status: 503, headers: { 'retry-after': '1' },
  body: {
    code: 'PROMOTE_RETRYABLE_FAILURE', error: message, retryAction: 'resume_existing_knowledge_asset',
    retryPhase: 'swm-share', retryable: true, ...(job ? pendingJob(job) : {}),
  },
});

/** The create's answer when the share it ran is left to a pending share job. */
export const createPendingAnswer = (job, message = PREREQUISITE_MESSAGE) => {
  const answer = prerequisiteAnswer({ job, message });
  return { ...answer, body: { created: true, ...answer.body, partial: true, phase: 'swm-share', failedPhase: 'swm-share' } };
};

/** A share sent again while the job that owns it is still active. */
export const ownerConflictAnswer = (job, message = 'Promote job already active for this asset') => ({
  status: 503, headers: { 'retry-after': '1' },
  body: { code: 'SHARE_OWNER_CONFLICT', error: message, retryable: true, ...pendingJob(job) },
});

/** The create's 207 when its share failed before a share job was admitted: the message is all it says. */
export const createdShareErrorAnswer = (message = PREREQUISITE_MESSAGE) => ({
  status: 207, body: { created: true, errors: [{ phase: 'swm-share', error: message }] },
});

/** A share answer that is final: the asset needs recovery by hand. */
export const recoveryRequiredAnswer = () => ({
  status: 409,
  body: { code: 'KA_PROMOTE_RECOVERY_REQUIRED', error: 'Share recovery required', retryAction: 'resume_existing_knowledge_asset' },
});

/**
 * A node API on a free local port. The n-th create, the n-th share and the
 * n-th status request of a job get the n-th answer planned for them (a job's
 * plan lists states), and the last one again after that. Each request is
 * recorded with its path, Authorization header and JSON body.
 */
export async function standInNode(t, plan) {
  const requests = [];
  const next = (list) => (list && list.length > 1 ? list.shift() : list?.[0]);
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://stand-in');
      requests.push({ method: req.method, path: pathname, auth: req.headers.authorization ?? null, body: text ? JSON.parse(text) : null });
      const job = /^\/api\/knowledge-assets\/swm\/share-jobs\/([^/]+)$/.exec(pathname);
      let answer;
      if (req.method === 'POST' && pathname === '/api/knowledge-assets') answer = next(plan.create);
      else if (req.method === 'POST' && /^\/api\/knowledge-assets\/[^/]+\/swm\/share$/.test(pathname)) answer = next(plan.share);
      else if (req.method === 'GET' && job) {
        const jobId = decodeURIComponent(job[1]);
        const state = next(plan.jobs?.[jobId]);
        if (state) answer = { status: 200, body: { jobId, state, attempts: 2 } };
      }
      answer ??= { status: 500, body: { error: `unplanned ${req.method} ${pathname}` } };
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(JSON.stringify(answer.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => { server.close(done); }));
  return { port: server.address().port, requests };
}
