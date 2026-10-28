// SPDX-License-Identifier: Apache-2.0
import { normalizePublicSnapshotSyncOptions } from '@origintrail-official/dkg-agent';
import { readBody, jsonResponse, isPayloadTooLargeError } from '../http-utils.js';
import type { RequestContext } from './context.js';

import type { PublicCheckpointJob } from '../../public-checkpoint-contract.js';
import { createSnapshotJobTracker } from './snapshot-job-tracker.js';
type Result = Extract<PublicCheckpointJob, { state: 'complete' }>['result'];
const jobs = createSnapshotJobTracker<Result, object, object>(() => ({}));

/** Parent route enforces node-admin access. A completed preparation is never active coverage. */
export async function handlePublicCheckpointJob({ req, res, agent }: RequestContext): Promise<void> {
  if (req.method === 'GET') { jsonResponse(res, 200, jobs.get(agent) ?? { state: 'idle' }); return; }
  if (req.method !== 'POST') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
  if (jobs.isRunning(agent)) { jsonResponse(res, 409, { error: 'Checkpoint preparation already running' }); return; }
  let input: ReturnType<typeof normalizePublicSnapshotSyncOptions>, native: boolean;
  try {
    const raw = JSON.parse(await readBody(req, 4096));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(k => !['contextGraphId', 'onChainId', 'trustedCorePeerIds', 'sourcePolicy', 'mode', 'native'].includes(k))
      || (raw.native !== undefined && typeof raw.native !== 'boolean')) throw new Error('Invalid request');
    input = normalizePublicSnapshotSyncOptions(raw); native = raw.native === true;
  } catch (error) {
    jsonResponse(res, isPayloadTooLargeError(error) ? 413 : 400, { error: 'Invalid checkpoint request' }); return;
  }
  const job = jobs.start(agent, {}, () => agent.preparePublicGraphCheckpoint(input, native));
  if (!job) { jsonResponse(res, 409, { error: 'Checkpoint preparation already running' }); return; }
  jsonResponse(res, 202, job);
}
