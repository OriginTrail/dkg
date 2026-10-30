import { toErrorMessage } from '@origintrail-official/dkg-core';

/**
 * A failed async share or publish answer says whether a job exists: its body carries the job ID, whether the share
 * was admitted, and whether a publish job was created. The error message alone says none of that, and running the
 * command again after it can share a draft twice once the first job has run, or start a second publish job (#3574).
 * The async commands print these fields with the error and name the command that follows the job.
 */
export type AsyncJobKind = 'share' | 'publish';

/** The answer fields that say whether a job exists, in print order. */
const JOB_FIELDS = [
  ['code', 'Code'],
  ['admissionOutcome', 'Admission outcome'],
  ['jobId', 'Job ID'],
  ['statusPath', 'Status path'],
  ['jobCreated', 'Job created'],
  ['existingJobId', 'Existing job'],
] as const;

export type AsyncJobFailureFields = Partial<Record<(typeof JOB_FIELDS)[number][0], string | boolean>>;

const FOLLOW = {
  share: { command: 'dkg ka share-job', hint: 'poll this job; do not run share-async again' },
  publish: { command: 'dkg publisher job', hint: 'read this job before you run publish-async again' },
} as const;

function answerBody(err: unknown): Record<string, unknown> | undefined {
  const body = (err as { responseBody?: unknown } | null | undefined)?.responseBody;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

/** The answer's job fields. An error without an answer, such as an unanswered request, gives its own `code`. */
export function asyncJobFailureFields(err: unknown): AsyncJobFailureFields {
  const body = answerBody(err) ?? {};
  const ownCode = (err as { code?: unknown } | null | undefined)?.code;
  const source = body.code === undefined && typeof ownCode === 'string' ? { ...body, code: ownCode } : body;
  const fields: AsyncJobFailureFields = {};
  for (const [key] of JOB_FIELDS) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'boolean') fields[key] = value;
  }
  return fields;
}

/** The command that reads the job the answer names, if it names one. */
export function asyncJobFollowCommand(kind: AsyncJobKind, fields: AsyncJobFailureFields): string | undefined {
  const jobId = [fields.jobId, fields.existingJobId].find((id): id is string => typeof id === 'string' && id !== '');
  return jobId === undefined ? undefined : `${FOLLOW[kind].command} ${jobId}`;
}

/**
 * Print a failed async share or publish request: the message on stderr, then what the answer says about a job, as
 * lines on stderr or, with `--json`, as one object on stdout (the answer's body, its HTTP status and `next`, the
 * command that follows the job).
 */
export function printAsyncJobFailure(err: unknown, kind: AsyncJobKind, opts: { json?: unknown } = {}): void {
  const message = toErrorMessage(err);
  const fields = asyncJobFailureFields(err);
  const follow = asyncJobFollowCommand(kind, fields);
  if (opts.json) {
    const httpStatus = (err as { httpStatus?: unknown } | null | undefined)?.httpStatus;
    console.log(JSON.stringify({
      ...answerBody(err),
      ...fields,
      error: message,
      ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
      ...(follow ? { next: follow } : {}),
    }, null, 2));
    console.error(message);
    return;
  }
  console.error(message);
  for (const [key, label] of JOB_FIELDS) {
    if (fields[key] !== undefined) console.error(`  ${`${label}:`.padEnd(19)}${String(fields[key])}`);
  }
  if (follow) {
    console.error(`  ${'Follow:'.padEnd(19)}${follow} (${FOLLOW[kind].hint})`);
  } else if (fields.admissionOutcome === 'not_admitted' || fields.jobCreated === false) {
    console.error(`  ${'Note:'.padEnd(19)}this request created no job`);
  }
}
