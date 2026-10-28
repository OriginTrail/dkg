// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { normalizePublicSnapshotSyncOptions, type DKGAgent } from '@origintrail-official/dkg-agent';
import { readBody, jsonResponse, isPayloadTooLargeError } from '../http-utils.js';
import type { RequestContext } from './context.js';

type Job = { id: string; startedAt: number } & (
  | { state: 'running' }
  | { state: 'complete'; result: Awaited<ReturnType<DKGAgent['preparePublicGraphCheckpoint']>> }
  | { state: 'failed'; error: string }
);
const jobs = new WeakMap<DKGAgent, Job>();

/** Parent route enforces node-admin access. A completed preparation is never active coverage. */
export async function handlePublicCheckpointJob({ req, res, agent }: RequestContext): Promise<void> {
  if (req.method === 'GET') { jsonResponse(res, 200, jobs.get(agent) ?? { state: 'idle' }); return; }
  if (req.method !== 'POST') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }
  if (jobs.get(agent)?.state === 'running') { jsonResponse(res, 409, { error: 'Checkpoint preparation already running' }); return; }
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
  if (jobs.get(agent)?.state === 'running') { jsonResponse(res, 409, { error: 'Checkpoint preparation already running' }); return; }
  const job: Job = { id: randomUUID(), startedAt: Date.now(), state: 'running' };
  jobs.set(agent, job);
  void agent.preparePublicGraphCheckpoint(input, native).then(
    result => { jobs.set(agent, { ...job, state: 'complete', result }); },
    error => { jobs.set(agent, { ...job, state: 'failed', error: error instanceof Error ? error.message : String(error) }); },
  );
  jsonResponse(res, 202, job);
}
