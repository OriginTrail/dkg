/**
 * Job failure reasons: every job failure carries its machine code and a short reason. The reason is at
 * most 512 characters and holds no transaction payload, long hex, URL or request detail; when it had to
 * be cut, the whole text, reduced the same way, goes to the node's own log instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { JOB_FAILURE_REASON_MAX_LENGTH, jobFailureReason, jobFailureText } from '../src/job-failure-reason.js';
import { createLiftJobFailureMetadata } from '../src/lift-job.js';
import { mapExecutionFailure } from '../src/async-lift-execution-failure.js';
import { mapPublishExceptionToLiftJobFailure } from '../src/async-lift-publish-result.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from '../src/promote-replay-safety.js';

const CALLDATA = `0x${'a1b2c3d4'.repeat(250)}`;
const FROM = `0x${'1'.repeat(40)}`;
const TO = `0x${'2'.repeat(40)}`;
// The shape ethers v6 gives a reverted gas estimate: a short message, then a detail block with the transaction.
const ETHERS_REVERT = 'execution reverted (unknown custom error) '
  + `(action="estimateGas", data="0x${'ab'.repeat(36)}", reason=null, `
  + `transaction={ "data": "${CALLDATA}", "from": "${FROM}", "to": "${TO}" }, `
  + 'invocation=null, revert=null, code=CALL_EXCEPTION, version=6.16.0)';
// A throttled request: the block carries the request URL (with a key in its path) and the response body.
const ETHERS_THROTTLED = 'server response 429 Too Many Requests (request={  }, response={  }, error=null, '
  + 'info={ "requestUrl": "https://rpc.example/v2/SECRET-API-KEY", '
  + '"responseBody": "{\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"code\\":429,\\"message\\":\\"rate limited (retry later)\\"}}", '
  + '"responseStatus": "429 Too Many Requests" }, code=SERVER_ERROR, version=6.16.0)';
// A refused send: the RPC node's own message, then the JSON-RPC payload with the signed transaction.
const ETHERS_REFUSED = 'could not coalesce error (error={ "code": -32000, "message": "nonce too low: next nonce 7, tx nonce 6" }, '
  + `payload={ "id": 9, "jsonrpc": "2.0", "method": "eth_sendRawTransaction", "params": [ "0x02f8${'cd'.repeat(300)}" ] }, `
  + 'code=UNKNOWN_ERROR, version=6.16.0)';
const ETHERS_UNFUNDED = 'insufficient funds for intrinsic transaction cost '
  + `(transaction={ "data": "${CALLDATA}", "from": "${FROM}" }, `
  + 'info={ "error": { "code": -32000, "message": "insufficient funds for gas * price + value: balance 0, tx cost 1000" } }, '
  + 'code=INSUFFICIENT_FUNDS, version=6.16.0)';

describe('jobFailureText', () => {
  it('cuts a 2,758-character publish failure to a short reason with its code and no transaction', () => {
    const text = `Publish transaction failed: ${ETHERS_REVERT}`.padEnd(2_758, ' retrying');
    expect(text.length).toBe(2_758);

    const { reason } = jobFailureText(text);

    expect(reason.startsWith('Publish transaction failed: execution reverted (unknown custom error) (code=CALL_EXCEPTION)')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(JOB_FAILURE_REASON_MAX_LENGTH);
    expect(reason).not.toContain('transaction=');
    expect(reason).not.toContain('a1b2c3d4');
  });

  it('replaces each ethers detail block with the RPC node message, when there is one, and the error code', () => {
    expect(jobFailureReason(ETHERS_THROTTLED)).toBe('server response 429 Too Many Requests (code=SERVER_ERROR)');
    expect(jobFailureReason(ETHERS_REFUSED))
      .toBe('could not coalesce error: nonce too low: next nonce 7, tx nonce 6 (code=UNKNOWN_ERROR)');
    expect(jobFailureReason(ETHERS_UNFUNDED)).toBe('insufficient funds for intrinsic transaction cost: '
      + 'insufficient funds for gas * price + value: balance 0, tx cost 1000 (code=INSUFFICIENT_FUNDS)');
    expect(jobFailureReason('missing response (code=SERVER_ERROR, version=6.16.0)')).toBe('missing response (code=SERVER_ERROR)');
    expect(jobFailureReason('refused (error={ "message": "bad \\q escape" }, code=UNKNOWN_ERROR, version=6.16.0)'))
      .toBe('refused: bad \\q escape (code=UNKNOWN_ERROR)');
  });

  it('keeps the text between two detail blocks, and parenthesised text that is not a detail block', () => {
    expect(jobFailureReason(`All endpoints failed: [rpc-a] ${ETHERS_THROTTLED}; [rpc-b] ${ETHERS_REFUSED}`)).toBe(
      'All endpoints failed: [rpc-a] server response 429 Too Many Requests (code=SERVER_ERROR); '
      + '[rpc-b] could not coalesce error: nonce too low: next nonce 7, tx nonce 6 (code=UNKNOWN_ERROR)',
    );
    const own = 'Legacy promote job (formatVersion=2) found in recovery (count=3); needs operator inspection';
    expect(jobFailureReason(own)).toBe(own);
    expect(jobFailureReason('execution reverted (TooLowAllowance(5, 10))')).toBe('execution reverted (TooLowAllowance(5, 10))');
  });

  it('reduces a URL to its host and hex longer than 32 bytes to its length', () => {
    expect(jobFailureReason('lookup failed at https://rpc.example/v2/SECRET-API-KEY?x=1: busy')).toBe('lookup failed at rpc.example: busy');
    const hash = `0x${'cd'.repeat(32)}`;
    expect(jobFailureReason(`signed ${'ef'.repeat(65)} for ${hash} from ${FROM} with data 0x${'ab'.repeat(33)}`))
      .toBe(`signed [hex, 65 bytes] for ${hash} from ${FROM} with data [hex, 33 bytes]`);
  });

  it('turns runs of whitespace and control characters into one space', () => {
    expect(jobFailureReason('  first line\n\tsecond\u0000line \u0085  end  ')).toBe('first line second line end');
  });

  it('keeps the whole reduced text as the detail and cuts the reason with an ellipsis', () => {
    const { reason, detail } = jobFailureText(`${'x'.repeat(2_000)}\n0x${'ab'.repeat(40)}`);
    expect(reason).toBe(`${'x'.repeat(JOB_FAILURE_REASON_MAX_LENGTH - 1)}…`);
    expect(detail).toBe(`${'x'.repeat(2_000)} [hex, 40 bytes]`);
    expect(jobFailureText('short').detail).toBe('short');
  });

  it('never splits a surrogate pair at the cut', () => {
    const reason = jobFailureReason(`${'x'.repeat(510)}😀${'z'.repeat(100)}`);
    expect(reason).toBe(`${'x'.repeat(510)}…`);
  });

  it('reads at most 64 KiB of a failure text', () => {
    const { reason, detail } = jobFailureText('y'.repeat(100_000));
    expect(detail).toBe(`${'y'.repeat(65_536)}…`);
    expect(reason.length).toBe(JOB_FAILURE_REASON_MAX_LENGTH);
  });

  it('takes linear work on a detail block whose close never comes', () => {
    const started = performance.now();
    const unclosed = `failed (error=1, code=X, version=1.2.${'1'.repeat(60_000)}`;
    expect(jobFailureText(unclosed).detail.startsWith('failed (error=1, code=X, version=1.2.[hex, 30000 bytes]')).toBe(true);
    expect(jobFailureReason(`${unclosed} (data=1, code=Y, version=6.16.0)`)).toBe('failed (code=Y)');
    expect(jobFailureReason(`missing (code=X, version=6.0.0-beta-exports.16)`)).toBe('missing (code=X)');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('drops a detail block that the read limit cut before its close, from its start', () => {
    const request = 'request failed (request={ "headers": { "authorization": "Bearer SECRET" }, "body": "'
      + `${'x'.repeat(70_000)}" }, code=SERVER_ERROR, version=6.16.0)`;
    for (const text of [request, `${ETHERS_THROTTLED}; then ${request}`]) {
      const { reason, detail } = jobFailureText(text);
      for (const out of [reason, detail]) {
        expect(out).not.toContain('SECRET');
        expect(out).not.toContain('authorization');
      }
    }
    expect(jobFailureText(request).detail).toBe('request failed…');
    expect(jobFailureText(`${ETHERS_THROTTLED}; then ${request}`).detail)
      .toBe('server response 429 Too Many Requests (code=SERVER_ERROR); then request failed…');
  });

  it('is unchanged by a second pass, so a stored reason reads back as it was written', () => {
    for (const text of [ETHERS_REVERT, ETHERS_THROTTLED, ETHERS_REFUSED, `${'x '.repeat(600)}`, PROMOTE_POST_COMMIT_FAILURE_MESSAGE]) {
      const reason = jobFailureReason(text);
      expect(jobFailureReason(reason)).toBe(reason);
    }
    expect(jobFailureReason(PROMOTE_POST_COMMIT_FAILURE_MESSAGE)).toBe(PROMOTE_POST_COMMIT_FAILURE_MESSAGE);
  });

  it('never throws, whatever it is given', () => {
    expect(jobFailureReason(new Error('boom'))).toBe('boom');
    expect(jobFailureReason(null)).toBe('');
    expect(jobFailureReason(42)).toBe('42');
    expect(jobFailureReason({ [Symbol.toPrimitive]() { throw new Error('hostile'); } })).toBe('');
    expect(jobFailureReason(Object.defineProperty(new Error(), 'message', { get() { throw new Error('hostile'); } }))).toBe('');
  });

  it('stays linear on adversarial text', () => {
    const started = performance.now();
    const blockStarts = ' (data=1'.repeat(8_000);
    expect(jobFailureReason(`code=X, version=1.2.3) ${blockStarts}`).endsWith('(data=1 (data=1…')).toBe(true);
    expect(jobFailureReason(`${blockStarts} code=X, version=1.2.3)`)).toBe('(code=X)');
    expect(jobFailureReason(' (data=1 code=X, version=1.2.3)'.repeat(2_000)).startsWith('(code=X) (code=X)')).toBe(true);
    expect(jobFailureReason(`${' code=AAAAAAAAAAAAAAAA'.repeat(2_500)} (data=1 code=X, version=1.2.3)`))
      .toMatch(/^code=A{16} code=A{16} .*…$/);
    expect(jobFailureReason(`failed (error=${'"message": "x'.repeat(4_000)} code=X, version=1.2.3)`)).toBe('failed: x (code=X)');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('a publish job failure records a short reason', () => {
  const logged: Array<{ level: string; message: string }> = [];
  beforeEach(() => {
    logged.length = 0;
    Logger.setSink((record) => { logged.push(record); });
  });
  afterEach(() => Logger.setSink(null));

  it('keeps the code, and logs the whole reduced text only when the reason was cut', () => {
    const failure = createLiftJobFailureMetadata({
      failedFromState: 'broadcast',
      code: 'rpc_unavailable',
      message: `${'endpoint refused the request; '.repeat(40)}${ETHERS_THROTTLED}`,
      errorPayloadRef: 'urn:dkg:publisher:error:job-long',
    });
    expect(failure.code).toBe('rpc_unavailable');
    expect(failure.message.length).toBeLessThanOrEqual(JOB_FAILURE_REASON_MAX_LENGTH);
    expect(failure.message.endsWith('…')).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('warn');
    expect(logged[0]!.message).toContain('urn:dkg:publisher:error:job-long failed (rpc_unavailable): endpoint refused');
    expect(logged[0]!.message).toContain('server response 429 Too Many Requests (code=SERVER_ERROR)');
    expect(logged[0]!.message).not.toContain('SECRET-API-KEY');

    logged.length = 0;
    const short = createLiftJobFailureMetadata({
      failedFromState: 'broadcast', code: 'tx_reverted', message: ETHERS_REVERT, errorPayloadRef: 'urn:dkg:publisher:error:job-short',
    });
    expect(short.message).toBe('execution reverted (unknown custom error) (code=CALL_EXCEPTION)');
    expect(logged).toHaveLength(0);
  });

  it('never logs the contents of a detail block that the read limit cut', () => {
    const failure = createLiftJobFailureMetadata({
      failedFromState: 'broadcast',
      code: 'rpc_unavailable',
      message: `${'endpoint refused the request; '.repeat(40)}send failed `
        + `(request={ "headers": { "authorization": "Bearer SECRET" }, "body": "${'x'.repeat(70_000)}`,
      errorPayloadRef: 'urn:dkg:publisher:error:job-cut',
    });
    expect(failure.message.length).toBeLessThanOrEqual(JOB_FAILURE_REASON_MAX_LENGTH);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.message.endsWith('endpoint refused the request; send failed…')).toBe(true);
    expect(logged[0]!.message).not.toContain('SECRET');
  });

  it('on the broadcast path, with the code the raw text classifies to', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error(ETHERS_UNFUNDED), failedFromState: 'broadcast', errorPayloadRef: 'urn:dkg:publisher:error:job-1',
    });
    expect(failure.code).toBe('insufficient_funds');
    expect(failure.message).toBe('insufficient funds for intrinsic transaction cost: '
      + 'insufficient funds for gas * price + value: balance 0, tx cost 1000 (code=INSUFFICIENT_FUNDS)');
  });

  it('on the execution path, for a structured precondition that keeps its own text', () => {
    const error = Object.assign(new Error(`authority read failed: ${'no answer; '.repeat(300)}`), {
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', reason: 'authority-circuit-open',
    });
    const failure = mapExecutionFailure({ jobId: 'job-2', currentStatus: 'validated', requestedOrigin: 'validated', error, now: () => 0 });
    expect(failure.code).toBe('authority_unavailable');
    expect(failure.message.startsWith('authority read failed: no answer;')).toBe(true);
    expect(failure.message.length).toBeLessThanOrEqual(JOB_FAILURE_REASON_MAX_LENGTH);
    expect(failure.message.endsWith('…')).toBe(true);
  });
});

describe('a share job failure records a short reason', () => {
  it('stores the attempt error cut and reduced, and keeps its classification', async () => {
    const queue = new TripleStoreAsyncPromoteQueue(new OxigraphStore(), { now: () => 1_000, idGenerator: () => 'job-share' });
    const jobId = await queue.enqueue({ contextGraphId: 'cg', assertionName: 'a', entities: 'all' });
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: `Promote failed: ${ETHERS_REFUSED} ${'and again; '.repeat(100)}`,
      retryable: false,
      classification: 'fatal',
      recordedAt: 1_000,
    });

    const lastError = (await queue.getStatus(jobId))!.attempt.lastError!;
    expect(lastError.classification).toBe('fatal');
    expect(lastError.message.startsWith('Promote failed: could not coalesce error: nonce too low')).toBe(true);
    expect(lastError.message.length).toBeLessThanOrEqual(JOB_FAILURE_REASON_MAX_LENGTH);
    expect(lastError.message.endsWith('…')).toBe(true);
    expect(lastError.message).not.toContain('eth_sendRawTransaction');
  });
});
