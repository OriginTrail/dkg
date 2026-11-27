/**
 * #3574: a failed `dkg ka share-async`, `dkg ka publish-async` or `dkg publisher publish-async` printed only the
 * error text. The answer's body says whether a job exists, and without it the obvious next step, running the command
 * again, could share a draft twice once the first job had run, or start a second publish job. The commands now print
 * the body's job fields and name the command that reads the job, as lines or, with `--json`, as one object.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient, DaemonOutcomeUnknownError } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';

const INDETERMINATE = {
  code: 'PROMOTE_ADMISSION_UNAVAILABLE',
  error: 'Async share admission could not be confirmed',
  retryable: true,
  admissionScope: 'async_promote_job',
  phase: 'persist',
  admissionOutcome: 'indeterminate',
  jobId: 'share-job-1',
  statusPath: '/api/knowledge-assets/swm/share-jobs/share-job-1',
  recovery: 'Poll this job ID; do not resend.',
};

function program(): Command {
  const root = new Command().name('dkg');
  root.exitOverride();
  registerKnowledgeAssetCommand(root);
  registerPublisherCommand(root);
  return root;
}

describe('async share and publish commands on failure (#3574)', () => {
  const out: string[] = [];
  const err: string[] = [];

  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { err.push(args.map(String).join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failWith(method: 'knowledgeAssetShareAsync' | 'knowledgeAssetPublishAsync', error: unknown) {
    const call = vi.fn().mockRejectedValue(error);
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ [method]: call } as unknown as ApiClient);
    return call;
  }

  async function run(args: string[]): Promise<void> {
    await expect(program().parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit:1');
  }

  it('share-async: an indeterminate admission names the job to poll instead of a re-run', async () => {
    failWith('knowledgeAssetShareAsync', ApiClient.httpError(503, INDETERMINATE.error, INDETERMINATE));
    await run(['ka', 'share-async', 'paper', '-c', 'research']);
    expect(err).toEqual([
      'Async share admission could not be confirmed',
      '  Code:              PROMOTE_ADMISSION_UNAVAILABLE',
      '  Admission outcome: indeterminate',
      '  Job ID:            share-job-1',
      '  Status path:       /api/knowledge-assets/swm/share-jobs/share-job-1',
      '  Follow:            dkg ka share-job share-job-1 (poll this job; do not run share-async again)',
    ]);
    expect(out).toEqual([]);
  });

  it('share-async: a not_admitted answer says that the request created no job', async () => {
    const body = { code: 'PROMOTE_ADMISSION_UNAVAILABLE', error: INDETERMINATE.error, phase: 'lock', admissionOutcome: 'not_admitted' };
    failWith('knowledgeAssetShareAsync', ApiClient.httpError(503, body.error, body));
    await run(['ka', 'share-async', 'paper', '-c', 'research']);
    expect(err).toEqual([
      'Async share admission could not be confirmed',
      '  Code:              PROMOTE_ADMISSION_UNAVAILABLE',
      '  Admission outcome: not_admitted',
      '  Note:              this request created no job',
    ]);
  });

  it('share-async: a conflict names the running share job', async () => {
    const body = { error: 'A share job for this assertion is already running', existingJobId: 'share-job-0' };
    failWith('knowledgeAssetShareAsync', ApiClient.httpError(409, body.error, body));
    await run(['ka', 'share-async', 'paper', '-c', 'research']);
    expect(err).toEqual([
      'A share job for this assertion is already running',
      '  Existing job:      share-job-0',
      '  Follow:            dkg ka share-job share-job-0 (poll this job; do not run share-async again)',
    ]);
  });

  it('share-async: an unanswered request says outcome unknown, with its code and the job list to check', async () => {
    const unanswered = new DaemonOutcomeUnknownError('POST', '/api/knowledge-assets/paper/swm/share-async', 240_000,
      'A share job for "paper" may exist: look for it with `dkg ka share-jobs --context-graph-id research` before retrying.');
    failWith('knowledgeAssetShareAsync', unanswered);
    await run(['ka', 'share-async', 'paper', '-c', 'research']);
    expect(err).toEqual([unanswered.message, '  Code:              OUTCOME_UNKNOWN']);
  });

  it('share-async: an error without an answer prints its message alone', async () => {
    failWith('knowledgeAssetShareAsync', new Error('connect ECONNREFUSED'));
    await run(['ka', 'share-async', 'paper', '-c', 'research']);
    expect(err).toEqual(['connect ECONNREFUSED']);
  });

  it('ka publish-async: a conflict names the publish job holding the asset', async () => {
    const body = { error: 'A publish job for this Knowledge Asset already exists', existingJobId: 'lift-job-4' };
    failWith('knowledgeAssetPublishAsync', ApiClient.httpError(409, body.error, body));
    await run(['ka', 'publish-async', 'paper', '-c', 'research']);
    expect(err).toEqual([
      'A publish job for this Knowledge Asset already exists',
      '  Existing job:      lift-job-4',
      '  Follow:            dkg publisher job lift-job-4 (read this job before you run publish-async again)',
    ]);
  });

  it('ka publish-async --json: prints the answer, its status and the follow command on stdout', async () => {
    const body = { code: 'LIFT_JOB_PENDING_CHAIN_PROOF', error: 'held for chain proof', retryable: true, existingJobId: 'lift-job-5' };
    failWith('knowledgeAssetPublishAsync', ApiClient.httpError(503, body.error, body));
    await run(['ka', 'publish-async', 'paper', '-c', 'research', '--json']);
    expect(JSON.parse(out.join('\n'))).toEqual({ ...body, httpStatus: 503, next: 'dkg publisher job lift-job-5' });
    expect(err).toEqual(['held for chain proof']);
  });

  it('ka publish-async --json: a store refusal before the enqueue carries jobCreated: false and no follow command', async () => {
    const body = { code: 'STORE_SCHEDULER_BUSY', error: 'store busy', retryable: true, jobCreated: false };
    failWith('knowledgeAssetPublishAsync', ApiClient.httpError(503, body.error, body));
    await run(['ka', 'publish-async', 'paper', '-c', 'research', '--json']);
    expect(JSON.parse(out.join('\n'))).toEqual({ ...body, httpStatus: 503 });
  });

  it('ka publish-async --json: an unanswered request gives the error and its code', async () => {
    const unanswered = new DaemonOutcomeUnknownError('POST', '/api/knowledge-assets/paper/vm/publish-async', 240_000, 'hint');
    failWith('knowledgeAssetPublishAsync', unanswered);
    await run(['ka', 'publish-async', 'paper', '-c', 'research', '--json']);
    expect(JSON.parse(out.join('\n'))).toEqual({ error: unanswered.message, code: 'OUTCOME_UNKNOWN' });
  });

  it('publisher publish-async: a stale intent says that the request created no job', async () => {
    const body = { code: 'PUBLISH_INTENT_STALE', error: 'stale update intent', jobCreated: false };
    const call = failWith('knowledgeAssetPublishAsync', ApiClient.httpError(409, body.error, body));
    await run(['publisher', 'publish-async', 'research', 'paper']);
    expect(call).toHaveBeenCalledWith('research', 'paper', {});
    expect(err).toEqual([
      'stale update intent',
      '  Code:              PUBLISH_INTENT_STALE',
      '  Job created:       false',
      '  Note:              this request created no job',
    ]);
  });

  it('publisher publish-async: a conflict names the publish job holding the asset', async () => {
    const body = { error: 'A publish job for this Knowledge Asset already exists', existingJobId: 'lift-job-6' };
    failWith('knowledgeAssetPublishAsync', ApiClient.httpError(409, body.error, body));
    await run(['publisher', 'publish-async', 'research', 'paper']);
    expect(err).toEqual([
      'A publish job for this Knowledge Asset already exists',
      '  Existing job:      lift-job-6',
      '  Follow:            dkg publisher job lift-job-6 (read this job before you run publish-async again)',
    ]);
  });
});
